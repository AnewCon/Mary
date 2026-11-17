import { useEffect, useRef, useState } from 'react';
import { Activity, RefreshCw } from 'lucide-react';
import type { Plan, Candle } from '../worker/pathmatch-core';
import './pathmatch.css';

type Point=Candle&{expected:number;lower:number;upper:number;similarity:number};
type Prediction={id:string;symbol:string;state:string;mode:string;startAt:number|null;expiresAt:number;createdAt:number;atr:number|null;
  plan:Plan;result:{reason?:string;similarity?:number|null;points?:Point[]}|null};
const stamp=(value:number)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
const states:Record<string,string>={DRAFT:'草稿',ARMED:'已锁定',VALIDATING:'观测中',CANCELED:'已取消',EXPIRED:'已到期'};

function Chart({row}:{row:Prediction}){
  const canvas=useRef<HTMLCanvasElement>(null);
  useEffect(()=>{
    const target=canvas.current;
    if(!target)return;
    const chart=()=>{
      const width=target.clientWidth,height=target.clientHeight;
      const dpr=window.devicePixelRatio||1;
      target.width=width*dpr;target.height=height*dpr;
      const context=target.getContext('2d');
      if(!context)return;
      context.scale(dpr,dpr);
      const {plan,atr}=row,actual=row.result?.points??[];
      const tolerance=(atr??0)*plan.validation.atrTolerance;
      const values=[plan.referencePrice,plan.hardInvalidation,plan.entry.priceMin,plan.entry.priceMax,...actual.flatMap(x=>[x.low,x.high]),
        ...plan.forecast.candles.flatMap(x=>[x.low-tolerance,x.high+tolerance])];
      const min=Math.min(...values),max=Math.max(...values),span=max-min||1;
      const x=(n:number)=>12+(width-88)*n/15;
      const y=(n:number)=>18+(max-n)/span*(height-48);
      context.font='11px sans-serif';
      for(let i=0;i<5;i++){
        const px=min+span*i/4;
        context.strokeStyle='#d8e4dc';context.beginPath();context.moveTo(x(0),y(px));context.lineTo(x(15),y(px));context.stroke();
        context.fillStyle='#486459';context.fillText(px.toPrecision(5),x(15)+5,y(px)+4);
      }
      context.fillStyle='rgba(90,120,167,.16)';
      plan.forecast.candles.forEach((bar,i)=>{
        context.fillRect(x(i*5),y(bar.high+tolerance),x(5)-x(0),y(bar.low-tolerance)-y(bar.high+tolerance));
        context.fillStyle='#486459';context.fillText('+'+(i+1)*5+'m',x((i+1)*5)-17,height-9);
        context.fillStyle='rgba(90,120,167,.16)';
      });
      context.strokeStyle='#496cad';context.setLineDash([5,4]);context.beginPath();
      context.moveTo(x(0),y(plan.referencePrice));
      plan.forecast.candles.forEach((bar,i)=>context.lineTo(x(5*(i+1)),y(bar.close)));
      context.stroke();context.setLineDash([]);
      for(const point of actual){
        const index=(point.time-(row.startAt??point.time))/60000+1;
        context.strokeStyle=point.close>=point.open?'#27755d':'#a04046';
        context.beginPath();context.moveTo(x(index),y(point.high));context.lineTo(x(index),y(point.low));context.stroke();
        context.fillStyle=context.strokeStyle;context.fillRect(x(index)-2,Math.min(y(point.open),y(point.close)),4,Math.max(2,Math.abs(y(point.open)-y(point.close))));
      }
    };
    const observer=new ResizeObserver(chart);observer.observe(target);chart();
    return ()=>observer.disconnect();
  },[row]);
  return <canvas ref={canvas} className="pathmatch-chart" aria-label="预测参考线、价格区间及真实已收盘分钟 K 线"/>;
}

export default function PathMatch({api}:{api:(path:string,body?:unknown)=>Promise<any>}){
  const [rows,setRows]=useState<Prediction[]>([]),[selected,setSelected]=useState(''),[busy,setBusy]=useState(true),[error,setError]=useState('');
  const [now,setNow]=useState(Date.now);
  async function load(){
    setBusy(true);setError('');
    try{setRows(await api('/predictions/history?limit=20'));}
    catch{setError('暂时无法读取预测记录。');}
    finally{setBusy(false);}
  }
  useEffect(()=>{void load();const clock=window.setInterval(()=>setNow(Date.now()),1000);return ()=>clearInterval(clock);},[api]);
  const row=rows.find(x=>x.id===selected)??rows[0];
  const watching=row&&['ARMED','VALIDATING'].includes(row.state);
  useEffect(()=>{
    if(!watching)return;
    const timer=window.setInterval(()=>void load(),15000);
    return ()=>clearInterval(timer);
  },[watching,api]);
  return <section className="pathmatch-workspace">
    <div className="panel pathmatch-head"><div><h2><Activity size={19}/> 预测交易 / PathMatch</h2><p>Binance Demo · 影子观察</p></div>
      <button onClick={()=>void load()} disabled={busy}><RefreshCw size={15}/> {busy?'读取中…':'刷新记录'}</button>
    </div>
    {error&&<p role="alert" className="alert">{error}</p>}
    {!row&&!busy&&!error&&<div className="panel exchange-body">还没有预测。可以在 ChatGPT 中用 QuantOS 创建预测，再授权启动影子观察。</div>}
    {row&&<div className="pathmatch-layout">
      <div className="panel pathmatch-records"><h3>预测记录</h3>{rows.map(item=><button type="button" key={item.id} aria-pressed={row.id===item.id} onClick={()=>setSelected(item.id)}>
        <strong>{item.symbol}</strong><span>{states[item.state]??item.state}</span><small>{stamp(item.createdAt)}</small>
      </button>)}</div>
      <div className="panel pathmatch-detail">
        <div className="panelhead"><div><h2>{row.symbol} · {row.plan.direction==='LONG'?'多头':'空头'}</h2><p>{states[row.state]??row.state} · {row.id}</p></div>
          <span className="badge">{row.result?.similarity==null?'相似率待计算':row.result.similarity.toFixed(1)+'% 相似率'}</span></div>
        <div className="pathmatch-inner">
          <p className="pathmatch-legend"><span>⋯ 预测参考线</span><span>■ 容许价区</span><span>▮ 已收盘 1m</span></p>
          <Chart row={row}/>
          <dl className="pathmatch-facts">
            <div><dt>剩余验证时间</dt><dd>{watching?Math.max(0,Math.ceil((row.expiresAt-now)/1000))+' 秒':'—'}</dd></div>
            <div><dt>入场范围</dt><dd>{row.plan.entry.priceMin} – {row.plan.entry.priceMax}</dd></div>
            <div><dt>硬性失效价</dt><dd>{row.plan.hardInvalidation}</dd></div>
            <div><dt>止损 / 止盈</dt><dd>{row.plan.risk.stopLoss} / {row.plan.risk.takeProfit}</dd></div>
            <div><dt>模拟订单</dt><dd>影子观察</dd></div>
          </dl>
          {row.result?.reason&&<p>最新结果 · {row.result.reason}</p>}
          <div className="pathmatch-forecast">{row.plan.forecast.candles.map((bar,i)=><div key={i}><strong>第 {i+1} 根 5m</strong><small>收盘 {bar.close} · {bar.low}–{bar.high}</small></div>)}</div>
        </div>
      </div>
    </div>}
  </section>;
}
