import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const {outputFiles:[out]}=await build({entryPoints:['src/martin-engine.ts'],bundle:true,format:'esm',platform:'node',write:false});
const {martinDefaults,planMartin,simulateMartin}=await import('data:text/javascript;base64,'+Buffer.from(out.text).toString('base64'));
const start=1800000000000,step=900000;
const rules={tick:'0.01',quantityStep:'0.001',minQty:.001,maxQty:10000,minNotional:5,minPrice:.01,maxPrice:1e7,marketMinQty:.001};
const config={...martinDefaults,entry:100,quantity:1,margin:50,reserve:80,leverage:10,maxLoss:50,maxQuantity:5,maxAdds:2,shock:20};
function tape(values){
 return {symbol:'BTCUSDT',interval:'15m',from:start,to:start+values.length*step,step,rules,funding:null,
  candles:values.map(([open,high,low,close],i)=>({time:start+i*step,open,high,low,close,volume:1}))};
}
test('stress scenarios, break-even and liquidation estimate for an existing short',()=>{
 const plan=planMartin(config,tape([[100,101,99,100]]),[],100);
 assert.deepEqual(plan.scenarios.map(s=>s.shock),[6,10,20]);
 assert.ok(plan.current.breakEven<config.entry);
 assert.equal(plan.current.quantity,1);assert.equal(plan.current.margin,50);
 assert.ok(plan.current.liquidation>config.entry);
 assert.equal(plan.scenarios.at(-1).floating,-20);
 assert.ok(plan.scenarios[0].buffer>plan.scenarios[2].buffer);
});
test('staged quantities obey budgets, contract steps and max aggregate position',()=>{
 const x=planMartin(config,tape([[100,101,99,100]]),[106,112],100);
 const first=x.stages[0],last=x.stages[1];
 assert.equal(first.item.status,'OK'); assert.equal(last.item.status,'OK');
 assert.equal(first.item.quantity,1.05);
 assert.ok(last.after.quantity<=config.maxQuantity);
 assert.ok(first.after.average>config.entry);
 assert.ok(first.after.breakEven<first.after.average);
 assert.ok(first.item.stressPrice>=106*1.1);
 const deny=planMartin({...config,maxLoss:5},tape([[100,101,99,100]]),[106],100);
 assert.equal(deny.stages[0].item.status,'BLOCKED');
 assert.match(deny.stages[0].item.reason,/超出亏损预算/);
});
test('history dispatches add then exit and is causal when future K lines change',()=>{
 const a=tape([[100,106,99,105],[105,114,103,111],[111,114,90,95]]);
 const b=tape([[100,106,99,105],[105,114,103,111],[111,145,109,144]]);
 const c={...config,take:96};
 const one=simulateMartin(c,a,[106,112]),two=simulateMartin(c,b,[106,112]);
 assert.ok(one.events.filter(e=>e.kind==='ADD').length>=1);
 assert.equal(one.events.at(-1).kind,'TAKE_PROFIT');
 assert.deepEqual(one.snapshots.slice(0,2),two.snapshots.slice(0,2));
 assert.ok(one.events.at(-1).fee>0);
 assert.deepEqual(one,simulateMartin(c,structuredClone(a),[106,112]));
});
test('stop has priority over take profit and new add, and liquidation is labelled when gapping',()=>{
 const first=simulateMartin({...config,stop:108,take:95},tape([[100,110,94,101]]),[106]);
 assert.deepEqual(first.events.map(e=>e.kind),['STOP_LOSS']);
 const gap=simulateMartin({...config,margin:15,maxLoss:100},tape([[125,132,110,127]]),[106]);
 assert.deepEqual(gap.events.map(e=>e.kind),['ESTIMATED_LIQUIDATION']);
});
