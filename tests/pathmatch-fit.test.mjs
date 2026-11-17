import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

const out=await build({entryPoints:['src/pathmatch-fit.ts'],bundle:true,format:'esm',platform:'node',write:false});
const {adjustForecast,compareForecast,originalFitParams}=await import('data:text/javascript;base64,'+Buffer.from(out.outputFiles[0].text).toString('base64'));
const start=1800000000000;
const candles=Array.from({length:15},(_,i)=>({time:start+i*60000,open:100+i,close:101+i,high:103+i,low:99+i}));
const plan={forecast:{interval:'1m',candles},direction:'LONG',referencePrice:100,
 entry:{priceMin:90,priceMax:120},hardInvalidation:80,validation:{similarityThreshold:85}};

test('default parameters preserve the frozen forecast and match the original evaluation',()=>{
 assert.strictEqual(adjustForecast(plan,originalFitParams,10),candles);
 const fit=compareForecast(plan,candles,candles,start,10);
 assert.equal(fit.similarity,100);
 assert.equal(compareForecast(plan,candles,[],start,10),null);
 assert.equal(compareForecast(plan,candles,candles.slice(1),start,10),null);
});
test('scale the trend and wick separately while preserving timestamps, OHLC order and the input',()=>{
 const original=structuredClone(candles);
 const scaled=adjustForecast(plan,{slope:50,wick:200,pullback:0},10);
 assert.deepEqual(scaled.map(c=>c.time),candles.map(c=>c.time));
 assert.deepEqual(scaled[0],{time:start,open:100,close:100.5,high:104.5,low:98});
 assert.equal(scaled[14].close,107.5);
 assert.ok(scaled.every(c=>c.low<=Math.min(c.open,c.close)&&c.high>=Math.max(c.open,c.close)));
 assert.deepEqual(candles,original);
 assert.ok(compareForecast(plan,scaled,candles,start,10).similarity<100);
});
test('ATR pullback peaks at two minutes, reverts at six and rejects invalid prices',()=>{
 const params={...originalFitParams,pullback:50};
 const adjusted=adjustForecast(plan,params,10);
 assert.equal(adjusted[1].close,candles[1].close-5);
 assert.equal(adjusted[5].close,candles[5].close);
 assert.equal(adjusted[2].open,adjusted[1].close);
 assert.equal(adjustForecast(plan,params,null),null);
 assert.equal(adjustForecast(plan,params,1000),null);
 assert.equal(adjustForecast(plan,{...params,wick:-5},10),null);
});
