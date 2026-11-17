import { useEffect, useRef, useState } from 'react';
import { Activity, RefreshCw, Trash2 } from 'lucide-react';
import type { Plan, Candle } from '../worker/pathmatch-core';
import './pathmatch.css';

type Point=Candle&{expected:number;lower:number;upper:number;similarity:number};
type Prediction={strategy?:{strategyId:string;version:string;contentHash:string}|null;id:string;symbol:string;state:string;mode:string;startAt:number|null;expiresAt:number;createdAt:number;atr:number|null;
  plan:Plan;result:{reason?:string;similarity?:number|null;points?:Point[];fit?:{pathSimilarity:number;rangeOverlap:number;trendSimilarity:number;similarity:number};complete?:boolean;veto?:string|null;decision?:string}|null};
const stamp=(value:number)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
const states:Record<string,string>={DRAFT:'草稿',ARMED:'已锁定',VALIDATING:'观测中',CANCELED:'已取消',EXPIRED:'已到期',COMPLETED:'拟合完成'};

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
      const candles=plan.forecast.candles;
      const minuteForecast=plan.forecast.interval==='1m';
      const step=minuteForecast?1:5;
      for(let i=0;i<3;i++){
        const minute=(i+1)*5;
        context.strokeStyle='#dce6e0';context.beginPath();context.moveTo(x(minute),18);context.lineTo(x(minute),height-22);context.stroke();
        context.fillStyle='#486459';context.fillText('+'+minute+'m',x(minute)-17,height-8);
      }
      const draw=(bar:Omit<Candle,'time'>,index:number,w:number,outline:boolean)=>{
        const column=x(index),top=Math.min(y(bar.open),y(bar.close)),body=Math.max(2,Math.abs(y(bar.open)-y(bar.close)));
        context.strokeStyle=bar.close>=bar.open?'#27755d':'#a04046';context.fillStyle=context.strokeStyle;
        context.beginPath();context.moveTo(column,y(bar.high));context.lineTo(column,y(bar.low));context.stroke();
        if(outline){context.fillStyle='#f6faf6';context.fillRect(column-w/2,top,w,body);context.strokeRect(column-w/2,top,w,body);}
        else context.fillRect(column-w/2,top,w,body);
      };
      const candleWidth=Math.max(2,Math.min(10,(x(1)-x(0))*0.34));
      candles.forEach((bar,i)=>{
        const open='open' in bar?bar.open:(i===0?plan.referencePrice:candles[i-1].close);
        const center=i*step+step/2-(minuteForecast?0.19:0.05);
        draw({...bar,open},center,candleWidth,true);
      });
      for(const point of actual){
        const index=(point.time-(row.startAt??point.time))/60000+0.5+(minuteForecast?0.19:0);
        draw(point,index,candleWidth,false);
      }
    };
    const observer=new ResizeObserver(chart);observer.observe(target);chart();
    return ()=>observer.disconnect();
  },[row]);
  return <canvas ref={canvas} className="pathmatch-chart" aria-label="预测与真实已收盘蜡烛图，共用时间和价格坐标"/>;
}

