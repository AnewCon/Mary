import hashlib,hmac,json,time,urllib.request,urllib.error,urllib.parse,os
from decimal import Decimal
from pathlib import Path

config=json.load(open('/etc/quantos-binance/config.json'))
cf='https://marya-4j3.pages.dev/api/binance-demo/agent/'
demo='https://demo-fapi.binance.com'
http=urllib.request.build_opener(urllib.request.ProxyHandler({}))
spool=Path('/var/lib/quantos-binance/result.json')

class Upstream(Exception):
    def __init__(self,code): self.code=code

def request(url,headers,method='GET',body=None):
    try:
        with http.open(urllib.request.Request(url,headers={'User-Agent':'QuantOS-VPS/1.0',**headers},method=method,data=body),timeout=15) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try: code=json.load(e).get('code')
        except (ValueError,AttributeError): code=None
        raise Upstream(code if isinstance(code,(int,str)) else 'HTTP_'+str(e.code)) from None

def cloud(path,body):
    result=request(cf+path,{'Authorization':'Bearer '+config['token'],'Content-Type':'application/json'},'POST',json.dumps(body).encode())
    if not result.get('ok'): raise ValueError('Invalid cloud response')
    return result['data']

def exchange(path,method='GET',params=None,live=None):
    if live is not None and (method!='GET' or path not in {'/fapi/v3/account','/fapi/v3/positionRisk'}):
        raise ValueError('Live endpoint is read-only')
    credentials=config if live is None else live
    host=demo if live is None else 'https://fapi.binance.com'
    params=dict(params or {})
    headers={}
    if path!='/fapi/v1/exchangeInfo':
        params.update(timestamp=int(time.time()*1000),recvWindow=5000)
        query=urllib.parse.urlencode(params)
        params['signature']=hmac.new(credentials['secret'].encode(),query.encode(),hashlib.sha256).hexdigest()
        headers['X-MBX-APIKEY']=credentials['key']
    result=request(host+path+'?'+urllib.parse.urlencode(params),headers,method)
    if isinstance(result,dict) and isinstance(result.get('code'),int) and result['code']<0:
        raise Upstream(result['code'])
    return result

def snapshot(include_history=False):
    account=exchange('/fapi/v3/account')
    positions=exchange('/fapi/v3/positionRisk')
    if not isinstance(account.get('assets'),list) or not isinstance(positions,list):
        raise ValueError('Invalid account snapshot')
    positions=[p for p in positions if Decimal(p['positionAmt'])!=0]
    data={'account':{'assets':[a for a in account['assets'] if a['asset']=='USDT']},'positions':positions}
    if include_history:
        try:
            income=exchange('/fapi/v1/income',params={'incomeType':'REALIZED_PNL','limit':20})
            data['history']=[{k:row[k] for k in ('symbol','income','asset','time','tranId')} for row in income]
        except Exception as e:
            print('history failed',getattr(e,'code',type(e).__name__),flush=True)
    cloud('snapshot',data)
    return bool(positions)


def live_snapshot():
    path=Path('/etc/quantos-binance/live-readonly.json')
    if not path.is_file(): return
    credentials=json.loads(path.read_text())
    account=exchange('/fapi/v3/account',live=credentials)
    positions=exchange('/fapi/v3/positionRisk',live=credentials)
    cloud('live-snapshot',{'account':{'assets':[a for a in account['assets'] if a['asset']=='USDT']},
        'positions':[p for p in positions if Decimal(p['positionAmt'])!=0]})

