import { Failure } from './exchange';
import { candles, contract, minute, partialTrades, priceType, quote, source, symbolId, type MarketBudget, type MarketEnv } from './binance-market';
import { abs, bps, decimal, div, max, min, mul, positive, roundDown, text } from './virtual-decimal';
import { exit, fillPrice, pnl, protection, settleCandle, view, widenStop, type Position, type TradeEvent } from './virtual-model';

interface Env extends MarketEnv { DB: D1Database }
interface Account { id:string; name:string; created_at:number; initial:string; wallet:string; realized:string; fees:string;
  peak:string; drawdown:string; fee_bps:number; slip_bps:number; deviation_bps:number }
interface PositionRow { data:string }
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const day=86400000, offset=8*3600000;

function accountId(v:unknown) {
  if(v===undefined||v==='main')return 'main';
  if(typeof v!=='string'||!uuid.test(v))throw new Failure('INVALID_ACCOUNT_ID');
  return v;
}
function requiredId(value:unknown) {
  if(typeof value!=='string'||!uuid.test(value))throw new Failure('INVALID_REQUEST_OR_POSITION_ID');
  return value;
}
function requiredText(v:unknown,limit:number) {
  if(typeof v!=='string'||!v.trim()||v.length>limit)throw new Failure('INVALID_TEXT_FIELD');
  return v.trim();
}
function integer(v:unknown,minValue:number,maxValue:number) {
  if(typeof v!=='number'||!Number.isInteger(v)||v<minValue||v>maxValue)throw new Failure('INVALID_INTEGER_RANGE');
  return v;
}
function canonical(v:any):string {
  if(v===null||typeof v!=='object')return JSON.stringify(v);
  if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
  return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
}
const parsePosition=(row:PositionRow):Position=>JSON.parse(row.data);

async function withLock<T>(e:Env,work:(owner:string)=>Promise<T>) {
  const owner=crypto.randomUUID(),now=Date.now();
  const held=await e.DB.prepare(`INSERT INTO virtual_mutex VALUES(1,?,?) ON CONFLICT(id)
    DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE virtual_mutex.expires<=? RETURNING owner`)
    .bind(owner,now+90000,now).first();
  if(!held)throw new Failure('VIRTUAL_SETTLEMENT_BUSY',409);
  try{return await work(owner)}
  finally{await e.DB.prepare('DELETE FROM virtual_mutex WHERE id=1 AND owner=?').bind(owner).run()}
}

async function commit(e:Env,owner:string,statements:D1PreparedStatement[]) {
  const fence=e.DB.prepare(`INSERT INTO virtual_guard SELECT CASE WHEN EXISTS
    (SELECT 1 FROM virtual_mutex WHERE id=1 AND owner=? AND expires>?) THEN 1 ELSE 0 END`).bind(owner,Date.now());
  await e.DB.batch([fence,...statements,e.DB.prepare('DELETE FROM virtual_guard')]);
}

async function getAccount(e:Env,id:string) {
  const account=await e.DB.prepare('SELECT * FROM virtual_accounts WHERE id=?').bind(id).first<Account>();
  if(!account)throw new Failure('VIRTUAL_ACCOUNT_NOT_FOUND',404);
  return account;
}

function accountStatement(e:Env,a:Account) {
  return e.DB.prepare('UPDATE virtual_accounts SET wallet=?,realized=?,fees=?,peak=?,drawdown=? WHERE id=?')
    .bind(a.wallet,a.realized,a.fees,a.peak,a.drawdown,a.id);
}

function positionStatement(e:Env,p:Position,insert=false) {
  const net=decimal(p.realized)-decimal(p.fees), sign=net>0n?1:net<0n?-1:0;
  if(insert)return e.DB.prepare('INSERT INTO virtual_positions VALUES(?,?,?,?,?,?,?,?,?)')
    .bind(p.id,p.accountId,p.symbol,p.openedAt,p.closedAt,p.cursor,p.shadowOf,sign,JSON.stringify(p));
  return e.DB.prepare('UPDATE virtual_positions SET closed_at=?,cursor=?,net_sign=?,data=? WHERE id=?')
    .bind(p.closedAt,p.cursor,sign,JSON.stringify(p),p.id);
}

function eventStatement(e:Env,p:Position,event:TradeEvent) {
  return e.DB.prepare('INSERT INTO virtual_events VALUES(?,?,?,?,?,?,?)')
    .bind(event.id,p.id,p.accountId,event.time,event.kind,p.shadowOf?1:0,JSON.stringify(event));
}

