import { chooseAdaptiveForecast, evaluateIssuedForecast, shouldIssueForecast, type AdaptiveForecast, type CalibrationSample } from './pathmatch-adaptive';
import type { StrategyBinding } from './strategy-center';
import { Failure } from './exchange';
import { atr14, match, minute, parsePlan, type Candle, type Plan } from './pathmatch-core';

type Slot={id:string;payload:string;symbol:string;state:string;version:string;created_at:number;expires_at:number;
  locked_at:number|null;start_at:number|null;atr:number|null;last_check:number|null;deleted_at:number|null;revision:number;result:string|null;strategy_id?:string;strategy_version?:string;strategy_hash?:string};
const active=['ARMED','VALIDATING'];
const actionId=(id:unknown)=>{
  if(typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id))throw new Failure('PATHMATCH_INVALID_ID');
  return id;
};
const get=(db:D1Database,id:unknown)=>db.prepare("SELECT p.*,l.strategy_id,l.version strategy_version,l.content_hash strategy_hash FROM pathmatch_predictions p LEFT JOIN strategy_prediction_links l ON l.prediction_id=p.id WHERE p.id=?").bind(actionId(id)).first<Slot>();
const view=(row:Slot)=>({strategy:row.strategy_id?{strategyId:row.strategy_id,version:row.strategy_version,contentHash:row.strategy_hash}:null,id:row.id,state:row.state,mode:'SHADOW',symbol:row.symbol,version:row.version,createdAt:row.created_at,
  expiresAt:row.expires_at,lockedAt:row.locked_at,startAt:row.start_at,atr:row.atr,checkedAt:row.last_check,
  plan:JSON.parse(row.payload) as Plan,result:row.result?JSON.parse(row.result):null,execution:'DISABLED_PENDING_INDEPENDENT_ACCEPTANCE'});
export function pathRelay(ns:DurableObjectNamespace){return ns.get(ns.idFromName('private-market-relay'));}

async function market(relay:DurableObjectStub,target:string){
  const result=await relay.fetch('https://market-relay.internal/request',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'binance_demo_public',target})});
  if(!result.ok)throw new Failure('PATHMATCH_MARKET_HTTP_'+result.status,502);
  return result.json();
}

async function candles(relay:DurableObjectStub,symbol:string,interval:'1m'|'5m',params:string,cutoff:number){
  const data=await market(relay,`/fapi/v1/klines?symbol=${symbol}&interval=${interval}&${params}`);
  if(!Array.isArray(data)||data.some(x=>!Array.isArray(x)||x.length<7))throw new Failure('PATHMATCH_INVALID_MARKET_DATA',502);
  const duration=interval==='5m'?5*minute:minute;
  return data.filter(row=>Number(row[6])<cutoff&&Number(row[0])+duration<=cutoff).map(row=>{
    const [time,open,high,low,close]=row.slice(0,5).map(Number);
    if(!Number.isSafeInteger(time)||time%duration||Number(row[6])!==time+duration-1||
      [open,high,low,close].some(x=>!Number.isFinite(x)||x<=0)||low>Math.min(open,close)||high<Math.max(open,close))
      throw new Failure('PATHMATCH_INVALID_MARKET_DATA',502);
    return {time,open,high,low,close};
  }) as Candle[];
}

export async function predictionReference(relay:DurableObjectStub,symbol:unknown){
  if(typeof symbol!=='string'||!/^[A-Z0-9]{2,20}USDT$/.test(symbol))throw new Failure('PATHMATCH_INVALID_SYMBOL');
  const now=Date.now();
  const latest=(await candles(relay,symbol,'1m','limit=3',now)).at(-1);
  if(!latest||latest.time+minute!==Math.floor(now/minute)*minute)throw new Failure('PATHMATCH_REFERENCE_STALE',502);
  return {symbol,exchange:'BINANCE_DEMO',referenceTime:latest.time+minute,referencePrice:latest.close,suggestedStartAt:latest.time+2*minute,asOf:now};
}