def execute(job):
    action=job['action']
    kind=action['kind']
    symbol=action['symbol']

    if kind in {'open','limit','protect'} and any(
        json.loads(file.read_text())['action']['symbol']==symbol
        for file in (spool.parent/'brackets').glob('*.json')
    ) and not job.get('bracketEntry'):
        raise Upstream('BRACKET_ALREADY_ACTIVE')

    if kind=='contract':
        item=next((p for p in exchange('/fapi/v1/exchangeInfo')['symbols'] if p['symbol']==symbol),None)
        if not item: raise Upstream('CONTRACT_NOT_FOUND')
        return {'symbol':symbol,'status':item['status'],'contractType':item['contractType'],
                'filters':item['filters'],'configuration':exchange('/fapi/v1/symbolConfig',params={'symbol':symbol}),
                'positionMode':exchange('/fapi/v1/positionSide/dual')}
    if kind=='orders':
        return {'openOrders':exchange('/fapi/v1/openOrders',params={'symbol':symbol})[:20],
                'openProtection':exchange('/fapi/v1/openAlgoOrders',params={'symbol':symbol})[:20],
                'recentOrders':exchange('/fapi/v1/allOrders',params={'symbol':symbol,'limit':10})}
    if kind=='query':
        return exchange('/fapi/v1/order',params={'symbol':symbol,'orderId':action['exchangeOrderId']})
    if kind=='cancel':
        if action['conditional']:
            order=exchange('/fapi/v1/algoOrder',params={'algoId':action['exchangeOrderId']})
            if order['symbol']!=symbol: raise Upstream('ORDER_SYMBOL_MISMATCH')
            return exchange('/fapi/v1/algoOrder','DELETE',{'algoId':action['exchangeOrderId']})
        return exchange('/fapi/v1/order','DELETE',{'symbol':symbol,'orderId':action['exchangeOrderId']})

    if kind=='leverage':
        result=exchange('/fapi/v1/leverage','POST',{'symbol':symbol,'leverage':action['leverage']})
        return {'leverage':result['leverage'],'symbol':result['symbol']}
    side=action['side']
    positions=exchange('/fapi/v3/positionRisk',params={'symbol':symbol})
    hedge=exchange('/fapi/v1/positionSide/dual')['dualSidePosition']
    if type(hedge) is not bool: raise ValueError('Invalid position mode')
    position_side=side if hedge else 'BOTH'
    active=[p for p in positions if p['symbol']==symbol and Decimal(p['positionAmt'])!=0]
    def direction(position):
        return position['positionSide'] if hedge else 'LONG' if Decimal(position['positionAmt'])>0 else 'SHORT'
    params={'symbol':symbol,'positionSide':position_side,'type':'MARKET','newClientOrderId':'qos_'+job['id'],'newOrderRespType':'RESULT'}

    if kind=='protect':
        position=next((p for p in active if direction(p)==side),None)
        if not position: raise Upstream('POSITION_CHANGED')
        closing_side='SELL' if side=='LONG' else 'BUY'
        existing=exchange('/fapi/v1/openAlgoOrders',params={'symbol':symbol})
        if any(p.get('positionSide')==position_side and p.get('side')==closing_side and
               p.get('orderType')==action['protection'] and p.get('closePosition') in (True,'true') for p in existing):
            raise Upstream('PROTECTION_ALREADY_EXISTS')
        result=exchange('/fapi/v1/algoOrder','POST',{'algoType':'CONDITIONAL','symbol':symbol,'side':closing_side,
            'positionSide':position_side,'type':action['protection'],'triggerPrice':action['triggerPrice'],
            'workingType':'MARK_PRICE','closePosition':'true','clientAlgoId':'qos_'+job['id']})
        if result.get('clientAlgoId')!='qos_'+job['id'] or result.get('symbol')!=symbol:
            raise ValueError('Invalid protection response')
        return {'algoId':str(result['algoId']),'algoStatus':result.get('algoStatus'),'triggerPrice':result.get('triggerPrice')}

    if kind=='close':
        position=next((p for p in active if direction(p)==side),None)
        if not position: raise Upstream('POSITION_CHANGED')
        contract=next(p for p in exchange('/fapi/v1/exchangeInfo')['symbols'] if p['symbol']==symbol)
        filters={f['filterType']:f for f in contract['filters']}
        lot=filters['MARKET_LOT_SIZE']
        step=Decimal(lot['stepSize']) or Decimal(filters['LOT_SIZE']['stepSize'])
        desired=min(abs(Decimal(position['positionAmt']))*action['percent']/100, Decimal(lot['maxQty']))
        quantity=(desired//step)*step
        if quantity<=0 or quantity<Decimal(lot['minQty']): raise Upstream('QUANTITY_TOO_SMALL')
        params['quantity']=format(quantity,'f')
        if not hedge: params['reduceOnly']='true'
    elif kind in {'open','limit'}:
        if not hedge and any(direction(p)!=side for p in active): raise Upstream('OPPOSITE_POSITION')
        params['quantity']=action['quantity']
        if kind=='limit': params.update(type='LIMIT',price=action['price'],timeInForce='GTC')
    else: raise Upstream('INVALID_ACTION')
    params['side']='BUY' if (side=='LONG')==(kind in {'open','limit'}) else 'SELL'
    result=exchange('/fapi/v1/order','POST',params)
    if result.get('clientOrderId')!=params['newClientOrderId'] or result.get('symbol')!=symbol:
        raise ValueError('Invalid order response')
    return {'exchangeOrderId':str(result['orderId']),'exchangeStatus':result.get('status'),
            'executedQuantity':result.get('executedQty'),'averagePrice':result.get('avgPrice')}


def atomic_json(path,data):
    tmp=path.with_suffix('.tmp')
    tmp.write_text(json.dumps(data))
    os.replace(tmp,path)

def bracket_entry(job):
    action=job['action']
    symbol=action['symbol']
    folder=spool.parent/'brackets'
    folder.mkdir(exist_ok=True)
    if any(json.loads(p.read_text())['action']['symbol']==symbol for p in folder.glob('*.json')):
        raise Upstream('BRACKET_ALREADY_ACTIVE')
    if any(Decimal(p['positionAmt'])!=0 for p in exchange('/fapi/v3/positionRisk',params={'symbol':symbol})):
        raise Upstream('BRACKET_REQUIRES_FLAT_SYMBOL')
    if exchange('/fapi/v1/openOrders',params={'symbol':symbol}) or exchange('/fapi/v1/openAlgoOrders',params={'symbol':symbol}):
        raise Upstream('BRACKET_REQUIRES_NO_OPEN_ORDERS')
    file=folder/(job['id']+'.json')
    atomic_json(file,job)
    result=execute({'id':job['id'],'bracketEntry':True,'action':{**action,'kind':'limit'}})
    return {**result,'protectionState':'waiting_fill'}

def monitor_bracket(file):
    job=json.loads(file.read_text())
    action=job['action']
    symbol=action['symbol']
    try:
        order=exchange('/fapi/v1/order',params={'symbol':symbol,'origClientOrderId':'qos_'+job['id']})
    except Upstream as e:
        if e.code!=-2013: raise
        if time.time()-file.stat().st_mtime<180: return
        file.unlink()
        return
    result={'exchangeOrderId':str(order['orderId']),'exchangeStatus':order['status'],'executedQuantity':order['executedQty']}
    if not Decimal(order['executedQty']):
        if order['status'] not in {'CANCELED','EXPIRED','REJECTED','EXPIRED_IN_MATCH'}: return
        result['protectionState']='entry_canceled'
    else:
        hedge=exchange('/fapi/v1/positionSide/dual')['dualSidePosition']
        pos_side=action['side'] if hedge else 'BOTH'
        opposite='SELL' if action['side']=='LONG' else 'BUY'
        positions=exchange('/fapi/v3/positionRisk',params={'symbol':symbol})
        active=any(p['positionSide']==pos_side and Decimal(p['positionAmt'])!=0 and
                   (hedge or (Decimal(p['positionAmt'])>0)==(action['side']=='LONG')) for p in positions)
        legs={}
        for key,kind,suffix in [('stopLoss','STOP_MARKET','s'),('takeProfit','TAKE_PROFIT_MARKET','t')]:
            leg_id='qb'+job['id']+suffix
            try:
                current=exchange('/fapi/v1/algoOrder',params={'clientAlgoId':leg_id})
            except Upstream as e:
                if e.code not in {-2011,-2013}: raise
                current=None
            if active and current is None:
                try: current=exchange('/fapi/v1/algoOrder','POST',{'algoType':'CONDITIONAL','symbol':symbol,
                    'side':opposite,'positionSide':pos_side,'type':kind,'workingType':'MARK_PRICE',
                    'closePosition':'true','triggerPrice':action[key],'clientAlgoId':leg_id})
                except Upstream as e:
                    legs[key]={'status':'ERROR','code':str(e.code)}
            if current:
                if not active and current.get('algoStatus')=='NEW':
                    current=exchange('/fapi/v1/algoOrder','DELETE',{'algoId':current['algoId']})
                legs[key]={'algoId':str(current['algoId']),'status':current.get('algoStatus')}
        armed=all(legs.get(k,{}).get('status')=='NEW' for k in ('stopLoss','takeProfit'))
        result.update(protectionState=('armed' if armed else 'protection_error') if active else 'completed',protection=legs)
        if not active and order['status'] in {'NEW','PARTIALLY_FILLED'}:
            exchange('/fapi/v1/order','DELETE',{'symbol':symbol,'orderId':order['orderId']})
    if job.get('lastReport')!=result:
        cloud('result',{'id':job['id'],'state':'acknowledged','result':result})
        job['lastReport']=result
        atomic_json(file,job)
    if result['protectionState'] in {'completed','entry_canceled'}: file.unlink()


def process(job):
    result={'id':job['id']}
    try: result.update(state='acknowledged',result=bracket_entry(job) if job['action']['kind']=='bracket' else execute(job))
    except Upstream as e:
        certain=(isinstance(e.code,int) and e.code not in {-1000,-1001,-1006,-1007}) or e.code in {'POSITION_CHANGED','QUANTITY_TOO_SMALL','OPPOSITE_POSITION','INVALID_ACTION','CONTRACT_NOT_FOUND','ORDER_SYMBOL_MISMATCH','PROTECTION_ALREADY_EXISTS','BRACKET_ALREADY_ACTIVE','BRACKET_REQUIRES_FLAT_SYMBOL','BRACKET_REQUIRES_NO_OPEN_ORDERS'}
        result.update(state='rejected' if certain else 'unknown',result={'code':str(e.code)})
    except Exception: result.update(state='unknown',result={'code':'VERIFY_BINANCE_BEFORE_RETRY'})
    tmp=spool.with_suffix('.tmp')
    tmp.write_text(json.dumps(result))
    os.replace(tmp,spool)

def main():
    due=0
    bootstrap=True
    config_due=0
    history_due=0
    bracket_due=0
    live_due=0
    mode='paused'
    marker=spool.with_name('sync-active')
    while True:
        current=time.monotonic()
        if current>=live_due:
            live_due=current+300
            try: live_snapshot()
            except Exception as e: print('live read failed',getattr(e,'code',type(e).__name__),flush=True)
        if current>=config_due:
            try:
                next_mode=cloud('sync-mode',{})['mode']
                if next_mode!=mode: due=0
                mode=next_mode
            except Exception as e:
                print('sync configuration failed',getattr(e,'code',type(e).__name__),flush=True)
            config_due=current+60
        if current>=due and mode!='paused' and (bootstrap or mode=='always' or mode=='on_open' and marker.exists()):
            try:
                active=snapshot(current>=history_due)
                if bootstrap and active: marker.touch()
                bootstrap=False
                if current>=history_due: history_due=current+300
                if mode=='on_open' and not active and not exchange('/fapi/v1/openOrders'):
                    marker.unlink(missing_ok=True)
                print('snapshot uploaded',flush=True)
            except Exception as e:
                print('snapshot failed',getattr(e,'code',type(e).__name__),flush=True)
            due=time.monotonic()+60
        try:
            if spool.exists():
                cloud('result',json.loads(spool.read_text()))
                spool.unlink()
            else:
                job=cloud('claim',{})
                if job:
                    kind=job['action']['kind']
                    if kind=='refresh_snapshot':
                        report={'id':job['id']}
                        try:
                            active=snapshot(True)
                            if mode=='on_open' and active: marker.touch()
                            bootstrap=False
                            due=time.monotonic()+60
                            history_due=time.monotonic()+300
                            report.update(state='acknowledged',result={'refreshed':True})
                            print('manual snapshot uploaded',flush=True)
                        except Exception as error:
                            code=str(getattr(error,'code',type(error).__name__))
                            report.update(state='rejected',result={'code':code})
                            print('manual snapshot failed',code,flush=True)
                        atomic_json(spool,report)
                    else:
                        if kind in {'open','limit','bracket'}:
                            marker.touch()
                            due=0
                        if kind in {'close','cancel'}: due=history_due=0
                        process(job)
        except Exception as e:
            print('queue operation failed',getattr(e,'code',type(e).__name__),flush=True)
        if time.monotonic()>=bracket_due and not spool.exists():
            bracket_due=time.monotonic()+15
            for file in (spool.parent/'brackets').glob('*.json'):
                try: monitor_bracket(file)
                except Exception as e:
                    print('bracket check failed',file.stem,getattr(e,'code',type(e).__name__),flush=True)
        time.sleep(5)

if __name__=='__main__': main()
