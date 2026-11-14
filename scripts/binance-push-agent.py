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

def exchange(path,method='GET',params=None):
    params=dict(params or {})
    headers={}
    if path!='/fapi/v1/exchangeInfo':
        params.update(timestamp=int(time.time()*1000),recvWindow=5000)
        query=urllib.parse.urlencode(params)
        params['signature']=hmac.new(config['secret'].encode(),query.encode(),hashlib.sha256).hexdigest()
        headers['X-MBX-APIKEY']=config['key']
    result=request(demo+path+'?'+urllib.parse.urlencode(params),headers,method)
    if isinstance(result,dict) and isinstance(result.get('code'),int) and result['code']<0:
        raise Upstream(result['code'])
    return result

def snapshot():
    account=exchange('/fapi/v3/account')
    positions=exchange('/fapi/v3/positionRisk')
    if not isinstance(account.get('assets'),list) or not isinstance(positions,list):
        raise ValueError('Invalid account snapshot')
    return cloud('snapshot',{'account':{'assets':[a for a in account['assets'] if a['asset']=='USDT']},
        'positions':[p for p in positions if Decimal(p['positionAmt'])!=0]})

def execute(job):
    action=job['action']
    kind=action['kind']
    symbol=action['symbol']

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

def process(job):
    result={'id':job['id']}
    try: result.update(state='acknowledged',result=execute(job))
    except Upstream as e:
        certain=(isinstance(e.code,int) and e.code not in {-1000,-1001,-1006,-1007}) or e.code in {'POSITION_CHANGED','QUANTITY_TOO_SMALL','OPPOSITE_POSITION','INVALID_ACTION','CONTRACT_NOT_FOUND','ORDER_SYMBOL_MISMATCH','PROTECTION_ALREADY_EXISTS'}
        result.update(state='rejected' if certain else 'unknown',result={'code':str(e.code)})
    except Exception: result.update(state='unknown',result={'code':'VERIFY_BINANCE_BEFORE_RETRY'})
    tmp=spool.with_suffix('.tmp')
    tmp.write_text(json.dumps(result))
    os.replace(tmp,spool)

def main():
    due=0
    while True:
        if time.monotonic()>=due:
            try:
                snapshot()
                print('snapshot uploaded',flush=True)
            except Exception as e:
                print('snapshot failed',getattr(e,'code',type(e).__name__),flush=True)
            due=time.monotonic()+60
        try:
            if spool.exists():
                cloud('result',json.loads(spool.read_text()))
                spool.unlink()
                due=0
            else:
                job=cloud('claim',{})
                if job: process(job)
        except Exception as e:
            print('queue operation failed',getattr(e,'code',type(e).__name__),flush=True)
        time.sleep(5)

if __name__=='__main__': main()
