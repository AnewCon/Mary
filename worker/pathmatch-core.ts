import { Failure } from './exchange';

const M=60_000;
export type Candle={time:number;open:number;high:number;low:number;close:number};
export type Forecast={direction:'UP'|'DOWN'|'FLAT';close:number;high:number;low:number;invalidatesWhen:string};
export type Plan={strategyVersion:'2.6-pathmatch';symbol:string;exchange:'BINANCE_DEMO';direction:'LONG'|'SHORT';
  referenceTime:number;referencePrice:number;expiresAt:number;source:string;forecast:{interval:'5m';candles:Forecast[]};
  entry:{type:'LIMIT';price:number;priceMin:number;priceMax:number};hardInvalidation:number;
  risk:{leverage:number;quantity:number;stopLoss:number;takeProfit:number;maxLossUsdt:number;estimatedLossCostsUsdt:number;estimatedWinCostsUsdt:number};
  context:{trend4h:string;trend1h:string;structure15m:string;entry5m:string;dailyFilter:string;directionScore:number;entryScore:number};
  validation:{similarityThreshold:number;minimumClosed1mCandles:number;maximumValidationMinutes:number;atrTolerance:number}};
export const minute=M;
const finite=(x:unknown):x is number=>typeof x==='number'&&Number.isFinite(x);
const price=(x:unknown):x is number=>finite(x)&&x>0&&x<1e12;
const text=(x:unknown):x is string=>typeof x==='string'&&x.trim().length>0&&x.length<=320;
const bounded=(x:unknown,lo:number,hi:number)=>finite(x)&&x>=lo&&x<=hi;
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
function exact(row:unknown, keys:string[]){
  return object(row)&&Object.keys(row).length===keys.length&&keys.every(key=>Object.hasOwn(row,key));
}
export function parsePlan(input:unknown,now=Date.now()):Plan{
  if(!exact(input,['strategyVersion','symbol','exchange','direction','referenceTime','referencePrice','expiresAt','source','forecast','entry','hardInvalidation','risk','context','validation']))
    throw new Failure('PATHMATCH_INVALID_PLAN');
  const p=input as Plan;
  const {forecast,entry,risk,context,validation}=p;
  if(p.strategyVersion!=='2.6-pathmatch'||p.exchange!=='BINANCE_DEMO'||!/^[A-Z0-9]{2,20}USDT$/.test(p.symbol)||
     !['LONG','SHORT'].includes(p.direction)||!text(p.source)||!price(p.referencePrice)||!price(p.hardInvalidation)||
     !Number.isSafeInteger(p.referenceTime)||p.referenceTime%M!==0||p.referenceTime>now||now-p.referenceTime>3*M||
     !Number.isSafeInteger(p.expiresAt)||p.expiresAt<=now||p.expiresAt>now+15*M||
     !exact(forecast,['interval','candles'])||forecast.interval!=='5m'||!Array.isArray(forecast.candles)||forecast.candles.length!==3||
     forecast.candles.some(c=>!exact(c,['direction','close','high','low','invalidatesWhen'])||!['UP','DOWN','FLAT'].includes(c.direction)||
       !price(c.close)||!price(c.high)||!price(c.low)||c.low>c.close||c.high<c.close||!text(c.invalidatesWhen))||
     !exact(entry,['type','price','priceMin','priceMax'])||entry.type!=='LIMIT'||!price(entry.price)||!price(entry.priceMin)||
     !price(entry.priceMax)||entry.price<entry.priceMin||entry.price>entry.priceMax||
     !exact(risk,['leverage','quantity','stopLoss','takeProfit','maxLossUsdt','estimatedLossCostsUsdt','estimatedWinCostsUsdt'])||
     risk.leverage!==10||!price(risk.quantity)||!price(risk.stopLoss)||!price(risk.takeProfit)||!bounded(risk.maxLossUsdt,0.000001,0.35)||
     !bounded(risk.estimatedLossCostsUsdt,0,2)||!bounded(risk.estimatedWinCostsUsdt,0,2)||
     !exact(context,['trend4h','trend1h','structure15m','entry5m','dailyFilter','directionScore','entryScore'])||
     ![context.trend4h,context.trend1h,context.structure15m,context.entry5m,context.dailyFilter].every(text)||
     !bounded(context.directionScore,0,100)||!bounded(context.entryScore,0,100)||
     !exact(validation,['similarityThreshold','minimumClosed1mCandles','maximumValidationMinutes','atrTolerance'])||
     !bounded(validation.similarityThreshold,85,100)||!Number.isInteger(validation.minimumClosed1mCandles)||
     !bounded(validation.minimumClosed1mCandles,3,10)||!Number.isInteger(validation.maximumValidationMinutes)||
     !bounded(validation.maximumValidationMinutes,3,15)||validation.minimumClosed1mCandles>validation.maximumValidationMinutes||
     !bounded(validation.atrTolerance,0.1,2))
    throw new Failure('PATHMATCH_INVALID_PLAN');
  const side=p.direction==='LONG'?1:-1;
  if(side*(entry.price-risk.stopLoss)<=0||side*(risk.takeProfit-entry.price)<=0||side*(p.referencePrice-p.hardInvalidation)<=0)
    throw new Failure('PATHMATCH_INVALID_PRICE_DIRECTION');
  return p;
}

