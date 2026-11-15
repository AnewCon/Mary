
import { decode } from './binance-demo-trades';
import { Failure } from './exchange';
import { hash } from './security';
import { positive,text } from './virtual-decimal';

const heartbeatKey='binance_local_heartbeat';
const requestKey='binance_live_request_v1';
const queryKey='binance_live_query_v1';
type Action=ReturnType<typeof decode>['action'] & {conditional?:boolean};
type Order={symbol:string;side:string;quantity:string;type:string;price?:string;reduceOnly:boolean};
type Queue={id:string;order?:Order;action?:Action;state:string;expires:number;result?:unknown};
const queryKinds=new Set(['orders','contract','query']);
const actionKinds=new Set([...queryKinds,'open','limit','close','leverage','protect','cancel']);
const receiptKey=(id:string)=>'binance_live_id:'+id;


async function value<T>(db:D1Database,key:string):Promise<T|null>{
  const raw=await db.prepare('SELECT value FROM system_settings WHERE key=?').bind(key).first<string>('value');
  return raw?JSON.parse(raw):null;
}
export async function localLiveStatus(db:D1Database){
  const beat=await value<{time:number;ready:boolean;version?:number}>(db,heartbeatKey);
  const online=Boolean(beat?.ready===true&&Date.now()-beat.time<35000);
  return {online,ready:online&&beat?.ready===true,lastSeen:beat?.time??null,version:beat?.version??1};
}
export async function localLiveAgent(db:D1Database,secret:string|undefined,authorization:string,path:string,input:any){
  if(!secret||await hash(authorization)!==await hash('Bearer '+secret))throw new Failure('UNAUTHORIZED',401);
  if(path==='heartbeat'){
    await db.prepare('INSERT OR REPLACE INTO system_settings(key,value) VALUES(?,?)').bind(heartbeatKey,JSON.stringify({time:Date.now(),ready:input?.ready===true,version:input?.version===2?2:1})).run();
    if(input?.ready!==true)return null;
    for(const key of input?.version===2?[requestKey,queryKey]:[requestKey]){
      const queue=await value<Queue>(db,key);
      if(queue?.state==='pending'&&queue.expires>Date.now()&&(!queue.action||input?.version===2))return queue;
    }
    return null;
  }
  if(!['claim','result'].includes(path))throw new Failure('NOT_FOUND',404);
  const entries=await db.prepare('SELECT key,value FROM system_settings WHERE key IN (?,?)').bind(requestKey,queryKey).all<{key:string;value:string}>();
  const row=entries.results.find(row=>JSON.parse(row.value).id===input?.id);
  const raw=row?.value;
  const queue:Queue|null=raw?JSON.parse(raw):null;
  if(!queue||input?.id!==queue.id)throw new Failure('LIVE_REQUEST_NOT_FOUND',404);
  if(path==='claim'){
    if(queue.state!=='pending'||queue.expires<=Date.now()||!(await localLiveStatus(db)).ready||Boolean(queue.action&&input?.version!==2))throw new Failure('LIVE_REQUEST_UNAVAILABLE',409);
    queue.state='executing';
  } else {
    if(queue.state==='pending'&&input.state==='declined')queue.state='declined';
    else if(queue.state==='executing'&&['accepted','unknown','rejected'].includes(input.state))queue.state=input.state;
    else throw new Failure('LIVE_REQUEST_UNAVAILABLE',409);
    queue.result=input.result??null;
  }
  const changed=await db.prepare('UPDATE system_settings SET value=? WHERE key=? AND value=?').bind(JSON.stringify(queue),row!.key,raw).run();
  if(changed.meta.changes!==1)throw new Failure('LIVE_REQUEST_CONFLICT',409);
  return queue;
}

export async function submitLocalLive(db:D1Database,input:any){
  const {id,symbol,side,type,quantity,price,confirm,reduceOnly}=input??{};
  if(typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id)||typeof symbol!=='string'||!/^[A-Z0-9]{2,24}USDT$/.test(symbol)||
     !['BUY','SELL'].includes(side)||!['MARKET','LIMIT'].includes(type)||typeof reduceOnly!=='boolean'||confirm!==true)throw new Failure('LIVE_INVALID_ORDER');
  const order={symbol,side,type,reduceOnly,quantity:text(positive(quantity)),...(type==='LIMIT'?{price:text(positive(price))}:{})};
  return enqueue(db,{id,order});
}

