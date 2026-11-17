import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChartCandlestick, Download, Lock, Unlock, Play, Pause, RotateCcw, Save, FolderOpen, SkipBack, SkipForward, Undo2, Redo2 } from 'lucide-react';
import GridChart, { fullTime, type Drawing, type DrawingPoint } from './GridChart';
import { defaults, gridLevels, priceFormat, simulateGrid, snapPrice, type GridConfig, type GridMarket, type GridResult } from './grid-engine';
import './grid-lab.css';

type Api=(path:string)=>Promise<any>;
type Range={preset:string;from:string;to:string};
type DrawingState={lower:number;upper:number;lines:Drawing[]};
type Scenario={schema:1;symbol:string;interval:string;range:Range;config:GridConfig;drawings:DrawingState;market:GridMarket;simulation?:GridMarket;result?:GridResult};
const day=86400000;
const nowInput=(time:number)=>new Date(time+8*3600000).toISOString().slice(0,16);
const beijing=(value:string)=>Date.parse(value+'+08:00');
const period=(preset:string):Range=>{
 const now=Date.now(),today=Math.floor((now+8*3600000)/day)*day-8*3600000;
 const start=preset==='yesterday'?today-day:preset==='3d'?today-2*day:preset==='7d'?today-6*day:today;
 return {preset,from:nowInput(start),to:nowInput(preset==='yesterday'?today:now)};
};
const money=(value:number|undefined)=>value===undefined?'—':value.toLocaleString('zh-CN',{useGrouping:true,minimumFractionDigits:2,maximumFractionDigits:4});
const reason:Record<string,string>={OPEN:'开仓',CLOSE:'平仓',BREAKOUT:'突破',STOP:'风控退出',GRID_TARGET:'网格止盈',
 TRAILING_STOP:'移动止盈',HARD_STOP:'硬止损',LOSS_LIMIT:'单轮亏损上限',DRAWDOWN_LIMIT:'回撤上限',
 ESTIMATED_LIQUIDATION:'触发预估强平',BREAKOUT_EXIT:'突破平仓',UPPER_BREAKOUT:'向上突破',LOWER_BREAKOUT:'向下突破',REDRAW_REQUIRED:'暂停待重画'};
