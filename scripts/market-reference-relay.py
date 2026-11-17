"""Read-only market data relay. The only public routes are fixed provider reads."""
import hmac
from concurrent.futures import ThreadPoolExecutor
from threading import Thread, Lock
from oi_collector import run_collector, bounded
import json
from pathlib import Path
import re
import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import build_opener, HTTPRedirectHandler, ProxyHandler, Request

TOKEN = Path('/etc/quantos-market-relay/token').read_text().strip()
ORIGINS = {
    'blockmetric': 'https://api.blockmetric.io',
    'marginpad': 'https://marginpad.io',
    'coingecko': 'https://api.coingecko.com',
    'bybit': 'https://api.bybit.com',
    'binance_demo_public': 'https://demo-fapi.binance.com',
}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


opener = build_opener(ProxyHandler({}), NoRedirect())


def allowed(provider, target):
    url = urlsplit(target)
    if url.scheme or url.netloc or url.fragment:
        return False
    rules = {
        'blockmetric': (r'/v1/heatmap/[A-Z0-9]{1,20}', {'tf', 'hours'}),
        'marginpad': (r'/api/v1/liquidations/live', {'symbol', 'limit'}),
        'coingecko': (r'/api/v3/coins/markets', {'vs_currency', 'order', 'sparkline', 'per_page'}),
        'binance_demo_public': (r'/fapi/v1/(?:klines|time)', {'symbol', 'interval', 'limit'}),
        'bybit': (r'/v5/market/(?:tickers|account-ratio)', {'category', 'symbol', 'period', 'limit'}),
    }
    if provider not in rules:
        return False
    path, keys = rules[provider]
    params = parse_qs(url.query, keep_blank_values=True, max_num_fields=6)
    if provider=='binance_demo_public':
        if url.path=='/fapi/v1/time': return not params
        if url.path!='/fapi/v1/klines' or set(params)!={'symbol','interval','limit'}: return False
        if params['interval'] not in (['1m'],['5m']) or params['limit'] not in (['3'],['16'],['17']): return False
        if not re.fullmatch(r'[A-Z0-9]{2,20}USDT',params['symbol'][0]): return False
    return bool(re.fullmatch(path, url.path)) and all(
        key in keys and len(values) == 1 and re.fullmatch(r'[A-Za-z0-9_]{1,30}', values[0])
        for key, values in params.items())


CLOUD='https://marya-4j3.pages.dev/api/market-agent/'


def provider_request(provider,target):
    if not allowed(provider,target):
        return 400,b'{"error":"INVALID_MARKET_ROUTE"}'
    headers={'Accept':'application/json','User-Agent':'QuantOS-Market/1.0'}
    if provider=='blockmetric': headers['X-Blockmetric-Access']='public'
    try:
        with opener.open(Request(ORIGINS[provider]+target,headers=headers),timeout=6) as response:
            body=response.read(2_500_001)
        if len(body)>2_500_000:
            return 502,b'{"error":"MARKET_RESPONSE_TOO_LARGE"}'
        return 200,body
    except HTTPError as error:
        return error.code if error.code>=400 else 502,b'{"error":"PROVIDER_HTTP_FAILURE"}'
    except (OSError,URLError,TimeoutError):
        return 502,b'{"error":"PROVIDER_UNREACHABLE"}'


budget_lock=Lock()
budget_day=None
counts={}
daily_budget=bounded('QUANTOS_MARKET_DAILY_REQUESTS',3500,500,10000)


def fetch_provider(provider,target):
    global budget_day
    day=int(time.time())//86400
    with budget_lock:
        if budget_day!=day:
            if counts: print('market UTC daily metrics',json.dumps(counts),flush=True)
            counts.clear()
            budget_day=day
        if sum(entry['requests'] for entry in counts.values())>=daily_budget:
            return 429,b'{"error":"DAILY_MARKET_BUDGET_EXHAUSTED"}'
        entry=counts.setdefault(provider,dict(requests=0,errors=0,request_target_bytes=0,response_payload_bytes=0))
        entry['requests']+=1
        entry['request_target_bytes']+=len(target.encode())
    status,body=provider_request(provider,target)
    with budget_lock:
        entry['errors']+=int(status!=200)
        entry['response_payload_bytes']+=len(body)
    return status,body


def cloud(path,body,headers=None,timeout=25):
    return opener.open(Request(CLOUD+path,data=body,method='POST',
        headers={'Authorization':'Bearer '+TOKEN,'Content-Type':'application/json','User-Agent':'QuantOS-VPS/1.0',**(headers or {})}),timeout=timeout)


def work(job):
    try:
        status,body=fetch_provider(job['provider'],job['target'])
        if status in {502,503,504}:
            status,body=fetch_provider(job['provider'],job['target'])
        with cloud('result',body,{'X-QuantOS-Market-Id':job['id'],'X-QuantOS-Market-Status':str(status)},timeout=6):
            pass
    except Exception as error:
        print('market result delivery:',type(error).__name__,getattr(error,'code',''),flush=True)


def main():
    if len(TOKEN)<40:
        raise ValueError('Missing market relay token')
    Thread(target=run_collector,args=(fetch_provider,cloud),daemon=True,name='oi-collector').start()
    with ThreadPoolExecutor(max_workers=6) as pool:
        from threading import BoundedSemaphore
        capacity=BoundedSemaphore(6)
        def run(job):
            try: work(job)
            finally: capacity.release()
        while True:
            capacity.acquire()
            try:
                with cloud('poll',b'{}') as response:
                    job=json.load(response) if response.status==200 else None
            except Exception as error:
                capacity.release()
                print('market poll:',type(error).__name__,getattr(error,'code',''),flush=True)
                time.sleep(3)
                continue
            if job: pool.submit(run,job)
            else: capacity.release()


if __name__=='__main__':
    main()