export async function submitLocalLiveAction(db:D1Database,input:unknown){
  const kind=(input as {kind?:unknown}|null)?.kind;
  if(typeof kind!=='string'||!actionKinds.has(kind))throw new Failure('LIVE_INVALID_ACTION');
  if(!queryKinds.has(kind)&&(input as {confirm?:unknown}).confirm!==true)throw new Failure('BINANCE_LIVE_CONFIRMATION_REQUIRED');
  const {id,action}=decode(input);
  return enqueue(db,{id,action:kind==='query'&&(input as {conditional?:unknown}).conditional===true?{...action,conditional:true}:action});
}

export async function readLocalLiveAccount(db:D1Database){
  const snapshot=await value(db,'binance_live_snapshot');
  return {accountMode:'live',snapshot,...await localLiveStatus(db)};
}

async function enqueue(db:D1Database,payload:Pick<Queue,'id'|'order'|'action'>){
  const {id,action,order}=payload;
  const read=Boolean(action&&queryKinds.has(action.kind));
  const slot=read?queryKey:requestKey;
  const old=await value<Queue>(db,slot);
  if(old?.id===id){
    if(JSON.stringify([old.order,old.action])!==JSON.stringify([order,action]))throw new Failure('LIVE_REQUEST_CONFLICT',409);
    return expired(old);
  }
  const past=await value<Queue>(db,receiptKey(id));
  if(past){
    if(past.id!==id)throw new Failure('LIVE_REQUEST_ALREADY_USED',409);
    if(JSON.stringify([past.order,past.action])!==JSON.stringify([order,action]))throw new Failure('LIVE_REQUEST_CONFLICT',409);
    return expired(past);
  }
  const status=await localLiveStatus(db);
  if(!status.ready)throw new Failure('LIVE_DESKTOP_OFFLINE',409);
  if(action&&status.version!==2)throw new Failure('LIVE_DESKTOP_UPDATE_REQUIRED',409);
  // The last request stays visible until a new one is accepted. A persistent receipt prevents ID reuse.
  if(old&&(!read&&(old.state==='executing'||old.state==='unknown')||['pending','executing'].includes(old.state)&&old.expires>Date.now()))throw new Failure('LIVE_DESKTOP_HAS_REQUEST',409);
  const queue={...payload,state:'pending',expires:Date.now()+120000};
  // Reserve the ID before modifying either slot, including when read and write calls race.
  const reservation=JSON.stringify(crypto.randomUUID());
  const reserve=db.prepare("INSERT OR IGNORE INTO system_settings(key,value) SELECT ?,? WHERE COALESCE((SELECT value FROM system_settings WHERE key=?),'')=?")
    .bind(receiptKey(id),reservation,slot,old?JSON.stringify(old):'');
  const guarded=old
    ?db.prepare("UPDATE system_settings SET value=? WHERE key=? AND value=? AND (SELECT value FROM system_settings WHERE key=?)=?").bind(JSON.stringify(queue),slot,JSON.stringify(old),receiptKey(id),reservation)
    :db.prepare("INSERT OR IGNORE INTO system_settings(key,value) SELECT ?,? WHERE (SELECT value FROM system_settings WHERE key=?)=?").bind(slot,JSON.stringify(queue),receiptKey(id),reservation);
  const archive=old?[db.prepare("UPDATE system_settings SET value=? WHERE key=? AND (SELECT value FROM system_settings WHERE key=?)=?")
    .bind(JSON.stringify(expired(old)),receiptKey(old.id),slot,JSON.stringify(queue))]:[];
  const [,result]=await db.batch([reserve,guarded,...archive]);
  if(result.meta.changes!==1)throw new Failure('LIVE_REQUEST_CONFLICT',409);
  return queue;
}

function expired(queue:Queue){
  return (queue.state==='pending'||queue.action&&queryKinds.has(queue.action.kind)&&queue.state==='executing')
    &&queue.expires<=Date.now()?{...queue,state:'expired'}:queue;
}

export async function readLocalLiveRequest(db:D1Database,id:unknown){
  if(typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id))throw new Failure('INVALID_REQUEST_ID');
  const rows=await db.prepare('SELECT key,value FROM system_settings WHERE key IN (?,?,?)')
    .bind(requestKey,queryKey,receiptKey(id)).all<{key:string;value:string}>();
  for(const row of rows.results){
    const queue=JSON.parse(row.value) as Queue;
    if(queue.id===id)return expired(queue);
  }
  throw new Failure('LIVE_REQUEST_NOT_FOUND',404);
}
