import {okx,Failure,type Credentials} from './exchange';
import {closeQuantity,closeSide,sameDecimal} from './quantity';
import {quote,close,reconcile as reconcileClose} from './trading';
interface Env extends Credentials{DB:D1Database;DEMO_TRADING_ENABLED?:string;MCP_DEMO_TRADING_ENABLED?:string}
type Sync=(e:any)=>Promise<any>;
type Command={instId:string;path:string;body:any;resource:string;query:'order'|'algo'|'leverage';queryId?:string;kind:string;verify?:()=>Promise<void>};
const uuid=(v:any)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
function enabled(e:Env){if(e.DEMO_TRADING_ENABLED!=='true'||e.MCP_DEMO_TRADING_ENABLED!=='true')throw new Failure('MCP_DEMO_TRADING_DISABLED',403)}
function instrumentId(v:any){if(typeof v!=='string'||! /^[A-Z0-9][A-Z0-9-]{2,75}-SWAP$/.test(v))throw new Failure('SWAP_INSTRUMENT_REQUIRED');return v}
function positive(v:any){if(typeof v!=='string'||v.length>40||!/^\d+(\.\d+)?$/.test(v)||!Number.isFinite(Number(v))||Number(v)<=0)throw new Failure('INVALID_POSITIVE_DECIMAL');return v}
function exactSize(size:any,i:any,market:boolean){positive(size);let normalized;try{normalized=closeQuantity(size,size,i.lotSz,i.minSz,100)}catch{throw new Failure('INVALID_ORDER_SIZE')}if(!sameDecimal(normalized,size))throw new Failure('INVALID_LOT_SIZE');const max=market?i.maxMktSz:i.maxLmtSz;if(!max||Number(size)>Number(max))throw new Failure('ORDER_SIZE_EXCEEDS_EXCHANGE_MAX');return normalized}
export function validPrice(price:any,tick:string){positive(price);positive(tick);const digits=Math.max(price.split('.')[1]?.length||0,tick.split('.')[1]?.length||0);const units=(s:string)=>{const [a,b='']=s.split('.');return BigInt(a+b.padEnd(digits,'0'))};if(units(price)%units(tick)!==0n)throw new Failure('INVALID_PRICE_TICK');return price}
function triggers(b:any,long:boolean,reference:string,tick:string){positive(reference);if(!b.takeProfit&&!b.stopLoss)throw new Failure('PROTECTION_PRICE_REQUIRED');if(b.takeProfit){validPrice(b.takeProfit,tick);if(long?Number(b.takeProfit)<=Number(reference):Number(b.takeProfit)>=Number(reference))throw new Failure('TAKE_PROFIT_WRONG_SIDE')}if(b.stopLoss){validPrice(b.stopLoss,tick);if(long?Number(b.stopLoss)>=Number(reference):Number(b.stopLoss)<=Number(reference))throw new Failure('STOP_LOSS_WRONG_SIDE')}}
function canonical(v:any):string{if(v===null||typeof v!=='object')return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}'}
async function instrument(e:Env,id:string){const rows=await okx(e,'/api/v5/public/instruments?instType=SWAP&instId='+encodeURIComponent(instrumentId(id)));const i=rows.find((x:any)=>x.instId===id);if(!i||i.state!=='live')throw new Failure('INSTRUMENT_UNAVAILABLE');return i}
async function config(e:Env){const c=(await okx(e,'/api/v5/account/config'))[0];if(!['2','3'].includes(c?.acctLv)||!['net_mode','long_short_mode'].includes(c?.posMode))throw new Failure('UNSUPPORTED_ACCOUNT_MODE');return c}
async function positions(e:Env){return okx(e,'/api/v5/account/positions?instType=SWAP')}
function marginMode(v:any){if(!['cross','isolated'].includes(v))throw new Failure('INVALID_MARGIN_MODE');return v}
export async function leverageInfo(e:Env,instId:string,mgnMode:string){enabled(e);instrumentId(instId);marginMode(mgnMode);const [i,c,rows]=await Promise.all([instrument(e,instId),config(e),okx(e,'/api/v5/account/leverage-info?instId='+encodeURIComponent(instId)+'&mgnMode='+mgnMode)]);return {mode:'demo',instId,marginMode:mgnMode,accountMode:c.posMode,instrumentMaxLeverage:i.lever||null,leverage:rows.filter((x:any)=>x.instId===instId&&x.mgnMode===mgnMode),note:'全仓杠杆由交易所按合约/品种共享，不能分别设置多空；逐仓双向模式需要明确long或short。合约最大杠杆仅作参考，实际限额以账户风险档位和交易所校验为准。'}}
async function leverageCommand(e:Env,b:any):Promise<Command>{const id=instrumentId(b.instId),mgnMode=marginMode(b.marginMode);positive(b.leverage);if(Number(b.leverage)<1)throw new Failure('INVALID_LEVERAGE');const [i,c]=await Promise.all([instrument(e,id),config(e)]);if(!i.lever||Number(b.leverage)>Number(i.lever))throw new Failure('LEVERAGE_EXCEEDS_INSTRUMENT_MAX');const directional=mgnMode==='isolated'&&c.posMode==='long_short_mode';if(directional?!['long','short'].includes(b.posSide):b.posSide!==undefined&&b.posSide!=='net')throw new Failure('INVALID_LEVERAGE_POSITION_SIDE');const body:any={instId:id,mgnMode,lever:b.leverage};if(directional)body.posSide=b.posSide;return {instId:id,path:'/api/v5/account/set-leverage',body,resource:'leverage:'+id+':'+mgnMode+':'+(body.posSide||'net'),query:'leverage',kind:'leverage',verify:async()=>{if((await config(e)).posMode!==c.posMode)throw new Failure('ACCOUNT_MODE_CHANGED',409)}}}
async function algo(e:Env,id:string,instId:string){if(typeof id!=='string'||!/^\d{1,40}$/.test(id))throw new Failure('INVALID_ALGO_ID');const a=(await okx(e,'/api/v5/trade/order-algo?algoId='+id))[0];if(!a||a.instId!==instId||!['conditional','oco'].includes(a.ordType))throw new Failure('PROTECTION_NOT_FOUND',404);if(a.posSide==='net'&&a.reduceOnly!==true&&a.reduceOnly!=='true')throw new Failure('NOT_A_REDUCE_ONLY_PROTECTION');return a}
export async function tradeContext(e:Env,instId:string){enabled(e);const [i,c,p,marks]=await Promise.all([instrument(e,instId),config(e),positions(e),okx(e,'/api/v5/public/mark-price?instType=SWAP&instId='+encodeURIComponent(instrumentId(instId)))]);return {mode:'demo',instId,instrument:i,accountMode:c.posMode,positions:p.filter((x:any)=>x.instId===instId&&Number(x.pos)!==0),markPrice:marks[0]?.markPx||null,quantityUnit:'contracts',note:'所有交易所请求强制模拟盘标志。下单不自动改变杠杆。'}}
export async function orders(e:Env,instId?:string){enabled(e);const filter=instId?'&instId='+encodeURIComponent(instrumentId(instId)):'';const [normal,conditional,oco]=await Promise.all([okx(e,'/api/v5/trade/orders-pending?instType=SWAP&limit=100'+filter),okx(e,'/api/v5/trade/orders-algo-pending?ordType=conditional&instType=SWAP&limit=100'+filter),okx(e,'/api/v5/trade/orders-algo-pending?ordType=oco&instType=SWAP&limit=100'+filter)]);return {mode:'demo',normal,conditional,oco,possiblyTruncated:{normal:normal.length===100,conditional:conditional.length===100,oco:oco.length===100},note:'各类别最多读取100条；标记为可能截断时不要把结果视为全部订单。'}}
async function prepare(e:Env,kind:string,b:any):Promise<Command>{
 if(kind==='leverage')return leverageCommand(e,b);
 if(kind==='place'){const id=instrumentId(b.instId);if(!['long','short'].includes(b.direction)||!['cross','isolated'].includes(b.marginMode)||!['market','limit'].includes(b.orderType))throw new Failure('INVALID_ORDER_INPUT');const [i,c,p]=await Promise.all([instrument(e,id),config(e),positions(e)]);const long=b.direction==='long',size=exactSize(b.size,i,b.orderType==='market');const opposite=(rows:any[])=>c.posMode==='net_mode'&&rows.some(x=>x.instId===id&&Number(x.pos)!==0&&(long?Number(x.pos)<0:Number(x.pos)>0));if(opposite(p))throw new Failure('OPPOSITE_POSITION_EXISTS');const body:any={instId:id,tdMode:b.marginMode,side:long?'buy':'sell',posSide:c.posMode==='net_mode'?'net':b.direction,ordType:b.orderType,sz:size,clOrdId:b.requestId.replace(/-/g,'')};if(b.orderType==='limit')body.px=validPrice(b.price,i.tickSz);else if(b.price!==undefined)throw new Failure('MARKET_ORDER_MUST_NOT_SET_PRICE');return {instId:id,path:'/api/v5/trade/order',body,resource:'order:'+id,query:'order',kind,verify:async()=>{const latest=await config(e);if(latest.posMode!==c.posMode||opposite(await positions(e)))throw new Failure('POSITION_CHANGED',409)}}}
 if(kind==='protect'){if(typeof b.positionId!=='string'||!Number.isInteger(b.percent)||b.percent<1||b.percent>100)throw new Failure('INVALID_PROTECTION_INPUT');const q=await quote(e,b.positionId),p=q.position,i=await instrument(e,p.instId);const size=closeQuantity(p.pos,q.closeableSize,q.instrument.lotSz,q.instrument.minSz,b.percent);triggers(b,q.side==='sell',p.markPx,i.tickSz);const pending=await orders(e,p.instId);if(pending.conditional.length===100||pending.oco.length===100)throw new Failure('PENDING_ORDERS_INCOMPLETE');if([...pending.conditional,...pending.oco].some((a:any)=>a.posSide===p.posSide&&a.side===q.side&&a.tdMode===p.mgnMode))throw new Failure('PROTECTION_ALREADY_EXISTS');const body:any={instId:p.instId,tdMode:p.mgnMode,side:q.side,posSide:p.posSide,ordType:b.takeProfit&&b.stopLoss?'oco':'conditional',algoClOrdId:b.requestId.replace(/-/g,''),cxlOnClosePos:true};if(b.percent===100)body.closeFraction='1';else body.sz=size;if(p.posSide==='net')body.reduceOnly=true;if(b.takeProfit)Object.assign(body,{tpTriggerPx:b.takeProfit,tpOrdPx:'-1',tpTriggerPxType:'mark'});if(b.stopLoss)Object.assign(body,{slTriggerPx:b.stopLoss,slOrdPx:'-1',slTriggerPxType:'mark'});return {instId:p.instId,path:'/api/v5/trade/order-algo',body,resource:'protection:'+b.positionId,query:'algo',kind,verify:async()=>{const latest=await quote(e,b.positionId);if(!sameDecimal(latest.position.pos,p.pos)||latest.position.posSide!==p.posSide)throw new Failure('POSITION_CHANGED',409);triggers(b,q.side==='sell',latest.position.markPx,i.tickSz);const fresh=await orders(e,p.instId);if(fresh.possiblyTruncated.conditional||fresh.possiblyTruncated.oco)throw new Failure('PENDING_ORDERS_INCOMPLETE');if([...fresh.conditional,...fresh.oco].some(a=>a.instId===p.instId&&(a.posSide||'net')===p.posSide&&a.side===q.side&&a.tdMode===p.mgnMode))throw new Failure('PROTECTION_ALREADY_EXISTS',409)}}}
 if(kind==='amend_protection'||kind==='cancel_protection'){const id=instrumentId(b.instId),a=await algo(e,b.algoId,id);if(a.state!=='live')throw new Failure('PROTECTION_NOT_LIVE');if(kind==='cancel_protection')return {instId:id,path:'/api/v5/trade/cancel-algos',body:[{instId:id,algoId:b.algoId}],resource:'algo:'+b.algoId,query:'algo',queryId:b.algoId,kind};const p=(await positions(e)).find((p:any)=>p.instId===id&&p.posSide===a.posSide&&p.mgnMode===a.tdMode&&Number(p.pos)!==0);if(!p||a.side!==closeSide(p.posSide,p.pos))throw new Failure('POSITION_NOT_FOUND',404);const i=await instrument(e,id);triggers(b,a.side==='sell',p.markPx,i.tickSz);if(a.ordType==='conditional'&&((b.takeProfit&&!a.tpTriggerPx)||(b.stopLoss&&!a.slTriggerPx)))throw new Failure('PROTECTION_KIND_CHANGE_REQUIRED');const body:any={instId:id,algoId:b.algoId,reqId:b.requestId.replace(/-/g,''),cxlOnFail:false};if(b.takeProfit)Object.assign(body,{newTpTriggerPx:b.takeProfit,newTpOrdPx:'-1',newTpTriggerPxType:'mark'});if(b.stopLoss)Object.assign(body,{newSlTriggerPx:b.stopLoss,newSlOrdPx:'-1',newSlTriggerPxType:'mark'});return {instId:id,path:'/api/v5/trade/amend-algos',body,resource:'algo:'+b.algoId,query:'algo',queryId:b.algoId,kind,verify:async()=>{const latest=await algo(e,b.algoId,id);if(latest.state!=='live'||latest.uTime!==a.uTime)throw new Failure('PROTECTION_CHANGED',409)}}}
 if(kind==='cancel_order'){const id=instrumentId(b.instId);if(typeof b.orderId!=='string'||!/^\d{1,40}$/.test(b.orderId))throw new Failure('INVALID_ORDER_ID');const order=(await okx(e,'/api/v5/trade/order?instId='+encodeURIComponent(id)+'&ordId='+b.orderId))[0];if(!order||order.instId!==id||!['live','partially_filled'].includes(order.state))throw new Failure('ORDER_NOT_CANCELABLE');return {instId:id,path:'/api/v5/trade/cancel-order',body:{instId:id,ordId:b.orderId},resource:'order-id:'+b.orderId,query:'order',queryId:b.orderId,kind}}
 throw new Failure('UNSUPPORTED_DEMO_ACTION')
}
const finalStates=['LEVERAGE_SET','FILLED','CANCELED','MMP_CANCELED','REJECTED','AMENDED','TRIGGERED','ORDER_FAILED','PARTIALLY_FAILED'];
function actionResult(row:any,d:any,status:string){return {requestId:row.id,kind:row.kind,mode:'demo',status,exchangeOrder:d.exchangeOrder||null,leverage:row.kind==='leverage'?d.exchangeOrder||null:undefined,filledQuantity:d.exchangeOrder?.accFillSz||d.exchangeOrder?.actualSz||'0',remainingPositions:d.remainingPositions??null,syncError:d.syncError||null,error:d.error||null,note:row.kind==='leverage'?(status==='LEVERAGE_SET'?'杠杆已通过交易所查询确认。':'杠杆结果待确认；查询原请求，禁止盲目重发。'):status==='UNKNOWN'?'结果待确认；仅查询原请求，禁止以新ID盲目重发。':row.kind==='protect'?'欧意模拟盘保护单状态；LIVE代表等待触发，不代表已成交。':row.kind==='amend_protection'?'已查询模拟盘保护单，请核对实际触发价。':'欧意模拟盘操作结果，实际成交量以交易所返回为准。'}}
async function save(e:Env,id:string,d:any,status:string){await e.DB.prepare('UPDATE demo_actions SET status=?,data=? WHERE id=?').bind(status,JSON.stringify(d),id).run()}
type Tier = {percent:number;takeProfit?:string;stopLoss?:string};
type TierResult = {tier:Tier;body:Record<string,unknown>;status:string;algoId?:string;error?:string};
type TierBatch = {positionId:string;instId:string;originalPosition:string;tiers:TierResult[];error?:string};

