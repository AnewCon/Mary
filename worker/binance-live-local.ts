
import { Failure } from './exchange';
import { hash } from './security';
import { positive,text } from './virtual-decimal';

const heartbeatKey='binance_local_heartbeat';
const requestKey='binance_live_request_v1';
type Queue={id:string;order:{symbol:string;side:string;quantity:string;type:string;price?:string;reduceOnly:boolean};state:string;expires:number;result?:unknown};

async function value<T>(db:D1Database,key:string):Promise<T|null>{
  const raw=await db.prepare('SELECT value FROM system_settings WHERE key=?').bind(key).first<string>('value');
  return raw?JSON.parse(raw):null;
}
export async function localLiveStatus(db:D1Database){
  const beat=await value<{time:number;ready:boolean}>(db,heartbeatKey);
  const online=Boolean(beat&&Date.now()-beat.time<35000);
  return {online,ready:online&&beat?.ready===true,lastSeen:beat?.time??null};
}
export async function localLiveAgent(db:D1Database,secret:string|undefined,authorization:string,path:string,input:any){
  if(!secret||await hash(authorization)!==await hash('Bearer '+secret))throw new Failure('UNAUTHORIZED',401);
  if(path==='heartbeat'){
    await db.prepare('INSERT OR REPLACE INTO system_settings(key,value) VALUES(?,?)').bind(heartbeatKey,JSON.stringify({time:Date.now(),ready:input?.ready===true})).run();
    const queue=await value<Queue>(db,requestKey);
    return queue?.state==='pending'&&queue.expires>Date.now()?queue:null;
  }
  if(!['claim','result'].includes(path))throw new Failure('NOT_FOUND',404);
  const raw=await db.prepare('SELECT value FROM system_settings WHERE key=?').bind(requestKey).first<string>('value');
  const queue:Queue|null=raw?JSON.parse(raw):null;
  if(!queue||input?.id!==queue.id)throw new Failure('LIVE_REQUEST_NOT_FOUND',404);
  if(path==='claim'){
    if(queue.state!=='pending'||queue.expires<=Date.now()||!(await localLiveStatus(db)).ready)throw new Failure('LIVE_REQUEST_UNAVAILABLE',409);
    queue.state='executing';
  } else {
    if(queue.state==='pending'&&input.state==='declined')queue.state='declined';
    else if(queue.state==='executing'&&['accepted','unknown','rejected'].includes(input.state))queue.state=input.state;
    else throw new Failure('LIVE_REQUEST_UNAVAILABLE',409);
    queue.result=input.result??null;
  }
  const changed=await db.prepare('UPDATE system_settings SET value=? WHERE key=? AND value=?').bind(JSON.stringify(queue),requestKey,raw).run();
  if(changed.meta.changes!==1)throw new Failure('LIVE_REQUEST_CONFLICT',409);
  return queue;
}

export async function submitLocalLive(db:D1Database,input:any){
  const {id,symbol,side,type,quantity,price,confirm,reduceOnly}=input??{};
  if(typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id)||typeof symbol!=='string'||!/^[A-Z0-9]{2,24}USDT$/.test(symbol)||
     !['BUY','SELL'].includes(side)||!['MARKET','LIMIT'].includes(type)||typeof reduceOnly!=='boolean'||confirm!==true)throw new Failure('LIVE_INVALID_ORDER');
  const order={symbol,side,type,reduceOnly,quantity:text(positive(quantity)),...(type==='LIMIT'?{price:text(positive(price))}:{})};
  const old=await value<Queue>(db,requestKey);
  if(old?.id===id){
    if(JSON.stringify(old.order)!==JSON.stringify(order))throw new Failure('LIVE_REQUEST_CONFLICT',409);
    return old;
  }
  if(!(await localLiveStatus(db)).ready)throw new Failure('LIVE_DESKTOP_OFFLINE',409);
  // The last request stays visible until a new one is accepted. A persistent receipt prevents ID reuse.
  const past=await db.prepare('SELECT value FROM system_settings WHERE key=?').bind('binance_live_id:'+id).first();
  if(past)throw new Failure('LIVE_REQUEST_ALREADY_USED',409);
  if(old&&(old.state==='executing'||old.state==='unknown'||old.state==='pending'&&old.expires>Date.now()))throw new Failure('LIVE_DESKTOP_HAS_REQUEST',409);
  const queue={id,order,state:'pending',expires:Date.now()+120000};
  // Compare the prior value so concurrent submissions cannot overwrite one another.
  const update=old?db.prepare('UPDATE system_settings SET value=? WHERE key=? AND value=?').bind(JSON.stringify(queue),requestKey,JSON.stringify(old)):
    db.prepare('INSERT OR IGNORE INTO system_settings(key,value) VALUES(?,?)').bind(requestKey,JSON.stringify(queue));
  const receipt=db.prepare("INSERT OR IGNORE INTO system_settings(key,value) SELECT ?,'1' WHERE (SELECT value FROM system_settings WHERE key=?)=?")
    .bind('binance_live_id:'+id,requestKey,JSON.stringify(queue));
  const [result]=await db.batch([update,receipt]);
  if(result.meta.changes!==1)throw new Failure('LIVE_REQUEST_CONFLICT',409);
  return queue;
}

export async function readLocalLiveRequest(db:D1Database,id:unknown){
  const queue=await value<Queue>(db,requestKey);
  if(!queue||queue.id!==id)throw new Failure('LIVE_REQUEST_NOT_FOUND',404);
  return queue.state==='pending'&&queue.expires<=Date.now()?{...queue,state:'expired'}:queue;
}
