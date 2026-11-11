import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import fs from 'node:fs';
const out=await build({entryPoints:['worker/performance.ts'],bundle:true,write:false,format:'esm',platform:'node'});
const mod=await import('data:text/javascript;base64,'+Buffer.from(out.outputFiles[0].text).toString('base64'));
let mf,cookie,fail=false,sourceBills=[],sourceFills=[];const origin=Date.now()-86400000;
function bill(id,type='2',pnl='0',fee='0',ccy='USDT',extra={}){return {billId:id,ts:String(origin),ccy,type,subType:'5',pnl,fee,balChg:'0',instType:'SWAP',instId:'DOGE-USDT-SWAP',...extra}}
function fill(id){return {billId:id,ts:String(origin),instType:'SWAP',instId:'DOGE-USDT-SWAP',fillPnl:'0.1',fee:'-0.001',feeCcy:'USDT',fillSz:'1',fillPx:'0.07',ordId:'order'+id,side:'buy',posSide:'net'}}
before(async()=>{const code=await build({entryPoints:['worker/index.ts'],bundle:true,write:false,format:'esm',platform:'browser'});mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'quantos',modules:true,script:code.outputFiles[0].text,compatibilityDate:'2026-11-01',d1Databases:['DB'],bindings:{ADMIN_PASSWORD:'test',SESSION_SECRET:'test',OKX_API_KEY:'test',OKX_SECRET_KEY:'test',OKX_PASSPHRASE:'test'},outboundService:async r=>{assert.equal(r.method,'GET');assert.equal(r.headers.get('x-simulated-trading'),'1');if(fail)return new Response(JSON.stringify({code:'50001',data:[]}));const u=new URL(r.url);let rows=u.pathname.includes('bills-archive')?sourceBills:u.pathname.includes('fills-history')?sourceFills:null;if(!rows)throw Error('unexpected path');const begin=Number(u.searchParams.get('begin')),end=Number(u.searchParams.get('end')),after=u.searchParams.get('after');rows=rows.filter(x=>Number(x.ts)>=begin&&Number(x.ts)<=end&&(!after||x.billId<after)).sort((a,b)=>b.billId.localeCompare(a.billId)).slice(0,100);return new Response(JSON.stringify({code:'0',data:rows}))}}]}));const db=await mf.getD1Database('DB');for(const f of ['migrations/0001.sql','migrations/0003_performance.sql'])for(const statement of fs.readFileSync(f,'utf8').split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(statement).run();const login=await request('/login',{password:'test'});cookie=login.r.headers.get('set-cookie').split(';')[0]});
after(async()=>await mf?.dispose());
async function request(path,body,authorization){const r=await mf.dispatchFetch('https://quantos.test/api'+path,{method:body===undefined?'GET':'POST',headers:authorization?{Authorization:'Bearer '+authorization}:cookie?{Cookie:cookie}:{},body:body===undefined?undefined:JSON.stringify(body)});return {r,j:await r.json()}}
test('signed decimal totals are exact and currencies never mix',()=>{assert.equal(mod.sumDecimals(['0.1','0.2','-0.01']),'0.29');assert.equal(mod.sumDecimals(['-10000000000000.00000001','10000000000000']),'-.00000001'.replace('-.','-0.'));const rows=[mod.normalizeBill(bill('1','2','10','-0.1')),mod.normalizeBill(bill('2','8','-0.5','0','USDT',{subType:'173',balChg:'0'})),mod.normalizeBill(bill('3','1','999','999')),mod.normalizeBill(bill('4','2','0.2','0.01','BTC')),mod.normalizeBill(bill('5','5','-2','-0.02'))];const sums=mod.summarize(rows);assert.equal(sums.find(x=>x.currency==='USDT').net,'7.38');assert.equal(sums.find(x=>x.currency==='BTC').net,'0.21');assert.equal(sums.find(x=>x.currency==='USDT').curve.at(-1).cumulative,'7.38')});
test('no imported history is shown as incomplete rather than fabricated profit',async()=>{const p=await request('/performance');assert.equal(p.j.data.complete,false);assert.equal(p.j.data.updatedAt,null);assert.deepEqual(p.j.data.currencies,[])});
test('history import deduplicates overlapping pages and excludes transfers',async()=>{sourceBills=[bill('100','2','0.1','-0.01'),bill('101','2','0.2','0'),bill('102','8','-0.05','0','USDT',{subType:'173',balChg:'0'}),bill('103','1','1000','0')];sourceFills=[fill('200'),fill('201')];assert.equal((await request('/performance/sync',{})).r.status,200);const p=(await request('/performance')).j.data;assert.equal(p.complete,true);assert.equal(p.tradeCount,2);assert.equal(p.currencies[0].net,'0.24');await request('/performance/sync',{});const repeated=(await request('/performance')).j.data;assert.equal(repeated.currencies[0].net,'0.24');assert.equal(repeated.tradeCount,2)});
test('equal timestamp pagination is stable without omitted or repeated fills',async()=>{const db=await mf.getD1Database('DB');for(let i=0;i<101;i++){const f=fill('z'+String(i).padStart(3,'0'));await db.prepare('INSERT INTO exchange_fills VALUES(?,?,?,?)').bind(f.billId,Number(f.ts),f.instId,JSON.stringify(f)).run()}const a=(await request('/history')).j.data;const b=(await request('/history?cursor='+encodeURIComponent(a.nextCursor))).j.data;const c=(await request('/history?cursor='+encodeURIComponent(b.nextCursor))).j.data;assert.equal(a.items.length,50);assert.equal(b.items.length,50);assert.equal(c.items.length,3);assert.equal(new Set([...a.items,...b.items,...c.items].map(x=>x.billId)).size,103);assert.equal(c.nextCursor,null);assert.equal((await request('/history?cursor=bad')).r.status,400)});
test('failed history refresh preserves prior imported data and last success time',async()=>{const before=(await request('/performance')).j.data;fail=true;assert.equal((await request('/performance/sync',{})).r.status,503);const after=(await request('/performance')).j.data;assert.equal(after.updatedAt,before.updatedAt);assert.equal(after.currencies[0].net,before.currencies[0].net);assert.match(after.error,/OKX_ERROR/);fail=false});
test('read keys can view history but cannot trigger a history sync',async()=>{const key=(await request('/keys',{name:'reader',scopes:['read']})).j.data.key;assert.equal((await request('/performance',undefined,key)).r.status,200);assert.equal((await request('/history',undefined,key)).r.status,200);assert.equal((await request('/performance/sync',{},key)).r.status,401)});

