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
