import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const {outputFiles:[bundle]}=await build({entryPoints:['worker/pathmatch-core.ts'],bundle:true,format:'esm',platform:'node',write:false});
const {parsePlan,match,atr14}=await import('data:text/javascript;base64,'+Buffer.from(bundle.text).toString('base64'));
const M=60000,start=1800000000000;
const plan={strategyVersion:'2.6-pathmatch',symbol:'BTCUSDT',exchange:'BINANCE_DEMO',direction:'LONG',referenceTime:start-M,
 referencePrice:100,expiresAt:start+5*M,source:'Test fixture',forecast:{interval:'5m',candles:[
  {direction:'UP',close:105,high:110,low:99,invalidatesWhen:'below 90'},
  {direction:'UP',close:110,high:114,low:104,invalidatesWhen:'below 90'},
  {direction:'FLAT',close:110,high:114,low:104,invalidatesWhen:'below 90'}]},
 entry:{type:'LIMIT',price:103,priceMin:99,priceMax:108},hardInvalidation:90,
 risk:{leverage:10,quantity:0.01,stopLoss:98,takeProfit:115,maxLossUsdt:0.35,estimatedLossCostsUsdt:0.01,estimatedWinCostsUsdt:0.01},
 context:{trend4h:'LONG',trend1h:'LONG',structure15m:'CONFIRMED',entry5m:'REVIEW_REQUIRED',dailyFilter:'PASS',directionScore:80,entryScore:80},
 validation:{similarityThreshold:85,minimumClosed1mCandles:3,maximumValidationMinutes:5,atrTolerance:0.5}};
