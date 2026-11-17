import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
async function bundle(entry){
 const {outputFiles:[out]}=await build({entryPoints:[entry],bundle:true,format:'esm',platform:'node',write:false});
 return import('data:text/javascript;base64,'+Buffer.from(out.text).toString('base64'));
}
const {defaults,channelBox,channelLevels,moveChannelStart,gridLevels,simulateGrid}=await bundle('src/grid-engine.ts');
const {gridMarket}=await bundle('worker/grid-market.ts');
const base=1794873600000, minute=60000;
const rules={tick:'0.01',quantityStep:'0.001',minQty:.001,maxQty:50000,minNotional:5,minPrice:.01,maxPrice:100000,marketMinQty:.001};
function market(matrix,funding=null){
 return {symbol:'BTCUSDT',interval:'1m',step:minute,requestedFrom:base,from:base,to:base+matrix.length*minute,rules,
  funding,candles:matrix.map(([open,high,low,close],i)=>({time:base+i*minute,open,high,low,close,volume:10}))};
}
const config={...defaults,lower:90,upper:120,maxLoss:0,drawdown:0,maxPositions:1,fundingMode:'OFF'};
test('six arithmetic intervals and tick-safe geometric levels, including low priced contracts',()=>{
 assert.deepEqual(gridLevels(config,rules),[90,95,100,105,110,115,120]);
 const low={...rules,tick:'0.000001',minPrice:.000001};
 assert.deepEqual(gridLevels({lower:.000001,upper:.000008,count:3,spacing:'GEOMETRIC'},low),[.000001,.000002,.000004,.000008]);
 assert.throws(()=>gridLevels({lower:.000001,upper:.000004,count:6,spacing:'LINEAR'},low),/减少格数/);
});
test('short execution waits a bar before exit and applies actual position size and fee',()=>{
 const data=market([[101,106,99,104],[104,104,99,100]]);
 const next=simulateGrid(data,config),again=simulateGrid(structuredClone(data),structuredClone(config));
 assert.deepEqual(next,again);
 assert.equal(next.frames[0].done,0);
 assert.equal(next.frames[0].open[0].entry,105);
 assert.equal(next.trades.length,1);
 const trade=next.trades[0];
 assert.equal(trade.exit,100);
 assert.equal(trade.qty,.476);
 assert.ok(Math.abs(trade.net-(trade.gross-trade.fees))<1e-10);
 assert.ok(Math.abs(next.last.equity-(80+trade.net))<1e-10);
});
test('hard stop wins when a bar also touches the target, with gap and taker slippage',()=>{
 const result=simulateGrid(market([[101,106,99,104],[113,115,99,100]]),{...config,upper:110,lower:90,count:4,stopUpper:112});
 assert.equal(result.state,'HALTED');
 assert.equal(result.stops,1);
 assert.equal(result.trades[0].reason,'HARD_STOP');
 assert.ok(result.trades[0].exit>113);
 assert.equal(result.last.open.length,0);
 assert.ok(result.last.equity<80);
 assert.ok(result.frames[1].events.every(e=>e.kind!=='OPEN'));
});
test('breakouts halt, hold blocks new entries, pause closes the current box',()=>{
 const data=market([[101,106,99,104],[104,111,99,109],[109,110,104,107]]);
 const profile={...config,upper:110,count:4};
 const out=simulateGrid(data,profile);
 assert.equal(out.state,'HALTED');assert.equal(out.trades[0].reason,'BREAKOUT_EXIT');assert.equal(out.frames.length,2);
 assert.equal(simulateGrid(data,{...profile,up:'PAUSE'}).state,'PAUSED');
 const held=simulateGrid(data,{...profile,up:'HOLD'});
 assert.equal(held.state,'RUNNING');
 assert.ok(held.frames.slice(1).every(f=>f.events.every(e=>e.kind!=='OPEN')));
});
test('funding, drawdown and minimum order constraints enter the equity calculation',()=>{
 const input=market([[101,106,99,104],[104,104,99,100]],[{time:base+minute,rate:.001,mark:104}]);
 const result=simulateGrid(input,{...config,fundingMode:'HISTORY'});
 assert.ok(result.last.funding>0);
 assert.equal(result.trades[0].funding,result.last.funding);
 assert.ok(Math.abs(result.last.net-result.trades[0].net)<1e-10);
 const tiny=simulateGrid(input,{...config,size:.01});
 assert.equal(tiny.last.done,0);assert.ok(tiny.rejectedOrders>0);
 const dd=simulateGrid(market([[101,106,99,104],[104,112,103,110]]),{...config,drawdown:2,maxPositions:2});
 assert.equal(dd.trades[0].reason,'DRAWDOWN_LIMIT');
});
function stub(symbol,gaps=false){
 let reads=0;
 const relay={fetch:async(_url,r)=>{
  const {target}=JSON.parse(r.body),u=new URL(target,'https://fixture.test');
  if(u.pathname.endsWith('exchangeInfo'))return Response.json({symbols:[{symbol,status:'TRADING',contractType:'PERPETUAL',quoteAsset:'USDT',marginAsset:'USDT',
   filters:[{filterType:'PRICE_FILTER',tickSize:'0.01',minPrice:'0.01',maxPrice:'99999'},{filterType:'LOT_SIZE',stepSize:'0.001',minQty:'0.001',maxQty:'50000'},{filterType:'MIN_NOTIONAL',notional:'5'}]}]});
  const start=+u.searchParams.get('startTime'),end=+u.searchParams.get('endTime');
  if(u.pathname.endsWith('fundingRate')) return Response.json([{fundingTime:start,fundingRate:'0.0001',markPrice:'103'}]);
  reads++;
  const rows=Array.from({length:Math.round((end+1-start)/minute)},(_,i)=>[start+i*minute,'100','101','99','100','12',start+(i+1)*minute-1]);
  return Response.json(gaps?rows.slice(1):[...rows,rows[0]]);
 }};
 return {relay,reads:()=>reads};
}
test('market normalizes symbol, paginates historical candles, deduplicates and reads funding',async()=>{
 const pair='FIXTUREUSDT', source=stub(pair);
 const query=new URLSearchParams({symbol:pair.toLowerCase(),interval:'1m',from:String(base),to:String(base+1001*minute),funding:'1'});
 const got=await gridMarket(query,source.relay,base+1002*minute);
 assert.equal(source.reads(),2);assert.equal(got.candles.length,1001);assert.equal(got.symbol,pair);assert.equal(got.funding[0].rate,.0001);
});
test('market rejects missing time slots and invalid time ranges',async()=>{
 const source=stub('FIXTUREUSDT',true);
 const query=new URLSearchParams({symbol:'FIXTUREUSDT',interval:'1m',from:String(base),to:String(base+33*minute)});
 await assert.rejects(gridMarket(query,source.relay,base+35*minute),/GRID_KLINE_GAPS/);
 query.set('from',String(base+44*minute));
 await assert.rejects(gridMarket(query,source.relay,base+45*minute),/GRID_INVALID_RANGE/);
});