function applyEvents(a:Account,events:TradeEvent[]) {
  for(const event of events){
    const realized=decimal(event.realized),fee=decimal(event.fee);
    a.wallet=text(decimal(a.wallet)+realized-fee);
    a.realized=text(decimal(a.realized)+realized);
    a.fees=text(decimal(a.fees)+fee);
  }
  if(decimal(a.wallet)<0n)throw new Failure('VIRTUAL_LEDGER_INVARIANT',500);
}

async function active(e:Env,id?:string) {
  const query=id?e.DB.prepare('SELECT data FROM virtual_positions WHERE account_id=? AND closed_at IS NULL').bind(id):
    e.DB.prepare('SELECT data FROM virtual_positions WHERE closed_at IS NULL ORDER BY cursor,id');
  return (await query.all<PositionRow>()).results.map(parsePosition);
}
async function getPosition(e:Env,id:string) {
  const row=await e.DB.prepare('SELECT data FROM virtual_positions WHERE id=?').bind(requiredId(id)).first<PositionRow>();
  if(!row)throw new Failure('VIRTUAL_POSITION_NOT_FOUND',404);
  return parsePosition(row);
}

function funds(a:Account,positions:Position[]) {
  let locked=0n,unrealized=0n;
  for(const p of positions){
    if(p.shadowOf||p.closedAt!==null)continue;
    locked+=decimal(p.locked);
    unrealized+=max(-decimal(p.locked),pnl(p,decimal(p.current)));
  }
  const wallet=decimal(a.wallet),equity=wallet+unrealized;
  return {locked,unrealized,wallet,equity,available:wallet-locked};
}

function drawdown(a:Account,positions:Position[]) {
  const {equity}=funds(a,positions);
  const peak=max(equity,decimal(a.peak));
  a.peak=text(peak);
  a.drawdown=text(max(decimal(a.drawdown),div(peak-equity,peak)));
}

export async function portfolio(e:Env,id:unknown) {
  const key=accountId(id);
  const beginning=Math.floor((Date.now()+offset)/day)*day-offset;
  const [accounts,open,rows,marketRows]=await e.DB.batch([
    e.DB.prepare('SELECT * FROM virtual_accounts WHERE id=?').bind(key),
    e.DB.prepare('SELECT data FROM virtual_positions WHERE account_id=? AND closed_at IS NULL AND shadow_of IS NULL').bind(key),
    e.DB.prepare('SELECT data FROM virtual_events WHERE account_id=? AND shadow=0 AND occurred_at>=?').bind(key,beginning),
    e.DB.prepare('SELECT * FROM virtual_market WHERE symbol IN (SELECT symbol FROM virtual_positions WHERE account_id=? AND closed_at IS NULL) ORDER BY checked_at DESC').bind(key),
  ]);
  const account=accounts.results[0] as unknown as Account|undefined;
  if(!account)throw new Failure('VIRTUAL_ACCOUNT_NOT_FOUND',404);
  const positions=(open.results as unknown as PositionRow[]).map(parsePosition);
  const f=funds(account,positions),net=decimal(account.realized)-decimal(account.fees);
  let earned=0n,lost=0n;
  for(const row of rows.results as {data:string}[]){const event=JSON.parse(row.data);const amount=decimal(event.realized)-decimal(event.fee);if(amount>=0n)earned+=amount;else lost+=amount}
  return {mode:'virtual',source,priceType,account,positions:positions.map(view),market:marketRows.results,
    equity:text(f.equity),available:text(f.available),usedMargin:text(f.locked),unrealized:text(f.unrealized),net:text(net),
    returnRatio:text(div(net,positive(account.initial))),today:{earned:text(earned),lost:text(lost),net:text(earned+lost)},
    positionCount:positions.length,latestMarketTime:positions.length?Math.min(...positions.map(p=>p.markTime)):null};
}

export async function positionDetail(e:Env,id:string) {
  const p=await getPosition(e,id);
  const [events,shadows]=await e.DB.batch([e.DB.prepare('SELECT data FROM virtual_events WHERE position_id=? ORDER BY occurred_at,id').bind(id),
    e.DB.prepare('SELECT data FROM virtual_positions WHERE shadow_of=? ORDER BY id').bind(id)]);
  return {position:view(p),events:events.results.map((r:any)=>JSON.parse(r.data)),shadows:shadows.results.map((r:any)=>view(parsePosition(r)))};
}

