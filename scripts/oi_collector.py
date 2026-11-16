"""Sample only the configured Bybit contracts, preserving upstream decimal strings."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import os
import re
import time


def bounded(name, default, minimum, maximum):
    try: value=int(os.getenv(name,str(default)))
    except ValueError: value=default
    return max(minimum,min(maximum,value))


def run_collector(fetch_provider, cloud):
    symbols = list(dict.fromkeys(
        coin if coin.endswith('USDT') else coin+'USDT'
        for raw in os.getenv('QUANTOS_OI_SYMBOLS','BTC,ETH,SOL,ZEC,NEAR').upper().split(',')
        if re.fullmatch(r'[A-Z0-9]{1,16}',coin:=raw.strip())
    ))[:10]
    if not symbols: return
    interval=bounded('QUANTOS_OI_INTERVAL_MINUTES',15,5,60)*60
    upload_retry=None
    last_slot=-1

    def sample(symbol):
        target='/v5/market/tickers?category=linear&symbol='+symbol
        status,body=fetch_provider('bybit',target)
        fetched_at=time.time_ns()//1_000_000
        if status!=200:
            return None
        try:
            data=json.loads(body)
            row=data['result']['list'][0]
            if data['retCode']!=0 or row['symbol']!=symbol: return None
            return dict(symbol=symbol,open_interest=row['openInterest'],
                        open_interest_value=row.get('openInterestValue') or None,
                        mark_price=row.get('markPrice') or None,source_timestamp=int(data['time']),fetched_at=fetched_at)
        except (KeyError,IndexError,TypeError,ValueError): return None

    with ThreadPoolExecutor(max_workers=3) as pool:
        while True:
            slot=int(time.time())//interval
            if slot!=last_slot:
                last_slot=slot
                upload_retry=[row for row in pool.map(sample,symbols) if row is not None]
            if upload_retry:
                try:
                    with cloud('oi',json.dumps(upload_retry,separators=(',',':')).encode(),timeout=9) as response:
                        stats=json.load(response)['data']
                    print('oi batch UTC',datetime.now(timezone.utc).isoformat(),'samples',len(upload_retry),
                          'failed',len(symbols)-len(upload_retry),'D1 writes',stats['writes'],flush=True)
                    upload_retry=None
                except Exception as error:
                    print('oi upload:',type(error).__name__,getattr(error,'code',''),flush=True)
                    time.sleep(30)
                    continue
            elif upload_retry==[]:
                print('oi batch: no source samples',flush=True)
                upload_retry=None
            time.sleep(max(1,(last_slot+1)*interval-time.time()))