test('today total follows Shanghai midnight, includes costs and funding, and excludes transfers and other currencies',()=>{const t=Date.parse('2026-11-10T15:59:59.999Z');const event=(id,ts,type,pnl,fee,ccy='USDT',extra={})=>mod.normalizeBill(bill(id,type,pnl,fee,ccy,{ts:String(Date.parse(ts)),...extra}));const rows=[event('d0','2026-11-09T15:59:59.999Z','2','100','0'),event('d1','2026-11-09T16:00:00.000Z','2','0.3','-0.01'),event('d2','2026-11-10T10:00:00Z','8','-0.05','0','USDT',{subType:'173'}),event('d3','2026-11-10T11:00:00Z','1','1000','0'),event('d4','2026-11-10T12:00:00Z','2','5','0','BTC'),event('d5','2026-11-10T16:00:00Z','2','0.7','0')];const today=mod.todayEarnings(rows,t);assert.equal(today.date,'2026-11-10');assert.equal(today.start,Date.parse('2026-11-09T16:00:00Z'));assert.equal(today.currencies.find(c=>c.currency==='USDT').net,'0.24');assert.equal(today.currencies.find(c=>c.currency==='BTC').net,'5');const next=mod.todayEarnings(rows,Date.parse('2026-11-10T16:00:00Z'));assert.equal(next.date,'2026-11-11');assert.equal(next.currencies.find(c=>c.currency==='USDT').net,'0.7');assert.equal(next.currencies.find(c=>c.currency==='BTC').net,'0');});