export async function createPrediction(db:D1Database,body:any,resolveBinding?:()=>Promise<StrategyBinding>){
  const id=actionId(body?.id);
  const previous=await get(db,id);
  if(previous){
    if(previous.deleted_at!==null)throw new Failure('PATHMATCH_ID_RETIRED',409);
    if(previous.strategy_id&&(body?.strategy?.strategyId!==previous.strategy_id||body?.strategy?.version!==previous.strategy_version||body?.strategy?.contentHash!==previous.strategy_hash))throw new Failure('PATHMATCH_ID_CONFLICT',409);
    if(previous.payload!==JSON.stringify(body?.plan))throw new Failure('PATHMATCH_ID_CONFLICT',409);
    return view(previous);
  }
  const created=Date.now(),plan=parsePlan(body?.plan,created);
  if(plan.forecast.interval!=='1m')throw new Failure('PATHMATCH_15_MINUTE_OHLC_REQUIRED');
  if(resolveBinding){
    const binding=await resolveBinding(), policy=binding.config.pathMatch;
    if(!policy.enabled||policy.mode!=='SHADOW'||plan.forecast.candles.length!==policy.forecast1mCount||
      plan.validation.maximumValidationMinutes!==policy.windowMinutes||plan.validation.minimumClosed1mCandles!==policy.minClosedCandles||
      plan.validation.similarityThreshold!==policy.similarityThreshold||plan.validation.atrTolerance!==policy.atrTolerance)
      throw new Failure('PATHMATCH_STRATEGY_POLICY_MISMATCH',409);
    const [insert]=await db.batch([
      db.prepare(`INSERT OR IGNORE INTO pathmatch_predictions(id,payload,symbol,version,state,created_at,expires_at)
        SELECT ?,?,?,?,'DRAFT',?,? FROM strategy_active WHERE strategy_id=? AND version=? AND generation=?`)
        .bind(id,JSON.stringify(plan),plan.symbol,plan.strategyVersion,created,plan.expiresAt,binding.strategyId,binding.version,binding.generation),
      db.prepare(`INSERT INTO strategy_prediction_links(prediction_id,strategy_id,version,content_hash)
        SELECT ?,?,?,? WHERE changes()=1`).bind(id,binding.strategyId,binding.version,binding.contentHash)
    ]);
    if(!insert.meta.changes){
      const replay=await get(db,id);
      if(!replay)throw new Failure('STRATEGY_CHANGED_OR_UNBOUND',409);
      if(replay.strategy_id!==binding.strategyId||replay.strategy_version!==binding.version||replay.strategy_hash!==binding.contentHash)
        throw new Failure('PATHMATCH_ID_CONFLICT',409);
    }
  }else await db.prepare(`INSERT OR IGNORE INTO pathmatch_predictions(id,payload,symbol,version,state,created_at,expires_at)
    VALUES(?,?,?,?,'DRAFT',?,?)`).bind(id,JSON.stringify(plan),plan.symbol,plan.strategyVersion,created,plan.expiresAt).run();
  const stored=await get(db,id);
  if(stored?.deleted_at!=null)throw new Failure('PATHMATCH_ID_RETIRED',409);
  if(!stored||stored.payload!==JSON.stringify(plan))throw new Failure('PATHMATCH_ID_CONFLICT',409);
  return view(stored);
}

export async function armPrediction(db:D1Database,relay:DurableObjectStub,body:any){
  const row=await get(db,body?.id);
  if(!row||row.deleted_at!==null)throw new Failure('PATHMATCH_NOT_FOUND',404);
  if(body?.mode!=='SHADOW'||body?.confirm!==true)throw new Failure('PATHMATCH_SHADOW_AUTHORIZATION_REQUIRED',409);
  if(active.includes(row.state))return view(row);
  if(row.state!=='DRAFT'||row.expires_at<=Date.now())throw new Failure('PATHMATCH_DRAFT_UNAVAILABLE',409);
  const plan=parsePlan(JSON.parse(row.payload));
  const before=Date.now();
  const [latest,bars,clock]=await Promise.all([candles(relay,row.symbol,'1m','limit=3',before),
    candles(relay,row.symbol,'5m','limit=16',before),market(relay,'/fapi/v1/time')]);
  const locked=Date.now(),base=latest.at(-1);
  const atr=atr14(bars.slice(-15));
  const upstreamTime=Number((clock as {serverTime?:number})?.serverTime);
  if(!Number.isFinite(upstreamTime)||upstreamTime<before-5000||upstreamTime>locked+5000)
    throw new Failure('PATHMATCH_CLOCK_OFFSET',409);
  if(!base||base.time+minute!==Math.floor(locked/minute)*minute||base.time+minute!==plan.referenceTime||
      Math.abs(base.close-plan.referencePrice)>Math.max(1e-12,base.close*1e-8))
    throw new Failure('PATHMATCH_REFERENCE_MISMATCH',409);
  if(Math.abs(base.close-bars.at(-1)!.close)>2*atr)throw new Failure('PATHMATCH_REFERENCE_PRICE_JUMP',409);
  const start=Math.ceil(locked/minute)*minute;
  if(plan.forecast.interval==='1m'&&start!==plan.forecast.candles[0].time)
    throw new Failure('PATHMATCH_FORECAST_START_MISMATCH',409);
  const end=Math.min(row.expires_at,start+plan.validation.maximumValidationMinutes*minute);
  if(end-start<(plan.forecast.interval==='1m'?15:plan.validation.minimumClosed1mCandles)*minute)throw new Failure('PATHMATCH_WINDOW_TOO_SHORT',409);
  const updated=await db.prepare(`UPDATE pathmatch_predictions SET state='ARMED',locked_at=?,start_at=?,atr=?,expires_at=?,revision=revision+1
    WHERE id=? AND revision=? AND deleted_at IS NULL AND state='DRAFT' AND (SELECT COUNT(*) FROM pathmatch_predictions
      WHERE state IN ('ARMED','VALIDATING') AND expires_at>?)<5`).bind(locked,start,atr,end,row.id,row.revision,locked).run();
  if(updated.meta.changes!==1)throw new Failure('PATHMATCH_ACTIVE_LIMIT_OR_CONFLICT',409);
  return predictionStatus(db,row.id);
}