export default function PathMatch({api}:{api:(path:string,body?:unknown)=>Promise<any>}){
  const [rows,setRows]=useState<Prediction[]>([]),[selected,setSelected]=useState(''),[busy,setBusy]=useState(true),[error,setError]=useState('');
  const [now,setNow]=useState(Date.now);
  const [deleting,setDeleting]=useState(false);
  const removed=useRef(new Set<string>());
  async function load(){
    setBusy(true);setError('');
    try{const entries:Prediction[]=await api('/predictions/history?limit=20');setRows(entries.filter(item=>!removed.current.has(item.id)));}
    catch{setError('暂时无法读取预测记录。');}
    finally{setBusy(false);}
  }
  useEffect(()=>{void load();const clock=window.setInterval(()=>setNow(Date.now()),1000);return ()=>clearInterval(clock);},[api]);
  const row=rows.find(x=>x.id===selected)??rows[0];
  const watching=row&&['ARMED','VALIDATING'].includes(row.state);
  useEffect(()=>{
    if(!watching)return;
    const timer=window.setInterval(()=>void load(),60000);
    return ()=>clearInterval(timer);
  },[watching,api]);
  async function remove(item:Prediction){
    const message=['ARMED','VALIDATING'].includes(item.state)
      ? `停止 ${item.symbol} 的观察并删除这条预测记录？` : `删除这条 ${item.symbol} 预测记录？`;
    if(!window.confirm(message))return;
    setDeleting(true);setError('');
    try{
      await api('/predictions/delete',{id:item.id,confirm:true});
      removed.current.add(item.id);
      setRows(previous=>previous.filter(candidate=>candidate.id!==item.id));
      setSelected(current=>current===item.id?'':current);
    }catch{setError('暂时无法删除预测记录，请重试。');}
    finally{setDeleting(false);}
  }
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
          <div className="actions"><span className="badge">{row.result?.similarity==null?'相似率待计算':row.result.similarity.toFixed(1)+'% 相似率'}</span>
            <button type="button" className="danger" disabled={deleting} onClick={()=>void remove(row)}><Trash2 size={14}/>{deleting?'删除中…':'删除记录'}</button>
          </div></div>
        <div className="pathmatch-inner">
          <p>绑定策略 {row.strategy?<span title={row.strategy.contentHash}>{row.strategy.strategyId} v{row.strategy.version}</span>:'—'}</p>
          <p className="pathmatch-legend"><span>□ 预测蜡烛</span><span>■ 实际已收盘 1m</span></p>
          <Chart row={row}/>
          {row.plan.forecast.interval==='5m'&&<p>历史计划 · 三根 5 分钟预测，开盘价按上一根预测收盘价绘制。</p>}
          {row.plan.forecast.interval==='1m'&&<div className="pathmatch-fit">
            {([['轨迹相似度','pathSimilarity'],['高低区间重合度','rangeOverlap'],['趋势一致度','trendSimilarity'],['综合拟合度','similarity']] as const).map(([label,key])=>
              <div key={key}><span>{label}</span><b>{row.result?.fit?.[key]?.toFixed(1)??'—'}{row.result?.fit?'%':''}</b></div>)}
            <p>已收盘 {row.result?.points?.length??0}/15 {row.result?.complete?' · 最终结果':watching?' · 观察中':' · 未形成最终结果'}
              {row.result?.decision==='REVIEW'?' · 待复核':' · WAIT'}{row.result?.veto?' · 已触发硬性失效':''}</p>
          </div>}
          <dl className="pathmatch-facts">
            <div><dt>剩余验证时间</dt><dd>{watching?Math.max(0,Math.ceil((row.expiresAt-now)/1000))+' 秒':'—'}</dd></div>
            <div><dt>入场范围</dt><dd>{row.plan.entry.priceMin} – {row.plan.entry.priceMax}</dd></div>
            <div><dt>硬性失效价</dt><dd>{row.plan.hardInvalidation}</dd></div>
            <div><dt>止损 / 止盈</dt><dd>{row.plan.risk.stopLoss} / {row.plan.risk.takeProfit}</dd></div>
            <div><dt>模拟订单</dt><dd>影子观察</dd></div>
          </dl>
          {row.result?.reason&&<p>最新结果 · {row.result.reason}</p>}
          <details><summary>预测 OHLC 明细</summary><div className="pathmatch-forecast">{row.plan.forecast.candles.map((bar,i)=>
            <div key={i}><strong>第 {i+1} 根 {row.plan.forecast.interval}</strong>
            <small>{'open' in bar?'开 '+bar.open+' · ':''}高 {bar.high} · 低 {bar.low} · 收 {bar.close}</small></div>)}</div></details>
        </div>
      </div>
    </div>}
  </section>;
}