export async function history(e:Env,query:URLSearchParams) {
  const id=accountId(query.get('accountId')??undefined);
  await getAccount(e,id);
  const cursor=query.get('cursor');
  let before=Number.MAX_SAFE_INTEGER, beforeId='~';
  if(cursor){
    const [time,position]=cursor.split(':');
    before=Number(time);beforeId=requiredId(position);
    if(!Number.isSafeInteger(before)||before<0)throw new Failure('INVALID_HISTORY_CURSOR');
  }
  const conditions=['account_id=?','shadow_of IS NULL','closed_at IS NOT NULL','(closed_at<? OR (closed_at=? AND id<?))'];
  const params:(string|number)[]=[id,before,before,beforeId];
  for(const [key,column] of [['symbol','symbol'],['direction',"json_extract(data,'$.direction')"],['strategy',"json_extract(data,'$.decision.strategy')"]]){
    const value=query.get(key);if(value){conditions.push(column+'=?');params.push(requiredText(value,80))}
  }
  for(const [key,op] of [['from','>='],['to','<=']]){
    const value=query.get(key);if(value){conditions.push('closed_at'+op+'?');params.push(integer(Number(value),0,Number.MAX_SAFE_INTEGER))}
  }
  const result=query.get('result');
  if(result==='win'||result==='loss'){conditions.push('net_sign=?');params.push(result==='win'?1:-1)}
  const reason=query.get('reason');
  if(reason){conditions.push('EXISTS (SELECT 1 FROM virtual_events WHERE position_id=virtual_positions.id AND kind=? AND occurred_at=virtual_positions.closed_at)');params.push(requiredText(reason,40))}
  const rows=(await e.DB.prepare('SELECT data FROM virtual_positions WHERE '+conditions.join(' AND ')+' ORDER BY closed_at DESC,id DESC LIMIT 51').bind(...params).all<PositionRow>()).results;
  const items=rows.slice(0,50).map(row=>view(parsePosition(row)));
  const last=items.at(-1);
  return {items,nextCursor:rows.length>50&&last?`${last.closedAt}:${last.id}`:null};
}

function audit(p:Position,id:string,kind:string,actor:string,time:number,price:string,fee='0'):TradeEvent {
  return {id,positionId:p.id,kind,time,processedAt:Date.now(),price,triggerPrice:null,fillPrice:p.entry,
    quantity:kind==='OPEN'?p.quantity:'0',fee,realized:'0',released:'0',remaining:p.remaining,source,priceType,actor,
    strategy:p.decision.strategy,executionAmbiguity:false};
}

