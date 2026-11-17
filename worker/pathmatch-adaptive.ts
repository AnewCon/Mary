import { adjustForecast, originalFitParams, type FitParams } from './pathmatch-fit';
import { match, minute, type Candle, type Plan } from './pathmatch-core';

export type CalibrationSample={symbol:string;start:number;atr:number;plan:Plan;actual:Candle[]};
type Choice={method:'ORIGINAL'|'RECENTERED';params:FitParams;historicalFit:number;observedFit:number;rank:number};
type Round={observed:number;lockedAt:number;selected:Choice;next:Candle;alternatives:Choice[];observedGain:number|null};
export type AdaptiveForecast=
 | {status:'ACTIVE';sampleCount:number;scope:'SYMBOL'|'ALL';historicalCutoff:number;rounds:Round[];candles:Candle[];
    evaluated:number;score:number|null;originalScore:number|null;complete:boolean}
 | {status:'INSUFFICIENT_DATA'|'HISTORY_UNAVAILABLE';sampleCount?:number};
const catalog:FitParams[]=[50,75,100].flatMap(slope=>[75,100,125].flatMap(wick=>[0,50].map(pullback=>({slope,wick,pullback}))));
const closeAt=(bar:Candle)=>bar.time+minute;
const average=(values:number[])=>values.length?values.reduce((s,v)=>s+v,0)/values.length:null;

function recenter(bars:Candle[],actual:Candle[]){
 const end=actual.length-1,last=actual[end];
 const shift=last.close-bars[end].close;
 const future=bars.slice(actual.length).map((bar,i)=>{
   const open=i===0?last.close:bar.open+shift,close=bar.close+shift;
   const high=Math.max(open,close)+(bar.high-Math.max(bar.open,bar.close));
   const low=Math.min(open,close)-(Math.min(bar.open,bar.close)-bar.low);
   return {time:bar.time,open,high,low,close};
 });
 return future.every(bar=>Number.isFinite(bar.low)&&bar.low>0&&Number.isFinite(bar.high)&&bar.high<1e12)?future:null;
}

function similarity(plan:Plan,bars:Candle[],actual:Candle[],anchor:number,atr:number):number|null{
 if(!actual.length)return null;
 const result=match({...plan,referencePrice:anchor,forecast:{interval:'1m',candles:bars}},
   actual[0].time,atr,actual,closeAt(actual[actual.length-1]));
 return 'fit' in result?result.fit?.similarity??null:null;
}

function features(plan:Plan,actual:Candle[],atr:number){
 const last=actual[actual.length-1];
 const path=plan.forecast.interval==='1m'?plan.forecast.candles[actual.length-1].close:plan.referencePrice;
 return [(last.close-path)/atr,(last.high-last.low)/atr];
}

export function adaptiveHistory(plan:Plan,actual:Candle[],history:CalibrationSample[]){
 const cutoff=closeAt(actual[0]), newest=new Map<string,number>();
 const past=history.filter(s=>s.plan.forecast.interval==='1m'&&s.actual.length===15&&s.atr>0&&closeAt(s.actual[14])<=cutoff)
  .sort((a,b)=>b.start-a.start).filter(s=>{
    const previous=newest.get(s.symbol);
    if(previous!==undefined&&previous-s.start<15*minute)return false;
    newest.set(s.symbol,s.start);
    return true;
  });
 const own=past.filter(s=>s.symbol===plan.symbol);
 const scope=own.length>=5?'SYMBOL':'ALL';
 return {scope,cutoff,samples:scope==='SYMBOL'?own:past} as const;
}

export function evaluateIssuedForecast(previous:AdaptiveForecast|undefined,plan:Plan,actual:Candle[],atr:number):AdaptiveForecast|undefined{
 if(previous?.status!=='ACTIVE'||plan.forecast.interval!=='1m')return previous;
 const issued:number[]=[],original:number[]=[];
 const initial=plan.forecast.candles;
 for(const round of previous.rounds){
   const minute=round.observed,observed=actual[minute];
   if(observed?.time!==round.next.time)continue;
   const anchor=actual[minute-1].close;
   const a=similarity(plan,[round.next],[observed],anchor,atr),b=similarity(plan,[initial[minute]],[observed],anchor,atr);
   if(a!==null&&b!==null){issued.push(a);original.push(b);}
 }
 if(issued.length<previous.evaluated)return previous;
 return {...previous,evaluated:issued.length,score:average(issued),originalScore:average(original),
  complete:actual.length===15,candles:actual.length===15?[]:previous.candles};
}

