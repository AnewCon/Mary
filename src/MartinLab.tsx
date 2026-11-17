import { useEffect, useMemo, useRef, useState } from 'react';
import { Calculator, Play, Pause, RefreshCw } from 'lucide-react';
import GridChart,{fullTime,type ReferenceLine} from './GridChart';
import {priceFormat,snapPrice,type GridMarket} from './grid-engine';
import {beijingInput,beijingMidnight,day,loadMarket,parseBeijing} from './grid-market-client';
import {martinDefaults,planMartin,simulateMartin,type MartinConfig,type MartinSnapshot} from './martin-engine';
import './grid-lab.css';
import './martin-lab.css';

type Api=(path:string)=>Promise<unknown>;
const actualMoney=(v:number)=>v.toLocaleString('zh-CN',{maximumFractionDigits:4});
const labels={ADD:'模拟补仓',TAKE_PROFIT:'止盈',STOP_LOSS:'止损',LOSS_LIMIT:'亏损上限',ESTIMATED_LIQUIDATION:'预估强平'};
const errorText:Record<string,string>={GRID_SYMBOL_NOT_FOUND:'未找到该 USDT 永续合约。',GRID_CONTRACT_NOT_TRADING:'该合约当前不可交易。',
 GRID_NO_CLOSED_CANDLES:'所选时间内没有已收盘 K 线。',GRID_INVALID_RANGE:'请选择有效的北京时间范围。',
 GRID_KLINE_GAPS:'历史 K 线有缺口，请更换时段。',GRID_INVALID_SYMBOL:'请输入交易对，例如 AKEUSDT。'};
const issue=(err:unknown)=>errorText[(err as Error).message]??(err as Error).message;
const rangeOf=(preset:string)=>{
 const now=Date.now(),today=beijingMidnight(now);
 return {preset,from:beijingInput(preset==='yesterday'?today-day:preset==='3d'?today-2*day:today),
  to:beijingInput(preset==='yesterday'?today:now)};
};

const fieldList=[
 ['entry','首次开仓价'],['quantity','已有空单数量'],['margin','已有仓位保证金 USDT'],['reserve','可用于补仓的余额 USDT'],
 ['leverage','补仓杠杆'],['maxAdds','最多补仓次数'],['maxQuantity','最大累计数量'],['maxLoss','最大允许亏损 USDT'],
 ['take','止盈价（0 关闭）'],['stop','止损价（0 关闭）'],
 ['fee','单边手续费 %'],['slip','滑点 %'],['maintenance','维持保证金率 %']
] as const;

