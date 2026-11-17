import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, RefreshCw, SlidersHorizontal, Trash2 } from 'lucide-react';
import type { AdaptiveForecast } from '../worker/pathmatch-adaptive';
import type { Plan, Candle } from '../worker/pathmatch-core';
import { adjustForecast, compareForecast, fitControls, originalFitParams, type FitParams } from './pathmatch-fit';
import './pathmatch.css';

type Point=Candle&{similarity:number};
type Prediction={strategy?:{strategyId:string;version:string;contentHash:string}|null;id:string;symbol:string;state:string;mode:string;startAt:number|null;expiresAt:number;createdAt:number;atr:number|null;
  plan:Plan;result:{reason?:string;similarity?:number|null;points?:Point[];adaptive?:AdaptiveForecast;fit?:{pathSimilarity:number;rangeOverlap:number;trendSimilarity:number;similarity:number};complete?:boolean;veto?:string|null;decision?:string}|null};
const stamp=(value:number)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
const states:Record<string,string>={DRAFT:'草稿',ARMED:'已锁定',VALIDATING:'观测中',CANCELED:'已取消',EXPIRED:'已到期',COMPLETED:'拟合完成'};

function Chart({row,adjusted}:{row:Prediction;adjusted?:Candle[]}){
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
      const candles=plan.forecast.candles;
      const values=[plan.referencePrice,...actual.flatMap(x=>[x.low,x.high]),...candles.flatMap(x=>[x.low,x.high]),
        ...(adjusted??[]).flatMap(x=>[x.low,x.high])];
      if(plan.forecast.interval==='5m')values.push(plan.hardInvalidation,plan.entry.priceMin,plan.entry.priceMax,
        ...candles.flatMap(x=>[x.low-tolerance,x.high+tolerance]));
      const bottom=Math.min(...values),top=Math.max(...values),padding=(top-bottom||top*0.005)*0.07;
      const min=bottom-padding,max=top+padding,span=max-min;
      const x=(n:number)=>12+(width-88)*n/15;
      const y=(n:number)=>18+(max-n)/span*(height-48);
      context.font='11px sans-serif';
      for(let i=0;i<5;i++){
        const px=min+span*i/4;
        context.strokeStyle='#d8e4dc';context.beginPath();context.moveTo(x(0),y(px));context.lineTo(x(15),y(px));context.stroke();
        context.fillStyle='#486459';context.fillText(px.toPrecision(5),x(15)+5,y(px)+4);
      }
      const minuteForecast=plan.forecast.interval==='1m';
      const step=minuteForecast?1:5;
      for(let i=0;i<3;i++){
        const minute=(i+1)*5;
        context.strokeStyle='#dce6e0';context.beginPath();context.moveTo(x(minute),18);context.lineTo(x(minute),height-22);context.stroke();
        context.fillStyle='#486459';context.fillText('+'+minute+'m',x(minute)-17,height-8);
      }
      const draw=(bar:Omit<Candle,'time'>,index:number,w:number,series:'original'|'adjusted'|'actual')=>{
        const column=x(index),top=Math.min(y(bar.open),y(bar.close)),body=Math.max(2,Math.abs(y(bar.open)-y(bar.close)));
        context.strokeStyle=series==='original'&&adjusted?'#6c7e88':bar.close>=bar.open?'#27755d':'#a04046';
        context.fillStyle=context.strokeStyle;
        context.beginPath();context.moveTo(column,y(bar.high));context.lineTo(column,y(bar.low));context.stroke();
        if(series==='actual')context.fillRect(column-w/2,top,w,body);
        else{
          context.fillStyle=series==='adjusted'?(bar.close>=bar.open?'#c6ebd7':'#ffd5d6'):'#f6faf6';
          context.fillRect(column-w/2,top,w,body);context.strokeRect(column-w/2,top,w,body);
        }
      };
      const candleWidth=Math.max(2,Math.min(10,(x(1)-x(0))*(adjusted?0.23:0.34)));
      const offset=adjusted?0.29:0.19;
      candles.forEach((bar,i)=>{
        const open='open' in bar?bar.open:(i===0?plan.referencePrice:candles[i-1].close);
        const center=i*step+step/2-(minuteForecast?offset:0.05);
        draw({...bar,open},center,candleWidth,'original');
      });
      adjusted?.forEach((bar,i)=>draw(bar,row.startAt?(bar.time-row.startAt)/60000+0.5:i+0.5,candleWidth,'adjusted'));
      for(const point of actual){
        const index=(point.time-(row.startAt??point.time))/60000+0.5+(minuteForecast?offset:0);
        draw(point,index,candleWidth,'actual');
      }
    };
    const observer=new ResizeObserver(chart);observer.observe(target);chart();
    return ()=>observer.disconnect();
  },[row,adjusted]);
  return <canvas ref={canvas} className="pathmatch-chart" aria-label={adjusted?'原始、加工与实际蜡烛图，共用时间和价格坐标':'原始预测与实际蜡烛图，共用时间和价格坐标'}/>;
}