const friendly:Record<string,string>={
 GRID_INVALID_SYMBOL:'请输入 USDT 永续合约交易对，例如 AKEUSDT。',GRID_INVALID_RANGE:'请选择有效区间。1m 最长 7 天，其他周期最长 31 天。',
 GRID_SYMBOL_NOT_FOUND:'币安 USDⓈ-M 永续合约中未找到此交易对。',GRID_CONTRACT_NOT_TRADING:'此永续合约当前不可交易。',
 GRID_NO_CLOSED_CANDLES:'所选时段没有完整收盘 K 线。',GRID_KLINE_GAPS:'币安返回的 K 线有缺口，无法在该范围内模拟。',
 GRID_FUNDING_UNAVAILABLE:'资金费率数据不可用，可选自定义费率或关闭。'
};
const explain=(e:unknown)=>friendly[(e as Error).message]??((e as Error).message.startsWith('GRID_BINANCE_HTTP')?'行情服务暂不可用（'+(e as Error).message+'）。':(e as Error).message);
const breakoutChoices=[['CLOSE','撤单并平仓'],['HOLD','保留持仓'],['PAUSE','暂停待重画']] as const;
const initialDrawings:DrawingState={lower:0,upper:0,lines:[]};
const dbAccess=()=>new Promise<IDBDatabase>((resolve,reject)=>{
 const req=indexedDB.open('quantos-grid-lab',1);
 req.onupgradeneeded=()=>req.result.createObjectStore('scenarios');
 req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
});
async function localScenario(value?:Scenario):Promise<Scenario|undefined>{
 const db=await dbAccess();
 try{return await new Promise((resolve,reject)=>{
  const tx=db.transaction('scenarios',value?'readwrite':'readonly');
  const req=value?tx.objectStore('scenarios').put(value,'latest'):tx.objectStore('scenarios').get('latest');
  tx.oncomplete=()=>resolve(value?undefined:req.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
 });}finally{db.close();}
}
function NumberField({label,value,onChange,min=0,step='any'}:{label:string;value:number;onChange:(n:number)=>void;min?:number;step?:number|'any'}){
 const [text,setText]=useState(String(value||''));
 const focused=useRef(false);
 useEffect(()=>{if(!focused.current)setText(String(value||''));},[value]);
 return <label>{label}<input inputMode="decimal" type="number" step={step} min={min} value={text}
  onFocus={()=>{focused.current=true;}}
  onChange={e=>setText(e.target.value)}
  onBlur={()=>{focused.current=false;let parsed=Number(text);if(!Number.isFinite(parsed))parsed=value;onChange(parsed);setText(String(parsed||''));}}
  onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur();}}/></label>;
}
function Pick({label,value,options,change}:{label:string;value:string;options:readonly (readonly [string,string])[];change:(s:string)=>void}){
 return <label>{label}<select value={value} onChange={e=>change(e.target.value)}>
  {options.map(([id,text])=><option key={id} value={id}>{text}</option>)}</select></label>;
}
function Card({title,children,open=true}:{title:string;children:ReactNode;open?:boolean}){
 return <details className="grid-lab-card" open={open}><summary>{title}</summary>{children}</details>;
}
function EquityChart({values,capital}:{values:number[];capital:number}){
 const ref=useRef<HTMLCanvasElement>(null);
 useEffect(()=>{
  const el=ref.current!;
  const draw=()=>{
   const w=el.clientWidth,h=el.clientHeight,dpr=window.devicePixelRatio||1;
   el.width=w*dpr;el.height=h*dpr;
   const c=el.getContext('2d');if(!c||!values.length)return;
   c.scale(dpr,dpr);
   const min=Math.min(capital,...values),max=Math.max(capital,...values),spread=max-min||1;
   const y=(v:number)=>h-14-(h-28)*(v-min)/spread;
   c.strokeStyle='#627772';c.setLineDash([4,4]);c.beginPath();c.moveTo(10,y(capital));c.lineTo(w-10,y(capital));c.stroke();c.setLineDash([]);
   c.strokeStyle='#8fddb0';c.lineWidth=2;c.beginPath();
   values.forEach((v,i)=>{const x=10+i*(w-20)/Math.max(values.length-1,1);if(i)c.lineTo(x,y(v));else c.moveTo(x,y(v));});c.stroke();
  };
  const obs=new ResizeObserver(draw);obs.observe(el);draw();return()=>obs.disconnect();
 },[values,capital]);
 return <canvas ref={ref} className="grid-equity" aria-label="已播放时段的账户权益曲线"/>;
}

