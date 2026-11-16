import { Failure } from './exchange';
import { marketReference } from './market-reference';
import { contract, oiHistory } from './oi-history';
import { signal25 } from './signal-v25';

const sections={derivatives:'derivatives',oi_history:'oi_history',liquidation_heatmap:'heatmap',recent_liquidations:'liquidations'} as const;
type Section = keyof typeof sections;

export async function analyzeMarket(db:D1Database,body:unknown,context:ExecutionContext,relay:DurableObjectStub,interval:number,config?:string,cacheConfig?:string) {
  const input=body as {symbol?:string;include?:unknown;candles?:unknown;flow?:unknown}|null;
  const symbol=contract(input?.symbol);
  const coin=symbol.slice(0,-4);
  const include=input?.include??Object.keys(sections);
  if(!Array.isArray(include)||include.length<1||include.length>4||include.some(key=>typeof key!=='string'||!Object.hasOwn(sections,key)))
    throw new Failure('INVALID_MARKET_SECTIONS');
  const selected=[...new Set(include)] as Section[];
  const records=await Promise.all(selected.map(async key=>{
    let data: any;
    const label={derivatives:'Bybit',oi_history:'Bybit / QuantOS D1',liquidation_heatmap:'Blockmetric',recent_liquidations:'MarginPad'}[key];
    const layer=key==='oi_history'?'derived':key==='liquidation_heatmap'?'estimated':'observed';
    try {
      data=key==='oi_history'?await oiHistory(db,symbol,interval):await marketReference(
        new URL('https://quantos.internal/api/market/'+sections[key]+'?symbol='+coin+(key==='recent_liquidations'?'&limit=12':'')),context,relay,cacheConfig);
      const asOf=data.asOf??data.latest?.time??data.events?.[0]?.ts??null;
      const stamp=typeof asOf==='string'?Date.parse(asOf):asOf;
      const maxAge=key==='liquidation_heatmap'?7200000:key==='derivatives'?180000:key==='recent_liquidations'?3600000:interval*120000;
      const state=data.status??(key==='liquidation_heatmap'&&!data.latest||key==='recent_liquidations'&&!data.events.length?'EMPTY':
        !stamp?'UNKNOWN_TIME':Date.now()-stamp>maxAge?'STALE':'OK');
      return {key,layer,source:data.source??label,asOf,fetchedAt:data.fetchedAt??null,status:state,data};
    } catch (error) {
      return {key,layer,source:label,status:'ERROR',asOf:null,fetchedAt:null,error:error instanceof Failure?error.code:'MARKET_UNAVAILABLE'};
    }
  }));
  const dictionary=Object.fromEntries(records.map(record=>[record.key,record]));
  const entries=dictionary.recent_liquidations?.data?.events??[];
  const usd=(side:string)=>entries.filter((row:any)=>row.side===side).reduce((total:number,row:any)=>{
    const n=Number(row.notional);return total+(Number.isFinite(n)&&n>0?n:0);
  },0);
  return {symbol,asOf:new Date().toISOString(),status:records.every(r=>r.status==='OK')?'OK':'PARTIAL',
    observed:records.filter(r=>r.layer==='observed'),estimated:records.filter(r=>r.layer==='estimated'),
    derived:{oiHistory:dictionary.oi_history??null,liquidationSample:dictionary.recent_liquidations?{
      source:'MarginPad',asOf:dictionary.recent_liquidations.asOf,fetchedAt:dictionary.recent_liquidations.fetchedAt,
      status:dictionary.recent_liquidations.status,data:entries.length?{count:entries.length,longUsd:usd('long_liquidated'),shortUsd:usd('short_liquidated')}:null
    }:null},
    interpretation:signal25(input?.candles,input?.flow,dictionary,config)};
}