export async function predictionStatus(db:D1Database,id:unknown){
  const row=await get(db,id);
  if(!row||row.deleted_at!==null)throw new Failure('PATHMATCH_NOT_FOUND',404);
  return view(row);
}

export async function cancelPrediction(db:D1Database,body:any){
  const row=await get(db,body?.id);
  if(!row||row.deleted_at!==null)throw new Failure('PATHMATCH_NOT_FOUND',404);
  if(body?.confirm!==true)throw new Failure('PATHMATCH_CONFIRMATION_REQUIRED');
  for(let i=0;i<2;i++){
    const current=i?(await get(db,row.id))!:row;
    if(current.deleted_at!==null)throw new Failure('PATHMATCH_NOT_FOUND',404);
    if(!['DRAFT',...active].includes(current.state))return view(current);
    const result={...(current.result?JSON.parse(current.result):{}),reason:'USER_CANCELED'};
    const updated=await db.prepare("UPDATE pathmatch_predictions SET state='CANCELED',result=?,revision=revision+1 WHERE id=? AND revision=?")
      .bind(JSON.stringify(result),row.id,current.revision).run();
    if(updated.meta.changes===1)return predictionStatus(db,row.id);
  }
  throw new Failure('PATHMATCH_CONFLICT',409);
}

export async function deletePrediction(db:D1Database,body:any){
  const id=actionId(body?.id);
  if(body?.confirm!==true)throw new Failure('PATHMATCH_CONFIRMATION_REQUIRED');
  const row=await db.prepare(`UPDATE pathmatch_predictions SET deleted_at=?,revision=revision+1,
    state=CASE WHEN state IN ('DRAFT','ARMED','VALIDATING') THEN 'CANCELED' ELSE state END
    WHERE id=? AND deleted_at IS NULL RETURNING deleted_at`).bind(Date.now(),id).first<{deleted_at:number}>();
  if(row)return {id,deletedAt:row.deleted_at};
  const prior=await get(db,id);
  if(prior?.deleted_at!=null)return {id,deletedAt:prior.deleted_at};
  throw new Failure('PATHMATCH_NOT_FOUND',404);
}

export async function predictionHistory(db:D1Database,query:URLSearchParams){
  const clauses:string[]=['p.deleted_at IS NULL'],values:(number|string)[]=[];
  for(const [key,column] of [['symbol','symbol'],['state','state'],['version','version']]){
    const value=query.get(key);
    if(value){if(!/^[A-Za-z0-9._-]{1,30}$/.test(value))throw new Failure('PATHMATCH_INVALID_FILTER');
      clauses.push('p.'+column+'=?');values.push(value);}
  }
  for(const [key,op] of [['from','>='],['to','<=']]){
    const value=query.get(key);
    if(value!==null){if(!/^\d{10,14}$/.test(value))throw new Failure('PATHMATCH_INVALID_FILTER');
      clauses.push('p.created_at'+op+'?');values.push(Number(value));}
  }
  const limit=Number(query.get('limit')??20);
  if(!Number.isInteger(limit)||limit<1||limit>50)throw new Failure('PATHMATCH_INVALID_FILTER');
  const rows=await db.prepare('SELECT p.*,l.strategy_id,l.version strategy_version,l.content_hash strategy_hash FROM pathmatch_predictions p LEFT JOIN strategy_prediction_links l ON l.prediction_id=p.id'+(clauses.length?' WHERE '+clauses.join(' AND '):'')+
    ' ORDER BY p.created_at DESC,p.id DESC LIMIT ?').bind(...values,limit).all<Slot>();
  return rows.results.map(view);
}