async function createPosition(e:Env,b:any,id:string,actor:string) {
  const symbol=symbolId(b.symbol);
  const a=await getAccount(e,accountId(b.accountId));
  const positions=await active(e);
  const main=positions.filter(p=>!p.shadowOf);
  const symbols=new Set(positions.map(p=>p.symbol));
  if(main.length>=12||positions.length+3>36||(!symbols.has(symbol)&&symbols.size>=4))throw new Failure('VIRTUAL_ACTIVE_LIMIT',409);
  const margin=positive(b.margin),leverage=integer(b.leverage,1,100);
  if(b.direction!=='LONG'&&b.direction!=='SHORT')throw new Failure('INVALID_DIRECTION');
  const decisionPrice=positive(b.decisionPrice),decisionTime=integer(b.decisionTime,Date.now()-day,Date.now()+5000);
  const reason=requiredText(b.reason,2500),strategy=requiredText(b.strategy,80);
  const analysis=b.analysis??{};
  if(!analysis||typeof analysis!=='object'||Array.isArray(analysis)||JSON.stringify(analysis).length>6000)throw new Failure('INVALID_ANALYSIS');
  const [instrument,latest]=await Promise.all([contract(e,symbol),quote(e,symbol)]);
  const market=positive(latest.price),tick=positive(instrument.tick),step=positive(instrument.step);
  const entry=fillPrice(market,tick,a.slip_bps,b.direction==='LONG');
  if(abs(entry-decisionPrice)>bps(decisionPrice,a.deviation_bps))throw new Failure('VIRTUAL_PRICE_DEVIATION',409);
  const quantity=roundDown(div(margin*BigInt(leverage),entry),step),notional=mul(entry,quantity);
  if(quantity<positive(instrument.minQty)||quantity>positive(instrument.maxQty)||notional<decimal(instrument.minNotional))throw new Failure('VIRTUAL_ORDER_SIZE_FILTER');
  const actualMargin=notional/BigInt(leverage),fee=bps(notional,a.fee_bps);
  if(actualMargin<=0n||funds(a,positions.filter(p=>p.accountId===a.id)).available<actualMargin+fee)throw new Failure('INSUFFICIENT_VIRTUAL_FUNDS',409);
  const openedAt=Math.max(Date.now(),latest.time);
  const p:Position={id,accountId:a.id,symbol,direction:b.direction,leverage,margin:text(actualMargin),locked:text(actualMargin),quantity:text(quantity),remaining:text(quantity),
    entry:text(entry),current:latest.price,markTime:latest.time,marketTime:latest.time,openedAt,closedAt:null,cursor:openedAt+1,
    stopLoss:'0',tiers:[],step:instrument.step,tick:instrument.tick,feeBps:a.fee_bps,slipBps:a.slip_bps,
    decision:{price:text(decisionPrice),time:decisionTime,reason,strategy,analysis},realized:'0',fees:text(fee),mfe:'0',mae:'0',shadowOf:null,variant:'primary'};
  Object.assign(p,protection(b.stopLoss,b.tiers,p,p.entry));
  protection(b.stopLoss,b.tiers,p,latest.price);
  const last=p.tiers[p.tiers.length-1];
  const single:Position={...p,id:crypto.randomUUID(),shadowOf:p.id,variant:'single',...protection(p.stopLoss,[{percent:100,price:last.price}],p,p.entry,true)};
  const wide:Position={...p,id:crypto.randomUUID(),shadowOf:p.id,variant:'wide_stop',...protection(widenStop(p),p.tiers,p,p.entry)};
  const opening={...audit(p,id+':OPEN','OPEN',actor,openedAt,latest.price,text(fee)),
    marketTime:latest.time,protection:{stopLoss:p.stopLoss,tiers:p.tiers},decision:p.decision};
  applyEvents(a,[opening]);
  drawdown(a,[...positions.filter(row=>row.accountId===a.id),p]);
  const statements=[accountStatement(e,a),...([p,single,wide].flatMap(row=>[positionStatement(e,row,true),
    eventStatement(e,row,row===p?opening:audit(row,row.id+':OPEN','OPEN',actor,openedAt,latest.price,text(fee)))]))];
  return {statements,result:{requestId:id,status:'COMMITTED',position:view(p),shadows:[single.id,wide.id]}};
}

async function replay(e:Env,p:Position,until:number,budget?:MarketBudget) {
  const events:TradeEvent[]=[];
  if(p.closedAt!==null||p.cursor>=until)return events;
  const boundary=Math.ceil(p.cursor/minute)*minute;
  if(boundary>p.cursor){
    const end=Math.min(boundary,until);
    for(const row of await partialTrades(e,p.symbol,p.cursor,end,budget)){
      events.push(...settleCandle(p,row));
      if(p.closedAt!==null)break;
    }
    p.cursor=end;
  }
  const lastClosed=Math.floor(until/minute)*minute;
  if(p.closedAt===null&&p.cursor<lastClosed){
    for(const row of await candles(e,p.symbol,p.cursor,lastClosed,budget)){
      events.push(...settleCandle(p,row));
      p.cursor=row.end+1;
      if(p.closedAt!==null)break;
    }
  }
  if(p.closedAt===null&&p.cursor===lastClosed&&until>lastClosed){
    for(const row of await partialTrades(e,p.symbol,p.cursor,until,budget)){
      events.push(...settleCandle(p,row));
      if(p.closedAt!==null)break;
    }
    p.cursor=until;
  }
  return events;
}

