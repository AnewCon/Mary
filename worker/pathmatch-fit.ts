import { match, minute, type Candle, type Plan } from './pathmatch-core';

export const fitControls=[
  {key:'slope',label:'趋势幅度',min:0,max:200,step:5,initial:100,unit:'%',description:'以预测起点为基准，缩放开盘和收盘的价格位移。'},
  {key:'wick',label:'上下影线',min:0,max:250,step:5,initial:100,unit:'%',description:'独立缩放实体外的上下影线。'},
  {key:'pullback',label:'开头回踩',min:0,max:100,step:5,initial:0,unit:'% ATR',description:'沿预测净方向的反向偏移，第 2 分钟最大，第 6 分钟归零。'}
] as const;
export type FitParams=Record<(typeof fitControls)[number]['key'],number>;
export const originalFitParams:FitParams={slope:100,wick:100,pullback:0};

export function adjustForecast(plan:Plan,params:FitParams,atr:number|null):Candle[]|null {
  if(plan.forecast.interval!=='1m'||fitControls.some(({key,min,max})=>!Number.isFinite(params[key])||params[key]<min||params[key]>max))return null;
  if(params.pullback>0&&(atr===null||!Number.isFinite(atr)||atr<=0))return null;
  if(fitControls.every(({key})=>params[key]===originalFitParams[key]))return plan.forecast.candles;

  const reference=plan.referencePrice;
  const direction=Math.sign(plan.forecast.candles.at(-1)!.close-reference)||(plan.direction==='LONG'?1:-1);
  const amplitude=-direction*(atr??0)*params.pullback/100;
  const shift=(step:number)=>amplitude*Math.max(0,Math.min(step/2,(6-step)/4));
  const adjust=(price:number,step:number)=>reference+(price-reference)*params.slope/100+shift(step);
  const candles=plan.forecast.candles.map((bar,i)=>{
    const open=adjust(bar.open,i),close=adjust(bar.close,i+1);
    const high=Math.max(open,close)+(bar.high-Math.max(bar.open,bar.close))*params.wick/100;
    const low=Math.min(open,close)-(Math.min(bar.open,bar.close)-bar.low)*params.wick/100;
    return {time:bar.time,open,high,low,close};
  });
  return candles.every(bar=>Number.isFinite(bar.low)&&bar.low>0&&Number.isFinite(bar.high)&&bar.high<1e12)?candles:null;
}

export function compareForecast(plan:Plan,candles:Candle[],actual:Candle[],start:number|null,atr:number|null){
  if(!start||!atr||!actual.length)return null;
  const result=match({...plan,forecast:{interval:'1m',candles}},start,atr,actual,actual[actual.length-1].time+minute);
  return 'fit' in result?result.fit:null;
}
