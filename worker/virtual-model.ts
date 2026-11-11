import { Failure } from './exchange';
import { abs, bps, decimal, div, max, min, mul, positive, roundDown, roundUp, text } from './virtual-decimal';
import { type Candle, priceType, source } from './binance-market';

export interface Tier { percent: number; price: string; quantity: string; filled: string }
export interface Position {
  id: string; accountId: string; symbol: string; direction: 'LONG'|'SHORT'; leverage: number;
  margin: string; locked: string; quantity: string; remaining: string; entry: string; current: string;
  markTime: number; marketTime: number; openedAt: number; closedAt: number | null; closedBy?: string; cursor: number;
  stopLoss: string; tiers: Tier[]; step: string; tick: string; feeBps: number; slipBps: number;
  decision: { price:string; time:number; reason:string; strategy:string; analysis:Record<string,unknown> };
  realized: string; fees: string; mfe: string; mae: string; shadowOf: string|null; variant: string;
}
export interface TradeEvent {
  id:string; positionId:string; kind:string; time:number; processedAt:number; price:string; triggerPrice:string|null;
  fillPrice:string; quantity:string; fee:string; realized:string; released:string; remaining:string;
  source:string; priceType:string; actor:string; strategy:string; executionAmbiguity:boolean; tier?:number;
}

export function fillPrice(mark:bigint,tick:bigint,slip:number,buy:boolean) {
  return buy ? roundUp(mark + bps(mark,slip),tick) : max(tick,roundDown(mark - bps(mark,slip),tick));
}

export function protection(stop:unknown, input:unknown, p:Pick<Position,'direction'|'step'|'tick'|'remaining'>, reference:string, allowSingle=false) {
  const stopPrice=positive(stop), price=positive(reference), tick=positive(p.tick);
  const long=p.direction==='LONG';
  if (stopPrice % tick || (long ? stopPrice>=price : stopPrice<=price)) throw new Failure('INVALID_STOP_LOSS');
  if (!Array.isArray(input) || input.length<(allowSingle?1:2) || input.length>5) throw new Failure('TWO_TO_FIVE_TIERS_REQUIRED');
  const quantity=positive(p.remaining), step=positive(p.step);
  let allocated=0n, percent=0, previous=price;
  const tiers:Tier[]=input.map(item=>{
    if(!item||!Number.isInteger(item.percent)||item.percent<1||item.percent>100)throw new Failure('INVALID_TIER_PERCENT');
    const target=positive(item.price);
    if(target%tick||(long?target<=previous:target>=previous))throw new Failure('INVALID_TIER_PRICE_ORDER');
    percent+=item.percent;
    if(percent>100)throw new Failure('TIER_PERCENT_OVER_100');
    previous=target;
    const cumulative=roundDown(quantity*BigInt(percent)/100n,step);
    const amount=cumulative-allocated;
    if(amount<=0n)throw new Failure('TIER_BELOW_QUANTITY_STEP');
    allocated=cumulative;
    return {percent:item.percent,price:text(target),quantity:text(amount),filled:'0'};
  });
  return {stopLoss:text(stopPrice),tiers};
}

export function pnl(p:Position, price:bigint, quantity=decimal(p.remaining)) {
  return mul((price-decimal(p.entry))*(p.direction==='LONG'?1n:-1n),quantity);
}

export function view(p:Position) {
  const floating=pnl(p,decimal(p.current));
  const net=decimal(p.realized)-decimal(p.fees);
  return {...p, unrealized:text(floating), net:text(net), notional:text(mul(decimal(p.current),decimal(p.remaining))),
    priceDifference:text(decimal(p.entry)-decimal(p.decision.price)), remainingRatio:text(div(decimal(p.remaining),positive(p.quantity))),
    unrealizedRatio:text(decimal(p.locked)>0n?div(floating,decimal(p.locked)):0n), realizedRatio:text(div(net,positive(p.margin))),
    durationMs:Math.max(0,(p.closedAt??Date.now())-p.openedAt)};
}