export async function action(e:Env,b:any,actor:string) {
  const id=requiredId(b?.requestId),intent=canonical(b);
  return withLock(e,async owner=>{
    const previous=await e.DB.prepare('SELECT actor,intent,result FROM virtual_requests WHERE id=?').bind(id).first<{actor:string;intent:string;result:string}>();
    if(previous){if(previous.actor!==actor||previous.intent!==intent)throw new Failure('VIRTUAL_IDEMPOTENCY_CONFLICT',409);return JSON.parse(previous.result)}
    let statements:D1PreparedStatement[],result:unknown;
    if(b.action==='OPEN'){
      const halt=await e.DB.prepare("SELECT value FROM system_settings WHERE key='virtual_halt'").first<{value:string}>();
      if(halt?.value==='true')throw new Failure('VIRTUAL_NEW_ENTRIES_PAUSED',409);
      ({statements,result}=await createPosition(e,b,id,actor));
    }else if(b.action==='CLOSE'||b.action==='UPDATE_PROTECTION'){
      const p=await getPosition(e,b.positionId);
      if(p.shadowOf||p.closedAt!==null)throw new Failure('VIRTUAL_POSITION_NOT_EDITABLE',409);
      const a=await getAccount(e,p.accountId),latest=await quote(e,p.symbol);
      if(latest.time+1<p.cursor)throw new Failure('VIRTUAL_MARKET_OUT_OF_ORDER',409);
      const events=await replay(e,p,latest.time+1);
      if(p.closedAt===null&&p.cursor<latest.time+1)throw new Failure('VIRTUAL_CATCHUP_REQUIRED',409);
      if(p.closedAt===null){
        p.current=latest.price;p.markTime=latest.time;
        if(b.action==='CLOSE')events.push(exit(p,{id:id+':CLOSE',kind:'MANUAL_CLOSE',quantity:positive(p.remaining),market:positive(latest.price),time:latest.time,actor}));
        else{
          Object.assign(p,protection(b.stopLoss,b.tiers,p,latest.price));
          const event=audit(p,id+':PROTECTION','UPDATE_PROTECTION',actor,latest.time,latest.price);
          events.push({...event,fillPrice:'0',protection:{stopLoss:p.stopLoss,tiers:p.tiers}} as TradeEvent);
        }
      }
      applyEvents(a,events);
      drawdown(a,(await active(e,a.id)).map(row=>row.id===p.id?p:row));
      statements=[accountStatement(e,a),positionStatement(e,p),...events.map(event=>eventStatement(e,p,event))];
      result={requestId:id,status:'COMMITTED',position:view(p),events};
    }else throw new Failure('INVALID_VIRTUAL_ACTION');
    await commit(e,owner,[...statements,e.DB.prepare('INSERT INTO virtual_requests VALUES(?,?,?,?,?)').bind(id,actor,intent,Date.now(),JSON.stringify(result))]);
    return result;
  });
}

export async function requestStatus(e:Env,id:string,actor:string) {
  const row=await e.DB.prepare('SELECT result FROM virtual_requests WHERE id=? AND actor=?').bind(requiredId(id),actor).first<{result:string}>();
  if(!row)throw new Failure('VIRTUAL_REQUEST_NOT_COMMITTED',404);
  return JSON.parse(row.result);
}

