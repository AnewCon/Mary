type Candle={time:number;open:number;high:number;low:number;close:number;volume:number};
const spans={'15m':900000,'1h':3600000,'4h':14400000} as const;
const defaults={weights:[40,20,15,10,15],minEntry:60,shortSpikePct:3,maxRangePct:5,minTurnover:5_000_000};

export function signal25(candles:unknown,flow:unknown,sources:Record<string,any>,raw?:string,now=Date.now()) {
  let cfg=defaults;
  try{
    const c=JSON.parse(raw??'{}');
    if(c&&typeof c==='object'){
      const weights=Array.isArray(c.weights)&&c.weights.length===5&&c.weights.every((x:unknown)=>typeof x==='number'&&Number.isFinite(x)&&x>=0)&&c.weights.reduce((a:number,b:number)=>a+b,0)===100?c.weights:defaults.weights;
      const valid=(value:unknown,otherwise:number)=>typeof value==='number'&&Number.isFinite(value)&&value>0?value:otherwise;
      cfg={weights,minEntry:valid(c.minEntry,defaults.minEntry),shortSpikePct:valid(c.shortSpikePct,defaults.shortSpikePct),
        maxRangePct:valid(c.maxRangePct,defaults.maxRangePct),minTurnover:valid(c.minTurnover,defaults.minTurnover)};
    }
  }catch{/* Use reviewed defaults if configuration is invalid. */}
  const missing:string[]=[],risks:string[]=[],evidence:string[]=[];
  const input=candles as Record<string,Candle[]>|null;
  const trends=Object.entries(spans).map(([key,span])=>{
    const series=input?.[key]??[];
    const usable=Array.isArray(series)&&series.length>=8&&series.length<=24&&series.every((r,i)=>r&&
      [r.time,r.open,r.high,r.low,r.close,r.volume].every(Number.isFinite)&&r.open>0&&r.low>0&&r.close>0&&
      r.high>=Math.max(r.open,r.close)&&r.low<=Math.min(r.open,r.close)&&r.volume>=0&&
      r.time+span<=now&&(!i||r.time-series[i-1].time===span));
    const last=usable?series.at(-1):undefined;
    if(!last||now-last.time-span>span*2){missing.push(key+' 已收盘 K 线');return null;}
    const previous=series.at(-2)!;
    const pivot=series.slice(-7,-1);
    const structure=last.close>Math.max(...pivot.map(x=>x.high))?1:last.close<Math.min(...pivot.map(x=>x.low))?-1:0;
    const direction=Math.sign(last.close-series[series.length-8].close);
    if(key==='15m'&&Math.abs(last.close/previous.close-1)*100>cfg.shortSpikePct)risks.push('15m 短线跳变');
    if(key==='15m'&&(last.high-last.low)/last.close*100>cfg.maxRangePct)risks.push('15m 波动超阈值');
    evidence.push(key+' 方向 '+direction+'，收盘突破 '+structure);
    return {direction,structure};
  });
  const direction=trends[1]?.direction??0;
  if(trends.every(Boolean)&&(direction===0||trends.some(row=>row!.direction!==direction)))risks.push('多周期方向不一致');
  if(trends.every(Boolean)&&trends[0]!.structure!==direction)risks.push('15m 收盘结构未确认');
  const derivatives=sources.derivatives?.status==='OK'?sources.derivatives.data:null;
  const oi=sources.oi_history?.data?.changes?.['1h'];
  const sample=sources.recent_liquidations?.status==='OK'?sources.recent_liquidations.data.events:null;
  if(!derivatives||!Number.isFinite(Number(derivatives.ticker?.fundingRate))||!derivatives.accountRatio)missing.push('资金费率或多空账户占比');
  if(oi?.status!=='OK')missing.push('1h OI 变化');
  if(!sample?.length)missing.push('近期爆仓样本');
  const active=flow as {ratio?:number;asOf?:number;source?:string}|null;
  if(!active||typeof active.source!=='string'||!Number.isFinite(active.ratio)||!Number.isFinite(active.asOf)||
    active.ratio!<0||active.ratio!>1||active.asOf!>now||now-active.asOf!>1800000)missing.push('30 分钟内的主动买入成交占比');
  else evidence.push('主动买入占比 '+active.ratio+'（'+active.source+'）');
  if(oi?.quadrant)evidence.push('价格与 OI 四象限：'+oi.quadrant+'。该分类描述同期状态。');
  if(oi?.quadrant==='PRICE_UP_OI_DOWN')evidence.push('可能存在减仓或空头回补，需要结合主动成交及爆仓方向核实。');
  if(oi?.quadrant==='PRICE_DOWN_OI_DOWN')evidence.push('可能存在多头减仓，需要结合主动成交及爆仓方向核实。');
  if(oi?.quadrant?.endsWith('_OI_UP'))evidence.push('净未平仓量上升，可能有新增风险敞口；仅凭 OI 无法识别主动方。');
  if(derivatives&&!(Number(derivatives.ticker?.turnover24h)>=cfg.minTurnover))risks.push('24h 成交额低于流动性阈值');
  const trend=trends.every(Boolean)&&!!direction&&trends.every(row=>row!.direction===direction)?1:0;
  const activity=oi?.status==='OK'&&oi.changePct>0&&active?.ratio!==undefined&&Math.sign(active.ratio-0.5)===direction?1:0;
  const long=sample?.filter((row:any)=>row.side==='long_liquidated').length??0;
  const short=sample?.filter((row:any)=>row.side==='short_liquidated').length??0;
  const liquidation=direction!==0&&Math.sign(short-long)===direction?1:0;
  const positioning=derivatives&&Math.abs(Number(derivatives.ticker.fundingRate))<=0.001&&Math.abs(Number(derivatives.accountRatio?.buyRatio)-0.5)<=0.25?1:0;
  const risk=risks.length===0&&derivatives?1:0;
  const entryScore=missing.length?null:[trend,activity,liquidation,positioning,risk].reduce((sum,x,i)=>sum+x*cfg.weights[i],0);
  const directionScore=trends.every(Boolean)?direction*(trend*cfg.weights[0]+activity*cfg.weights[1]+liquidation*cfg.weights[2]):null;
  const recommendation=entryScore!==null&&entryScore>=cfg.minEntry&&risks.length===0&&direction!==0?(direction>0?'LONG':'SHORT'):'WAIT';
  if(recommendation==='WAIT'&&!missing.length&&!risks.length)risks.push('综合入场分不足');
  return {source:'QuantOS experimental scoring',strategyVersion:'2.5-experimental',status:missing.length?'INSUFFICIENT_DATA':'OK',asOf:new Date(now).toISOString(),
    recommendation,directionScore,entryScore,evidence,risks,missing,weights:cfg.weights,
    providedInputs:['candles','flow'].filter(key=>key==='candles'?!!input:!!active)};
}