test('daily gains and losses split each bill net with fees and funding, then restart after the cutoff',()=>{
 const start=Date.parse('2026-11-10T16:00:00.000Z');
 const rows=[
  {ts:start,ccy:'USDT',kind:'trade',pnl:'1.2',fee:'-0.1',funding:'0'},
  {ts:start+1,ccy:'USDT',kind:'trade',pnl:'-0.3',fee:'-0.05',funding:'0'},
  {ts:start+2,ccy:'USDT',kind:'funding',pnl:'0',fee:'0',funding:'-0.02'},
  {ts:start+3,ccy:'BTC',kind:'trade',pnl:'0.01',fee:'0',funding:'0'},
  {ts:start+4,ccy:'USDT',kind:'trade',pnl:'0',fee:'-0.01',funding:'0'},
  {ts:start+5,ccy:'USDT',kind:'other',pnl:'99',fee:'0',funding:'0'},
  {ts:start+86400000,ccy:'USDT',kind:'trade',pnl:'0.5',fee:'0',funding:'0'}
 ];
 const get=(now,reset)=>mod.todayEarnings(rows,now,reset);
 const amounts=(report,ccy='USDT')=>{const {earned,lost,net}=report.currencies.find(c=>c.currency===ccy);return [earned,lost,net]};
 assert.deepEqual(amounts(get(start+5)),['1.1','-0.38','0.72']);
 assert.deepEqual(amounts(get(start+5),'BTC'),['0.01','0','0.01']);
 assert.deepEqual(amounts(get(start+3,start+3)),['0','0','0']);
 assert.deepEqual(amounts(get(start+5,start+3)),['0','-0.01','-0.01']);
 assert.equal(get(start+5,start+3).resetAt,new Date(start+3).toISOString());
 assert.equal(get(start+86400000,start+3).resetAt,null);
 assert.deepEqual(amounts(get(start+86400000,start+3)),['0.5','0','0.5']);
});

test('reset requires a confirmed admin session and preserves fills, bills and cumulative earnings',async()=>{
 const db=await mf.getD1Database('DB');
 const row=mod.normalizeBill(bill('reset-test-bill','2','5','-0.1','USDT',{ts:String(Date.now()-5)}));
 await db.prepare('INSERT INTO exchange_bills VALUES(?,?,?,?,?,?,?,?)').bind(row.id,row.ts,row.ccy,row.pnl,row.fee,row.funding,row.kind,row.data).run();
 const before=(await request('/performance')).j.data;
 const bills=(await request('/history?kind=bills')).j.data;
 const fills=(await request('/history?kind=fills')).j.data;
 const key=(await request('/keys',{name:'reset-forbidden',scopes:['read','write']})).j.data.key;
 assert.equal((await request('/performance/today/reset',{confirm:true},key)).r.status,401);
 assert.equal((await request('/performance/today/reset',{})).r.status,400);
 const reset=await request('/performance/today/reset',{confirm:true});
 assert.equal(reset.r.status,200);
 assert.ok(reset.j.data.today.resetAt);
 const {earned,lost,net}=reset.j.data.today.currencies.find(c=>c.currency==='USDT');
 assert.deepEqual([earned,lost,net],['0','0','0']);
 assert.deepEqual(reset.j.data.currencies,before.currencies);
 assert.deepEqual((await request('/performance')).j.data.today,reset.j.data.today);
 assert.deepEqual((await request('/history?kind=bills')).j.data,bills);
 assert.deepEqual((await request('/history?kind=fills')).j.data,fills);
});
