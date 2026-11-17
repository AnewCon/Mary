import {snapPrice,type Candle,type Frame,type GridMarket,type Rules} from './grid-engine';

export type MartinConfig={entry:number;quantity:number;margin:number;reserve:number;leverage:number;
 shock:number;maxAdds:number;maxQuantity:number;maxLoss:number;fee:number;slip:number;maintenance:number;take:number;stop:number};
export const martinDefaults:MartinConfig={entry:0,quantity:100,margin:8,reserve:16,leverage:10,shock:20,maxAdds:3,maxQuantity:10000,maxLoss:12,
 fee:.05,slip:.05,maintenance:.5,take:0,stop:0};

type Position={quantity:number;notional:number;margin:number;reserve:number;fees:number};
export type MartinSnapshot={quantity:number;average:number;margin:number;reserve:number;fees:number;breakEven:number|null;liquidation:number|null;
 floating:number;netExit:number;equity:number;buffer:number;maintenanceDue:number};
export type MartinEvent={kind:'ADD'|'TAKE_PROFIT'|'STOP_LOSS'|'LOSS_LIMIT'|'ESTIMATED_LIQUIDATION';time:number;trigger:number;fill:number;quantity:number;fee:number;net:number|null};
type AddResult={status:'OK';quantity:number;fill:number;margin:number;fee:number;stressPrice:number;next:Position}|
 {status:'BLOCKED';reason:string;stressPrice:number};
const M15=15*60000;
const within=(n:number,min:number,max:number)=>Number.isFinite(n)&&n>=min&&n<=max;

export function validateMartin(c:MartinConfig,rules:Rules){
 if(!within(c.entry,Math.max(Number(rules.tick),rules.minPrice),rules.maxPrice)||!within(c.quantity,rules.minQty,rules.maxQty)||
  ![c.margin,c.maxLoss].every(n=>within(n,.00000001,1e9))||!within(c.reserve,0,1e9)||!Number.isInteger(c.maxAdds)||!within(c.maxAdds,0,8)||
  !Number.isInteger(c.leverage)||!within(c.leverage,1,125)||!within(c.maxQuantity,c.quantity,1e12)||!within(c.shock,0,100)||
  ![c.fee,c.slip,c.maintenance].every(n=>within(n,0,10))||![c.take,c.stop].every(n=>within(n,0,rules.maxPrice)))
  throw Error('请检查开仓价、数量、保证金、杠杆、费用和风险预算。');
 if(c.take&&c.take>=c.entry||c.stop&&c.stop<=c.entry)throw Error('空单止盈应低于开仓价，止损应高于开仓价。');
}
const initial=(c:MartinConfig):Position=>({quantity:c.quantity,notional:c.entry*c.quantity,margin:c.margin,reserve:c.reserve,fees:0});
const multiplier=(c:MartinConfig)=>(1+c.slip/100)*(1+c.fee/100);
const pnl=(p:Position,at:number)=>p.notional-p.quantity*at;
const net=(p:Position,c:MartinConfig,at:number)=>pnl(p,at*multiplier(c))-p.fees;
function snap(p:Position,c:MartinConfig,price:number):MartinSnapshot{
 const fees=p.fees,maintenanceDue=p.quantity*price*c.maintenance/100;
 const liquidation=p.quantity?(p.margin+p.notional-fees)/(p.quantity*(multiplier(c)+c.maintenance/100)):null;
 return {quantity:p.quantity,average:p.quantity?p.notional/p.quantity:0,margin:p.margin,reserve:p.reserve,fees,
  breakEven:p.quantity?(p.notional-fees)/(p.quantity*multiplier(c)):null,liquidation,
  floating:pnl(p,price),netExit:net(p,c,price),equity:p.margin+p.reserve+pnl(p,price)-fees,buffer:p.margin+net(p,c,price)-maintenanceDue,maintenanceDue};
}
function downQty(value:number,step:string){
 const size=Number(step),units=value/size;
 if(!Number.isFinite(units)||units>Number.MAX_SAFE_INTEGER)return 0;
 return Number((Math.floor(units+Number.EPSILON*units*2)*size).toPrecision(14));
}

