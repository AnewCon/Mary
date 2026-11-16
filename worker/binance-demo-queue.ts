import { Failure } from './exchange';
import { fetchDemoSnapshot, type BinanceDemoEnv } from './binance-demo';
import { decode } from './binance-demo-trades';

const now = () => new Date().toISOString();

const ledgerKinds = new Set(['REALIZED_PNL', 'COMMISSION', 'FUNDING_FEE']);
const money = (value: unknown): value is string => typeof value === 'string' && /^-?\d{1,30}(?:\.\d{1,24})?$/.test(value);

function sanitizeLedger(input: any) {
  const totals = (value: any) => value && money(value.net) && money(value.gains) && money(value.losses)
    ? { net: value.net, gains: value.gains, losses: value.losses } : null;
  const today = totals(input?.today), period = totals(input?.period);
  if (!today || !period || ![input.asOf, input.dayStart, input.rangeStart].every(Number.isSafeInteger)
      || input.rangeStart > input.dayStart || input.dayStart > input.asOf || !Array.isArray(input.bills) || !Array.isArray(input.closed)) return;
  const lines = (rows: any[]) => rows.slice(0, 40).flatMap(row => {
    if (!row || !ledgerKinds.has(row.kind) || !money(row.income) || row.asset !== 'USDT'
        || !Number.isSafeInteger(row.time) || typeof row.symbol !== 'string' || row.symbol.length > 40
        || typeof row.tranId !== 'string' || row.tranId.length > 40) return [];
    return [{ kind: row.kind, income: row.income, asset: 'USDT', time: row.time, symbol: row.symbol,
      tranId: row.tranId, tradeId: typeof row.tradeId === 'string' ? row.tradeId.slice(0, 40) : '' }];
  });
  const resetAt = Number.isSafeInteger(input.resetAt) && input.resetAt >= input.dayStart && input.resetAt <= input.asOf ? input.resetAt : 0;
  return { asOf: input.asOf, dayStart: input.dayStart, resetAt, rangeStart: input.rangeStart, complete: input.complete === true,
    today, period, bills: lines(input.bills), closed: lines(input.closed).filter(row => row.kind === 'REALIZED_PNL') };
}

const demoTodayResetKey='binance_demo_today_reset_at';

export async function demoTodayResetAt(db:D1Database) {
  const resetAt=Number(await db.prepare('SELECT value FROM system_settings WHERE key=?').bind(demoTodayResetKey).first<string>('value'));
  return Number.isSafeInteger(resetAt)&&resetAt>0?resetAt:0;
}

export async function resetDemoToday(db:D1Database) {
  const row=await db.prepare(`INSERT INTO system_settings(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=MAX(CAST(system_settings.value AS INTEGER),CAST(excluded.value AS INTEGER))
    RETURNING value`).bind(demoTodayResetKey,String(Date.now())).first<{value:string}>();
  return {todayResetAt:Number(row!.value)};
}

export async function publishDemoSnapshot(env: BinanceDemoEnv, input: any, live = false) {
  const cacheKey = live ? 'binance_live_snapshot' : 'binance_demo_snapshot';
  if (!input || !Array.isArray(input.positions) || input.positions.length > 500 || !Array.isArray(input.account?.assets))
    throw new Failure('INVALID_BINANCE_SNAPSHOT');
  const snapshot = await fetchDemoSnapshot(env, async (_method, path) =>
    path === '/fapi/v3/account' ? input.account : input.positions);
  const history=Array.isArray(input.history)?input.history.slice(0,20).filter((x:any)=>x && typeof x.symbol==='string' && typeof x.income==='string' && Number.isSafeInteger(x.time)) : undefined;
  const ledger=sanitizeLedger(input.ledger);
  const old=await env.DB.prepare('SELECT value FROM system_settings WHERE key=?').bind(cacheKey).first<string>('value');
  const previous=old?JSON.parse(old):null;
  Object.assign(snapshot,{history:history??previous?.history,
    ledger:ledger&&(!previous?.ledger||ledger.asOf>=previous.ledger.asOf)?ledger:previous?.ledger});
  await env.DB.prepare('INSERT OR REPLACE INTO system_settings(key,value) VALUES(?,?)')
    .bind(cacheKey,JSON.stringify(snapshot)).run();
  return {updatedAt:snapshot.updatedAt};
}

export async function enqueueDemo(db: D1Database, input: unknown) {
  const decoded=decode(input);
  const {id}=decoded;
  const extra=input as {strategyVersion?:unknown;triggerType?:unknown;leverage?:unknown};
  let action:typeof decoded.action & {strategyVersion?:string;triggerType?:string;leverage?:number}=decoded.action;
  if(['open','limit','bracket'].includes(action.kind)&&typeof extra.strategyVersion==='string'&&
     /^v?2\.5(?:$|[-._])/i.test(extra.strategyVersion))
    throw new Failure('DEMO_V25_EXECUTION_POLICY_NOT_ALIGNED',409);
  if(action.kind==='limit')throw new Failure('DEMO_LIMIT_REQUIRES_BRACKET',409);
  if(action.kind==='bracket'){
    if(extra.triggerType!==undefined&&extra.triggerType!=='MARK_PRICE'&&extra.triggerType!=='CONTRACT_PRICE')
      throw new Failure('INVALID_DEMO_TRIGGER');
    if(extra.strategyVersion!==undefined&&(typeof extra.strategyVersion!=='string'||!/^[A-Za-z0-9._-]{1,40}$/.test(extra.strategyVersion)))
      throw new Failure('INVALID_STRATEGY_VERSION');
    if(extra.leverage!==undefined&&(typeof extra.leverage!=='number'||!Number.isInteger(extra.leverage)||extra.leverage<1||extra.leverage>125))
      throw new Failure('INVALID_DEMO_LEVERAGE');
    action={...action,...(typeof extra.leverage==='number'?{leverage:extra.leverage}:{}),strategyVersion:extra.strategyVersion as string|undefined??'2.3',triggerType:extra.triggerType as string|undefined??'MARK_PRICE'};
  }
  const payload=JSON.stringify(action);
  await db.prepare("INSERT OR IGNORE INTO binance_demo_actions(id,payload,state,created_at) VALUES(?,?,'queued',?)")
    .bind(id,payload,now()).run();
  const row=await db.prepare('SELECT payload,state,result FROM binance_demo_actions WHERE id=?').bind(id)
    .first<{payload:string;state:string;result:string|null}>();
  if (!row || row.payload!==payload) throw new Failure('BINANCE_DEMO_REQUEST_CONFLICT',409);
  return {id,state:row.state,result:row.result?JSON.parse(row.result):null};
}

