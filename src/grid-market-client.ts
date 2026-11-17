import type { GridMarket } from './grid-engine';

type Api=(path:string)=>Promise<unknown>;
export const day=86400000;
export const beijingInput=(time:number)=>new Date(time+8*3600000).toISOString().slice(0,16);
export const parseBeijing=(value:string)=>Date.parse(value+'+08:00');
export const beijingMidnight=(now:number)=>Math.floor((now+8*3600000)/day)*day-8*3600000;

export async function loadMarket(api:Api,pair:string,from:number,to:number,interval:string,funding=false){
 return await api('/grid/market?'+new URLSearchParams({
  symbol:pair.trim().toUpperCase(),from:String(from),to:String(to),interval,...(funding?{funding:'1'}:{})
 })) as GridMarket;
}