export function atr14(rows:Candle[]){
  if(rows.length!==15||rows.some((r,i)=>i>0&&r.time-rows[i-1].time!==5*M))throw new Failure('PATHMATCH_ATR_GAP',502);
  const value=rows.slice(1).reduce((sum,row,i)=>sum+Math.max(row.high-row.low,Math.abs(row.high-rows[i].close),Math.abs(row.low-rows[i].close)),0)/14;
  if(!price(value))throw new Failure('PATHMATCH_INVALID_ATR',502);
  return value;
}

export function match(plan:Plan,start:number,atr:number,actual:Candle[],cutoff:number){
  let sum=0,direction=0,previousActual=plan.referencePrice,previousExpected=plan.referencePrice;
  const side=plan.direction==='LONG'?1:-1;
  const epsilon=atr*0.02;
  const sign=(value:number)=>Math.abs(value)<=epsilon?0:Math.sign(value);
  const points=[];
  for(const [i,row] of actual.entries()){
    if(row.time!==start+i*M||row.time+M>cutoff||i>=15)
      return {status:'ERROR',reason:'MINUTE_CANDLE_GAP_OR_UNCLOSED',similarity:null,points};
    const index=Math.floor(i/5),bar=plan.forecast.candles[index],from=index===0?plan.referencePrice:plan.forecast.candles[index-1].close;
    const expected=from+(bar.close-from)*(i%5+1)/5;
    const tolerance=atr*plan.validation.atrTolerance,lower=bar.low-tolerance,upper=bar.high+tolerance;
    sum+=(row.close-expected)**2;
    direction+=Number(sign(row.close-previousActual)===sign(expected-previousExpected));
    previousActual=row.close;previousExpected=expected;
    const rmse=Math.sqrt(sum/(i+1));
    const similarity=0.8*100*Math.max(0,1-rmse/(2*atr))+0.2*100*direction/(i+1);
    points.push({...row,expected,lower,upper,similarity,rmse});
    if((side===1?row.low<=plan.hardInvalidation:row.high>=plan.hardInvalidation))
      return {status:'CANCELED',reason:'HARD_INVALIDATION',similarity,points};
    if(row.close<lower||row.close>upper)return {status:'CANCELED',reason:'OUTSIDE_FORECAST_CHANNEL',similarity,points};
    if(i+1<plan.validation.minimumClosed1mCandles)continue;
    if(similarity<75)return {status:'CANCELED',reason:'BELOW_SIMILARITY_FLOOR',similarity,points};
  }
  const latest=points.at(-1);
  if(!latest||points.length<plan.validation.minimumClosed1mCandles)
    return {status:'VALIDATING',reason:'INSUFFICIENT_CLOSED_MINUTES',similarity:latest?.similarity??null,points};
  const eligible=latest.similarity>=plan.validation.similarityThreshold&&latest.close>=plan.entry.priceMin&&latest.close<=plan.entry.priceMax;
  return {status:'VALIDATING',reason:eligible?'PATH_MATCHED_EXECUTION_RISK_REVIEW_REQUIRED':
    latest.similarity<plan.validation.similarityThreshold?'SIMILARITY_OBSERVATION':'OUTSIDE_ENTRY_RANGE',similarity:latest.similarity,points};
}
