import {protectTiers,leverageInfo,tradeContext,orders as demoOrders,execute as demoExecute,actionStatus as demoActionStatus,mcpClose} from './demo-broker';
import {createPlan,listPlans} from './plans';
import * as virtual from './virtual-broker';
import {marketContext,symbolId,type MarketEnv} from './binance-market';
import {readBinanceDemo,syncBinanceDemo,type BinanceDemoEnv} from './binance-demo';
import {demoActionStatus as binanceDemoActionStatus,submitDemoAction} from './binance-demo-trades';
import {hash,randomKey,scopeAllowed} from './security';
import {okx,Failure} from './exchange';
import {quote,close,reconcile} from './trading';
import {performance,history,syncPerformance,resetTodayEarnings} from './performance';
interface Env extends MarketEnv,BinanceDemoEnv{ASSETS:Fetcher;ADMIN_PASSWORD:string;SESSION_SECRET:string;OKX_API_KEY:string;OKX_SECRET_KEY:string;OKX_PASSPHRASE:string;TRADING_MODE:string;DEMO_TRADING_ENABLED?:string;MCP_DEMO_TRADING_ENABLED?:string;VIRTUAL_ONLY?:string}
const json=(data:unknown,status=200)=>new Response(JSON.stringify(status<400?{ok:true,data}:{ok:false,error:{code:data}}),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
const now=()=>new Date().toISOString();
async function body(r:Request){const text=await r.text();if(new TextEncoder().encode(text).length>16384)throw new Failure('REQUEST_TOO_LARGE',413);try{return JSON.parse(text)}catch{throw new Failure('INVALID_JSON')}}
async function limit(e:Env,key:string,max:number){const bucket=Math.floor(Date.now()/60000);const row=await e.DB.prepare('INSERT INTO rate_limits(key,bucket,count) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN bucket=excluded.bucket THEN count+1 ELSE 1 END,bucket=excluded.bucket RETURNING count').bind(key,bucket).first<{count:number}>();if(row!.count>max)throw new Failure('RATE_LIMITED',429)}
async function auth(r:Request,e:Env,scope='read',sessionOnly=false){const cookie=r.headers.get('Cookie')?.match(/(?:^|; )quantos=([^;]+)/)?.[1];if(cookie){const s=await e.DB.prepare('SELECT expires FROM sessions WHERE hash=?').bind(await hash(cookie)).first<{expires:number}>();if(s&&s.expires>Date.now())return 'session'}if(!sessionOnly){const token=r.headers.get('Authorization')?.replace(/^Bearer /,'');if(token){const k=await e.DB.prepare('SELECT * FROM api_keys WHERE hash=? AND revoked=0').bind(await hash(token)).first<any>();if(k&&scopeAllowed(JSON.parse(k.scopes),scope)){await limit(e,'key:'+k.id,60);await e.DB.prepare('UPDATE api_keys SET last_used_at=? WHERE id=?').bind(now(),k.id).run();return k.id}}}throw new Failure('UNAUTHORIZED',401)}
async function sync(e:Env){const lease=await e.DB.prepare("INSERT INTO system_settings(key,value) VALUES('sync_lock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(value AS INTEGER)<? RETURNING value").bind(String(Date.now()),Date.now()-30000).first();if(!lease)throw new Failure('SYNC_IN_PROGRESS',409);try{const [balances,positions]=await Promise.all([okx(e,'/api/v5/account/balance'),okx(e,'/api/v5/account/positions?instType=SWAP')]);const a=balances[0];const data={account:{equity:a.totalEq,currency:'USD',details:a.details,source:'OKX API'},positions:positions.filter((p:any)=>Number(p.pos)!==0),updatedAt:now()};await e.DB.batch([e.DB.prepare('INSERT OR REPLACE INTO account_snapshots VALUES(1,?,?)').bind(JSON.stringify(data),data.updatedAt),e.DB.prepare('DELETE FROM positions'),...data.positions.map((p:any)=>e.DB.prepare('INSERT INTO positions VALUES(?,?)').bind(p.posId,JSON.stringify(p))),e.DB.prepare('INSERT INTO sync_logs(created_at,error) VALUES(?,NULL)').bind(now())]);return data}catch(err){const code=err instanceof Failure?err.code:'SYNC_NETWORK_FAILURE';await e.DB.prepare('INSERT INTO sync_logs(created_at,error) VALUES(?,?)').bind(now(),code).run();throw new Failure(code,503)}finally{await e.DB.prepare("DELETE FROM system_settings WHERE key='sync_lock'").run()}}
async function route(r:Request,e:Env){const u=new URL(r.url),p=u.pathname,m=r.method;if(!p.startsWith('/api/'))return e.ASSETS.fetch(r);if(!['GET','POST'].includes(m))throw new Failure('METHOD_NOT_ALLOWED',405);if(m==='POST'&&r.headers.get('Origin')&&r.headers.get('Origin')!==u.origin)throw new Failure('ORIGIN_DENIED',403);
if(p==='/api/login'&&m==='POST'){await limit(e,'login:'+r.headers.get('CF-Connecting-IP'),5);const b=await body(r);if(!e.ADMIN_PASSWORD||!e.SESSION_SECRET)throw new Failure('ADMIN_NOT_CONFIGURED',503);if(typeof b.password!=='string'||await hash(b.password)!==await hash(e.ADMIN_PASSWORD))throw new Failure('INVALID_LOGIN',401);const token=randomKey();await e.DB.prepare('INSERT INTO sessions VALUES(?,?)').bind(await hash(token),Date.now()+8*3600000).run();const out=json({authenticated:true});out.headers.set('Set-Cookie',`quantos=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`);return out}
if(p.startsWith('/api/binance-demo/')){
 await auth(r,e,'read',true);
 if(p==='/api/binance-demo/status'&&m==='GET')return json({enabled:e.BINANCE_DEMO_ENABLED==='true'});
 if(e.BINANCE_DEMO_ENABLED!=='true')throw new Failure('BINANCE_DEMO_DISABLED',404);
 if(p==='/api/binance-demo/account'&&m==='GET')return json(await readBinanceDemo(e));
 if(p==='/api/binance-demo/sync'&&m==='POST'){await limit(e,'binance-demo-sync',4);return json(await syncBinanceDemo(e))}
 if(e.BINANCE_DEMO_TRADING_ENABLED==='true'){
  if(p==='/api/binance-demo/action'&&m==='GET'){await limit(e,'binance-demo-status',10);return json(await binanceDemoActionStatus(e,u.searchParams.get('id')))}
  if(p==='/api/binance-demo/action'&&m==='POST'){await limit(e,'binance-demo-action',8);return json(await submitDemoAction(e,await body(r)))}
 }
 throw new Failure('NOT_FOUND',404);
}
const admin=p.startsWith('/api/keys')||p.startsWith('/api/trades/')||p==='/api/system/halt'||p==='/api/logout'||p==='/api/performance/today/reset'||p==='/api/settings/capital'||(m==='POST'&&['/api/virtual/accounts','/api/virtual/refresh'].includes(p));const principal=await auth(r,e,p.startsWith('/api/demo/')?'demo_trade':['/api/virtual/trade','/api/virtual/capabilities'].includes(p)?'virtual_trade':m==='GET'?'read':'write',admin);
if(p.startsWith('/api/virtual/')){
 if(e.VIRTUAL_ONLY!=='true')throw new Failure('VIRTUAL_LEDGER_DISABLED',404);
 if(p==='/api/virtual/capabilities'&&m==='GET')return json({enabled:true,mode:'virtual'});
 if(p==='/api/virtual/accounts'&&m==='GET')return json(await virtual.accounts(e));
 if(p==='/api/virtual/accounts'&&m==='POST'){await limit(e,'virtual-config:'+principal,8);return json(await virtual.configure(e,await body(r)))}
 if(p==='/api/virtual/portfolio'&&m==='GET')return json(await virtual.portfolio(e,u.searchParams.get('accountId')??undefined));
 if(p==='/api/virtual/stats'&&m==='GET')return json(await virtual.statistics(e,u.searchParams.get('accountId')??undefined));
 if(p==='/api/virtual/history'&&m==='GET')return json(await virtual.history(e,u.searchParams));
 if(p==='/api/virtual/market'&&m==='GET'){await limit(e,'virtual-market:'+principal,10);return json(await marketContext(e,symbolId(u.searchParams.get('symbol'))))}
 if(p==='/api/virtual/position'&&m==='GET')return json(await virtual.positionDetail(e,u.searchParams.get('id')||''));
 if(p==='/api/virtual/request'&&m==='GET')return json(await virtual.requestStatus(e,u.searchParams.get('id')||'',principal));
 if(p==='/api/virtual/refresh'&&m==='POST'){await limit(e,'virtual-refresh:'+principal,4);return json(await virtual.settle(e))}
 if(p==='/api/virtual/trade'&&m==='POST'){await limit(e,'virtual-trade:'+principal,15);return json(await virtual.action(e,await body(r),principal))}
 throw new Failure('NOT_FOUND',404);
}
if(e.VIRTUAL_ONLY==='true'){
 if(p==='/api/demo/capabilities'&&m==='GET')return json({enabled:false,mode:'virtual',operations:[]});
 if(p.startsWith('/api/demo/')||p==='/api/sync'||p==='/api/performance/sync'||p==='/api/performance/today/reset'||
    (p.startsWith('/api/trades/')&&(m==='POST'||p.endsWith('/close-quote'))))throw new Failure('OKX_ARCHIVE_READ_ONLY',410);
}
if(p==='/api/logout'&&m==='POST'){const token=r.headers.get('Cookie')?.match(/quantos=([^;]+)/)?.[1];if(token)await e.DB.prepare('DELETE FROM sessions WHERE hash=?').bind(await hash(token)).run();const out=json({});out.headers.set('Set-Cookie','quantos=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');return out}
if(p==='/api/settings/capital'&&m==='POST'){
 const {capitalUsd}=await body(r)??{};
 if(typeof capitalUsd!=='string'||!/^\d{1,12}(\.\d{1,2})?$/.test(capitalUsd)||Number(capitalUsd)<=0)throw new Failure('INVALID_CAPITAL_USD');
 const normalized=Number(capitalUsd).toFixed(2);
 await e.DB.prepare("INSERT INTO system_settings(key,value) VALUES('capital_usd',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(normalized).run();
 return json({capitalUsd:normalized});
}
if(p==='/api/status'&&m==='GET'&&e.VIRTUAL_ONLY==='true'){
 const [market,pause]=await e.DB.batch([
  e.DB.prepare('SELECT time,error FROM virtual_market ORDER BY checked_at DESC LIMIT 1'),
  e.DB.prepare("SELECT value FROM system_settings WHERE key='virtual_halt'")
 ]);
 const row=market.results[0] as {time:number|null;error:string|null}|undefined;
 return json({virtualOnly:true,exchange:'BINANCE',mode:'virtual',configured:true,interval:60,
  demoTradingEnabled:false,mcpDemoTradingEnabled:false,updatedAt:row?.time?new Date(row.time).toISOString():null,
  stale:!row?.time||Date.now()-row.time>120000,error:row?.error??null,halt:(pause.results[0] as {value:string}|undefined)?.value==='true'});
}
if(p==='/api/status'&&m==='GET'){const a=await e.DB.prepare('SELECT updated_at FROM account_snapshots WHERE id=1').first<any>();const last=await e.DB.prepare('SELECT * FROM sync_logs ORDER BY id DESC LIMIT 1').first<any>();const settings=(await e.DB.prepare("SELECT key,value FROM system_settings WHERE key IN ('halt','virtual_halt','capital_usd')").all<{key:string,value:string}>()).results;const halt=settings.find(s=>s.key===(e.VIRTUAL_ONLY==='true'?'virtual_halt':'halt'))?.value;const capitalUsd=settings.find(s=>s.key==='capital_usd')?.value??null;return json({capitalUsd,virtualOnly:e.VIRTUAL_ONLY==='true',exchange:'OKX',mode:'demo',demoTradingEnabled:e.DEMO_TRADING_ENABLED==='true',mcpDemoTradingEnabled:e.MCP_DEMO_TRADING_ENABLED==='true',interval:60,configured:!!(e.OKX_API_KEY&&e.OKX_SECRET_KEY&&e.OKX_PASSPHRASE),updatedAt:a?.updated_at||null,stale:!a||Date.now()-Date.parse(a.updated_at)>120000,error:last?.error||null,halt:halt==='true'})}
if(['/api/account','/api/positions'].includes(p)&&m==='GET'){const row=await e.DB.prepare('SELECT data FROM account_snapshots WHERE id=1').first<{data:string}>();const data=row?JSON.parse(row.data):null;return json(p.endsWith('positions')?data?.positions||[]:data)}
if(p==='/api/sync'&&m==='POST'){await limit(e,'sync',4);return json(await sync(e))}
if(p==='/api/performance/today/reset'&&m==='POST'){const b=await body(r);if(b?.confirm!==true)throw new Failure('CONFIRM_TODAY_RESET');return json(await resetTodayEarnings(e))}
if(p==='/api/performance'&&m==='GET')return json(await performance(e));
if(p==='/api/history'&&m==='GET')return json(await history(e,u));
if(p==='/api/performance/sync'&&m==='POST'){await limit(e,'history-sync',6);return json(await syncPerformance(e))}
if(p==='/api/demo/capabilities'&&m==='GET')return json({enabled:e.DEMO_TRADING_ENABLED==='true'&&e.MCP_DEMO_TRADING_ENABLED==='true',mode:'demo',scope:'demo_trade',operations:['leverage','place','close','protect','protect_tiers','amend_protection','cancel_protection','cancel_order']});
if(p==='/api/demo/leverage'&&m==='GET')return json(await leverageInfo(e,u.searchParams.get('instId')||'',u.searchParams.get('marginMode')||''));
if(p==='/api/demo/context'&&m==='GET')return json(await tradeContext(e,u.searchParams.get('instId')||''));
if(p==='/api/demo/orders'&&m==='GET')return json(await demoOrders(e,u.searchParams.get('instId')||undefined));
if(/^\/api\/demo\/actions\/[a-f0-9-]+$/i.test(p)&&m==='GET')return json(await demoActionStatus(e,p.split('/')[4],sync));
if(p==='/api/demo/protect_tiers'&&m==='POST'){await limit(e,'demo:'+principal,20);return json(await protectTiers(e,await body(r),principal))}
if(p==='/api/demo/close'&&m==='POST'){await limit(e,'demo:'+principal,20);return json(await mcpClose(e,await body(r),sync))}
if(/^\/api\/demo\/(leverage|place|protect|amend_protection|cancel_protection|cancel_order)$/.test(p)&&m==='POST'){await limit(e,'demo:'+principal,20);return json(await demoExecute(e,p.split('/')[3],await body(r),principal,sync))}
if(p==='/api/keys'&&m==='GET')return json((await e.DB.prepare('SELECT id,name,mask,scopes,created_at,last_used_at,revoked FROM api_keys ORDER BY created_at DESC').all()).results);
if(p==='/api/keys'&&m==='POST'){const b=await body(r);if(typeof b.name!=='string'||!b.name.trim()||b.name.length>60||!Array.isArray(b.scopes)||!b.scopes.length||b.scopes.some((s:string)=>!['read','write','demo_trade','virtual_trade'].includes(s)))throw new Failure('INVALID_KEY_INPUT');const key=randomKey(),id=crypto.randomUUID();await e.DB.prepare('INSERT INTO api_keys(id,name,hash,mask,scopes,created_at) VALUES(?,?,?,?,?,?)').bind(id,b.name,await hash(key),key.slice(0,8)+'…'+key.slice(-4),JSON.stringify(b.scopes),now()).run();return json({id,key})}
if(/^\/api\/keys\/[^/]+\/scopes$/.test(p)&&m==='POST'){const b=await body(r);if(!Array.isArray(b.scopes)||!b.scopes.length||b.scopes.length>4||b.scopes.some((s:string)=>!['read','write','demo_trade','virtual_trade'].includes(s)))throw new Failure('INVALID_SCOPES');await e.DB.prepare('UPDATE api_keys SET scopes=? WHERE id=? AND revoked=0').bind(JSON.stringify([...new Set(b.scopes)]),p.split('/')[3]).run();return json({updated:true})}
if(/^\/api\/keys\/[^/]+\/revoke$/.test(p)&&m==='POST'){await e.DB.prepare('UPDATE api_keys SET revoked=1 WHERE id=?').bind(p.split('/')[3]).run();return json({revoked:true})}
if(['/api/ai/decisions','/api/ai/logs'].includes(p)){const table=p.endsWith('decisions')?'ai_decisions':'ai_logs';if(m==='GET')return json((await e.DB.prepare(`SELECT * FROM ${table} ORDER BY created_at DESC LIMIT 100`).all()).results);const b=await body(r);if(typeof b.content!=='string'||!b.content.trim()||b.content.length>8000||['symbol','direction','recommendation','source'].some(k=>b[k]!==undefined&&(typeof b[k]!=='string'||b[k].length>200)))throw new Failure('INVALID_RECORD');const id=crypto.randomUUID();await e.DB.prepare(`INSERT INTO ${table} VALUES(?,?,?)`).bind(id,now(),JSON.stringify(b)).run();return json({id})}
if(p==='/api/ai/plans'&&m==='GET')return json(await listPlans(e.DB));
if(p==='/api/ai/plans'&&m==='POST'){await limit(e,'plans:'+principal,20);return json(await createPlan(e.DB,await body(r),principal))}
if(p==='/api/system/halt'&&m==='POST'&&e.VIRTUAL_ONLY==='true'){const b=await body(r);if(typeof b?.halt!=='boolean')throw new Failure('INVALID_VIRTUAL_PAUSE');await e.DB.prepare("INSERT OR REPLACE INTO system_settings VALUES('virtual_halt',?)").bind(String(b.halt)).run();return json({halt:b.halt})}
if(p==='/api/system/halt'&&m==='POST'){await e.DB.prepare("INSERT OR REPLACE INTO system_settings VALUES('halt','true')").run();return json({halt:true,note:'Only QuantOS future instructions are blocked.'})}
if(/^\/api\/trades\/[^/]+\/close-quote$/.test(p)&&m==='GET')return json(await quote(e,decodeURIComponent(p.split('/')[3])));
if(p==='/api/trades/actions'&&m==='GET')return json((await e.DB.prepare('SELECT * FROM trade_actions ORDER BY created_at DESC LIMIT 30').all()).results);
if(/^\/api\/trades\/actions\/[^/]+\/reconcile$/.test(p)&&m==='POST')return json(await reconcile(e,p.split('/')[4],sync));
if(/^\/api\/trades\/[^/]+\/close$/.test(p)&&m==='POST'){await limit(e,'close',10);return json(await close(e,decodeURIComponent(p.split('/')[3]),await body(r),sync))}
throw new Failure('NOT_FOUND',404)}
export default {async fetch(r:Request,e:Env){try{return await route(r,e)}catch(err){return json(err instanceof Failure?err.code:'INTERNAL_ERROR',err instanceof Failure?err.status:500)}},async scheduled(_c:ScheduledController,e:Env,ctx:ExecutionContext){
 if(e.BINANCE_DEMO_ENABLED==='true')ctx.waitUntil(syncBinanceDemo(e).catch(err=>{
  console.error('binance demo cron',err instanceof Failure?err.code:'BINANCE_DEMO_SYNC_ERROR');
 }));
 ctx.waitUntil((async()=>{if(e.VIRTUAL_ONLY==='true'){try{await virtual.settle(e)}catch(err){console.error('virtual cron',err instanceof Failure?err.code:'VIRTUAL_CRON_ERROR')}}else{try{await sync(e)}catch{}try{await syncPerformance(e)}catch{}}await e.DB.batch([e.DB.prepare('DELETE FROM sync_logs WHERE id NOT IN (SELECT id FROM sync_logs ORDER BY id DESC LIMIT 1440)'),e.DB.prepare('DELETE FROM sessions WHERE expires<?').bind(Date.now()),e.DB.prepare('DELETE FROM rate_limits WHERE bucket<?').bind(Math.floor(Date.now()/60000)-10)])})())
}};