export async function configure(e:Env,b:any) {
  return withLock(e,async owner=>{
    const initial=text(positive(b?.initial)),fee=integer(b.feeBps??5,0,100),slip=integer(b.slipBps??2,0,100),deviation=integer(b.deviationBps??50,1,500);
    const name=requiredText(b.name,60);
    if(b.id===undefined){
      const id=crypto.randomUUID();
      await commit(e,owner,[e.DB.prepare('INSERT INTO virtual_accounts VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,name,Date.now(),initial,initial,'0','0',initial,'0',fee,slip,deviation)]);
      return getAccount(e,id);
    }
    const id=accountId(b.id),a=await getAccount(e,id);
    const used=await e.DB.prepare('SELECT id FROM virtual_positions WHERE account_id=? LIMIT 1').bind(id).first();
    if(used&&decimal(a.initial)!==decimal(initial))throw new Failure('CREATE_NEW_ACCOUNT_TO_CHANGE_INITIAL',409);
    await commit(e,owner,[e.DB.prepare('UPDATE virtual_accounts SET name=?, initial=?, wallet=?, peak=?, fee_bps=?, slip_bps=?, deviation_bps=? WHERE id=?')
      .bind(name,initial,used?a.wallet:initial,used?a.peak:initial,fee,slip,deviation,id)]);
    return getAccount(e,id);
  });
}

export async function accounts(e:Env) {
  return (await e.DB.prepare('SELECT * FROM virtual_accounts ORDER BY created_at,id LIMIT 100').all<Account>()).results;
}

export async function statistics(e:Env,id:unknown) {
  const account=await getAccount(e,accountId(id));
  const rows=(await e.DB.prepare(`SELECT data FROM virtual_positions WHERE account_id=? AND shadow_of IS NULL
    AND closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 1001`).bind(account.id).all<PositionRow>()).results;
  const positions=rows.slice(0,1000).map(parsePosition);
  const groups=new Map<string,{dimension:string;key:string;count:number;wins:number;net:bigint}>();
  let gains=0n,losses=0n,wins=0,losers=0;
  for(const p of positions){
    const net=decimal(p.realized)-decimal(p.fees);
    if(net>0n){wins++;gains+=net}else if(net<0n){losers++;losses+=net}
    for(const [dimension,key] of [['symbol',p.symbol],['direction',p.direction],['strategy',p.decision.strategy],['hour',String(new Date(p.openedAt+offset).getUTCHours())]]){
      const id=dimension+':'+key;
      const group=groups.get(id)??{dimension,key,count:0,wins:0,net:0n};
      group.count++;if(net>0n)group.wins++;group.net+=net;groups.set(id,group);
    }
  }
  const averageGain=wins?gains/BigInt(wins):0n,averageLoss=losers?losses/BigInt(losers):0n;
  return {count:positions.length,wins,losses:losers,truncated:rows.length>1000,
    winRate:positions.length?text(div(BigInt(wins),BigInt(positions.length))):'0',
    expectancy:positions.length?text((gains+losses)/BigInt(positions.length)):'0',
    averageGain:text(averageGain),averageLoss:text(averageLoss), payoffRatio:averageLoss<0n?text(div(averageGain,-averageLoss)):null,
    drawdown:account.drawdown,fees:account.fees,
    groups:[...groups.values()].map(g=>({...g,net:text(g.net),winRate:text(div(BigInt(g.wins),BigInt(g.count)))}))};
}

export async function settle(e:Env) {
  return withLock(e,async owner=>{
    const open=await active(e),until=Math.floor(Date.now()/minute)*minute;
    const budget={remaining:22,deadline:Date.now()+65000};
    const changed:Position[]=[];
    const accountUpdates=new Map<string,Account>();
    const events:TradeEvent[]=[];
    const statements:D1PreparedStatement[]=[];
    const marketStatus: {symbol:string;price:string|null;time:number|null;error:string|null}[]=[];
    const groups=new Map<string,Position[]>();
    for(const p of open){const group=groups.get(p.symbol)??[];group.push(p);groups.set(p.symbol,group)}
    for(const [symbol,group] of groups){
      let latest:Awaited<ReturnType<typeof quote>>|undefined,error:string|null=null;
      try{latest=await quote(e,symbol,budget)}catch(err){error=err instanceof Failure?err.code:'VIRTUAL_QUOTE_FAILED'}
      for(const original of group){
        const p=structuredClone(original);
        try{
          const fills=await replay(e,p,until,budget);
          if(p.closedAt===null&&latest&&latest.time>=p.markTime){p.current=latest.price;p.markTime=latest.time}
          if(p.cursor<until&&p.closedAt===null)error??='VIRTUAL_CATCHUP_PENDING';
          if(!p.shadowOf&&fills.length){
            const a=accountUpdates.get(p.accountId)??await getAccount(e,p.accountId);
            applyEvents(a,fills);accountUpdates.set(a.id,a);
          }
          changed.push(p);events.push(...fills);
          statements.push(positionStatement(e,p),...fills.map(fill=>eventStatement(e,p,fill)));
        }catch(err){error=err instanceof Failure?err.code:'VIRTUAL_REPLAY_FAILED'}
      }
      marketStatus.push({symbol,price:latest?.price??null,time:latest?.time??null,error});
      statements.push(e.DB.prepare(`INSERT INTO virtual_market VALUES(?,?,?,?,?) ON CONFLICT(symbol) DO UPDATE SET
        price=COALESCE(excluded.price,virtual_market.price),time=COALESCE(excluded.time,virtual_market.time),error=excluded.error,checked_at=excluded.checked_at`)
        .bind(symbol,latest?.price??null,latest?.time??null,error,Date.now()));
    }
    const snapshots=new Map(changed.map(p=>[p.id,p]));
    for(const id of new Set(open.filter(p=>!p.shadowOf).map(p=>p.accountId))){
      const a=accountUpdates.get(id)??await getAccount(e,id);
      drawdown(a,open.filter(p=>p.accountId===id).map(p=>snapshots.get(p.id)??p));
      statements.push(accountStatement(e,a));
    }
    if(statements.length)await commit(e,owner,statements);
    return {processedUntil:until,events:events.length,market:marketStatus};
  });
}
