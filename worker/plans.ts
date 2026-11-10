import {Failure} from './exchange';
export async function createPlan(db:D1Database,b:any,actor:string){
 if(!b||typeof b!=='object'||typeof b.requestId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(b.requestId)||typeof b.symbol!=='string'||!b.symbol.trim()||b.symbol.length>80||!['long','short','observe'].includes(b.direction)||typeof b.content!=='string'||!b.content.trim()||b.content.length>8000)throw new Failure('INVALID_PLAN');
 for(const k of ['entry','stopLoss','takeProfit'])if(b[k]!==undefined&&(typeof b[k]!=='string'||!/^\d+(\.\d+)?$/.test(b[k])||b[k].length>40||!Number.isFinite(Number(b[k]))||Number(b[k])<=0))throw new Failure('INVALID_PLAN_PRICE');
 if(b.expiresAt!==undefined&&(typeof b.expiresAt!=='string'||b.expiresAt.length>40||!Number.isFinite(Date.parse(b.expiresAt))))throw new Failure('INVALID_PLAN_EXPIRY');
 const plan={symbol:b.symbol.trim(),direction:b.direction,content:b.content.trim(),...(b.entry?{entry:b.entry}:{}),...(b.stopLoss?{stopLoss:b.stopLoss}:{}),...(b.takeProfit?{takeProfit:b.takeProfit}:{}),...(b.expiresAt?{expiresAt:new Date(b.expiresAt).toISOString()}:{}),source:'authorized-api',status:'plan_only',execution:false};
 const text=JSON.stringify(plan),id=crypto.randomUUID(),createdAt=new Date().toISOString();
 await db.prepare('INSERT OR IGNORE INTO trade_plans VALUES(?,?,?,?,?)').bind(id,b.requestId,createdAt,actor,text).run();
 const existing=await db.prepare('SELECT * FROM trade_plans WHERE request_id=?').bind(b.requestId).first<any>();
 if(existing.data!==text||existing.actor!==actor)throw new Failure('PLAN_IDEMPOTENCY_CONFLICT',409);
 return {id:existing.id,createdAt:existing.created_at,...JSON.parse(existing.data)}
}
export async function listPlans(db:D1Database){const rows=(await db.prepare('SELECT id,created_at,data FROM trade_plans ORDER BY created_at DESC,id DESC LIMIT 100').all<any>()).results;return rows.map(r=>({id:r.id,createdAt:r.created_at,...JSON.parse(r.data)}))}
