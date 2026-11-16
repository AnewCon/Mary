import { Failure } from './exchange';

export const windows = {'15m':900000,'1h':3600000,'4h':14400000,'24h':86400000} as const;
const source='Bybit USDT linear';
const decimal=/^\d{1,28}(?:\.\d{1,24})?$/;
const quantity=(n:unknown): n is string => typeof n==='string'&&decimal.test(n);
export const contract=(symbol: unknown) => {
  const ticker=typeof symbol==='string'?symbol.toUpperCase():'';
  if(!/^[A-Z0-9]{1,20}$/.test(ticker))throw new Failure('MARKET_INVALID_SYMBOL');
  return ticker.endsWith('USDT')?ticker:ticker+'USDT';
};

type Sample={
  symbol:string;open_interest:string;open_interest_value:string|null;mark_price:string|null;
  source_timestamp:number;fetched_at:number;
};

export async function ingestOI(db:D1Database,input:unknown,intervalMinutes=15) {
  if(!Array.isArray(input)||input.length>100)throw new Failure('OI_INVALID_BATCH');
  const now=Date.now();
  const statements=input.map((row:Sample)=>{
    if(!row||typeof row.symbol!=='string'||row.symbol!==contract(row.symbol)||
      !quantity(row.open_interest)||!([row.open_interest_value,row.mark_price].every(x=>x===null||quantity(x)))||
      !Number.isSafeInteger(row.source_timestamp)||row.source_timestamp<=0||row.source_timestamp>now||
      !Number.isSafeInteger(row.fetched_at)||row.fetched_at<row.source_timestamp||row.fetched_at>now+30000)
      throw new Failure('OI_INVALID_SAMPLE');
    return db.prepare(`INSERT OR IGNORE INTO oi_snapshots(exchange,symbol,open_interest,open_interest_value,mark_price,
      source_timestamp,fetched_at,created_at,sample_slot) VALUES('bybit',?,?,?,?,?,?,?,?)`)
      .bind(row.symbol,row.open_interest,row.open_interest_value,row.mark_price,row.source_timestamp,row.fetched_at,now,Math.floor(row.fetched_at/(intervalMinutes*60000))*intervalMinutes*60000);
  });
  const result=statements.length?await db.batch(statements):[];
  return {accepted:input.length,writes:result.reduce((sum,row)=>sum+row.meta.changes,0)};
}

export async function pruneOI(db:D1Database,days:number) {
  const result=await db.prepare('DELETE FROM oi_snapshots WHERE source_timestamp<?').bind(Date.now()-days*86400000).run();
  return result.meta.changes;
}

export function change(current:string,older:string):number|null {
  const precision=Math.max(current.split('.')[1]?.length??0,older.split('.')[1]?.length??0);
  const integer=(s:string)=>{const [whole,fraction='']=s.split('.');return BigInt(whole+fraction.padEnd(precision,'0'));};
  const baseline=integer(older);
  if(baseline===0n)return null;
  return Number((integer(current)-baseline)*100000000n/baseline)/1000000;
}

export async function oiHistory(db:D1Database,input:unknown,intervalMinutes=15,now=Date.now()) {
  const symbol=contract(input);
  const query=(end:number)=>db.prepare(`SELECT symbol,open_interest,open_interest_value,mark_price,source_timestamp,fetched_at
    FROM oi_snapshots WHERE exchange='bybit' AND symbol=? AND source_timestamp<=? ORDER BY source_timestamp DESC LIMIT 1`)
    .bind(symbol,end).first<Sample>();
  const current=await query(now);
  const tolerance=Math.max(5,Math.min(intervalMinutes,60))*60000;
  const fresh=current!==null&&now-current.source_timestamp<=tolerance*2;
  const changes=await Promise.all(Object.entries(windows).map(async ([window,span])=>{
    const base={source,asOf:current?.source_timestamp??null,fetchedAt:current?.fetched_at??null};
    if(!current||!fresh)return [window,{...base,status:'INSUFFICIENT_DATA',reason:current?'STALE_LATEST':'NO_SNAPSHOT'}];
    if(tolerance>span)return [window,{...base,status:'INSUFFICIENT_DATA',reason:'SAMPLING_INTERVAL_TOO_WIDE'}];
    const boundary=Math.min(current.source_timestamp-1,Math.ceil(current.source_timestamp/tolerance)*tolerance-span);

    const row=await query(boundary);
    if(!row||Math.abs(current.source_timestamp-row.source_timestamp-span)>Math.min(tolerance/2,span/3))
      return [window,{...base,status:'INSUFFICIENT_DATA',reason:'MISSING_BASELINE'}];
    const percent=change(current.open_interest,row.open_interest);
    if(percent===null)return [window,{...base,status:'INSUFFICIENT_DATA',reason:'ZERO_BASELINE'}];
    const priceChange=current.mark_price&&row.mark_price?change(current.mark_price,row.mark_price):null;
    const quadrant=priceChange&&percent ? (priceChange>0?'PRICE_UP':'PRICE_DOWN')+'_'+(percent>0?'OI_UP':'OI_DOWN'):null;
    return [window,{...base,status:'OK',baselineTimestamp:row.source_timestamp,elapsedMs:current.source_timestamp-row.source_timestamp,changePct:percent,priceChangePct:priceChange,quadrant}];
  }));
  return {source,symbol,asOf:current?.source_timestamp??null,fetchedAt:current?.fetched_at??null,
    status:fresh?'OK':'INSUFFICIENT_DATA',latest:current,changes:Object.fromEntries(changes)};
}
