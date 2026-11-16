import { Failure } from './exchange';

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const rows = (value: unknown, source: string) => {
  if (!Array.isArray(value) || !value.every(isRow)) throw new Failure(source + '_INVALID_RESPONSE', 502);
  return value;
};
const select = (row: Row, fields: string[]) => Object.fromEntries(fields.flatMap(key =>
  ['number','string','boolean'].includes(typeof row[key]) || row[key] === null ? [[key,row[key]]] : []));
const count = (u: URL, fallback: number, max: number) => {
  const raw = u.searchParams.get('limit');
  if (raw === null) return fallback;
  if (!/^\d{1,3}$/.test(raw) || Number(raw)<1 || Number(raw)>max) throw new Failure('MARKET_INVALID_LIMIT');
  return Number(raw);
};
const symbol = (u: URL) => {
  const value = (u.searchParams.get('symbol') ?? '').toUpperCase();
  if (!/^[A-Z0-9]{1,20}$/.test(value)) throw new Failure('MARKET_INVALID_SYMBOL');
  return value;
};

async function upstream(relay: DurableObjectStub, source: string, url: string): Promise<unknown> {
  let response: Response;
  try {
    const target=new URL(url);
    response = await relay.fetch('https://market-relay.internal/request',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({provider:source.toLowerCase(),target:target.pathname+target.search}),
    });
  } catch { throw new Failure(source+'_UNREACHABLE',502); }
  if (!response.ok) throw new Failure(source+'_HTTP_'+response.status,502);
  try { return await response.json(); }
  catch { throw new Failure(source+'_INVALID_RESPONSE',502); }
}

async function heatmap(relay: DurableObjectStub, coin: string, limit: number) {
  const value = await upstream(relay,'BLOCKMETRIC','https://api.blockmetric.io/v1/heatmap/'+coin+'?tf=1h&hours=24') as {data?: Row;meta?: Row};
  const data = value?.data;
  if (!data || !Array.isArray(data.times) || !Array.isArray(data.prices) || !Array.isArray(data.longCells) || !Array.isArray(data.shortCells))
    throw new Failure('BLOCKMETRIC_INVALID_RESPONSE',502);
  const {times,prices,longCells,shortCells} = data;
  const snapshot = Array.isArray(data.hasSnapshot) ? data.hasSnapshot : [];
  const coverage = Array.isArray(data.columnSource) ? data.columnSource : [];
  const mark = Array.isArray(data.mark) ? data.mark : [];
  const available = times.map((_, i)=>i).filter(i=> snapshot[i] !== false && Array.isArray(longCells[i]) && Array.isArray(shortCells[i]) && typeof mark[i] === 'number');
  const top = (cell: unknown[], n: number) => cell.flatMap((amount, i)=>
    typeof amount === 'number' && amount > 0 && typeof prices[i] === 'number' ? [{bucketLowUsd:prices[i],estimatedUsd:amount}] : [])
    .sort((a,b)=>b.estimatedUsd-a.estimatedUsd).slice(0,n);
  const column = (i: number,n: number)=>({time:times[i], markPriceUsd:mark[i], coverage:coverage[i] ?? null,
    long:top(longCells[i],n), short:top(shortCells[i],n)});
  const latest = available.at(-1);
  return {source:'Blockmetric',attribution:'Data by Blockmetric',sourceUrl:'https://blockmetric.io/docs/api/heatmap-coin',
    coin, type:'estimated_liquidation_zones', coverage:'Hyperliquid positions covered by Blockmetric', bucketSizeUsd:data.bucketSize,
    latest:latest===undefined?null:column(latest,limit),
    history:available.filter(i=>i!==latest).slice(-6).map(i=>column(i,3))};
}

async function liquidations(relay: DurableObjectStub, coin: string, limit: number) {
  const value=await upstream(relay,'MARGINPAD','https://marginpad.io/api/v1/liquidations/live?symbol='+coin+'&limit='+limit);
  const list=Array.isArray(value)?value:isRow(value)?value.events??value.data:undefined;
  const events=rows(list,'MARGINPAD').slice(0,limit).map(row=>select(row,['ts','timestamp','time','exchange','symbol','side','price','qty','notional']));
  return {source:'MarginPad',sourceUrl:'https://marginpad.io/trading-api/',type:'observed_liquidation_events',coin, events,
    scope:'Recent returned events only; coverage and availability vary by coin.'};
}