test('independent slopes project prices per candle and reject crossing boundaries',()=>{
 const flat={...config,lower:90,upper:110,count:4};
 assert.deepEqual(channelLevels({...flat,upperAngle:45,lowerAngle:0},rules,.5),[90,97.5,105,112.5,120]);
 assert.deepEqual(channelLevels({...flat,upperAngle:45,lowerAngle:45},rules,.5),[100,105,110,115,120]);
 assert.throws(()=>channelLevels({...flat,upperAngle:-45,lowerAngle:45},rules,1),/箱体/);
 assert.throws(()=>channelLevels({...flat,upperAngle:81},rules,1),/角度/);
 const tape=market([[101,104,100,102],[102,106,101,105],[105,107,104,106],[106,107,105,106]]);
 const ordinary=simulateGrid(tape,flat);
 const shifted=simulateGrid(tape,{...flat,upperAngle:30,lowerAngle:30});
 assert.equal(ordinary.frames[1].open[0].entry,105);
 assert.equal(shifted.frames[1].open[0]?.entry,102.89);
 assert.equal(ordinary.frames[0].events.length,shifted.frames[0].events.length);
});

test('moving the left boundary preserves both right endpoint prices',()=>{
 const base={...config,upperAngle:20,lowerAngle:-10};
 const initialEnd=channelBox(base,1);
 const moved=moveChannelStart(base,rules,'upper',115,0);
 assert.equal(moved.upper,115);
 assert.equal(moved.lower,base.lower);
 const nextEnd=channelBox(moved,1);
 assert.ok(Math.abs(nextEnd.upper-initialEnd.upper)<1e-9);
 assert.ok(Math.abs(nextEnd.lower-initialEnd.lower)<1e-9);
 const right=channelBox(moveChannelStart(base,rules,'lower',96,.25),1);
 assert.ok(Math.abs(right.lower-initialEnd.lower)<1e-9);
 assert.throws(()=>moveChannelStart(base,rules,'upper',base.lower-1,0),/交叉/);
});