export function exit(p:Position, args:{id:string;kind:string;quantity:bigint; market:bigint; trigger?:bigint;time:number;actor:string;ambiguous?:boolean;tier?:number}):TradeEvent {
  const remaining=positive(p.remaining);
  const quantity=min(remaining,args.quantity);
  if(quantity<=0n)throw new Failure('INVALID_CLOSE_QUANTITY');
  const locked=decimal(p.locked);
  const released=quantity===remaining?locked:locked*quantity/remaining;
  const price=fillPrice(args.market,positive(p.tick),p.slipBps,p.direction==='SHORT');
  const gross=pnl(p,price,quantity);
  const fee=min(bps(mul(price,quantity),p.feeBps),max(0n,released+gross));
  const realized=max(gross,fee-released);
  p.remaining=text(remaining-quantity);
  p.locked=text(locked-released);
  p.realized=text(decimal(p.realized)+realized);
  p.fees=text(decimal(p.fees)+fee);
  if(quantity===remaining){p.closedAt=args.time;p.closedBy=args.kind}
  if(args.tier!==undefined)p.tiers[args.tier].filled=text(decimal(p.tiers[args.tier].filled)+quantity);
  return {id:args.id,positionId:p.id,kind:args.kind,time:args.time,processedAt:Date.now(),price:text(args.market),
    triggerPrice:args.trigger===undefined?null:text(args.trigger),fillPrice:text(price),quantity:text(quantity),fee:text(fee),
    realized:text(realized),released:text(released),remaining:p.remaining,source,priceType,actor:args.actor,
    strategy:p.decision.strategy,executionAmbiguity:!!args.ambiguous,tier:args.tier};
}

export function settleCandle(p:Position,c:Candle):TradeEvent[] {
  if(p.closedAt!==null)return [];
  const long=p.direction==='LONG', favorable=positive(long?c.high:c.low), adverse=positive(long?c.low:c.high);
  const open=positive(c.open), stop=positive(p.stopLoss), tick=positive(p.tick);
  const entry=positive(p.entry), remaining=positive(p.remaining);
  const collateralPerCoin=div(decimal(p.locked),remaining);
  const one=decimal('1');
  const exhausted=long?roundUp(div(max(tick,entry-collateralPerCoin),one-bps(one,p.feeBps)),tick):
    roundDown(div(entry+collateralPerCoin,one+bps(one,p.feeBps)),tick);
  const riskLevel=long?max(stop,exhausted):min(stop,exhausted);
  const riskKind=riskLevel===stop?'STOP_LOSS':'MARGIN_EXHAUSTED';
  const atRisk=long?adverse<=riskLevel:adverse>=riskLevel;
  const targets=p.tiers.map((tier,index)=>({tier,index,price:positive(tier.price)})).filter(({tier,price})=>
    decimal(tier.filled)<decimal(tier.quantity)&&(long?favorable>=price:favorable<=price));
  p.current=c.close;
  p.markTime=c.end;
  const observedAdverse=atRisk?(long?min(open,riskLevel):max(open,riskLevel)):adverse;
  p.mfe=text(max(decimal(p.mfe),pnl(p,atRisk?open:favorable)));
  p.mae=text(min(decimal(p.mae),pnl(p,observedAdverse)));
  if(atRisk)return [exit(p,{id:`${p.id}:${c.time}:${riskKind}`,kind:riskKind,quantity:remaining,
    market:long?min(open,riskLevel):max(open,riskLevel),trigger:riskLevel,time:c.end,actor:'settlement',ambiguous:targets.length>0})];
  const events:TradeEvent[]=[];
  for(const {tier,index,price} of targets){
    if(p.closedAt!==null)break;
    events.push(exit(p,{id:`${p.id}:${c.time}:TP:${index}`,kind:'TAKE_PROFIT',quantity:decimal(tier.quantity)-decimal(tier.filled),
      market:price,trigger:price,time:c.end,actor:'settlement',tier:index}));
  }
  return events;
}

export function widenStop(p:Position) {
  const entry=positive(p.entry), distance=abs(entry-positive(p.stopLoss))*3n/2n, tick=positive(p.tick);
  return text(p.direction==='LONG'?max(tick,roundDown(entry-distance,tick)):roundUp(entry+distance,tick));
}