export function recentVolatility(bars:Candle[]){
 const grouped=new Map<number,{open:number;high:number;low:number}>();
 for(const b of bars){
  const time=Math.floor(b.time/M15)*M15,prior=grouped.get(time);
  if(prior){prior.high=Math.max(prior.high,b.high);prior.low=Math.min(prior.low,b.low);}
  else grouped.set(time,{open:b.open,high:b.high,low:b.low});
 }
 const recent=Array.from(grouped.values()).slice(-12);
 return {count:recent.length,up:recent.length?100*Math.max(...recent.map(x=>x.high/x.open-1)):null,
  range:recent.length?100*Math.max(...recent.map(x=>x.high/x.low-1)):null};
}
function order(p:Position,c:MartinConfig,rules:Rules,trigger:number,at:number,vol:number,remaining:number):AddResult{
 const stressPrice=Math.max(at*(1+c.shock/100),trigger*(1+Math.max(10,vol)/100));
 const deny=(reason:string):AddResult=>({status:'BLOCKED',reason,stressPrice});
 if(!within(trigger,Math.max(rules.minPrice,Number(rules.tick)),rules.maxPrice)||remaining<1)return deny('补仓价格无效或已达到次数上限');
 const fill=snapPrice(trigger*(1-c.slip/100),rules);
 if(fill<=0)return deny('扣除滑点后低于最小价格');
 const basis=fill/c.leverage,addFee=fill*c.fee/100;
 const lossLeft=c.maxLoss+net(p,c,stressPrice);
 if(lossLeft<=0)return deny('压力情景下，原有仓位已经超出亏损预算');
 const oldBuffer=snap(p,c,stressPrice).buffer;
 const extraLoss=stressPrice*multiplier(c)-fill+addFee;
 const extraBuffer=basis-extraLoss-stressPrice*c.maintenance/100;
 if(oldBuffer<=0&&extraBuffer<=0)return deny('压力价已触及预估强平，补仓后仍无保证金缓冲');
 const maxQty=Math.min((p.reserve-p.fees)/(remaining*(basis+addFee)),(c.maxQuantity-p.quantity)/remaining,
  rules.maxQty,lossLeft/(remaining*extraLoss),extraBuffer<0?oldBuffer/(-extraBuffer):Infinity);
 const quantity=downQty(Math.max(0,maxQty),rules.quantityStep);
 if(quantity<Math.max(rules.minQty,rules.marketMinQty)||quantity*fill<rules.minNotional)return deny('剩余预算无法满足最小下单量或名义金额');
 const margin=quantity*basis,fee=quantity*addFee;
 const next={quantity:p.quantity+quantity,notional:p.notional+quantity*fill,margin:p.margin+margin,reserve:p.reserve-margin,fees:p.fees+fee};
 const checked=snap(next,c,stressPrice);
 if(checked.buffer<=0||checked.netExit< -c.maxLoss-1e-8)return deny('补仓后不能维持压力情景下的保证金或亏损预算');
 return {status:'OK',quantity,fill,margin,fee,stressPrice,next};
}

export function planMartin(c:MartinConfig,market:GridMarket,triggers:number[],at:number){
 validateMartin(c,market.rules);
 if(!Number.isFinite(at)||at<=0)throw Error('参考价须大于 0。');
 const base=initial(c),vol=recentVolatility(market.candles);
 const scenarios=[...new Set([6,10,c.shock])].sort((a,b)=>a-b).map(shock=>{
  const price=at*(1+shock/100);
  return {shock,price,...snap(base,c,price)};
 });
 let position=base,last=Math.max(c.entry,at);
 const stages=triggers.slice(0,c.maxAdds).map((trigger,i)=>{
  const fixed=snapPrice(trigger,market.rules);
  let item:AddResult;
  if(fixed<=last)item={status:'BLOCKED',reason:'本档须高于当前参考价和上一档',stressPrice:0};
  else if(c.stop&&fixed>=c.stop)item={status:'BLOCKED',reason:'本档已达到设定止损价',stressPrice:0};
  else item=order(position,c,market.rules,fixed,at,vol.up??0,Math.min(c.maxAdds,triggers.length)-i);
  if(item.status==='OK')position=item.next;
  last=Math.max(last,fixed);
  return {trigger:fixed,item,after:snap(position,c,fixed||at)};
 });
 return {current:snap(base,c,at),scenarios,stages,vol};
}