const candles=(closes)=>closes.map((c,i)=>({time:start+i*M,open:c-0.5,high:c+0.1,low:c-0.6,close:c}));
test('strict schema rejects live, unknown fields, expired timestamp and wrong stop side',()=>{
 assert.equal(parsePlan(plan,start-1000).exchange,'BINANCE_DEMO');
 for(const bad of [{...plan,exchange:'BINANCE_LIVE'},{...plan,extra:true},{...plan,referenceTime:start+M},{...plan,risk:{...plan.risk,stopLoss:110}}])
   assert.throws(()=>parsePlan(bad,start-1000));
});
test('exactly 85 is a matched path and still calls for separate execution review',()=>{
 const r=match(plan,start,1,candles([101.375,102.375,103.375]),start+3*M);
 assert.equal(r.similarity,85);assert.equal(r.reason,'PATH_MATCHED_EXECUTION_RISK_REVIEW_REQUIRED');assert.equal(r.status,'VALIDATING');
});
test('hard invalidation, outside-channel and below 75 take precedence',()=>{
 const hard=candles([101,102,103]);hard[2].low=90;
 assert.equal(match(plan,start,1,hard,start+3*M).reason,'HARD_INVALIDATION');
 assert.equal(match(plan,start,1,candles([111]),start+M).reason,'OUTSIDE_FORECAST_CHANNEL');
 assert.equal(match(plan,start,1,candles([102,103,104]),start+3*M).reason,'BELOW_SIMILARITY_FLOOR');
});
test('duplicate, missing, or incomplete minute candle fails closed',()=>{
 assert.equal(match(plan,start,1,candles([101,102]),start+M).status,'ERROR');
 const rows=candles([101,102,103]);rows[1].time+=M;
 assert.equal(match(plan,start,1,rows,start+4*M).status,'ERROR');
 assert.equal(match(plan,start,1,[],start+M).reason,'INSUFFICIENT_CLOSED_MINUTES');
});
test('price outside entry range never marks the path as actionable',()=>{
 const p={...plan,entry:{type:'LIMIT',price:100,priceMin:99,priceMax:101}};
 assert.equal(match(p,start,1,candles([101,102,103]),start+3*M).reason,'OUTSIDE_ENTRY_RANGE');
});
test('ATR uses fourteen true ranges and requires continuous closed samples',()=>{
 const rows=Array.from({length:15},(_,i)=>({time:start+i*5*M,open:100,high:101,low:99,close:100}));
 assert.equal(atr14(rows),2);rows[13].time+=5*M;
 assert.throws(()=>atr14(rows),/ATR_GAP/);
});
const {outputFiles:[storeBundle]}=await build({entryPoints:['worker/pathmatch-store.ts'],bundle:true,format:'esm',platform:'node',write:false});
const {createPrediction,armPrediction,monitorPredictions,cancelPrediction,predictionStatus}=await import('data:text/javascript;base64,'+Buffer.from(storeBundle.text).toString('base64'));
const {DatabaseSync}=await import('node:sqlite');
const {readFileSync}=await import('node:fs');
function db(){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(readFileSync('migrations/0010_pathmatch.sql','utf8'));
 return {prepare(sql){return {all:()=>({results:sqlite.prepare(sql).all()}),bind(...args){return {
  first:()=>sqlite.prepare(sql).get(...args)??null,
  all:()=>({results:sqlite.prepare(sql).all(...args)}),
  run:()=>({meta:{changes:sqlite.prepare(sql).run(...args).changes}})
 }}}}};
}
function relay(now,onRequest){
 return {fetch:async (url,request)=>{
   const {target}=JSON.parse(request.body);
   onRequest?.(target);
   if(target.endsWith('/time'))return Response.json({serverTime:now});
   const params=new URL(target,'https://sample.invalid').searchParams;
   const span=params.get('interval')==='5m'?5*M:M;
   const end=Math.floor(now/span)*span;
   return Response.json(Array.from({length:+params.get('limit')},(_,i)=>{
     const open=end-(+params.get('limit')-i)*span;
     return [open,'100','101','99','100','2',open+span-1];
   }));
 }};
}
test('draft replay, immutability, authenticated shadow arm and cancellation',async(t)=>{
 const now=start-10000;
 t.mock.method(Date,'now',()=>now);
 const database=db(),id='a'.repeat(32),input={id,plan};
 const first=await createPrediction(database,input);
 assert.equal(first.state,'DRAFT');
 assert.deepEqual(await createPrediction(database,input),first);
 await assert.rejects(createPrediction(database,{id,plan:{...plan,source:'edited'}}),/PATHMATCH_ID_CONFLICT/);
 await assert.rejects(armPrediction(database,relay(now),{id,mode:'DEMO_AUTO',confirm:true}),/PATHMATCH_SHADOW_AUTHORIZATION_REQUIRED/);
 const locked=await armPrediction(database,relay(now),{id,mode:'SHADOW',confirm:true});
 assert.equal(locked.startAt,start);
 assert.equal(locked.atr,2);
 assert.deepEqual(await armPrediction(database,relay(now),{id,mode:'SHADOW',confirm:true}),locked);
 assert.equal((await cancelPrediction(database,{id,confirm:true})).state,'CANCELED');
 assert.equal((await predictionStatus(database,id)).mode,'SHADOW');
});
test('D1 survives worker restart, symbol gets one upstream query, expiry cannot submit',async(t)=>{
 const now=start-10000;
 t.mock.method(Date,'now',()=>now);
 const database=db(),ids=['b'.repeat(32),'c'.repeat(32)];
 for(const id of ids){
  await createPrediction(database,{id,plan});
  await armPrediction(database,relay(now),{id,mode:'SHADOW',confirm:true});
 }
 let calls=0;
 await monitorPredictions(database,relay(start+2*M,()=>calls++),start+2*M);
 assert.equal(calls,1);
 assert.equal((await predictionStatus(database,ids[0])).result.points.length,2);
 await monitorPredictions(database,relay(start+5*M),start+5*M);
 const result=await predictionStatus(database,ids[0]);
 assert.ok(['EXPIRED','CANCELED'].includes(result.state));
 assert.equal(result.execution,'DISABLED_PENDING_INDEPENDENT_ACCEPTANCE');
});