async function completedSamples(db:D1Database,cutoff:number):Promise<CalibrationSample[]>{
  const rows=await db.prepare(`SELECT symbol,start_at,atr,payload,result FROM pathmatch_predictions
    WHERE state='COMPLETED' AND deleted_at IS NULL AND expires_at<=? AND last_check<=? AND last_check>=?
    ORDER BY last_check DESC LIMIT 36`).bind(cutoff,cutoff,cutoff-30*24*60*minute)
    .all<{symbol:string;start_at:number;atr:number;payload:string;result:string}>();
  return rows.results.flatMap(row=>{
    const plan=JSON.parse(row.payload) as Plan,result=JSON.parse(row.result);
    return row.atr>0&&plan.forecast.interval==='1m'&&result?.complete===true&&result.points?.length===15?
      [{symbol:row.symbol,start:row.start_at,atr:row.atr,plan,actual:result.points}]:[];
  });
}

export async function monitorPredictions(db:D1Database,relay:DurableObjectStub,now=Date.now()){
  const {results}=await db.prepare("SELECT * FROM pathmatch_predictions WHERE deleted_at IS NULL AND state IN ('ARMED','VALIDATING') ORDER BY created_at LIMIT 5").all<Slot>();
  const symbols=new Map<string,Promise<Candle[]>>();
  const history=new Map<number,Promise<CalibrationSample[]>>();
  const realStart=Date.now();
  const issueTime=()=>now+Math.max(0,Date.now()-realStart);
  await Promise.all(results.map(async row=>{
    const start=row.start_at!;
    if(now<start+minute&&now<row.expires_at)return;
    const cutoff=Math.min(now,row.expires_at);
    const plan=JSON.parse(row.payload) as Plan;
    const previous:AdaptiveForecast|undefined=row.result?JSON.parse(row.result).adaptive:undefined;
    let state='VALIDATING',result:any;
    try{
      let received=symbols.get(row.symbol);
      if(!received){received=candles(relay,row.symbol,'1m','limit=17',now);symbols.set(row.symbol,received);}
      const data=(await received).filter(o=>o.time>=start&&o.time+minute<=cutoff);
      result=match(plan,start,row.atr!,data,cutoff);
      if(plan.forecast.interval==='1m'){
        let adaptive=previous;
        if(result.status!=='ERROR'){
          adaptive=evaluateIssuedForecast(previous,plan,data,row.atr!);
          if(shouldIssueForecast(adaptive,data,issueTime())){
            const historyCutoff=data[0].time+minute;
            try{
              let cached=history.get(historyCutoff);
              if(!cached){cached=completedSamples(db,historyCutoff);history.set(historyCutoff,cached);}
              const available=await cached;
              const picked=chooseAdaptiveForecast(adaptive,plan,data,row.atr!,available,issueTime());
              if(shouldIssueForecast(adaptive,data,issueTime()))adaptive=picked;
            }catch{
              if(!adaptive||adaptive.status!=='ACTIVE')adaptive={status:'HISTORY_UNAVAILABLE'};
            }
          }
        }
        if(adaptive)result={...result,adaptive};
      }
      const elapsed=Math.floor((cutoff-start)/minute);
      if(result.status!=='ERROR'&&result.status!=='CANCELED'&&data.length<elapsed){
        result={...result,status:'VALIDATING',reason:'MISSING_OR_DELAYED_CANDLE'};
      }
      if(result.status==='ERROR')result={...result,status:'VALIDATING'};
      state=result.status;
    }catch(error){
      result={...(row.result?JSON.parse(row.result):{}),reason:error instanceof Failure?error.code:'PATHMATCH_UPSTREAM_UNAVAILABLE'};
    }
    const grace=plan.forecast.interval==='1m'?75000:0;
    if(now>=row.expires_at+grace&&state!=='CANCELED'&&state!=='COMPLETED'){
      state='EXPIRED';result={...result,lastObservation:result.reason,reason:'WINDOW_EXPIRED'};
    }
    await db.prepare("UPDATE pathmatch_predictions SET state=?,result=?,last_check=?,revision=revision+1 WHERE id=? AND revision=? AND deleted_at IS NULL AND state IN ('ARMED','VALIDATING')")
      .bind(state,JSON.stringify(result),now,row.id,row.revision).run();
  }));
}