export function simulateMartin(c:MartinConfig,market:GridMarket,triggers:number[]){
 validateMartin(c,market.rules);
 if(!market.candles.length)throw Error('没有可用的历史 K 线。');
 const levels=triggers.slice(0,c.maxAdds).map(price=>snapPrice(price,market.rules));
 if(levels.some((price,i)=>price<=(levels[i-1]??c.entry)))throw Error('回放的各档补仓价格须依次升高，且高于原开仓价。');
 let p=initial(c),index=0,blocked='',closedNet:number|null=null,peak=c.margin+c.reserve,maxDrawdown=0;
 const events:MartinEvent[]=[],snapshots:(MartinSnapshot&{time:number;equity:number;eventCount:number;realized:number|null;blocked:string})[]=[],frames:Frame[]=[];
 for(const [i,bar] of market.candles.entries()){
  const tickEvents:MartinEvent[]=[];
  if(closedNet===null){
   const position=snap(p,c,bar.open),liq=position.liquidation!;
   const maxLossAt=(p.notional-p.fees+c.maxLoss)/(p.quantity*multiplier(c));
   const stop=Math.min(c.stop||Infinity,maxLossAt);
   const adverse=Math.min(stop,liq);
   let kind:MartinEvent['kind']|null=null,trigger=0,base=0;
   if(bar.high>=adverse){
    const liquidated=bar.open>=liq||liq<stop;
    kind=liquidated?'ESTIMATED_LIQUIDATION':c.stop&&c.stop<=maxLossAt?'STOP_LOSS':'LOSS_LIMIT';
    trigger=liquidated?liq:stop;base=Math.max(bar.open,trigger);
   }else if(c.take&&bar.low<=c.take){kind='TAKE_PROFIT';trigger=c.take;base=Math.min(bar.open,c.take);}
   if(kind){
    const fill=snapPrice(base*(1+c.slip/100),market.rules);
    const fee=fill*p.quantity*c.fee/100;
    closedNet=pnl(p,fill)-p.fees-fee;
    tickEvents.push({kind,time:bar.time,trigger,fill,quantity:p.quantity,fee,net:closedNet});
    p={quantity:0,notional:0,margin:0,reserve:c.margin+c.reserve+closedNet,fees:p.fees+fee};
   }else if(index<levels.length&&bar.high>=levels[index]){
    const trigger=levels[index],reference=Math.max(trigger,bar.open);
    const offset=Math.ceil(12*M15/market.step);
    const end=bar.time-bar.time%M15;
    const lookback=market.candles.slice(Math.max(0,i-offset-15),i).filter(t=>t.time<end);
    const next=order(p,c,market.rules,reference,bar.open,recentVolatility(lookback).up??0,levels.length-index);
    index++;
    if(next.status==='OK'){
     p=next.next;blocked='';
     tickEvents.push({kind:'ADD',time:bar.time,trigger,fill:next.fill,quantity:next.quantity,fee:next.fee,net:null});
    }else blocked=next.reason;
   }
  }
  events.push(...tickEvents);
  const holding=snap(p,c,bar.close),equity=closedNet===null?holding.equity:p.reserve;
  snapshots.push({...holding,time:bar.time,equity,eventCount:events.length,realized:closedNet,blocked});
  peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,100*(peak-equity)/peak);
  frames.push({time:bar.time,price:bar.close,equity,available:holding.reserve,margin:holding.margin,realized:closedNet??0,
   floating:holding.floating,net:equity-c.margin-c.reserve,fees:holding.fees,funding:0,drawdown:maxDrawdown,open:[],done:closedNet===null?0:1,
   wins:closedNet!==null&&closedNet>0?1:0,state:closedNet===null?'RUNNING':'HALTED',
   events:tickEvents.map(e=>({time:e.time,price:e.fill,kind:e.kind==='ADD'?'OPEN':e.kind==='TAKE_PROFIT'?'CLOSE':'STOP',side:'SHORT',reason:e.kind,net:e.net??undefined}))});
 }
 return {frames,snapshots,events,maxDrawdown};
}
