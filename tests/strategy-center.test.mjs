import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const example=JSON.parse(readFileSync('docs/strategies/strategy-center.example.json','utf8'));
const bundle=async entry=>(await build({entryPoints:[entry],bundle:true,write:false,format:'esm',platform:'browser'})).outputFiles[0].text;
let mf,db,cookie,reader,trader;
const host='https://strategy.test';
before(async()=>{
 const [api,mcp]=await Promise.all([bundle('worker/index.ts'),bundle('mcp/index.ts')]);
 mf=new Miniflare(convertV4MiniflareOptions({workers:[
  {name:'quantos',modules:true,script:api,compatibilityDate:'2026-11-01',d1Databases:['DB'],durableObjects:{MARKET_RELAY:'MarketRelay'},bindings:{ADMIN_PASSWORD:'test-strategy-password',SESSION_SECRET:'test-strategy-session',BINANCE_DEMO_RELAY_TOKEN:'isolated-fake-token',MCP_DEMO_TRADING_ENABLED:'true'}},
  {name:'mcp',modules:true,script:mcp,compatibilityDate:'2026-11-01',serviceBindings:{API:'quantos'}}
 ]}));
 db=await mf.getD1Database('DB','quantos');
 for(const migration of ['0001','0007_binance_demo','0010_pathmatch','0011_pathmatch_deleted_at']){
  for(const sql of readFileSync('migrations/'+migration+'.sql','utf8').split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
 }
 for(const sql of readFileSync('migrations/0012_strategy_center.sql','utf8').trim().split(/\n(?=CREATE )/))await db.prepare(sql).run();
 const login=await request('/login',{password:'test-strategy-password'});
 assert.equal(login.status,200);
 cookie=login.cookie;
 reader=(await request('/keys',{name:'test strategy MCP',scopes:['read','write']})).data.key;
 trader=(await request('/keys',{name:'test strategy trade gate',scopes:['read','demo_trade']})).data.key;
});
after(async()=>{await mf?.dispose()});
async function request(path,body,token,origin){
 const worker=await mf.getWorker('quantos');
 const headers={};
 if(token)headers.Authorization='Bearer '+token;
 else if(cookie)headers.Cookie=cookie;
 if(origin)headers.Origin=origin;
 const r=await worker.fetch(host+'/api'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
 return {status:r.status,cookie:r.headers.get('set-cookie')?.split(';')[0],...(r.headers.get('Content-Type')?.includes('application/json')?await r.json():{})};
}
async function mcp(method,params){
 const worker=await mf.getWorker('mcp');
 const r=await worker.fetch(host+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+reader,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
 return (await r.json()).result;
}
const id=example.config.strategyId;
const input=(version,extra={})=>({strategyId:id,version,name:example.name,document:example.document,
 config:{...structuredClone(example.config),version,...extra},changeNote:'fixture'});
const manage=(op,data)=>request('/strategies/'+op,data);
const transition=(op,version,extra)=>manage(op,{strategyId:id,version,...extra});
async function published(version,extra={}){
 const created=await manage('create',input(version,extra));
 assert.equal(created.status,200,JSON.stringify(created.error));
 assert.equal((await transition('validate',version,{revision:1})).data.state,'VALIDATED');
 assert.equal((await transition('publish',version,{revision:2,confirm:true})).data.state,'PUBLISHED');
}
test('MCP exposes full read-only definitions and missing ACTIVE fails closed',async()=>{
 assert.equal((await request('/strategies/active')).status,404);
 const list=await mcp('tools/list');
 const strategy=list.tools.filter(t=>t.name.startsWith('quantos_strategy_'));
 assert.equal(strategy.length,6);
 assert.ok(strategy.every(t=>t.annotations.readOnlyHint&&t.outputSchema));
 const missing=await mcp('tools/call',{name:'quantos_strategy_active',arguments:{}});
 assert.equal(missing.structuredContent.data.code,'STRATEGY_NO_ACTIVE');
 const gate=await request('/binance-demo/action',{kind:'bracket'},trader);
 assert.equal(gate.error.code,'STRATEGY_NO_ACTIVE');
 assert.equal(await db.prepare('SELECT count(*) n FROM binance_demo_actions').first('n'),0);
 assert.equal((await request('/strategies/create',input('2.6.9'),reader)).status,401);
 assert.equal((await request('/strategies/create',input('2.6.9'),undefined,'https://other.test')).status,403);
});
test('validates schema, rejects duplicate and unauthorized state transitions',async()=>{
 const bad=input('2.6.1',{riskManagement:{...example.config.riskManagement,leverage:11},featureFlags:{derivativesExperimental:true,pathMatchAuto:true}});
 const preview=(await manage('preview',{config:bad.config})).data;
 assert.equal(preview.compatible,false);
 assert.ok(preview.errors.some(e=>e.includes('leverage')));
 assert.ok(preview.errors.some(e=>e.includes('pathMatchAuto')));
 assert.equal((await manage('create',bad)).status,200);
 assert.equal((await manage('create',bad)).status,409);
 assert.equal((await transition('validate','2.6.1',{revision:1})).data.validated,false);
 const edit=await manage('edit',{...input('2.6.1'),revision:1});
 assert.equal(edit.data.revision,2);
 assert.equal((await transition('validate','2.6.1',{revision:2})).data.state,'VALIDATED');
 assert.equal((await transition('publish','2.6.1',{revision:3})).status,409);
 assert.equal((await request('/strategies/publish',{strategyId:id,version:'2.6.1',revision:3,confirm:true},reader)).status,401);
 assert.equal((await transition('publish','2.6.1',{revision:3,confirm:true})).data.state,'PUBLISHED');
 assert.equal((await manage('edit',{...input('2.6.1'),revision:4})).status,409);
 await assert.rejects(db.prepare("UPDATE strategy_versions SET document='changed' WHERE version='2.6.1'").run(),/STRATEGY_IMMUTABLE/);
});
test('atomic activation/rollback, complete MCP and version-drift gate',async()=>{
 await published('2.6.2',{scoring:{...example.config.scoring,minimumEntry:82}});
 await published('2.6.3',{scoring:{...example.config.scoring,minimumEntry:84}});
 const first=await transition('activate','2.6.1',{generation:0,confirm:true});
 assert.equal(first.data.generation,1);
 const params={generation:1,confirm:true};
 const both=await Promise.all(['2.6.2','2.6.3'].map(v=>transition('activate',v,params)));
 assert.deepEqual(both.map(o=>o.status).sort(),[200,409]);
 const active=(await mcp('tools/call',{name:'quantos_strategy_active',arguments:{}})).structuredContent.data;
 assert.equal(active.generation,2);
 assert.match(active.contentHash,/^[a-f0-9]{64}$/);
 assert.deepEqual(active.config,input(active.version,{scoring:{...example.config.scoring,minimumEntry:active.version==='2.6.2'?82:84}}).config);
 assert.equal(active.document,example.document);
 assert.equal(active.executionAuthorized,false);
 const blocked=await request('/binance-demo/action',{kind:'bracket',strategy:active},trader);
 assert.equal(blocked.error.code,'STRATEGY_EXECUTION_NOT_ACCEPTED');
 const stale=await request('/binance-demo/action',{kind:'bracket',strategy:first.data},trader);
 assert.equal(stale.error.code,'STRATEGY_CHANGED_OR_UNBOUND');
 const rollback=await transition('rollback','2.6.1',{generation:2,confirm:true});
 assert.equal(rollback.data.generation,3);
 assert.equal(rollback.data.contentHash,first.data.contentHash);
 const diff=(await request('/strategies/compare?strategyId='+id+'&fromVersion=2.6.1&toVersion='+active.version)).data;
 assert.ok(diff.changes.some(change=>change.path==='scoring.minimumEntry'));
 const audit=(await request('/strategies/history?strategyId='+id)).data.items;
 assert.deepEqual(audit.slice(0,3).map(r=>r.operation),['ROLLBACK','ACTIVATE','ACTIVATE']);
});
test('PathMatch attaches a verified immutable version and filters stale bindings',async()=>{
 const strategy=(await request('/strategies/active')).data;
 const now=Math.floor(Date.now()/60000)*60000,start=now+60000;
 const plan={strategyVersion:'2.6-pathmatch',symbol:'BTCUSDT',exchange:'BINANCE_DEMO',direction:'LONG',referenceTime:now,referencePrice:100,
  expiresAt:start+900000,source:'isolated fixture',forecast:{interval:'1m',candles:Array.from({length:15},(_,i)=>({time:start+i*60000,open:100,high:101,low:99,close:100}))},
  entry:{type:'LIMIT',price:100,priceMin:98,priceMax:102},hardInvalidation:90,risk:{leverage:10,quantity:.01,stopLoss:98,takeProfit:104,maxLossUsdt:.35,estimatedLossCostsUsdt:.01,estimatedWinCostsUsdt:.01},
  context:{trend4h:'LONG',trend1h:'LONG',structure15m:'CONFIRMED',entry5m:'REVIEW_REQUIRED',dailyFilter:'PASS',directionScore:80,entryScore:80},
  validation:{similarityThreshold:85,minimumClosed1mCandles:3,maximumValidationMinutes:15,atrTolerance:.5}};
 const predictionId='6'.repeat(32);
 const create=await request('/predictions/create',{id:predictionId,plan,strategy});
 assert.equal(create.status,200,JSON.stringify(create.error));
 assert.equal(create.data.strategy?.contentHash,strategy.contentHash);
 assert.equal((await request('/predictions/create',{id:predictionId,plan,strategy})).status,200);
 const wrong=await request('/predictions/create',{id:'7'.repeat(32),plan:{...plan,validation:{...plan.validation,similarityThreshold:86}},strategy});
 assert.equal(wrong.error.code,'PATHMATCH_STRATEGY_POLICY_MISMATCH');
 const arm=await request('/predictions/arm',{id:predictionId,mode:'DEMO_AUTO',confirm:true});
 assert.equal(arm.error.code,'PATHMATCH_SHADOW_AUTHORIZATION_REQUIRED');
 const archived=(await request('/strategies/list?state=ARCHIVED')).data.items[0];
 await transition('rollback',archived.version,{generation:strategy.generation,confirm:true});
 assert.equal((await request('/predictions/create',{id:'8'.repeat(32),plan,strategy})).error.code,'STRATEGY_CHANGED_OR_UNBOUND');
 assert.equal((await request('/predictions/status?id='+predictionId)).data.strategy.contentHash,strategy.contentHash);
 const stats=(await request('/strategies/performance?strategyId='+id+'&version='+strategy.version)).data;
 assert.equal(stats.shadow.count,1);
 assert.equal(stats.shadow.status,'INSUFFICIENT_DATA');
 assert.equal(stats.demo.status,'INSUFFICIENT_DATA');
});
