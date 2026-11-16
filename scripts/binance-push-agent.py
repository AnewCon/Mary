import hashlib,hmac,json,time,urllib.request,urllib.error,urllib.parse,os
from decimal import Decimal
from pathlib import Path
from binance_history import account_history
from binance_limit_lifecycle import Lifecycle

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

def snapshot(include_history=False, reset_at=0):
    account=exchange('/fapi/v3/account')
    positions=exchange('/fapi/v3/positionRisk')
    if not isinstance(account.get('assets'),list) or not isinstance(positions,list):
        raise ValueError('Invalid account snapshot')
    positions=[p for p in positions if Decimal(p['positionAmt'])!=0]
    data={'account':{'assets':[a for a in account['assets'] if a['asset']=='USDT']},'positions':positions}
    if include_history:
        try:
            data['ledger']=account_history(lambda params: exchange('/fapi/v1/income',params=params), reset_at)
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

def order_context(symbol, direction):
    if direction not in {'LONG','SHORT'}:
        raise Upstream('INVALID_ACTION')
    mode=exchange('/fapi/v1/positionSide/dual')
    hedge=mode.get('dualSidePosition') if isinstance(mode,dict) else None
    if type(hedge) is not bool:
        raise Upstream('POSITION_MODE_UNAVAILABLE')
    position_side=direction if hedge else 'BOTH'
    allowed_sides={'LONG','SHORT'} if hedge else {'BOTH'}
    positions=exchange('/fapi/v3/positionRisk',params={'symbol':symbol})
    active=[p for p in positions if p['symbol']==symbol and Decimal(p['positionAmt'])!=0]
    if any(p.get('positionSide') not in allowed_sides for p in active):
        raise Upstream('POSITION_MODE_MISMATCH')
    position=next((p for p in active if p['positionSide']==position_side and
                   (hedge or (Decimal(p['positionAmt'])>0)==(direction=='LONG'))),None)
    return hedge,position_side,position,bool(active)


def execute(job):
    action=job['action']
    kind=action['kind']
    symbol=action['symbol']

    if kind=='limit' and not job.get('bracketEntry'):
        raise Upstream('DEMO_LIMIT_REQUIRES_BRACKET')
    if kind=='open' and lifecycle().blocked():
        raise Upstream('DEMO_PROTECTION_RISK_BLOCK')
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
    hedge,position_side,position,has_positions=order_context(symbol,side)
    params={'symbol':symbol,'positionSide':position_side,'type':'MARKET','newClientOrderId':'qos_'+job['id'],'newOrderRespType':'RESULT'}

    if kind=='protect':
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
        if not hedge and has_positions and not position: raise Upstream('OPPOSITE_POSITION')
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

def lifecycle():
    return Lifecycle(spool.parent/'brackets',exchange,order_context,
                     lambda id,result: cloud('result',{'id':id,'state':'acknowledged','result':result}),Upstream)


def bracket_entry(job):
    if os.getenv('QUANTOS_DEMO_LIMIT_ENABLED')!='true':
        raise Upstream('DEMO_LIMIT_VALIDATION_GATE')
    action=job['action']
    symbol=action['symbol']
    manager=lifecycle()
    if manager.blocked():
        raise Upstream('DEMO_PROTECTION_RISK_BLOCK')
    if any(json.loads(file.read_text())['action']['symbol']==symbol for file in manager.files()):
        raise Upstream('BRACKET_ALREADY_ACTIVE')
    _,_,_,active=order_context(symbol,action['side'])
    if active:
        raise Upstream('BRACKET_REQUIRES_FLAT_SYMBOL')
    if exchange('/fapi/v1/openOrders',params={'symbol':symbol}) or exchange('/fapi/v1/openAlgoOrders',params={'symbol':symbol}):
        raise Upstream('BRACKET_REQUIRES_NO_OPEN_ORDERS')
    return manager.begin(job,execute)


def process(job):
    result={'id':job['id']}
    try: result.update(state='acknowledged',result=bracket_entry(job) if job['action']['kind']=='bracket' else execute(job))
    except Upstream as e:
        certain=(isinstance(e.code,int) and e.code not in {-1000,-1001,-1006,-1007}) or e.code in {'DEMO_LIMIT_VALIDATION_GATE','DEMO_LIMIT_REQUIRES_BRACKET','DEMO_PROTECTION_RISK_BLOCK','POSITION_CHANGED','POSITION_MODE_UNAVAILABLE','POSITION_MODE_MISMATCH','QUANTITY_TOO_SMALL','OPPOSITE_POSITION','INVALID_ACTION','CONTRACT_NOT_FOUND','ORDER_SYMBOL_MISMATCH','PROTECTION_ALREADY_EXISTS','BRACKET_ALREADY_ACTIVE','BRACKET_REQUIRES_FLAT_SYMBOL','BRACKET_REQUIRES_NO_OPEN_ORDERS'}
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
    recover_legacy=True
    live_due=0
    mode='paused'
    reset_at=0
    marker=spool.with_name('sync-active')
    while True:
        current=time.monotonic()
        if current>=live_due:
            live_due=current+300
            try: live_snapshot()
            except Exception as e: print('live read failed',getattr(e,'code',type(e).__name__),flush=True)
        if current>=config_due:
            try:
                settings=cloud('sync-mode',{})
                next_mode=settings['mode']
                next_reset=settings.get('todayResetAt',0)
                if next_reset!=reset_at:
                    reset_at=next_reset
                    due=history_due=0
                if next_mode!=mode: due=0
                mode=next_mode
                if recover_legacy:
                    manager=lifecycle()
                    for job in cloud('legacy-limits',{}):
                        file=manager.folder/(job['id']+'.json')
                        if not file.exists(): atomic_json(file,job)
                    recover_legacy=False
            except Exception as e:
                print('sync configuration failed',getattr(e,'code',type(e).__name__),flush=True)
            config_due=current+60
        if current>=due and mode!='paused' and (bootstrap or mode=='always' or mode=='on_open' and marker.exists()):
            try:
                active=snapshot(current>=history_due, reset_at)
                if bootstrap and active: marker.touch()
                bootstrap=False
                if current>=history_due: history_due=current+300
                if mode=='on_open' and not active and not exchange('/fapi/v1/openOrders'):
                    marker.unlink(missing_ok=True)
                print('snapshot uploaded',flush=True)
            except Exception as e:
                print('snapshot failed',getattr(e,'code',type(e).__name__),flush=True)
            due=time.monotonic()+60
        if time.monotonic()>=bracket_due:
            bracket_due=time.monotonic()+5
            manager=lifecycle()
            unsent=json.loads(spool.read_text()).get('id') if spool.exists() else None
            for file in manager.files():
                if file.stem==unsent:
                    try: manager.poll(file,publish=False)
                    except Exception as e: print('limit lifecycle check failed',file.stem,type(e).__name__,flush=True)
                    continue
                try: manager.poll(file)
                except Exception as e:
                    print('limit lifecycle check failed',file.stem,getattr(e,'code',type(e).__name__),flush=True)
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
                            reset_at=cloud('sync-mode',{}).get('todayResetAt',0)
                            active=snapshot(True, reset_at)
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
        time.sleep(5)

if __name__=='__main__': main()