function Facts({s,price}:{s:MartinSnapshot;price:(x:number|null)=>string}){
 return <dl className="martin-facts">
 {([['持仓数量',actualMoney(s.quantity)],['持仓均价',s.quantity?price(s.average):'—'],['保证金',actualMoney(s.margin)],
 ['补仓可用余额',actualMoney(Math.max(0,s.reserve-s.fees))],['浮动盈亏',actualMoney(s.floating)],['假设现在平仓的净盈亏',actualMoney(s.netExit)],
 ['净回本价',price(s.breakEven)],['预估强平价',price(s.liquidation)],['保证金缓冲',actualMoney(s.buffer)],
 ['模型权益',actualMoney(s.equity)]] as const).map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
 </dl>;
}

export default function MartinLab({api}:{api:Api}){
 const [symbol,setSymbol]=useState('AKEUSDT'),[range,setRange]=useState(()=>rangeOf('today')),[market,setMarket]=useState<GridMarket|null>(null);
 const [config,setConfig]=useState<MartinConfig>(martinDefaults),[triggers,setTriggers]=useState<number[]>([]),[mark,setMark]=useState(0);
 const [source,setSource]=useState<GridMarket|null>(null),[replay,setReplay]=useState<ReturnType<typeof simulateMartin>|null>(null);
 const [cursor,setCursor]=useState(0),[playing,setPlaying]=useState(false),[speed,setSpeed]=useState(10),[precise,setPrecise]=useState(true);
 const [loading,setLoading]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [showRisk,setShowRisk]=useState(true);
 const request=useRef(0);
 const marketPrice=(value:number|null)=>value!==null&&Number.isFinite(value)&&market?priceFormat(value,market.rules.tick):'—';
 const clear=()=>{setReplay(null);setSource(null);setCursor(0);setPlaying(false);};
 function change(key:keyof MartinConfig,value:number){
  setConfig(c=>({...c,[key]:value}));
  if(replay)clear();
 }
 async function candles(){
  const id=++request.current;
  clear();setError('');setNotice('');setLoading(true);
  try{
   const data=await loadMarket(api,symbol,parseBeijing(range.from),parseBeijing(range.to),'15m');
   if(request.current!==id)return;
   const first=data.candles[0],last=data.candles.at(-1)!;
   setSymbol(data.symbol);setMarket(data);setMark(last.close);
   if(data.symbol!==market?.symbol){
    setConfig(c=>({...c,entry:first.open,take:0,stop:0}));
    setTriggers([]);
   }
  }catch(err){if(request.current===id){setMarket(null);setError(issue(err));}}
  finally{if(request.current===id)setLoading(false);}
 }
 const analysis=useMemo(()=>{
  if(!market)return null;
  try{return {data:planMartin(config,market,triggers,mark),error:''};}
  catch(err){return {data:null,error:issue(err)};}
 },[config,market,triggers,mark]);
 const calc=analysis?.data;
 const snapshot=replay?.snapshots[cursor-1];
 const displaySnapshot=replay?snapshot:calc?.current;
 const visible=source&&replay?source.candles.slice(0,cursor):market?.candles??[];
 const ended=!!replay&&cursor>=replay.frames.length;
 useEffect(()=>{
  if(!playing||!replay)return;
  const timer=window.setInterval(()=>setCursor(i=>Math.min(replay.frames.length,i+(speed===50?5:1))),Math.max(50,500/Math.min(speed,10)));
  return ()=>clearInterval(timer);
 },[playing,replay,speed]);
 useEffect(()=>{if(ended)setPlaying(false);},[ended]);
 function propose(){
  if(!market||!calc)return;
  const beyond=Math.max(config.entry,mark,triggers.at(-1)??0);
  const raw=beyond*(1+Math.max(6,calc.vol.up??0)/100);
  const next=snapPrice(raw,market.rules);
  setTriggers(previous=>[...previous,Math.min(market.rules.maxPrice,next)]);clear();
 }
 function level(index:number,value:number){
  if(!market)return;
  const trimmed=Math.min(market.rules.maxPrice,Math.max(Number(market.rules.tick),value));
  setTriggers(p=>p.map((v,i)=>i===index?snapPrice(trimmed,market.rules):v));
 }
 async function run(){
  if(!market)return;
  const id=++request.current;
  setError('');setNotice('');setLoading(true);setPlaying(false);
  try{
   let next=market;
   if(precise&&market.to-market.from<=7*day){
    try{next=await loadMarket(api,market.symbol,market.from,market.to,'1m');}
    catch(err){setNotice('1 分钟数据不可用，按 15 分钟保守回放。'+issue(err));}
   }else if(precise)setNotice('1 分钟查询最长 7 天，本次按 15 分钟保守回放。');
   if(id!==request.current)return;
   const output=simulateMartin(config,next,triggers);
   setSource(next);setReplay(output);setCursor(1);setPlaying(true);
  }catch(err){if(id===request.current)setError(issue(err));}
  finally{if(id===request.current)setLoading(false);}
 }
 const references:ReferenceLine[]=[];
 function line(id:string,label:string,n:number|null,color:string,draggable=false){
  if(n!==null&&Number.isFinite(n)&&n>0)references.push({id,label,price:n,color,draggable});
 }
 if(market){
  line('entry','首次开仓',config.entry,'#91c4f0',true);
  if(displaySnapshot?.quantity){
   line('avg','持仓均价',displaySnapshot.average,'#d5b8f3');
   if(showRisk){line('breakeven','净回本',displaySnapshot.breakEven,'#88dcb3');line('liq','预估强平',displaySnapshot.liquidation,'#f79092');}
  }
  line('take','止盈',config.take,'#88dcb3');
  line('stop','止损',config.stop,'#f7ad7b');
  triggers.slice(0,config.maxAdds).forEach((value,i)=>line('add:'+i,'补仓 '+(i+1),value,'#f4cf86',true));
 }
 function drag(id:string,value:number){
  if(!market||loading||replay)return;
  if(id==='entry')change('entry',snapPrice(Math.min(market.rules.maxPrice,Math.max(value,market.rules.minPrice)),market.rules));
  if(id.startsWith('add:'))level(Number(id.slice(4)),value);
 }
 function exportReport(){
  if(!replay||!source||!ended)return;
  const report={symbol:source.symbol,interval:source.interval,from:source.from,to:source.to,config,triggers,result:replay};
  const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download=source.symbol+'-martin-replay.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 return <section className="grid-lab grid-dark martin-lab">
  <header className="martin-head"><Calculator size={25}/><div><h2>马丁大师</h2><p>Binance USDⓈ-M · 手动输入已有空单 · 历史模拟</p></div></header>
  <div className="grid-lab-card grid-market-card"><form onSubmit={e=>{e.preventDefault();void candles();}}>
   <label>交易对<input value={symbol} maxLength={24} onChange={e=>setSymbol(e.target.value)} required/></label>
   <label>时间范围（北京时间）<select value={range.preset} onChange={e=>setRange(e.target.value==='custom'?{...range,preset:'custom'}:rangeOf(e.target.value))}>
    <option value="today">今天</option><option value="yesterday">昨天</option><option value="3d">最近 3 天</option><option value="custom">自定义</option>
   </select></label>
   {range.preset==='custom'&&<><label>开始时间<input type="datetime-local" value={range.from} onChange={e=>setRange({...range,from:e.target.value})}/></label>
    <label>结束时间<input type="datetime-local" value={range.to} onChange={e=>setRange({...range,to:e.target.value})}/></label></>}
   <button type="submit" className="grid-main-action" disabled={loading}><RefreshCw size={15}/>获取行情</button>
  </form>
  {loading&&<p role="status">加载历史行情…</p>}{error&&<p role="alert" className="grid-error">{error}</p>}{notice&&<p role="status">{notice}</p>}</div>
  {market&&<>
   <div className="grid-terminal">
    <div className="grid-main-column">
     <section className="grid-lab-card">
      <div className="grid-chart-top"><b>{market.symbol} · {source?.interval??'15m'} · {snapshot?fullTime.format(snapshot.time):'北京时间'}</b>
       <label className="grid-check"><input type="checkbox" checked={showRisk} onChange={e=>setShowRisk(e.target.checked)}/>显示回本与强平参考线</label></div>
      <GridChart key={market.symbol+market.from+(replay?'replay':'market')} bars={visible} tick={market.rules.tick} step={source?.step??market.step}
       levels={[]} stops={[]} lines={[]} selected={null} locked={!!replay||loading} tool="PAN" anchor={null}
       frame={replay?.frames[cursor-1]} frames={replay?.frames.slice(0,cursor)} onPrice={()=>{}} onSelect={()=>{}} onDrag={()=>{}} onSegment={()=>{}}
       referenceLines={references} onReferenceDrag={drag}/>
      <p className="grid-level-info">按住蓝色开仓线或金色补仓线拖动。回放行情为历史交易价，成交与强平为模型估算。</p>
      {replay&&<div className="grid-replay">
       <button type="button" onClick={()=>{if(ended)setCursor(1);setPlaying(x=>!x);}}>{playing?<Pause size={15}/>:<Play size={15}/>} {playing?'暂停':'播放'}</button>
       <button type="button" onClick={()=>{setPlaying(false);setCursor(x=>Math.max(1,x-1));}}>上一步</button>
       <button type="button" onClick={()=>{setPlaying(false);setCursor(x=>Math.min(replay.frames.length,x+1));}}>下一步</button>
       <select aria-label="播放速度" value={speed} onChange={e=>setSpeed(Number(e.target.value))}>{[1,2,5,10,50].map(x=><option key={x} value={x}>{x}×</option>)}</select>
       <input aria-label="马丁回放进度" type="range" min={1} max={replay.frames.length} value={cursor} onChange={e=>{setPlaying(false);setCursor(Number(e.target.value));}}/>
       <span>{cursor} / {replay.frames.length}</span><button type="button" onClick={clear}>返回配置</button></div>}
     </section>
     {replay&&snapshot?<section className="grid-lab-card grid-ledger" aria-label="马丁回放报告">
      <div className="grid-chart-top"><h3>{ended?'马丁回放报告':'马丁回放记录'}</h3><button type="button" disabled={!ended} onClick={exportReport}>导出报告</button></div>
      <Facts s={snapshot} price={marketPrice}/>
      <p>已实现净盈亏 {snapshot.realized===null?'持仓中':actualMoney(snapshot.realized)+' USDT'} · 已扣费用 {actualMoney(snapshot.fees)} USDT
       · 区间最大回撤 {actualMoney(replay.frames[cursor-1].drawdown)}%</p>
      {snapshot.blocked&&<p>不建议继续补仓。{snapshot.blocked}。</p>}
      <div className="grid-order-table"><table><thead><tr><th>北京时间</th><th>事件</th><th>触发价</th><th>模型成交价</th><th>数量</th><th>费用</th><th>净盈亏</th></tr></thead>
       <tbody>{replay.events.slice(0,snapshot.eventCount).map((e,i)=><tr key={i}><td>{fullTime.format(e.time)}</td><td>{labels[e.kind]}</td>
        <td>{marketPrice(e.trigger)}</td><td>{marketPrice(e.fill)}</td><td>{actualMoney(e.quantity)}</td><td>{actualMoney(e.fee)}</td><td>{e.net===null?'—':actualMoney(e.net)}</td></tr>)}</tbody></table></div>
      <details><summary>资金变化</summary><div className="grid-order-table"><table><thead><tr><th>时间</th><th>权益 USDT</th><th>保证金 USDT</th><th>空单均价</th></tr></thead>
       <tbody>{replay.snapshots.slice(Math.max(0,cursor-50),cursor).map(s=><tr key={s.time}><td>{fullTime.format(s.time)}</td><td>{actualMoney(s.equity)}</td><td>{actualMoney(s.margin)}</td><td>{s.quantity?marketPrice(s.average):'—'}</td></tr>)}</tbody></table></div>
       <p>页面显示最近 50 根回放数据，导出包含完整权益记录。</p></details>
     </section>:calc&&<section className="grid-lab-card grid-ledger" aria-label="空单压力测试">
      <h3>空单压力测试</h3><p>已有空单以 {marketPrice(mark)} 为参考价。已收盘 15m 样本 {calc.vol.count} 根，最大盘中涨幅 {calc.vol.up?.toFixed(2)??'—'}%。</p>
      <Facts s={calc.current} price={marketPrice}/>
      <div className="grid-order-table"><table><thead><tr><th>上涨情景</th><th>压力价</th><th>浮亏／浮盈</th><th>净平仓盈亏</th><th>保证金缓冲</th><th>强平风险</th></tr></thead>
       <tbody>{calc.scenarios.map(s=><tr key={s.shock}><td>+{s.shock}%</td><td>{marketPrice(s.price)}</td><td>{actualMoney(s.floating)}</td><td>{actualMoney(s.netExit)}</td>
        <td>{actualMoney(s.buffer)}</td><td>{s.buffer<=0?'触及参考线':'仍有缓冲'}</td></tr>)}</tbody></table></div>
      <h3>逐档补仓测算</h3>
      <div className="grid-order-table"><table><thead><tr><th>补仓价</th><th>可补数量</th><th>模型成交价</th><th>补后均价</th><th>净回本</th><th>预估强平</th><th>压力价</th></tr></thead>
       <tbody>{calc.stages.map(({trigger,item,after},i)=><tr key={i}><td>{marketPrice(trigger)}</td>
        {item.status==='OK'?<><td>{actualMoney(item.quantity)}</td><td>{marketPrice(item.fill)}</td><td>{marketPrice(after.average)}</td>
         <td>{marketPrice(after.breakEven)}</td><td>{marketPrice(after.liquidation)}</td><td>{marketPrice(item.stressPrice)}</td></>:
        <td colSpan={6}>不建议继续补仓。{item.reason}。</td>}</tr>)}</tbody></table></div>
      {!calc.stages.length&&<p>添加一档补仓线后查看测算。</p>}
     </section>}
    </div>
    <fieldset className="grid-side" disabled={loading}>
     <section className="grid-lab-card"><h3>已有空单</h3>
      <div className="grid-form">
       {fieldList.map(([key,label])=><label key={key}>{label}<input type="number" step="any" value={config[key]||''}
        onChange={e=>change(key,Number(e.target.value))}/></label>)}
       <label>压力涨幅<select value={config.shock} onChange={e=>change('shock',Number(e.target.value))}>
        {[10,20,30,50].map(v=><option key={v} value={v}>{v}%</option>)}</select></label>
       <label>当前参考价<input type="number" min="0" step="any" value={mark||''} onChange={e=>setMark(Number(e.target.value))}/></label>
      </div>
      {analysis?.error&&<p role="alert" className="grid-error">{analysis.error}</p>}
     </section>
     <section className="grid-lab-card"><h3>补仓线</h3>
      <div className="martin-triggers">{triggers.map((v,i)=><div key={i}><label>补仓 {i+1}<input type="number" min="0" step="any" value={v||''}
       onChange={e=>{const n=Number(e.target.value);setTriggers(p=>p.map((price,j)=>i===j?n:price));if(replay)clear();}}
       onBlur={e=>{if(Number(e.currentTarget.value)>0)level(i,Number(e.currentTarget.value));}}/></label>
       <button type="button" aria-label={'删除补仓 '+(i+1)} onClick={()=>{setTriggers(p=>p.filter((_,j)=>j!==i));clear();}}>删除</button></div>)}</div>
      <button type="button" disabled={!calc||triggers.length>=config.maxAdds} onClick={propose}>添加补仓线</button>
      <label className="grid-check"><input type="checkbox" checked={precise} onChange={e=>setPrecise(e.target.checked)}/>优先使用 1m 历史回放</label>
      <button className="grid-main-action grid-start" type="button" disabled={!calc||loading} onClick={()=>void run()}><Play size={16}/>历史模拟</button>
     </section>
     <p className="martin-note">仓位、保证金和费率由你输入。强平模型采用单一逐仓维持保证金率和历史交易价代理，未接入正式档位、标记价和资金费率。当 K 线同时触及止损与止盈，优先处理不利事件。</p>
    </fieldset>
   </div>
  </>}
 </section>;
}