export default function GridLab({api,onOpenPrediction}:{api:Api;onOpenPrediction:()=>void}){
 const [symbol,setSymbol]=useState('AKEUSDT'),[activeSymbol,setActiveSymbol]=useState('AKEUSDT'),[interval,setIntervalValue]=useState('15m');
 const [range,setRange]=useState<Range>(()=>period('today')),[market,setMarket]=useState<GridMarket|null>(null);
 const [config,setConfig]=useState<GridConfig>(defaults),[simulation,setSimulation]=useState<GridMarket|null>(null);
 const [result,setResult]=useState<GridResult|null>(null),[cursor,setCursor]=useState(0),[playing,setPlaying]=useState(false),[speed,setSpeed]=useState(10);
 const [drawings,setDrawings]=useState(initialDrawings),[undo,setUndo]=useState<DrawingState[]>([]),[redo,setRedo]=useState<DrawingState[]>([]);
 const [selected,setSelected]=useState<number|null>(null),[tool,setTool]=useState<'PAN'|'LINE'|'BOX'|'SEGMENT'>('PAN');
 const [anchor,setAnchor]=useState<number|null>(null),[locked,setLocked]=useState(false),[precise,setPrecise]=useState(true);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[dark,setDark]=useState(true);
 const [saved,setSaved]=useState(false);
 const requestNumber=useRef(0),replayNumber=useRef(0),dragStart=useRef<DrawingState|null>(null),lineId=useRef(1);
 const skipLoad=useRef(false);
 const frame=result&&cursor>0?result.frames[Math.min(cursor,result.frames.length)-1]:undefined;
 const ended=!!result&&cursor>=result.frames.length;
 const stats=useMemo(()=>{
  if(!market)return null;
  const bars=result?simulation?.candles.slice(0,cursor)??[]:market.candles;
  if(!bars.length)return null;
  const first=bars[0],last=bars.at(-1)!;
  return {last:last.close,change:(last.close/first.open-1)*100,high:Math.max(...bars.map(b=>b.high)),low:Math.min(...bars.map(b=>b.low)),vol:bars.reduce((n,b)=>n+b.volume,0)};
 },[market,result,simulation,cursor]);
 const params={...config,lower:drawings.lower,upper:drawings.upper};
 const levels=useMemo(()=>{
  try{return market?gridLevels({...config,lower:drawings.lower,upper:drawings.upper},market.rules):[];}catch{return [];}
 },[config,drawings.lower,drawings.upper,market]);
 const replaceDrawings=(next:DrawingState,prior=drawings)=>{
  if(next===prior)return;
  setUndo(history=>[...history.slice(-29),prior]);setRedo([]);setDrawings(next);
 };
 function clearSimulation(){
  replayNumber.current++;setResult(null);setSimulation(null);setCursor(0);setPlaying(false);
 }
 function change<K extends keyof GridConfig>(key:K,value:GridConfig[K]){
  setConfig(previous=>({...previous,[key]:value}));
  if(result)clearSimulation();
 }
 function box(which:'upper'|'lower',value:number,commit=true){
  if(!market||locked||result||busy)return;
  const price=value>0?snapPrice(value,market.rules):0,other=which==='upper'?drawings.lower:drawings.upper;
  const bounded=other&&price&&which==='upper'?Math.max(other+Number(market.rules.tick),price):
   other&&price?Math.max(Number(market.rules.tick),Math.min(other-Number(market.rules.tick),price)):price;
  const next={...drawings,[which]:bounded?snapPrice(bounded,market.rules):0};
  if(commit){
   replaceDrawings(next,dragStart.current??drawings);dragStart.current=null;
  }else{if(!dragStart.current)dragStart.current=drawings;setDrawings(next);}
 }
 function addSegment(segment:{start:DrawingPoint;end:DrawingPoint}){
  if(!market||locked||result||busy)return;
  const id=lineId.current++;
  replaceDrawings({...drawings,lines:[...drawings.lines,{id,...segment}]});
  setSelected(id);
  setTool('PAN');
 }
 function clickPrice(price:number){
  if(!market||result||locked||busy)return;
  const value=snapPrice(price,market.rules);
  if(value<=0)return;
  if(tool==='LINE'){
   const id=lineId.current++;replaceDrawings({...drawings,lines:[...drawings.lines,{id,price:value}]});setSelected(id);setTool('PAN');
  }else if(anchor===null)setAnchor(value);
  else{
   if(value===anchor){setError('上下限至少相隔一个价格档。');return;}
   replaceDrawings({...drawings,lower:Math.min(anchor,value),upper:Math.max(anchor,value)});setAnchor(null);setTool('PAN');setError('');
  }
 }
 const path=(pair:string,period:Range,cycle:string,funding=false)=>'/grid/market?'+new URLSearchParams({
  symbol:pair,from:String(beijing(period.from)),to:String(beijing(period.to)),interval:cycle,...(funding?{funding:'1'}:{})
 });
 async function load(pair=activeSymbol){
  const ordinal=++requestNumber.current;
  clearSimulation();setBusy(true);setError('');setNotice('');
  try{
   const data:GridMarket=await api(path(pair,range,interval));
   if(ordinal!==requestNumber.current)return;
   if(data.symbol!==market?.symbol){setDrawings(initialDrawings);setUndo([]);setRedo([]);setSelected(null);setLocked(false);setTool('PAN');setAnchor(null);}
   setMarket(data);
   if(data.from>beijing(range.from)+data.step)setNotice('合约上线前的区间已跳过，图表从第一根完整 K 线开始。');
  }catch(err){if(ordinal===requestNumber.current){setError(explain(err));setMarket(null);}}
  finally{if(ordinal===requestNumber.current)setBusy(false);}
 }
 useEffect(()=>{if(skipLoad.current){skipLoad.current=false;return;}const timeout=window.setTimeout(()=>void load(),300);
  return ()=>window.clearTimeout(timeout);},[range,interval,activeSymbol]);
 useEffect(()=>{void localScenario().then(data=>setSaved(!!data)).catch(()=>{});},[]);
 useEffect(()=>{
  if(!playing||!result)return;
  const timer=window.setInterval(()=>setCursor(n=>Math.min(result.frames.length,n+(speed===50?5:1))),Math.max(50,500/Math.min(10,speed)));
  return ()=>clearInterval(timer);
 },[playing,result,speed]);
 useEffect(()=>{if(ended)setPlaying(false);},[ended]);
 async function run(){
  if(!market)return;
  const ordinal=++replayNumber.current;
  setBusy(true);setError('');setNotice('');setPlaying(false);
  try{
   gridLevels(params,market.rules);
   const wantFunding=config.fundingMode==='HISTORY';
   let source:GridMarket;
   const actualRange={...range,from:nowInput(market.from),to:nowInput(market.to)};
   if(precise&&market.interval!=='1m'&&market.to-market.from<=7*day){
    try{source=await api(path(market.symbol,actualRange,'1m',wantFunding));}
    catch(err){
     source=wantFunding?await api(path(market.symbol,actualRange,market.interval,true)):market;
     if(ordinal===replayNumber.current)setNotice('1m 历史行情不可用，已使用 '+source.interval+' 保守回放（'+explain(err)+'）。');
    }
   }else{
    source=wantFunding&&!market.funding?await api(path(market.symbol,actualRange,market.interval,true)):market;
    if(precise&&market.interval!=='1m'&&market.to-market.from>7*day)setNotice('所选区间超过 1m 模拟上限，使用 '+market.interval+' 保守回放。');
   }
   if(ordinal!==replayNumber.current)return;
   const performance=simulateGrid(source,params);
   setSimulation(source);setResult(performance);setCursor(0);setPlaying(true);
  }catch(err){if(ordinal===replayNumber.current)setError(explain(err));}
  finally{if(ordinal===replayNumber.current)setBusy(false);}
 }
 async function save(){
  if(!market)return;
  try{
   await localScenario({schema:1,symbol:market.symbol,interval,range,config:params,drawings,market,
    ...(simulation&&result?{simulation,result}:{})});
   setSaved(true);setNotice('方案已保存到此设备。');
  }catch{setError('无法保存方案。请检查浏览器存储空间。');}
 }
 async function restore(){
  try{
   const data=await localScenario();if(!data||data.schema!==1)return;
   requestNumber.current++;setBusy(false);clearSimulation();skipLoad.current=activeSymbol!==data.symbol||interval!==data.interval||JSON.stringify(range)!==JSON.stringify(data.range);
   setSymbol(data.symbol);setActiveSymbol(data.symbol);setIntervalValue(data.interval);
   if(JSON.stringify(range)!==JSON.stringify(data.range))setRange(data.range);
   setMarket(data.market);setConfig(data.config);setDrawings(data.drawings);setUndo([]);setRedo([]);setLocked(false);
   lineId.current=Math.max(0,...data.drawings.lines.map(x=>x.id))+1;
   if(data.result&&data.simulation){setResult(data.result);setSimulation(data.simulation);}
   setNotice('已恢复本机方案。');setError('');
  }catch{setError('无法恢复本机方案。');}
 }
 function exportResult(){
  if(!result||!simulation)return;
  const data=JSON.stringify({symbol:simulation.symbol,interval:simulation.interval,from:simulation.from,to:simulation.to,config:params,drawings,result},null,2);
  const link=document.createElement('a'),url=URL.createObjectURL(new Blob([data],{type:'application/json'}));
  link.href=url;link.download=simulation.symbol+'-grid-backtest.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 function continueFromPause(){
  if(!frame||!simulation)return;
  const from=frame.time+simulation.step;
  if(from>=simulation.to)return;
  const newCapital=frame.equity;
  if(newCapital<=0)return;
  clearSimulation();setConfig(previous=>({...previous,capital:newCapital}));
  setRange(previous=>({...previous,preset:'custom',from:nowInput(from),to:nowInput(simulation.to)}));
  setNotice('已以本轮权益为新本金，可重新绘制箱体。');
 }
 const displayBars=result?simulation?.candles.slice(0,cursor)??[]:market?.candles??[];
 const visibleFrames=result?.frames.slice(0,cursor);
 const recent=visibleFrames?.slice(-10).flatMap(f=>f.events).slice(-12).reverse()??[];
 const closedRows=frame?result?.trades.slice(0,frame.done)??[]:[];
 const summary=stats?([['价格',market?priceFormat(stats.last,market.rules.tick):'—'],['区间涨跌',stats.change.toFixed(2)+'%'],
  ['区间最高',market?priceFormat(stats.high,market.rules.tick):'—'],['区间最低',market?priceFormat(stats.low,market.rules.tick):'—'],['成交量',money(stats.vol)]]):[];
 return <section className={'grid-lab '+(dark?'grid-dark':'grid-light')}>
  <header className="grid-lab-hero"><div><h2>网格交易实验室</h2><p>Binance USDⓈ-M · 人工绘图与历史回放</p></div>
   <div className="grid-hero-actions"><button type="button" onClick={()=>setDark(v=>!v)}>{dark?'浅色界面':'深色界面'}</button>
    <button type="button" onClick={onOpenPrediction}>查看历史预测</button></div></header>
  <section className="grid-lab-card grid-market-card">
   <form onSubmit={e=>{e.preventDefault();const pair=symbol.trim().toUpperCase();setSymbol(pair);if(pair===activeSymbol)void load(pair);else setActiveSymbol(pair);}}>
    <label>交易对<input value={symbol} onChange={e=>setSymbol(e.target.value)} placeholder="AKEUSDT" required maxLength={24}/></label>
    <Pick label="周期" value={interval} options={([['1m','1 分钟'],['5m','5 分钟'],['15m','15 分钟'],['1h','1 小时']])} change={setIntervalValue}/>
    <Pick label="时间范围（北京时间）" value={range.preset} options={([['today','今天'],['yesterday','昨天'],['3d','最近 3 天'],['7d','最近 7 天'],['custom','自定义']])}
     change={v=>setRange(v==='custom'?{...range,preset:v}:period(v))}/>
    {range.preset==='custom'&&<><label>开始时间<input type="datetime-local" value={range.from} onChange={e=>setRange({...range,from:e.target.value})}/></label>
     <label>结束时间<input type="datetime-local" value={range.to} onChange={e=>setRange({...range,to:e.target.value})}/></label></>}
    <button className="grid-main-action" type="submit" disabled={busy}><ChartCandlestick size={16}/>获取 K 线</button>
    <button type="button" disabled={!market||busy} onClick={()=>void save()}><Save size={15}/>保存方案</button>
    <button type="button" disabled={!saved||busy} onClick={()=>void restore()}><FolderOpen size={15}/>打开已保存方案</button>
   </form>
   {busy&&<p role="status">正在请求行情或准备回放…</p>}{error&&<p role="alert" className="grid-error">{error}</p>}{notice&&<p role="status">{notice}</p>}
  </section>
  {!market?<section className="grid-empty grid-lab-card"><div><h3>加载历史行情</h3><p>选择交易对与时间范围，加载后可在图上绘制网格箱体。</p></div></section>:
  <>
   <div className="grid-market-summary">
    <div><strong>{market.symbol}</strong><small>{market.interval} · 北京时间</small></div>
    {summary.map(([label,value])=><div key={label}><small>{label}</small><strong>{value}</strong></div>)}
   </div>
   <div className="grid-terminal">
    <div className="grid-main-column">
     <section className="grid-lab-card grid-chart-card">
      <div className="grid-chart-top"><b>{simulation?simulation.interval:market.interval} · {frame?fullTime.format(frame.time):'历史 K 线'}</b>
       <span>{market.candles.length} 根 · 价格步进 {Number(market.rules.tick)} · 最小名义 {market.rules.minNotional} USDT</span></div>
      <div className="grid-toolbar" aria-label="绘图工具栏">
       <button type="button" aria-pressed={tool==='PAN'} onClick={()=>{setTool('PAN');setAnchor(null);}}>平移</button>
       <button type="button" disabled={locked||!!result} aria-pressed={tool==='BOX'} onClick={()=>{setTool('BOX');setAnchor(null);}}>绘制网格箱体</button>
       <button type="button" disabled={locked||!!result} aria-pressed={tool==='LINE'} onClick={()=>{setTool('LINE');setAnchor(null);}}>画水平线</button>
       <button type="button" disabled={locked||!!result} aria-pressed={tool==='SEGMENT'} onClick={()=>{setTool('SEGMENT');setAnchor(null);}}>拉直线</button>
       <button type="button" disabled={locked||!!result||!selected} onClick={()=>{replaceDrawings({...drawings,lines:drawings.lines.filter(l=>l.id!==selected)});setSelected(null);}}>删除选中</button>
       <button type="button" disabled={locked||!!result} onClick={()=>{replaceDrawings(initialDrawings);setSelected(null);setAnchor(null);}}>清除绘图</button>
       <button type="button" aria-label="撤销" disabled={locked||!!result||!undo.length} onClick={()=>{setRedo([...redo,drawings]);setDrawings(undo.at(-1)!);setUndo(undo.slice(0,-1));setSelected(null);}}><Undo2 size={15}/></button>
       <button type="button" aria-label="重做" disabled={locked||!!result||!redo.length} onClick={()=>{setUndo([...undo,drawings]);setDrawings(redo.at(-1)!);setRedo(redo.slice(0,-1));setSelected(null);}}><Redo2 size={15}/></button>
       <button type="button" aria-pressed={locked} onClick={()=>{setLocked(v=>!v);setTool('PAN');setAnchor(null);}}>{locked?<Lock size={15}/>:<Unlock size={15}/>} {locked?'解锁':'锁定'}</button>
      </div>
      {tool==='BOX'&&<p className="grid-draw-hint">{anchor===null?'点击图表确定第一条边界。':'点击确定第二条边界。'}</p>}
      {tool==='SEGMENT'&&<p className="grid-draw-hint">从起点按住拖到终点，松开确定。按住 Shift 可画水平线。</p>}
      <GridChart key={market.symbol+market.interval+market.from+(result?'replay':'history')} bars={displayBars} tick={market.rules.tick} step={simulation?.step??market.step} levels={levels}
       stops={[config.stopLower,config.stopUpper]} lines={drawings.lines} selected={selected} locked={locked||!!result}
       tool={result?'PAN':tool} anchor={anchor} frame={frame} frames={visibleFrames} onPrice={clickPrice}
       onSelect={id=>setSelected(id||null)} onDrag={box} onSegment={addSegment}/>
      {result&&<div className="grid-replay">
       <button type="button" onClick={()=>{if(ended)setCursor(0);setPlaying(v=>!v);}}>{playing?<Pause size={15}/>:<Play size={15}/>} {playing?'暂停':cursor?'继续播放':'播放'}</button>
       <button type="button" aria-label="重新播放" onClick={()=>{setCursor(0);setPlaying(true);}}><RotateCcw size={15}/></button>
       <button type="button" aria-label="上一步" onClick={()=>{setPlaying(false);setCursor(n=>Math.max(0,n-1));}}><SkipBack size={15}/></button>
       <button type="button" aria-label="下一步" onClick={()=>{setPlaying(false);setCursor(n=>Math.min(result.frames.length,n+1));}}><SkipForward size={15}/></button>
       <select aria-label="播放速度" value={speed} onChange={e=>setSpeed(Number(e.target.value))}>{[1,2,5,10,50].map(n=><option key={n} value={n}>{n}×</option>)}</select>
       <input aria-label="播放进度" type="range" min={0} max={result.frames.length} value={cursor} onChange={e=>{setPlaying(false);setCursor(Number(e.target.value));}}/>
       <span>{cursor} / {result.frames.length}</span><button type="button" onClick={clearSimulation}>返回绘图</button>
      </div>}
     </section>
     {result&&<section className="grid-lab-card grid-ledger">
      <div className="grid-report-title"><h3>{ended?'回测报告':'回放记录'}</h3><button type="button" onClick={exportResult} disabled={!ended}><Download size={15}/>导出 JSON</button></div>
      <p>{simulation?.interval} 历史 OHLC · 人工事后绘图 · 止损和突破优先，同根新单不计止盈。图中成交为估算。</p>
      {frame&&<><div className="grid-report-stats">
       {([['净收益',frame.net],['收益率 %',100*frame.net/config.capital],['最终／当前权益',frame.equity],['最大回撤 %',frame.drawdown],
        ['已实现盈亏（毛）',frame.realized],['未实现盈亏',frame.floating],['成交轮数',frame.done],['盈利比 %',frame.done?frame.wins/frame.done*100:undefined],
        ['累计手续费',frame.fees],['资金费率净收支',frame.funding],['止损次数',visibleFrames?.filter(f=>f.events.some(e=>e.kind==='STOP')).length],
        ['最大单笔盈利',ended?result.best??undefined:undefined],['最大单笔亏损',ended?result.worst??undefined:undefined]] as const)
        .map(([label,v])=><div key={label}><small>{label}</small><b>{money(v)}</b></div>)}
       </div>
       <EquityChart values={visibleFrames?.map(f=>f.equity)??[]} capital={config.capital}/>
       <div className="grid-order-table"><table><thead><tr>{['交易对','方向','开仓时间／价格','平仓时间／价格','数量','手续费','资金费','毛盈亏','净盈亏','退出原因'].map(h=><th key={h}>{h}</th>)}</tr></thead>
        <tbody>{closedRows.slice(-100).reverse().map(x=><tr key={x.id}><td>{market.symbol}</td><td>{x.side==='LONG'?'多':'空'}</td>
         <td>{fullTime.format(x.openedAt)} / {x.entry}</td><td>{fullTime.format(x.closedAt)} / {x.exit}</td><td>{x.qty}</td>
         <td>{money(x.fees)}</td><td>{money(x.funding)}</td><td>{money(x.gross)}</td><td>{money(x.net)}</td><td>{reason[x.reason]??x.reason}</td></tr>)}</tbody></table></div>
       {!closedRows.length&&<p>目前没有已完成交易。</p>}{closedRows.length>100&&<p>表格显示最近 100 笔，导出包含全部成交。</p>}
       {ended&&result.state==='PAUSED'&&<button type="button" onClick={continueFromPause}>以当前权益开始下一箱体</button>}
      </>}
     </section>}
    </div>
    <fieldset className="grid-side" disabled={busy}>
     <Card title="网格参数">
      <div className="grid-form">
       <Pick label="方向" value={config.direction} options={([['SHORT','只做空'],['LONG','只做多'],['NEUTRAL','中性']])} change={v=>change('direction',v as GridConfig['direction'])}/>
       <Pick label="间距" value={config.spacing} options={([['LINEAR','等差'],['GEOMETRIC','等比']])} change={v=>change('spacing',v as GridConfig['spacing'])}/>
       <NumberField label="上限" value={drawings.upper} onChange={n=>box('upper',n)} step={Number(market.rules.tick)}/>
       <NumberField label="下限" value={drawings.lower} onChange={n=>box('lower',n)} step={Number(market.rules.tick)}/>
       <NumberField label="网格数量" value={config.count} onChange={n=>change('count',n)} min={2} step={1}/>
       <NumberField label="初始资金（USDT）" value={config.capital} onChange={n=>change('capital',n)}/>
       <NumberField label="杠杆倍数" value={config.leverage} onChange={n=>change('leverage',n)} min={1} step={1}/>
       <NumberField label="最大仓位数" value={config.maxPositions} onChange={n=>change('maxPositions',n)} min={1} step={1}/>
       <Pick label="每格单位" value={config.sizeMode} options={([['MARGIN','保证金 USDT'],['QUANTITY','合约数量']])} change={v=>change('sizeMode',v as GridConfig['sizeMode'])}/>
       <NumberField label="每格用量" value={config.size} onChange={n=>change('size',n)}/>
      </div>
      {levels.length>0&&<p className="grid-level-info">生成 {levels.length-1} 格 · {levels[0]} – {levels.at(-1)}</p>}
      <label className="grid-check"><input type="checkbox" checked={precise} onChange={e=>setPrecise(e.target.checked)}/>优先使用 1m 成交回放</label>
      <button className="grid-main-action grid-start" type="button" disabled={busy||!levels.length} onClick={()=>void run()}><Play size={17}/>开始模拟</button>
     </Card>
     <Card title="风控与费用" open={false}>
      <div className="grid-form">
       <Pick label="向上突破" value={config.up} options={breakoutChoices} change={v=>change('up',v as GridConfig['up'])}/>
       <Pick label="向下突破" value={config.down} options={breakoutChoices} change={v=>change('down',v as GridConfig['down'])}/>
       {([['stopUpper','上侧硬止损'],['stopLower','下侧硬止损'],['maxLoss','最大亏损 USDT'],['drawdown','最大回撤 %'],
        ['trailing','移动止盈 %'],['maker','Maker %'],['taker','Taker %'],['slippage','市价滑点 %'],['maintenance','维持保证金率 %']] as const)
        .map(([k,label])=><NumberField key={k} label={label} value={config[k]} onChange={n=>change(k,n)}/>)}
       <Pick label="资金费率" value={config.fundingMode} options={([['HISTORY','历史费率'],['FIXED','自定义（8h）'],['OFF','关闭']])}
        change={v=>change('fundingMode',v as GridConfig['fundingMode'])}/>
       {config.fundingMode==='FIXED'&&<NumberField label="自定义资金费率 %" min={-10} value={config.fundingRate} onChange={n=>change('fundingRate',n)}/>}
      </div><label className="grid-check"><input type="checkbox" checked={config.disableOnBreak} onChange={e=>change('disableOnBreak',e.target.checked)}/>突破后停止新单</label>
     </Card>
     <Card title="回放账户">
      <div className="grid-account-facts">{([['本金',config.capital],['现价',frame?.price],['权益',frame?.equity],['可用保证金',frame?.available],
       ['已用保证金',frame?.margin],['已实现盈亏（毛）',frame?.realized],['浮动盈亏',frame?.floating],['扣费后净收益',frame?.net],
       ['持仓数',frame?.open.length],['已完成／盈利交易',frame?frame.done+' / '+frame.wins:undefined],['最大回撤 %',frame?.drawdown],
       ['手续费',frame?.fees],['资金费',frame?.funding]] as const).map(([label,value])=><div key={label}><small>{label}</small><b>{typeof value==='string'?value:money(value)}</b></div>)}</div>
      {frame?.open.map(p=><p key={p.id} className="grid-position">{p.side==='LONG'?'多':'空'} · {p.qty} @ {p.entry}</p>)}
      {!!recent.length&&<div className="grid-events" aria-label="近期模拟成交"><b>最新事件</b>{recent.map((e,i)=><p key={i}>{fullTime.format(e.time)} · {reason[e.kind]} · {e.price}
       {e.net!==undefined?' · '+money(e.net)+' USDT':''}{e.reason?' · '+(reason[e.reason]??e.reason):''}</p>)}</div>}
     </Card>
    </fieldset>
   </div>
  </>}
 </section>;
}