async function market(relay: DurableObjectStub, limit: number) {
  const data=rows(await upstream(relay,'COINGECKO','https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&sparkline=false&per_page='+limit),'COINGECKO');
  return {source:'CoinGecko',sourceUrl:'https://docs.coingecko.com/reference/coins-markets',type:'market_cap_ranked_performance',
    quote:'USD', coins:data.map(row=>select(row,['id','symbol','name','last_updated','market_cap_rank','market_cap','total_volume','current_price','price_change_percentage_24h']))};
}

async function bybitData(relay: DurableObjectStub, path: string, ticker: string, parameters='') {
  const value = await upstream(relay,'BYBIT','https://api.bybit.com/v5/market/'+path+'?category=linear&symbol='+ticker+parameters);
  if (!isRow(value) || value.retCode!==0 || !isRow(value.result)) throw new Failure('BYBIT_MARKET_UNAVAILABLE',502);
  return {list:rows(value.result.list,'BYBIT'),time:value.time};
}

async function derivatives(relay: DurableObjectStub, input: string) {
  const ticker=input.endsWith('USDT')?input:input+'USDT';
  const [quote,ratio]=await Promise.allSettled([bybitData(relay,'tickers',ticker),bybitData(relay,'account-ratio',ticker,'&period=1h&limit=1')]);
  if (quote.status==='rejected') throw quote.reason;
  const row=quote.value.list[0];
  if (!row) throw new Failure('BYBIT_SYMBOL_NOT_FOUND',404);
  const ratioRow=ratio.status==='fulfilled'?ratio.value.list[0]:undefined;
  return {source:'Bybit',sourceUrl:'https://bybit-exchange.github.io/docs/v5/market/tickers',symbol:ticker,
    asOf:quote.value.time, scope:'Bybit USDT linear futures',
    ticker:select(row,['lastPrice','markPrice','openInterest','openInterestValue','fundingRate','nextFundingTime','turnover24h','price24hPcnt']),
    accountRatio:ratioRow?select(ratioRow,['buyRatio','sellRatio','timestamp']):null,
    ratioPeriod:'1h', ratioError:ratio.status==='rejected'?(ratio.reason instanceof Failure?ratio.reason.code:'BYBIT_RATIO_UNAVAILABLE'):undefined};
}

export async function marketReference(u: URL, context: ExecutionContext, relay: DurableObjectStub, cacheConfig?:string) {
  const kind=u.pathname.split('/').at(-1);
  const coin=kind==='overview'?'':symbol(u);
  const limit=kind==='overview'?count(u,20,50):kind==='liquidations'?count(u,20,50):kind==='heatmap'?count(u,6,12):0;
  const providers: Record<string,()=>Promise<unknown>> = {
    heatmap:()=>heatmap(relay,coin,limit), liquidations:()=>liquidations(relay,coin,limit), overview:()=>market(relay,limit), derivatives:()=>derivatives(relay,coin)
  };
  if (!kind || !Object.hasOwn(providers,kind)) throw new Failure('NOT_FOUND',404);
  const key = new Request('https://quantos.313919971.workers.dev/.market-cache/v3/'+kind+'/'+coin+'/'+limit);
  const cache = (caches as CacheStorage & {default:Cache}).default;
  const existing = await cache.match(key).catch(()=>null);
  if (existing) {
    console.log('market_cache',kind,'hit');
    return existing.json();
  }
  const started=Date.now();
  try{
    const data=await providers[kind]();
    const output={fetchedAt:new Date().toISOString(),...data as Row};
    const defaults=kind==='liquidations'?20:kind==='heatmap'?120:60;
    let ttl=defaults;
    try{
      const value=JSON.parse(cacheConfig??'{}')[kind];
      if(Number.isInteger(value)&&value>=10&&value<=300)ttl=value;
    }catch{/* Keep the endpoint default. */}
    const payload=JSON.stringify(output);
    console.log('market_cache',kind,'miss',new TextEncoder().encode(payload).byteLength,Date.now()-started);
    context.waitUntil(cache.put(key,new Response(payload,{headers:{'Content-Type':'application/json','Cache-Control':'public, max-age='+ttl}})).catch(()=>{}));
    return output;
  }catch(error){
    console.log('market_cache',kind,'error',error instanceof Failure?error.code:'MARKET_UNAVAILABLE',Date.now()-started);
    throw error;
  }
}
