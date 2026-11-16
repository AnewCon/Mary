import { decimal, div, mul, text } from './virtual-decimal';

const DAY=86_400_000;
const d=decimal;
export const legacyLimits={strategyVersion:'V2.4.1-DAILY-PUMP-FILTER',minimumDirectionScore:80,minimumEntryScore:80,
  dailyBars:14,dailyGainPct:300,intradayRangePct:400,cooldownBars:7,leverage:10,budgetUsdt:'80',
  maxSymbols:5,maxMarginUsdt:'32',maxPortfolioLossUsdt:'2',defaultMaxSingleLossUsdt:'0.35',
  minNetRewardRisk:'1.8',sameDirectionCorrelation:'0.85'} as const;

type Side='LONG'|'SHORT';
type Judgment='CONFIRMED'|'CONFLICT'|'UNKNOWN';
type Exposure={symbol:string;side:Side;plannedMargin:string;plannedLoss:string;correlationToCandidate?:number};
type Plan={
  symbol:string;side:Side;kind:'LIMIT';leverage:number;entry:string;stopLoss:string;takeProfit:string;quantity:string;
  lossCosts:string;winCosts:string;accountMode:'demo';accountVerified:boolean;
  instrumentVerified:boolean;liquidityVerified:boolean;protectionVerified:boolean;availableMargin:string;
  exposures:Exposure[];directionScore:number;entryScore:number;scoreVersion:string;
  trend4h:Side;trend1h:Side;structure15m:Judgment;entry5m:Judgment;
};

function value(input:unknown) {
  if(typeof input==='number'&&Number.isFinite(input))return d(String(input));
  return d(input);
}

export function reviewClosedDaily(input:unknown, side?:Side, now=Date.now()) {
  const end=Math.floor(now/DAY)*DAY;
  if(!Array.isArray(input)||input.length<14||input.length>60)
    return {status:'INSUFFICIENT_DATA',reason:'NEED_14_CLOSED_UTC_DAILY_CANDLES'};
  const bars=input.slice(-14);
  try{
    const flags=bars.flatMap((bar,i)=>{
      if(!bar||bar.time!==end-(14-i)*DAY)throw new Error('MISSING_OR_UNCLOSED_DAILY_CANDLE');
      const open=value(bar.open),high=value(bar.high),low=value(bar.low),close=value(bar.close);
      if(low<=0n||open<low||close<low||high<open||high<close)throw new Error('INVALID_DAILY_OHLC');
      const closeJump=close>=open*4n, rangeJump=high>=low*5n;
      return closeJump||rangeJump?[{openTime:bar.time,closeJump,rangeJump,fullBarsAfter:13-i}]:[];
    });
    const cooling=flags.some(flag=>flag.fullBarsAfter<7);
    const ordinaryLongBlocked=flags.some(flag=>flag.closeJump);
    return {status:cooling||side==='LONG'&&ordinaryLongBlocked?'BLOCKED':'PASS',
      asOf:end,flags,cooling,ordinaryLongBlocked,
      reason:cooling?'PUMP_COOLDOWN_ACTIVE':side==='LONG'&&ordinaryLongBlocked?'DAILY_PUMP_LONG_BLOCKED':null};
  }catch{
    return {status:'INSUFFICIENT_DATA',reason:'MISSING_OR_INVALID_CLOSED_DAILY_DATA'};
  }
}