function tierResult(id:string,data:TierBatch,status:string){
 return {requestId:id,kind:'protect_tiers',mode:'demo',status,positionId:data.positionId,instId:data.instId,
  originalPosition:data.originalPosition,error:data.error??null,tiers:data.tiers.map(({tier,body,status,algoId,error})=>
   ({...tier,quantity:body.sz,clientOrderId:body.algoClOrdId,status,algoId:algoId??null,error:error??null}))};
}

function tierStatus(tiers:TierResult[]){
 if(tiers.some(t=>t.status==='UNKNOWN'||t.status==='SUBMITTING'))return 'UNKNOWN';
 const submitted=tiers.filter(t=>t.algoId).length;
 if(submitted===tiers.length)return 'SUBMITTED';
 return submitted?'PARTIALLY_SUBMITTED':'REJECTED';
}

async function reconcileTiers(e:Env,row:any,data:TierBatch){
 // Leave the writer in control while the batch is running. An interrupted batch
 // can be reconciled after all bounded exchange calls would have timed out.
 if(row.status==='SUBMITTING'&&Date.now()-Date.parse(row.created_at)<300000)return tierResult(row.id,data,row.status);
 const needsRecovery=row.status==='SUBMITTING'||row.status==='UNKNOWN';
 for(const leg of data.tiers){
  if(!leg.algoId&&!['UNKNOWN','SUBMITTING'].includes(leg.status))continue;
  const query=leg.algoId?'algoId='+encodeURIComponent(leg.algoId):'algoClOrdId='+encodeURIComponent(String(leg.body.algoClOrdId));
  try{
   const [found]=await okx(e,'/api/v5/trade/order-algo?'+query);
   if(found?.instId!==data.instId||!found.algoId||!found.state)throw new Failure('ORDER_STATUS_UNAVAILABLE');
   leg.algoId=found.algoId;
   leg.status=found.state==='effective'?'TRIGGERED':found.state.toUpperCase();
   delete leg.error;
  }catch(err){
   if(!leg.algoId)leg.status='UNKNOWN';
   leg.error=err instanceof Failure?err.code:'ORDER_QUERY_FAILED';
  }
 }
 const status=needsRecovery?tierStatus(data.tiers):row.status;
 if(needsRecovery)await e.DB.prepare('UPDATE demo_actions SET status=?,data=? WHERE id=? AND status=? AND data=?')
  .bind(status,JSON.stringify(data),row.id,row.status,row.data).run();
 return tierResult(row.id,data,status);
}

