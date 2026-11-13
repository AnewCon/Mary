import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
const {outputFiles:[file]} = await build({entryPoints:['worker/paper-orders.ts'],bundle:true,format:'esm',write:false});
const {paperOrders,writePaperOrder} = await import('data:text/javascript;base64,'+Buffer.from(file.text).toString('base64'));
const id = () => crypto.randomUUID();
function database(){
  const sql = new DatabaseSync(':memory:');
  sql.exec('CREATE TABLE system_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  sql.prepare('INSERT INTO system_settings VALUES (?,?)').run('capital_usd','80');
  const db = {prepare(query){return {bind(...args){return {
    first: async column => sql.prepare(query).get(...args)?.[column] ?? null,
    run: async () => ({meta:sql.prepare(query).run(...args)})
  }}}}};
  return {db,sql};
}
test('paper orders persist, mark once, settle separately from OKX, and deduplicate retries',async()=>{
  const {db,sql} = database();
  assert.equal((await paperOrders(db)).initial,null);
  await writePaperOrder(db,{action:'INITIALIZE',requestId:id(),initial:'80'});
  const priceTime=Date.now(), orderId=id();
  const open={action:'OPEN',requestId:orderId,symbol:'BTCUSDT',side:'LONG',margin:'40',price:'100',priceTime};
  await writePaperOrder(db,open);
  await writePaperOrder(db,open);
  assert.equal((await paperOrders(db)).orders.length,1);
  assert.equal((await paperOrders(db)).available,'40');
  await assert.rejects(writePaperOrder(db,{...open,margin:'10'}),/PAPER_REQUEST_CONFLICT/);
  await assert.rejects(writePaperOrder(db,{...open,requestId:id(),margin:'41'}),/PAPER_INSUFFICIENT_BALANCE/);
  await writePaperOrder(db,{action:'MARK',requestId:id(),orderId,symbol:'BTCUSDT',price:'110',priceTime});
  assert.equal((await paperOrders(db)).unrealized,'4');
  assert.equal((await paperOrders(db)).balance,'80');
  await writePaperOrder(db,{action:'CLOSE',requestId:id(),orderId,symbol:'BTCUSDT',price:'105',priceTime});
  const final=await paperOrders(db);
  assert.equal(final.realized,'2');
  assert.equal(final.unrealized,'0');
  assert.equal(final.available,'82');
  assert.equal(sql.prepare("SELECT value FROM system_settings WHERE key='capital_usd'").get().value,'80');
});
test('leveraged positions keep weighted cost, ROI and liquidation risk across adds',async()=>{
  const {db} = database();
  await writePaperOrder(db,{action:'INITIALIZE',requestId:id(),initial:'1000'});
  const orderId=id(), priceTime=Date.now(), symbol='BTCUSDT';
  const open={action:'OPEN',requestId:orderId,symbol,side:'LONG',margin:'20',price:'100',priceTime,leverage:10};
  await assert.rejects(writePaperOrder(db,{...open,leverage:126}),/PAPER_INVALID_LEVERAGE/);
  const first=await writePaperOrder(db,open);
  assert.equal(first.orders[0].quantity,'2');
  const add={action:'ADD',requestId:id(),orderId,symbol,margin:'12',price:'120',priceTime};
  await assert.rejects(writePaperOrder(db,{...add,leverage:20}),/PAPER_LEVERAGE_MISMATCH/);
  await writePaperOrder(db,add);
  const retry=await writePaperOrder(db,add);
  assert.equal(retry.orders[0].quantity,'3');
  assert.equal(retry.orders[0].entry,'106.666666666666');
  assert.equal(retry.orders[0].pnl,'40');
  assert.equal(retry.orders[0].marginRoiPct,'125');
  assert.equal(retry.orders[0].liquidationPrice,'96.482412060301');
  const marked=await writePaperOrder(db,{action:'MARK',requestId:id(),orderId,symbol,price:'96',priceTime});
  assert.equal(marked.orders[0].liquidationRisk,'AT_RISK');
  const short=await writePaperOrder(db,{...open,requestId:id(),side:'SHORT',leverage:125});
  assert.equal(short.orders[1].quantity,'25');
  assert.equal(short.orders[1].liquidationPrice,'100.298507462686');
});
