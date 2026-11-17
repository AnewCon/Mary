import { Failure } from './exchange';
const intervals={ '1m':60000,'5m':300000,'15m':900000,'1h':3600000 };
type Interval=keyof typeof intervals;
const day=86400000;
const promises=new Map<string,{until:number;value:Promise<unknown>}>();
function cached<T>(key:string,ttl:number,read:()=>Promise<T>):Promise<T>{
 const previous=promises.get(key);
 if(previous&&previous.until>Date.now())return previous.value as Promise<T>;
 if(promises.size>=70)promises.delete(promises.keys().next().value!);
 const value=read().catch(error=>{if(promises.get(key)?.value===value)promises.delete(key);throw error;});
 promises.set(key,{until:Date.now()+ttl,value});
 return value;
}
async function upstream(relay:DurableObjectStub,path:string){
 const result=await relay.fetch('https://market-relay.internal/request',{method:'POST',
  headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'grid_binance_public',target:path})});
 if(!result.ok)throw new Failure('GRID_BINANCE_HTTP_'+result.status,502);
 try{return await result.json();}catch{throw new Failure('GRID_INVALID_UPSTREAM',502);}
}
const query=(path:string,params:Record<string,string|number>)=>'/fapi/v1/'+path+'?'+new URLSearchParams(Object.entries(params).map(([key,value])=>[key,String(value)]));
const integer=(q:URLSearchParams,key:string)=>/^\d{13}$/.test(q.get(key)??'')?Number(q.get(key)):NaN;
export async function gridMarket(q:URLSearchParams,relay:DurableObjectStub,now=Date.now()){
 const symbol=(q.get('symbol')??'').trim().toUpperCase();
 if(!/^[A-Z0-9]{2,20}USDT$/.test(symbol))throw new Failure('GRID_INVALID_SYMBOL');
 const interval=(q.get('interval')??'15m') as Interval;
 if(!Object.hasOwn(intervals,interval))throw new Failure('GRID_INVALID_INTERVAL');
 const step=intervals[interval],from=integer(q,'from'),requested=integer(q,'to');
 if(!Number.isSafeInteger(from)||!Number.isSafeInteger(requested)||requested<=from||from>=now||requested-from>(interval==='1m'?7:31)*day)
  throw new Failure('GRID_INVALID_RANGE');
 const end=Math.floor(Math.min(now,requested)/step)*step;
 const rules=await cached('contract:'+symbol,300000,async()=>{
  const data:any=await cached('exchangeInfo',300000,()=>upstream(relay,'/fapi/v1/exchangeInfo'));
  const contract=data?.symbols?.find((item:any)=>item.symbol===symbol);
  if(!contract||contract.contractType!=='PERPETUAL'||contract.quoteAsset!=='USDT'||contract.marginAsset!=='USDT')
   throw new Failure('GRID_SYMBOL_NOT_FOUND',404);
  const pick=(name:string)=>contract.filters?.find((item:any)=>item.filterType===name);
  const lot=pick('LOT_SIZE'),marketLot=pick('MARKET_LOT_SIZE'),price=pick('PRICE_FILTER'),min=pick('MIN_NOTIONAL');
  const tick=String(price?.tickSize??''),quantityStep=String(lot?.stepSize??'');
  const minQty=Number(lot?.minQty),maxQty=Number(lot?.maxQty);
  const minNotional=Number(min?.notional),minPrice=Number(price?.minPrice),maxPrice=Number(price?.maxPrice);
  const marketMinQty=Number(marketLot?.minQty??minQty);
  if(![Number(tick),Number(quantityStep),minQty,maxQty,minNotional,maxPrice].every(v=>Number.isFinite(v)&&v>0)||
   ![minPrice,marketMinQty].every(v=>Number.isFinite(v)&&v>=0))throw new Failure('GRID_INVALID_FILTERS',502);
  return {symbol,status:String(contract.status),onboard:Number(contract.onboardDate)||0,tick,quantityStep,minQty,maxQty,minNotional,minPrice,maxPrice,marketMinQty};
 });
 if(rules.status!=='TRADING')throw new Failure('GRID_CONTRACT_NOT_TRADING',409);
 const start=Math.ceil(Math.max(from,rules.onboard)/step)*step;
 if(start>=end)throw new Failure('GRID_NO_CLOSED_CANDLES',404);
 const output=await cached('candles:'+symbol+':'+interval+':'+start+':'+end,end<now-step?3600000:45000,async()=>{
  const markers=new Map<number,{time:number;open:number;high:number;low:number;close:number;volume:number}>();
  const pageSize=1000;
  for(let page=start;page<end;page+=step*pageSize){
   const stop=Math.min(end,page+step*pageSize);
   const rows=await upstream(relay,query('klines',{symbol,interval,startTime:page,endTime:stop-1,limit:pageSize}));
   if(!Array.isArray(rows))throw new Failure('GRID_INVALID_KLINES',502);
   for(const row of rows){
    if(!Array.isArray(row)||row.length<7)throw new Failure('GRID_INVALID_KLINES',502);
    const [time,open,high,low,close,volume]=row.slice(0,6).map(Number);
    if(time<page||time>=stop||time%step||Number(row[6])!==time+step-1||![open,high,low,close].every(x=>Number.isFinite(x)&&x>0)||
     !Number.isFinite(volume)||volume<0||low>Math.min(open,close)||high<Math.max(open,close))throw new Failure('GRID_INVALID_KLINES',502);
    markers.set(time,{time,open,high,low,close,volume});
   }
  }
  if(markers.size!==(end-start)/step)throw new Failure('GRID_KLINE_GAPS',502);
  return Array.from(markers.values()).sort((a,b)=>a.time-b.time);
 });
 let funding:{time:number;rate:number;mark:number|null}[]|null=null;
 if(q.get('funding')==='1'){
  funding=await cached('funding:'+symbol+':'+start+':'+end,600000,async()=>{
   const rows=await upstream(relay,query('fundingRate',{symbol,startTime:start,endTime:end-1,limit:1000}));
   if(!Array.isArray(rows)||rows.length===1000)throw new Failure('GRID_FUNDING_UNAVAILABLE',502);
   const entries=rows.map(row=>({time:Number(row.fundingTime),rate:Number(row.fundingRate),mark:Number(row.markPrice)||null}));
   if(entries.some(r=>!Number.isSafeInteger(r.time)||r.time<start||r.time>=end||!Number.isFinite(r.rate)))throw new Failure('GRID_FUNDING_UNAVAILABLE',502);
   if(new Set(entries.map(r=>r.time)).size!==entries.length)throw new Failure('GRID_FUNDING_UNAVAILABLE',502);
   return entries.sort((a,b)=>a.time-b.time);
  });
 }
 return {symbol,exchange:'Binance USDⓈ-M',interval,step,requestedFrom:from,from:start,to:end,rules,candles:output,funding};
}