const metrics=[['轨迹相似度','pathSimilarity'],['高低区间重合度','rangeOverlap'],
  ['趋势一致度','trendSimilarity'],['综合拟合度','similarity']] as const;
const percent=(value:number|undefined)=>value===undefined?'—':value.toFixed(1)+'%';

function FitPanel({row,watching}:{row:Prediction;watching:boolean}){
  const [params,setParams]=useState<FitParams>(originalFitParams);
  const changed=fitControls.some(({key})=>params[key]!==originalFitParams[key]);
  const adjusted=useMemo(()=>adjustForecast(row.plan,params,row.atr),[row.plan,params,row.atr]);
  const result=useMemo(()=>adjusted?compareForecast(row.plan,adjusted,row.result?.points??[],row.startAt,row.atr):null,[row,adjusted]);

  const adaptive=row.result?.adaptive;
  const rolling=adaptive?.status==='ACTIVE'?adaptive:null;
  const latest=rolling?.rounds.at(-1);
  const plotted=changed?adjusted??undefined:rolling?.candles.length?rolling.candles:undefined;

  return <>
    <p className="pathmatch-legend"><span>□ 原始预测</span>{plotted&&<span>▣ {changed?'手动加工':'滚动预测'}</span>}<span>■ 实际已收盘 1m</span></p>
    <Chart row={row} adjusted={plotted}/>
    <section className="pathmatch-adaptive" aria-label="滚动拟合">
      <h3>滚动拟合</h3>
      {rolling&&latest?<>
        <p>{rolling.scope==='SYMBOL'?'同币种':'跨币种'}历史样本 {rolling.sampleCount} 条 · 用前 {latest.observed} 根收盘 K 线更新 · {stamp(latest.lockedAt)}</p>
        <div className="pathmatch-rolling-stats">
          <div><span>已见区间拟合</span><b>{percent(latest.selected.observedFit)}</b></div>
          <div><span>滚动预测均分</span><b>{percent(rolling.score??undefined)}</b></div>
          <div><span>原始预测同分钟均分</span><b>{percent(rolling.originalScore??undefined)}</b></div>
        </div>
        <p>已验证 {rolling.evaluated} 次下一根预测。每次使用收盘前已锁定的预测评分。{latest.observedGain!==null&&`在同一批已见 K 线上，本轮参数较上一轮 ${latest.observedGain>0?'+':''}${latest.observedGain.toFixed(1)} 个百分点。`}</p>
        <p>{latest.selected.method==='ORIGINAL'?'沿用原始预测':`趋势 ${latest.selected.params.slope}% · 影线 ${latest.selected.params.wick}% · 回踩 ${latest.selected.params.pullback}% ATR`}</p>
        {!rolling.complete&&<p>第 {latest.observed+1} 根预测 · 开 {Number(latest.next.open.toPrecision(9))} · 高 {Number(latest.next.high.toPrecision(9))} · 低 {Number(latest.next.low.toPrecision(9))} · 收 {Number(latest.next.close.toPrecision(9))}</p>}
        <details><summary>参数候选 · 历史下一根加权拟合</summary>
          {[latest.selected,...latest.alternatives].map((c,i)=><p key={i}>{i===0?'已选 · ':''}{c.method==='ORIGINAL'?'原始':`趋势 ${c.params.slope}% / 影线 ${c.params.wick}% / 回踩 ${c.params.pullback}% ATR`} · {percent(c.historicalFit)}</p>)}
        </details>
      </>:<p>{adaptive?.status==='INSUFFICIENT_DATA'?`合格历史样本 ${adaptive.sampleCount??0} 条，暂不足以选参。`:
        adaptive?.status==='HISTORY_UNAVAILABLE'?'暂时无法读取历史拟合样本。':
        row.result?.complete?'这条历史记录没有当时锁定的滚动预测。':'等待第一根 1 分钟 K 线收盘。'}</p>}
    </section>
    <details className="pathmatch-parameters">
      <summary><SlidersHorizontal size={16}/>拟合参数</summary>
      <p>复盘试算。参数只作用于加工预测，原始预测、正式评分和交易判定保留。</p>
      <div className="pathmatch-controls">{fitControls.map(({key,label,min,max,step,unit,description})=>
        <label key={key}><span>{label}<output>{params[key]}{unit}</output></span>
          <input type="range" aria-label={label} min={min} max={max} step={step} value={params[key]}
            disabled={key==='pullback'&&row.atr===null}
            onChange={event=>{const value=event.currentTarget.valueAsNumber;setParams(previous=>({...previous,[key]:value}));}}/>
          <small>{key==='pullback'&&row.atr===null?'锁定 ATR 后可调。':description}</small>
        </label>)}</div>
      <div className="actions">
        <button type="button" onClick={()=>setParams({...originalFitParams,slope:50})}>趋势减半</button>
        <button type="button" disabled={!changed} onClick={()=>setParams(originalFitParams)}>恢复原始</button>
      </div>
      {changed&&!adjusted&&<p role="alert">加工后出现无效价格，请缩小参数幅度。</p>}
    </details>
    <div className="pathmatch-fit">{metrics.map(([label,key])=>{
      const original=row.result?.fit?.[key],processed=result?.[key];
      const delta=original!==undefined&&processed!==undefined?Math.round((processed-original)*10)/10:null;
      return <div key={key}><span>{label}</span>
        <small>原始 <strong>{percent(original)}</strong></small>
        <small>加工 <strong>{percent(processed)}</strong></small>
        {changed&&delta!==null&&<small className={delta<0?'fit-down':delta>0?'fit-up':''}>{delta>0?'+':''}{delta.toFixed(1)} 个百分点</small>}
      </div>;
    })}
      <p>已收盘 {row.result?.points?.length??0}/15 {row.result?.complete?' · 最终结果':watching?' · 观察中':' · 未形成最终结果'}
        {row.result?.decision==='REVIEW'?' · 待复核':' · WAIT'}{row.result?.veto?' · 已触发硬性失效':''}</p>
    </div>
    {changed&&adjusted&&<details><summary>加工 OHLC 明细</summary><div className="pathmatch-forecast">{adjusted.map((bar,i)=>
      <div key={bar.time}><strong>第 {i+1} 根 1m</strong><small>开 {Number(bar.open.toPrecision(9))} · 高 {Number(bar.high.toPrecision(9))} · 低 {Number(bar.low.toPrecision(9))} · 收 {Number(bar.close.toPrecision(9))}</small></div>)}</div></details>}
  </>;
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
          {row.plan.forecast.interval==='1m'?<FitPanel key={row.id} row={row} watching={watching}/>:<>
            <p className="pathmatch-legend"><span>□ 原始预测</span><span>■ 实际已收盘 1m</span></p>
            <Chart row={row}/>
            <p>历史计划 · 三根 5 分钟预测，开盘价按上一根预测收盘价绘制。</p>
          </>}
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