export function shouldIssueForecast(previous:AdaptiveForecast|undefined,actual:Candle[],now:number){
 const last=actual[actual.length-1];
 return !!last&&actual.length<15&&now>=closeAt(last)&&now<closeAt(last)+minute
   &&(previous?.status!=='ACTIVE'||(previous.rounds.at(-1)?.observed??0)<actual.length);
}

export function chooseAdaptiveForecast(previous:AdaptiveForecast|undefined,plan:Plan,actual:Candle[],atr:number,history:CalibrationSample[],now:number):AdaptiveForecast|undefined{
 const scored=evaluateIssuedForecast(previous,plan,actual,atr);
 if(plan.forecast.interval!=='1m'||!shouldIssueForecast(scored,actual,now))return scored;
 const {scope,cutoff,samples}=adaptiveHistory(plan,actual,history);
 if(samples.length<(scope==='SYMBOL'?5:8))return scored?.status==='ACTIVE'?scored:{status:'INSUFFICIENT_DATA',sampleCount:samples.length};
 const n=actual.length,[offset,range]=features(plan,actual,atr);
 const weighted=samples.map(s=>{
   const prefix=s.actual.slice(0,n),[otherOffset,otherRange]=features(s.plan,prefix,s.atr);
   const weight=1/(1+Math.abs(offset-otherOffset)+Math.abs(range-otherRange)/2);
   return {s,prefix,weight};
 });

 const assess=(params:FitParams|null)=>{
   const bars=params?adjustForecast(plan,params,atr):plan.forecast.interval==='1m'?plan.forecast.candles:null;
   const candles=bars&&(params?recenter(bars,actual):bars.slice(n));
   const observedFit=bars&&similarity(plan,bars,actual,plan.referencePrice,atr);
   if(!candles||observedFit===null)return [];
   let total=0,weights=0;
   for(const {s,prefix,weight} of weighted){
     const base=s.plan.forecast.interval==='1m'?s.plan.forecast.candles:null;
     const past=params?adjustForecast(s.plan,params,s.atr):base;
     const next=past&&(params?recenter(past,prefix)?.[0]:past[n]);
     const score=next&&similarity(s.plan,[next],[s.actual[n]],prefix[n-1].close,s.atr);
     if(score==null)return [];
     total+=score*weight;weights+=weight;
   }
   const historicalFit=total/weights;
   const choice:Choice={method:params?'RECENTERED':'ORIGINAL',params:params??originalFitParams,historicalFit,observedFit,
     rank:0.7*historicalFit+0.3*observedFit};
   return [{choice,candles}];
 };
 const ranked=[...assess(null),...catalog.flatMap(assess)].sort((a,b)=>b.choice.rank-a.choice.rank);
 const prior=scored?.status==='ACTIVE'?scored.rounds.at(-1)?.selected:null;
 const retained=prior&&ranked.find(({choice})=>choice.method===prior.method&&Object.keys(prior.params)
  .every(key=>choice.params[key as keyof FitParams]===prior.params[key as keyof FitParams]));
 const best=retained?ranked.find(({choice})=>choice.observedFit>=retained.choice.observedFit)??retained:ranked[0];
 if(!best)return scored?.status==='ACTIVE'?scored:{status:'HISTORY_UNAVAILABLE'};
 const active=scored?.status==='ACTIVE'?scored:null;
 return {status:'ACTIVE',scope,sampleCount:samples.length,historicalCutoff:cutoff,
  rounds:[...(active?.rounds??[]),{observed:n,lockedAt:now,selected:best.choice,next:best.candles[0],observedGain:retained?best.choice.observedFit-retained.choice.observedFit:null,alternatives:ranked.filter(r=>r!==best).slice(0,3).map(r=>r.choice)}],
  candles:best.candles,evaluated:active?.evaluated??0,score:active?.score??null,originalScore:active?.originalScore??null,complete:false};
}
