import { Failure } from './exchange';
import { fetchDemoSnapshot, type BinanceDemoEnv } from './binance-demo';
import { decode } from './binance-demo-trades';

const now = () => new Date().toISOString();

export async function publishDemoSnapshot(env: BinanceDemoEnv, input: any, live = false) {
  const cacheKey = live ? 'binance_live_snapshot' : 'binance_demo_snapshot';
  if (!input || !Array.isArray(input.positions) || input.positions.length > 500 || !Array.isArray(input.account?.assets))
    throw new Failure('INVALID_BINANCE_SNAPSHOT');
  const snapshot = await fetchDemoSnapshot(env, async (_method, path) =>
    path === '/fapi/v3/account' ? input.account : input.positions);
  const history=Array.isArray(input.history)?input.history.slice(0,20).filter((x:any)=>x && typeof x.symbol==='string' && typeof x.income==='string' && Number.isSafeInteger(x.time)) : undefined;
  if(history===undefined){
    const old=await env.DB.prepare('SELECT value FROM system_settings WHERE key=?').bind(cacheKey).first<string>('value');
    if(old) Object.assign(snapshot,{history:JSON.parse(old).history});
  } else Object.assign(snapshot,{history});
  await env.DB.prepare('INSERT OR REPLACE INTO system_settings(key,value) VALUES(?,?)')
    .bind(cacheKey,JSON.stringify(snapshot)).run();
  return {updatedAt:snapshot.updatedAt};
}

export async function enqueueDemo(db: D1Database, input: unknown) {
  const {id,action}=decode(input);
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
  const changed=await db.prepare("UPDATE binance_demo_actions SET state=?,result=? WHERE id=? AND (state='running' OR state='acknowledged' AND json_extract(payload,'$.kind')='bracket' AND json_extract(result,'$.protectionState') IN ('waiting_fill','armed','watching','protection_error'))")
    .bind(input.state,result,input.id).run();
  if(changed.meta.changes!==1){
    const old=await db.prepare('SELECT state,result FROM binance_demo_actions WHERE id=?').bind(input.id)
      .first<{state:string;result:string}>();
    if(old?.state!==input.state||old?.result!==result) throw new Failure('BINANCE_RESULT_CONFLICT',409);
  }
  return {id:input.id,state:input.state};
}