export async function enqueueDemoRefresh(db: D1Database) {
  const id = crypto.randomUUID().replaceAll('-', '');
  await db.prepare("INSERT INTO binance_demo_actions(id,payload,state,created_at) VALUES(?,?,'queued',?)")
    .bind(id, JSON.stringify({kind:'refresh_snapshot'}), now()).run();
  return {id};
}

export async function legacyDemoLimits(db:D1Database) {
  const records=await db.prepare(`SELECT id,payload FROM binance_demo_actions
    WHERE json_extract(payload,'$.kind')='limit' AND json_extract(result,'$.orderState') IS NULL
      AND json_extract(result,'$.exchangeStatus') IN ('NEW','PARTIALLY_FILLED')`).all<{id:string;payload:string}>();
  return records.results.map(row=>({id:row.id,action:JSON.parse(row.payload)}));
}

export async function listDemoLimits(db:D1Database) {
  const records=await db.prepare(`SELECT id,payload,state,result,created_at FROM binance_demo_actions
    WHERE json_extract(payload,'$.kind') IN ('bracket','limit') ORDER BY created_at DESC LIMIT 40`).all<{
      id:string;payload:string;state:string;result:string|null;created_at:string
    }>();
  return records.results.map(row=>({id:row.id,action:JSON.parse(row.payload),state:row.state,
    submittedAt:row.created_at,result:row.result?JSON.parse(row.result):null}));
}

export async function queuedDemoStatus(db:D1Database,id:unknown) {
  if(typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id)) throw new Failure('INVALID_REQUEST_ID');
  const row=await db.prepare('SELECT state,result,created_at FROM binance_demo_actions WHERE id=?').bind(id)
    .first<{state:string;result:string|null;created_at:string}>();
  if(!row) return {id,state:'not_found',result:null};
  const age=Date.now()-Date.parse(row.created_at);
  if(row.state==='queued'&&age>120000) return {id,state:'expired',result:{code:'VPS_DID_NOT_CLAIM'}};
  if((row.state==='running'&&age>180000)||row.state==='pending') return {id,state:'unknown',result:{code:'CHECK_EXCHANGE_BEFORE_RETRY'}};
  return {id,state:row.state,result:row.result?JSON.parse(row.result):null};
}

export async function claimDemo(db:D1Database, tradingEnabled: boolean) {
  const cutoff=new Date(Date.now()-120000).toISOString();
  const row=await db.prepare(`UPDATE binance_demo_actions SET state='running'
    WHERE id=(SELECT id FROM binance_demo_actions WHERE state='queued' AND created_at>=? AND (?=1 OR json_extract(payload,'$.kind') IN ('orders','contract','query','refresh_snapshot'))
      ORDER BY CASE WHEN json_extract(payload,'$.kind')='refresh_snapshot' THEN 1 ELSE 0 END,created_at,id LIMIT 1)
    RETURNING id,payload`).bind(cutoff,tradingEnabled?1:0).first<{id:string;payload:string}>();
  return row?{id:row.id,action:JSON.parse(row.payload)}:null;
}

export async function reportDemo(db:D1Database,input:any) {
  if(!input||typeof input.id!=='string'||!/^[a-f0-9]{32}$/.test(input.id)||
    !['acknowledged','rejected','unknown'].includes(input.state)||!input.result||
    typeof input.result!=='object'||Array.isArray(input.result)) throw new Failure('INVALID_BINANCE_RESULT');
  const result=JSON.stringify(input.result);
  const changed=await db.prepare(`UPDATE binance_demo_actions SET state=?,result=? WHERE id=? AND (state='running' OR state IN ('acknowledged','unknown') AND json_extract(payload,'$.kind') IN ('bracket','limit')
      AND json_extract(?,'$.orderState') IN ('PENDING','NEW','PARTIALLY_FILLED','FILLED','CANCEL_PENDING','CANCELED','EXPIRED','ERROR'))`)
    .bind(input.state,result,input.id,result).run();
  if(changed.meta.changes!==1){
    const old=await db.prepare('SELECT state,result FROM binance_demo_actions WHERE id=?').bind(input.id)
      .first<{state:string;result:string}>();
    if(old?.state!==input.state||old?.result!==result) throw new Failure('BINANCE_RESULT_CONFLICT',409);
  }
  return {id:input.id,state:input.state};
}