export async function protectTiers(e:Env,b:any,actor:string){
 enabled(e);
 if(!b||!uuid(b.requestId)||typeof b.positionId!=='string'||!b.positionId||b.positionId.length>100||
    !Array.isArray(b.tiers)||b.tiers.length<2||b.tiers.length>5)throw new Failure('INVALID_PROTECTION_TIERS');
 const tiers:Tier[]=b.tiers;
 for(const t of tiers){
  if(!t||typeof t!=='object'||Array.isArray(t)||Object.keys(t).some(k=>!['percent','takeProfit','stopLoss'].includes(k))||
     !Number.isInteger(t.percent)||t.percent<1||t.percent>100||(!t.takeProfit&&!t.stopLoss))throw new Failure('INVALID_PROTECTION_TIER');
  if(t.takeProfit!==undefined)positive(t.takeProfit);
  if(t.stopLoss!==undefined)positive(t.stopLoss);
 }
 const totalPercent=tiers.reduce((total,t)=>total+t.percent,0);
 if(totalPercent>100)throw new Failure('PROTECTION_TOTAL_EXCEEDS_POSITION');
 const intent=canonical(b);
 const existing=await e.DB.prepare('SELECT * FROM demo_actions WHERE id=?').bind(b.requestId).first<any>();
 if(existing){
  if(existing.actor!==actor||existing.kind!=='protect_tiers'||existing.intent!==intent)throw new Failure('IDEMPOTENCY_CONFLICT',409);
  return reconcileTiers(e,existing,JSON.parse(existing.data));
 }
 const initial=await quote(e,b.positionId),p=initial.position;
 const i=await instrument(e,p.instId);
 const quantity=(q:typeof initial,percent:number)=>{
  try{return closeQuantity(q.position.pos,q.closeableSize,q.instrument.lotSz,q.instrument.minSz,percent)}
  catch(err){throw new Failure((err as Error).message)}
 };
 quantity(initial,totalPercent);
 const legs:TierResult[]=[];
 for(const [index,tier] of tiers.entries()){
  triggers(tier,initial.side==='sell',p.markPx,i.tickSz);
  const sz=exactSize(quantity(initial,tier.percent),i,true);
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(b.requestId+':tier:'+index));
  const algoClOrdId=Array.from(new Uint8Array(digest).slice(0,16),x=>x.toString(16).padStart(2,'0')).join('');
  const body:Record<string,unknown>={instId:p.instId,tdMode:p.mgnMode,side:initial.side,posSide:p.posSide,
   ordType:tier.takeProfit&&tier.stopLoss?'oco':'conditional',sz,algoClOrdId,cxlOnClosePos:true};
  if(p.posSide==='net')body.reduceOnly=true;
  if(tier.takeProfit)Object.assign(body,{tpTriggerPx:tier.takeProfit,tpOrdPx:'-1',tpTriggerPxType:'mark'});
  if(tier.stopLoss)Object.assign(body,{slTriggerPx:tier.stopLoss,slOrdPx:'-1',slTriggerPxType:'mark'});
  legs.push({tier,body,status:'NOT_SUBMITTED'});
 }
 const data:TierBatch={positionId:b.positionId,instId:p.instId,originalPosition:p.pos,tiers:legs};
 const lock=await e.DB.prepare('INSERT OR IGNORE INTO demo_actions VALUES(?,?,?,?,?,?,?,?)')
  .bind(b.requestId,actor,'protect_tiers','protection:'+b.positionId,new Date().toISOString(),'SUBMITTING',intent,JSON.stringify(data)).run();
 if(!lock.meta.changes)throw new Failure('DEMO_ACTION_IN_PROGRESS',409);
 try{
  const pending=await orders(e,p.instId);
  if(pending.possiblyTruncated.conditional||pending.possiblyTruncated.oco)throw new Failure('PENDING_ORDERS_INCOMPLETE',503);
  if([...pending.conditional,...pending.oco].some(a=>a.instId===p.instId&&(a.posSide||'net')===p.posSide&&a.side===initial.side&&a.tdMode===p.mgnMode))
   throw new Failure('PROTECTION_ALREADY_EXISTS',409);
  for(const leg of legs){
   const latest=await quote(e,b.positionId);
   if(!sameDecimal(latest.position.pos,p.pos)||latest.side!==initial.side||latest.position.instId!==p.instId||
      latest.position.posSide!==p.posSide||latest.position.mgnMode!==p.mgnMode||latest.mode!==initial.mode)
    throw new Failure('POSITION_CHANGED',409);
   quantity(latest,totalPercent);
   if(quantity(latest,leg.tier.percent)!==leg.body.sz)throw new Failure('QUANTITY_CHANGED',409);
   triggers(leg.tier,latest.side==='sell',latest.position.markPx,i.tickSz);
   leg.status='SUBMITTING';
   await save(e,b.requestId,data,'SUBMITTING');
   try{
    const [result]=await okx(e,'/api/v5/trade/order-algo','POST',leg.body);
    if(result?.sCode===undefined)throw new Failure('ORDER_ACCEPTANCE_UNCERTAIN');
    if(String(result.sCode)!=='0'){
     leg.status='REJECTED';
     leg.error='OKX_ORDER_'+String(result.sCode).replace(/[^0-9]/g,'');
     break;
    }
    if(!result.algoId)throw new Failure('ORDER_ACCEPTANCE_UNCERTAIN');
    leg.algoId=result.algoId;
    leg.status='ACCEPTED';
    await save(e,b.requestId,data,'SUBMITTING');
   }catch(err){
    leg.status='UNKNOWN';
    leg.error=err instanceof Failure?err.code:'SUBMISSION_UNCERTAIN';
    break;
   }
  }
 }catch(err){data.error=err instanceof Failure?err.code:'PRE_SUBMIT_CHECK_FAILED'}
 const status=tierStatus(legs);
 await save(e,b.requestId,data,status);
 return tierResult(b.requestId,data,status);
}
export async function actionStatus(e:Env,id:string,sync:Sync){enabled(e);if(!uuid(id))throw new Failure('INVALID_REQUEST_ID');const row=await e.DB.prepare('SELECT * FROM demo_actions WHERE id=?').bind(id).first<any>();if(!row){const old=await e.DB.prepare('SELECT id FROM trade_actions WHERE id=?').bind(id).first();if(old)return {kind:'close',mode:'demo',...await reconcileClose(e,id,sync)};throw new Failure('ACTION_NOT_FOUND',404)}const d=JSON.parse(row.data);if(row.kind==='protect_tiers')return reconcileTiers(e,row,d);if(finalStates.includes(row.status)&&!d.syncError)return actionResult(row,d,row.status);let status=row.status;try{if(d.command.query==='leverage'){const b=d.command.body;const rows=await okx(e,'/api/v5/account/leverage-info?instId='+encodeURIComponent(b.instId)+'&mgnMode='+b.mgnMode);const current=rows.find((x:any)=>x.instId===b.instId&&x.mgnMode===b.mgnMode&&(!b.posSide||x.posSide===b.posSide));if(!current)throw new Failure('LEVERAGE_STATUS_UNAVAILABLE');d.exchangeOrder=current;d.error=null;status=sameDecimal(current.lever,b.lever)?'LEVERAGE_SET':'UNKNOWN'}else{const query=d.command.query==='order'?'/api/v5/trade/order?instId='+encodeURIComponent(d.command.instId)+(d.command.queryId?'&ordId='+d.command.queryId:'&clOrdId='+d.command.body.clOrdId):'/api/v5/trade/order-algo?'+(d.command.queryId?'algoId='+d.command.queryId:'algoClOrdId='+d.command.body.algoClOrdId);const o=(await okx(e,query))[0];if(!o?.state)throw new Failure('ORDER_STATUS_UNAVAILABLE');d.exchangeOrder=o;d.error=null;status=o.state.toUpperCase();if(row.kind==='amend_protection'&&o.state==='live'){const b=d.command.body;status=(!b.newTpTriggerPx||sameDecimal(o.tpTriggerPx,b.newTpTriggerPx))&&(!b.newSlTriggerPx||sameDecimal(o.slTriggerPx,b.newSlTriggerPx))?'AMENDED':'AMEND_PENDING'}if(row.kind.startsWith('cancel')&&['live','partially_filled'].includes(o.state))status='CANCEL_PENDING';if(o.state==='effective')status='TRIGGERED'}}catch(err){status='UNKNOWN';d.error=err instanceof Failure?err.code:'ORDER_QUERY_FAILED'}try{const snapshot=await sync(e);d.remainingPositions=snapshot.positions.filter((p:any)=>p.instId===d.command.instId);d.syncError=null}catch(err){d.syncError=err instanceof Failure?err.code:'POST_TRADE_SYNC_FAILED'}d.checkedAt=new Date().toISOString();await save(e,id,d,status);return actionResult(row,d,status)}
export async function execute(e:Env,kind:string,b:any,actor:string,sync:Sync){enabled(e);if(!b||!uuid(b.requestId))throw new Failure('INVALID_REQUEST_ID');const intent=canonical(b);const old=await e.DB.prepare('SELECT * FROM demo_actions WHERE id=?').bind(b.requestId).first<any>();if(old){if(old.actor!==actor||old.kind!==kind||old.intent!==intent)throw new Failure('IDEMPOTENCY_CONFLICT',409);return actionStatus(e,b.requestId,sync)}const command=await prepare(e,kind,b);const {verify,...serializable}=command;const d:any={command:serializable};const inserted=await e.DB.prepare('INSERT OR IGNORE INTO demo_actions VALUES(?,?,?,?,?,?,?,?)').bind(b.requestId,actor,kind,command.resource,new Date().toISOString(),'SUBMITTING',intent,JSON.stringify(d)).run();if(!inserted.meta.changes)throw new Failure('DEMO_ACTION_IN_PROGRESS',409);const row={id:b.requestId,kind};if(verify)try{await verify()}catch(err){d.error=err instanceof Failure?err.code:'PRE_SUBMIT_CHECK_FAILED';await save(e,b.requestId,d,'REJECTED');return actionResult(row,d,'REJECTED')}
 try{const results=await okx(e,command.path,'POST',command.body);const result=results[0];if(command.query==='leverage'){if(!result||result.instId!==command.instId||!sameDecimal(result.lever,command.body.lever))throw new Failure('LEVERAGE_ACCEPTANCE_UNCERTAIN')}else if(!result||result.sCode===undefined)throw new Failure('ORDER_ACCEPTANCE_UNCERTAIN');if(command.query!=='leverage'&&String(result.sCode)!=='0'){d.error='OKX_ORDER_'+String(result?.sCode||'UNKNOWN').replace(/[^A-Z0-9]/g,'');await save(e,b.requestId,d,'REJECTED');return actionResult(row,d,'REJECTED')}d.accepted=result;await save(e,b.requestId,d,'PENDING')}catch(err){if(command.query==='leverage'&&err instanceof Failure&&/^OKX_ERROR_/.test(err.code)){d.error=err.code;await save(e,b.requestId,d,'REJECTED');return actionResult(row,d,'REJECTED')}d.error=err instanceof Failure?err.code:'SUBMISSION_UNCERTAIN';await save(e,b.requestId,d,'UNKNOWN')}return actionStatus(e,b.requestId,sync)
}
export async function mcpClose(e:Env,b:any,sync:Sync){enabled(e);if(!b||!uuid(b.requestId)||typeof b.positionId!=='string'||!Number.isInteger(b.percent)||b.percent<1||b.percent>100)throw new Failure('INVALID_CLOSE_REQUEST');const previous=await e.DB.prepare('SELECT * FROM trade_actions WHERE id=?').bind(b.requestId).first<any>();if(previous){const data=JSON.parse(previous.data);if(previous.position_id!==b.positionId||data.intent?.percent!==b.percent)throw new Failure('IDEMPOTENCY_CONFLICT',409);return reconcileClose(e,b.requestId,sync)}const q=await quote(e,b.positionId),p=q.position;const quantity=closeQuantity(p.pos,q.closeableSize,q.instrument.lotSz,q.instrument.minSz,b.percent);return close(e,b.positionId,{confirm:true,requestId:b.requestId,percent:b.percent,expectedPos:p.pos,expectedQuantity:quantity,expectedInstId:p.instId,expectedPosSide:p.posSide},sync)}
