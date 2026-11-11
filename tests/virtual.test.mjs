import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createMarketRelay } from '../scripts/binance-market-relay.mjs';

const oneMinute=60000;
const boundary=Math.floor(Date.now()/oneMinute)*oneMinute;
const symbol='ACTUSDT';
const bar=(time,open,high,low,close)=>[time,open,high,low,close,'1',time+oneMinute-1];
let mf, mcp, cookie, key, readKey;
let price='0.001',quoteTime=Date.now(),bars=[],trades=[];
const marketRequests=[];
const json=value=>Response.json(value);
const relayToken='fixture-only-quantos-market-relay-token';
const relayMode=process.env.QUANTOS_TEST_MARKET_RELAY==='1';
const relay=createMarketRelay(relayToken,{fetchUpstream:(url,options)=>outbound(new Request(url,options))});
async function outbound(request){
 const u=new URL(request.url);marketRequests.push(u.pathname);
 assert.equal(u.origin,'https://fapi.binance.com');assert.equal(request.method,'GET');assert.equal(request.headers.has('X-MBX-APIKEY'),false);
 if(u.pathname.endsWith('exchangeInfo'))return json({symbols:[{symbol,status:'TRADING',contractType:'PERPETUAL',marginAsset:'USDT',filters:[
  {filterType:'MARKET_LOT_SIZE',stepSize:'0.01',minQty:'0.01',maxQty:'100000000'},
  {filterType:'PRICE_FILTER',tickSize:'0.00000001'},{filterType:'MIN_NOTIONAL',notional:'0.01'}]}]});
 if(u.pathname.endsWith('ticker/price'))return json({symbol,price,time:quoteTime});
 if(u.pathname.endsWith('aggTrades'))return json(trades.filter(r=>r.T>=Number(u.searchParams.get('startTime'))&&r.T<=Number(u.searchParams.get('endTime'))));
 if(u.pathname.endsWith('klines'))return json(bars.filter(row=>row[0]>=Number(u.searchParams.get('startTime'))&&row[0]<=Number(u.searchParams.get('endTime'))));
 throw Error('Unexpected '+u.pathname);
}
before(async()=>{
 const codes=await Promise.all(['worker/index.ts','mcp/index.ts'].map(entry=>build({entryPoints:[entry],bundle:true,write:false,format:'esm',platform:'browser'})));
 mf=new Miniflare(convertV4MiniflareOptions({workers:[
  {name:'api',modules:true,script:codes[0].outputFiles[0].text,compatibilityDate:'2026-11-01',d1Databases:['DB'],
   outboundService:relayMode?(request)=>{assert.equal(new URL(request.url).origin,'https://relay.quant.test');return relay(request)}:outbound,
   bindings:{ADMIN_PASSWORD:'test',SESSION_SECRET:'test',VIRTUAL_ONLY:'true',DEMO_TRADING_ENABLED:'true',MCP_DEMO_TRADING_ENABLED:'true',
    ...(relayMode?{BINANCE_RELAY_ORIGIN:'https://relay.quant.test',BINANCE_RELAY_TOKEN:relayToken}:{})}},
  {name:'mcp',modules:true,script:codes[1].outputFiles[0].text,compatibilityDate:'2026-11-01',serviceBindings:{API:'api'}}]}));
 const db=await mf.getD1Database('DB','api');
 for(const file of ['0001.sql','0006_virtual.sql'])for(const sql of fs.readFileSync('migrations/'+file,'utf8').split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
 const login=await api('/login',{password:'test'});cookie=login.response.headers.get('set-cookie').split(';')[0];
 key=(await api('/keys',{name:'virtual connector',scopes:['read','virtual_trade']})).body.data.key;
 readKey=(await api('/keys',{name:'readonly',scopes:['read','write','demo_trade']})).body.data.key;
 mcp=await mf.getWorker('mcp');
});
after(async()=>await mf?.dispose());
async function api(path,data,token){
 const response=await mf.dispatchFetch('https://quantos.test/api'+path,{method:data===undefined?'GET':'POST',
  headers:token?{Authorization:'Bearer '+token}:cookie?{Cookie:cookie}:{},body:data===undefined?undefined:JSON.stringify(data)});
 return {response,body:await response.json()};
}
async function rpc(method,params={},token=key){
 const r=await mcp.fetch('https://mcp.test/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
 return (await r.json()).result;
}
const intent=()=>({action:'OPEN',requestId:crypto.randomUUID(),symbol,direction:'LONG',margin:'10',leverage:2,
 decisionPrice:'0.001',decisionTime:Date.now(),reason:'isolated test',strategy:'test-v1',analysis:{atr:'0.00004'},
 stopLoss:'0.0009',tiers:[{percent:20,price:'0.0011'},{percent:30,price:'0.0012'},{percent:50,price:'0.0013'}]});

test('MCP sandbox opens one precise position, keeps decisions separate and isolates shadow funds',async()=>{
 const listed=await rpc('tools/list');assert.ok(listed.tools.some(x=>x.name==='sync_virtual_trade'));
 assert.ok(!(await rpc('tools/list',{},readKey)).tools.some(x=>x.name==='sync_virtual_trade'));
 assert.ok(!listed.tools.some(x=>x.name==='quantos_demo_place_order'));
 const b=intent();
 assert.equal((await api('/virtual/trade',b,readKey)).response.status,401);
 assert.equal((await api('/demo/place',{},readKey)).response.status,410);
 assert.equal((await api('/sync',{})).response.status,410);
 const a=await rpc('tools/call',{name:'sync_virtual_trade',arguments:b});
 assert.equal(a.isError,false,JSON.stringify(a));
 const opened=a.structuredContent.data;
 assert.equal(opened.status,'COMMITTED');assert.equal(opened.position.decision.price,'0.001');assert.equal(opened.position.entry,'0.0010002');
 assert.equal(opened.position.quantity,'19996');assert.equal(opened.shadows.length,2);
 assert.deepEqual((await api('/virtual/trade',b,key)).body.data,opened);
 assert.equal((await api('/virtual/trade',{...b,margin:'11'},key)).response.status,409);
 const p=(await api('/virtual/portfolio')).body.data;
 assert.equal(p.positionCount,1);assert.equal(p.usedMargin,'9.9999996');assert.equal(p.net,'-0.0099999996');
 assert.equal((await api('/virtual/request?id='+b.requestId,undefined,key)).body.data.position.id,b.requestId);
});

test('gap stalls the cursor, then ordered backfill settles 20% and 30% before a stop, including concurrent refresh',async()=>{
 const db=await mf.getD1Database('DB','api');
 const initial=boundary-10*oneMinute;
 const rows=(await db.prepare('SELECT id,data FROM virtual_positions').all()).results;
 for(const row of rows){const p=JSON.parse(row.data);p.cursor=initial;await db.prepare('UPDATE virtual_positions SET cursor=?,data=? WHERE id=?').bind(initial,JSON.stringify(p),row.id).run()}
 bars=[bar(initial,'0.001','0.00115','0.00096','0.00102')];
 const missing=(await api('/virtual/refresh',{})).body.data;
 assert.equal(missing.market[0].error,'BINANCE_KLINE_GAP');
 assert.equal((await db.prepare('SELECT MIN(cursor) AS cursor FROM virtual_positions').first()).cursor,initial);
 bars=Array.from({length:10},(_,i)=>bar(initial+i*oneMinute,'0.001','0.00106','0.00096','0.00102'));
 bars[0]=bar(initial,'0.001','0.00115','0.00096','0.00102');
 bars[2]=bar(initial+2*oneMinute,'0.001','0.00125','0.00096','0.00102');
 bars[5]=bar(initial+5*oneMinute,'0.00088','0.00102','0.00087','0.001');
 const results=await Promise.all([api('/virtual/refresh',{}),api('/virtual/refresh',{})]);
 assert.ok(results.some(x=>x.response.status===200));
 const history=(await api('/virtual/history')).body.data;
 assert.equal(history.items.length,1);assert.equal(history.items[0].remaining,'0');
 const {events,shadows}=(await api('/virtual/position?id='+history.items[0].id)).body.data;
 const exits=events.filter(e=>e.kind!=='OPEN');
 assert.deepEqual(exits.map(e=>e.kind),['TAKE_PROFIT','TAKE_PROFIT','STOP_LOSS']);
 assert.deepEqual(exits.map(e=>e.quantity),['3999.2','5998.8','9998']);
 assert.equal(exits[2].price,'0.00088');assert.ok(Number(exits[2].fillPrice)<0.00088);
 assert.equal(shadows.length,2);assert.equal((await api('/virtual/portfolio')).body.data.positionCount,0);
 await api('/virtual/refresh',{});
 assert.equal((await api('/virtual/position?id='+history.items[0].id)).body.data.events.length,events.length);
 assert.equal((await api('/virtual/stats')).body.data.count,1);
});

test('same-candle TP and stop is ambiguous and resolves to the adverse exit',async()=>{
 const output=await build({entryPoints:['worker/virtual-model.ts'],bundle:true,write:false,format:'esm',platform:'node'});
 const {settleCandle}=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'));
 const closed=(await api('/virtual/history')).body.data.items[0];
 const p={...closed,closedAt:null,remaining:closed.quantity,locked:closed.margin,tiers:closed.tiers.map(t=>({...t,filled:'0'}))};
 const result=settleCandle(p,{time:boundary,end:boundary+59999,open:'0.001',high:'0.0012',low:'0.00085',close:'0.001',volume:'1'});
 assert.equal(result.length,1);assert.equal(result[0].kind,'STOP_LOSS');assert.equal(result[0].executionAmbiguity,true);assert.equal(p.remaining,'0');
});

test('partial entry minute ignores earlier trades and preserves 80% after its first target',async()=>{
 const made=await api('/virtual/accounts',{name:'partial-minute',initial:'80'});
 const b={...intent(),accountId:made.body.data.id};
 const opened=(await api('/virtual/trade',b,key)).body.data.position;
 const db=await mf.getD1Database('DB','api');
 const end=Math.floor(Date.now()/oneMinute)*oneMinute, start=end-oneMinute, cursor=start+20000;
 await db.prepare("DELETE FROM rate_limits WHERE key='virtual-refresh:session'").run();
 opened.cursor=cursor;opened.openedAt=cursor-1;
 await db.prepare('UPDATE virtual_positions SET opened_at=?,cursor=?,data=? WHERE id=?').bind(cursor-1,cursor,JSON.stringify(opened),opened.id).run();
 trades=[{a:1,T:start+5000,p:'0.0008',q:'1'},{a:2,T:start+30000,p:'0.00115',q:'1'}];
 const response=await api('/virtual/refresh',{});assert.equal(response.response.status,200,JSON.stringify(response.body));
 const x=response.body.data;
 assert.ok(x.events>=1);
 const result=(await api('/virtual/position?id='+opened.id)).body.data;
 assert.equal(result.position.remainingRatio,'0.8');
 assert.equal(result.events.filter(e=>e.kind==='STOP_LOSS').length,0);
 assert.equal(result.events.find(e=>e.kind==='TAKE_PROFIT').time,start+30000);
});

test('price deviation and concurrent margin checks reject unsafe entries without ledger effects',async()=>{
 const account=(await api('/virtual/accounts',{name:'margin isolation',initial:'20'})).body.data.id;
 const b={...intent(),accountId:account,margin:'15'};
 const deviated=await api('/virtual/trade',{...b,decisionPrice:'0.002'},key);
 assert.equal(deviated.body.error.code,'VIRTUAL_PRICE_DEVIATION');
 const other={...b,requestId:crypto.randomUUID()};
 const concurrent=await Promise.all([api('/virtual/trade',b,key),api('/virtual/trade',other,key)]);
 assert.equal(concurrent.filter(r=>r.response.ok).length,1);
 const uncommitted=concurrent[0].response.ok?other:b;
 assert.equal((await api('/virtual/trade',uncommitted,key)).body.error.code,'INSUFFICIENT_VIRTUAL_FUNDS');
 const p=(await api('/virtual/portfolio?accountId='+account)).body.data;
 assert.equal(p.positionCount,1);assert.ok(Number(p.available)>0);
});