export function reviewLegacyPlan(input:Plan, daily:unknown, options:{maxSingleLoss?:string;now?:number}={}) {
  const reasons:string[]=[];
  const filter=reviewClosedDaily(daily,input.side,options.now);
  if(filter.status!=='PASS')reasons.push(filter.reason??'DAILY_FILTER_BLOCKED');
  const passScore=(n:number)=>Number.isFinite(n)&&n>=80&&n<=100;
  if(input.scoreVersion!==legacyLimits.strategyVersion||!passScore(input.directionScore)||!passScore(input.entryScore))
    reasons.push('INDEPENDENT_LEGACY_SCORES_REQUIRED');
  if(!['LONG','SHORT'].includes(input.side)||input.trend1h!==input.side||input.trend4h!==input.side)
    reasons.push('TREND_4H_1H_CONFLICT_OR_MISSING');
  if(input.structure15m!=='CONFIRMED'||input.entry5m!=='CONFIRMED')reasons.push('ENTRY_15M_5M_NOT_CONFIRMED');
  if(input.accountMode!=='demo'||input.accountVerified!==true||!Array.isArray(input.exposures))reasons.push('DEMO_EXPOSURES_NOT_VERIFIED');
  if(input.kind!=='LIMIT'||input.leverage!==10||input.instrumentVerified!==true||input.liquidityVerified!==true)
    reasons.push('CONTRACT_OR_LEVERAGE_NOT_VERIFIED');
  if(input.protectionVerified!==true)reasons.push('PROTECTION_PLAN_NOT_VERIFIED');
  let risk=null;
  try{
    const direction=input.side==='LONG'?1n:-1n;
    const entry=d(input.entry),stop=d(input.stopLoss),take=d(input.takeProfit),quantity=d(input.quantity);
    const lossCosts=d(input.lossCosts),winCosts=d(input.winCosts),available=d(input.availableMargin);
    const stopDistance=(entry-stop)*direction,rewardDistance=(take-entry)*direction;
    if(entry<=0n||stop<=0n||take<=0n||quantity<=0n||lossCosts<0n||winCosts<0n||available<0n||stopDistance<=0n||rewardDistance<=0n)
      throw new Error('Invalid prices, quantity or costs');
    const ownMargin=mul(entry,quantity)/10n;
    const ownLoss=mul(stopDistance,quantity)+lossCosts;
    const reward=mul(rewardDistance,quantity)-winCosts;
    let margin=ownMargin, loss=ownLoss;
    const symbols=new Set([input.symbol]);
    const exposures=input.exposures;
    for(const exposure of exposures){
      const m=d(exposure.plannedMargin), l=d(exposure.plannedLoss);
      if(!exposure.symbol||!['LONG','SHORT'].includes(exposure.side)||m<0n||l<0n)throw new Error('Invalid exposure');
      margin+=m;loss+=l;symbols.add(exposure.symbol);
      if(exposure.symbol===input.symbol)reasons.push('CANDIDATE_ALREADY_EXPOSED');
      else if(exposure.side===input.side){
        const corr=exposure.correlationToCandidate;
        if(typeof corr!=='number'||!Number.isFinite(corr)||Math.abs(corr)>1)reasons.push('CORRELATION_NOT_VERIFIED');
        else if(corr>=0.85)reasons.push('SAME_DIRECTION_CORRELATION_LIMIT');
      }
    }
    const configured=d(options.maxSingleLoss??'0.35');
    if(configured<=0n||configured>d('2'))throw new Error('Invalid single loss limit');
    if(symbols.size>5)reasons.push('SYMBOL_LIMIT_EXCEEDED');
    if(ownMargin>available||margin>d('32')||margin>d('80'))reasons.push('MARGIN_BUDGET_EXCEEDED');
    if(ownLoss>configured)reasons.push('SINGLE_LOSS_BUDGET_EXCEEDED');
    if(loss>d('2'))reasons.push('PORTFOLIO_LOSS_BUDGET_EXCEEDED');
    if(ownLoss<=0n||reward*10n<ownLoss*18n)reasons.push('NET_REWARD_RISK_BELOW_1_8');
    risk={marginUsdt:text(ownMargin),portfolioMarginUsdt:text(margin),lossUsdt:text(ownLoss),
      portfolioLossUsdt:text(loss),netRewardUsdt:text(reward),netRewardRisk:ownLoss>0n?text(div(reward,ownLoss)):null};
  }catch{reasons.push('INVALID_OR_INCOMPLETE_RISK_INPUTS');}
  return {strategyVersion:legacyLimits.strategyVersion,mode:'RESEARCH_ONLY',execute:false,
    result:reasons.length?'WAIT':'CANDIDATE_FOR_MANUAL_REVIEW',reasons:[...new Set(reasons)],dailyFilter:filter,risk};
}
