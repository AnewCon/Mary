import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const load=async entry=>{
  const {outputFiles:[file]}=await build({entryPoints:[entry],bundle:true,platform:'node',format:'esm',write:false});
  return import('data:text/javascript;base64,'+Buffer.from(file.text).toString('base64'));
};
const {change,ingestOI,oiHistory}=await load('worker/oi-history.ts');
const {signal25}=await load('worker/signal-v25.ts');
const {analyzeMarket}=await load('worker/market-analyze.ts');

function db(){
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(fs.readFileSync('migrations/0009_oi_snapshots.sql','utf8'));
  return {
    prepare(sql){return {bind(...args){return {
      first:()=>sqlite.prepare(sql).get(...args)??null,
      run:()=>({meta:{changes:sqlite.prepare(sql).run(...args).changes}}),
    }}}},
    batch(statements){sqlite.exec('BEGIN');try{const result=statements.map(s=>s.run());sqlite.exec('COMMIT');return result}
      catch(e){sqlite.exec('ROLLBACK');throw e;}}
  };
}
const step=900000;
const now=Math.floor(Date.now()/step)*step;
function row(amount,offset,mark='100',symbol='BTCUSDT') {
  return {symbol,open_interest:amount,open_interest_value:null,mark_price:mark,source_timestamp:now+offset,
    fetched_at:now+offset+300};
}

test('preserves decimals and atomically deduplicates identical snapshots and slots',async()=>{
  const database=db();
  const a=row('100.000000000000000000004',-step+2000);
  assert.equal((await ingestOI(database,[a])).writes,1);
  assert.equal((await ingestOI(database,[a,{...a,source_timestamp:a.source_timestamp+1000,fetched_at:a.fetched_at+1000}])).writes,0);
  const actual=await oiHistory(database,'BTC',15,now);
  assert.equal(actual.latest.open_interest,a.open_interest);
  assert.equal(change('12.0000000000000000001','10'),20);
  await assert.rejects(ingestOI(database,[row('9',step)]),/OI_INVALID_SAMPLE/);
});

test('same contract and historical cutoffs with no future or missing baseline substitution',async()=>{
  const database=db();
  await ingestOI(database,[row('100',-4*step+100,'90'),row('110',-step+200,'100'),
    row('120',-step*2+900,'95'),row('105',-step*5+300,'90'),row('999',-step*5+200,'55','ETHUSDT')]);
  const actual=await oiHistory(database,'BTC',15,now);
  assert.equal(actual.changes['15m'].changePct,-8.333333);
  assert.equal(actual.changes['15m'].quadrant,'PRICE_UP_OI_DOWN');
  assert.equal(actual.changes['1h'].changePct,4.761904);
  assert.equal(actual.changes['24h'].status,'INSUFFICIENT_DATA');
  assert.equal((await oiHistory(database,'BTC',15,now+6*step)).changes['15m'].reason,'STALE_LATEST');
});

test('experimental strategy waits on incomplete or future inputs',()=>{
  const out=signal25({ '15m':[{time:now+1}] },null,{},undefined,now);
  assert.equal(out.recommendation,'WAIT');
  assert.equal(out.entryScore,null);
  assert.ok(out.missing.includes('1h OI 变化'));
});

test('aggregate tolerates a failed upstream and keeps an empty OI section',async()=>{
  const cache=new Map();
  globalThis.caches={default:{
    match:async key=>cache.get(key.url)?.clone(),
    put:async (key,response)=>{cache.set(key.url,response.clone());},
  }};
  const relay={fetch:async()=>new Response(null,{status:503})};
  const ctx={waitUntil(){}};
  const out=await analyzeMarket(db(),{symbol:'BTC',include:['oi_history','derivatives']},ctx,relay,15);
  assert.equal(out.status,'PARTIAL');
  assert.equal(out.observed[0].error,'BYBIT_HTTP_503');
  assert.equal(out.derived.oiHistory.status,'INSUFFICIENT_DATA');
});

test('provider cache returns the same snapshot until the cache expires',async()=>{
  const cache=new Map();
  let calls=0;
  globalThis.caches={default:{
    match:async key=>cache.get(key.url)?.clone(),
    put:async (key,response)=>{cache.set(key.url,response.clone());},
  }};
  const relay={fetch:async()=>{
    calls++;
    return Response.json({events:[{ts:Date.now(),side:'long_liquidated',notional:3}]});
  }};
  const ctx={waitUntil(){}};
  const request={symbol:'BTC',include:['recent_liquidations']};
  const first=await analyzeMarket(db(),request,ctx,relay,15);
  const cached=await analyzeMarket(db(),request,ctx,relay,15);
  assert.equal(calls,1);
  assert.equal(first.observed[0].fetchedAt,cached.observed[0].fetchedAt);
  cache.clear();
  await analyzeMarket(db(),request,ctx,relay,15);
  assert.equal(calls,2);
});
test('demo bracket retry retains the original confirmed request and rejects changes',async()=>{
  const {enqueueDemo}=await load('worker/binance-demo-queue.ts');
  const database=db();
  await database.prepare('CREATE TABLE binance_demo_actions(id TEXT PRIMARY KEY,payload TEXT,state TEXT,result TEXT,created_at TEXT)').bind().run();
  const action={id:'d'.repeat(32),kind:'bracket',symbol:'BTCUSDT',side:'LONG',quantity:'0.01',
    price:'100',stopLoss:'90',takeProfit:'120',leverage:10,confirm:true};
  assert.deepEqual(await enqueueDemo(database,action),await enqueueDemo(database,action));
  await assert.rejects(
    enqueueDemo(database,{...action,id:'e'.repeat(32),strategyVersion:'2.5-experimental',entryScore:80}),
    /DEMO_V25_EXECUTION_POLICY_NOT_ALIGNED/
  );
  const record=await database.prepare('SELECT payload,COUNT(*) AS entries FROM binance_demo_actions').bind().first();
  assert.equal(record.entries,1);
  assert.equal(JSON.parse(record.payload).leverage,10);
  await assert.rejects(enqueueDemo(database,{...action,price:'101'}),/BINANCE_DEMO_REQUEST_CONFLICT/);
});
