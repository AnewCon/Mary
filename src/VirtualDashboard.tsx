import { useEffect, useState, type FormEvent } from 'react';
import { ArrowUpRight, Download, RefreshCw, Snowflake } from 'lucide-react';
import EquityAnimation from './EquityAnimation';
import './virtual-dashboard.css';

type Api=(path:string,body?:unknown)=>Promise<any>;
const money=(value:unknown)=>value==null?'—':Number(value).toLocaleString('en-US',{maximumFractionDigits:6});
const rate=(value:unknown)=>value==null?'—':Number(value).toLocaleString('zh-CN',{style:'percent',maximumFractionDigits:2});
const time=(value:number|null)=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'—';
const tone=(value:string)=>Number(value)<0?'red':Number(value)>0?'green':'';
const kinds:Record<string,string>={OPEN:'虚拟开仓',TAKE_PROFIT:'分档止盈',STOP_LOSS:'统一止损',MANUAL_CLOSE:'手动平仓',MARGIN_EXHAUSTED:'模拟保证金耗尽',UPDATE_PROTECTION:'修改保护'};
const columns=['合约 / 方向','决策价 / 成交价','最新成交价','杠杆 / 保证金','浮动盈亏 / 收益率','已实现净收益','剩余 / 名义价值','策略 / 开仓','操作'];

export default function VirtualDashboard({api,page,accountId,onAccount,onSettings}:{api:Api;page:number;accountId:string;onAccount:(id:string)=>void;onSettings:()=>void}) {
  const [portfolio,setPortfolio]=useState<any>(null),[accounts,setAccounts]=useState<any[]>([]);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[selected,setSelected]=useState<string|null>(null);
  const [revision,setRevision]=useState(0);
  useEffect(()=>{
    let live=true;
    async function load(){try{
      const [a,p]=await Promise.all([api('/virtual/accounts'),api('/virtual/portfolio?accountId='+encodeURIComponent(accountId))]);
      if(live){setAccounts(a);setPortfolio(p)}
    }catch(err){if(live)setError((err as Error).message)}}
    void load();const timer=setInterval(load,60000);
    return()=>{live=false;clearInterval(timer)};
  },[accountId,revision,api]);
  async function run(work:()=>Promise<void>){
    setBusy(true);setError('');
    try{await work();setRevision(value=>value+1)}catch(err){setError((err as Error).message)}finally{setBusy(false)}
  }
  const p=portfolio?.account.id===accountId?portfolio:null;
  const a=p?.account;
  const marketError=p?.market?.filter((row:any)=>row.error);
  const daily=p?{currencies:[{currency:'USDT',...p.today}],updatedAt:new Date().toISOString(),complete:true,error:null}:undefined;
  return <>
    <div className="virtual-controls">
      <label>实验账户 <select value={accountId} onChange={event=>{setError('');setSelected(null);onAccount(event.target.value)}}>
        {accounts.length?accounts.map(account=><option key={account.id} value={account.id}>{account.name}</option>):<option value={accountId}>载入中</option>}
      </select></label>
      <button className="primary" disabled={busy} onClick={()=>void run(async()=>{
        const outcome=await api('/virtual/refresh',{});
        if(outcome.market.some((row:any)=>row.error))setError('部分合约行情待补齐，请查看下方行情状态。');
      })}><RefreshCw size={15}/>{busy?'处理中…':'刷新行情与结算'}</button>
    </div>
    {error&&<div className="alert" role="alert">{error}</div>}
    {!!marketError?.length&&<div className="alert" role="status">行情待补齐 · {marketError.map((row:any)=>`${row.symbol} ${row.error}`).join(' · ')}</div>}
    {!p&&<div className="panel empty">正在读取虚拟账本</div>}
    {p&&page===0&&<>
      <section className="hero virtual-hero">
        <div className="heroart" aria-hidden="true"/>
        <div className="herotext"><div className="eyebrow"><span className="pulse"/> BINANCE USDⓈ-M</div>
          <h3 className="winter-title">风雪在外，<br/>心里有数。</h3>
          <h2>{money(p.equity)} <span>USDT</span></h2><p>虚拟账户总权益</p>
          <div className="herobadges"><span><Snowflake size={14}/> 每分钟服务端结算</span><span>行情时间 {time(p.latestMarketTime)}</span></div>
        </div>
      </section>
      <EquityAnimation today={daily} capital={a.initial} onConfigure={onSettings}/>
      <div className="metrics virtual-metrics">{[
        ['初始本金',a.initial],['可用余额',p.available],['已用保证金',p.usedMargin],['当前持仓',p.positionCount],
        ['今日净收益',p.today.net],['今日赚取',p.today.earned],['今日亏损',p.today.lost],['浮动盈亏',p.unrealized],
        ['已实现盈亏',a.realized],['累计净收益',p.net],['累计收益率',rate(p.returnRatio)],['最大回撤',rate(a.drawdown)],
      ].map(([label,value],index)=><div className="metric" key={label}><div>{label}</div><b className={index>=4&&index<=9?tone(String(value)):''}>{index>=10?value:money(value)}</b><small>{index===3?'笔':index>=10?'':'USDT'}</small></div>)}</div>
    </>}
    {p&&[0,1].includes(page)&&<section className="panel">
      <div className="panelhead"><div><h2>当前虚拟持仓 <span className="count">{p.positionCount}</span></h2><p>价格来源为币安永续合约最新成交价</p></div></div>
      <PositionTable items={p.positions} onSelect={setSelected}/>
    </section>}
    {p&&page===5&&<VirtualHistory api={api} accountId={accountId} revision={revision} onSelect={setSelected}/>}
    {p&&page===4&&<AccountSettings key={accountId} account={a} busy={busy} onSave={(body)=>run(async()=>{
      if(!window.confirm(body.id?'保存实验账户参数？':'创建独立的虚拟实验账户？'))return;
      const saved=await api('/virtual/accounts',body);onAccount(saved.id);
    })}/>}
    {selected&&<PositionDetail key={selected} api={api} id={selected} onClose={()=>setSelected(null)} onChange={()=>setRevision(value=>value+1)}/>}
  </>;
}

function PositionTable({items,onSelect}:{items:any[];onSelect:(id:string)=>void}) {
  if(!items.length)return <div className="empty"><Snowflake size={24}/><p>当前没有记录</p></div>;
  return <div className="tablewrap"><table><thead><tr>{columns.map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>
    {items.map(p=><tr key={p.id}>
      <td><b>{p.symbol}</b><small>{p.direction==='LONG'?'做多':'做空'}</small></td>
      <td>{p.decision.price}<small>成交 {p.entry} · 偏差 {p.priceDifference}</small></td>
      <td>{p.current}<small>{time(p.markTime)}</small></td>
      <td>{p.leverage}×<small>{money(p.locked)} USDT</small></td>
      <td className={tone(p.unrealized)}>{money(p.unrealized)}<small>{rate(p.unrealizedRatio)}</small></td>
      <td className={tone(p.net)}>{money(p.net)}<small>{rate(p.realizedRatio)}</small></td>
      <td>{rate(p.remainingRatio)}<small>{money(p.notional)} USDT</small></td>
      <td>{p.decision.strategy}<small>{time(p.openedAt)}</small></td>
      <td><button onClick={()=>onSelect(p.id)}>详情 <ArrowUpRight size={13}/></button></td>
    </tr>)}
  </tbody></table></div>;
}

function VirtualHistory({api,accountId,revision,onSelect}:{api:Api;accountId:string;revision:number;onSelect:(id:string)=>void}) {
  const [filter,setFilter]=useState({symbol:'',direction:'',strategy:'',result:'',reason:'',from:'',to:''});
  const [report,setReport]=useState<any>(null),[stats,setStats]=useState<any>(null),[error,setError]=useState(''),[exporting,setExporting]=useState(false);
  const search=new URLSearchParams({accountId});
  for(const [key,value] of Object.entries(filter)){
    if(!value)continue;
    if(key==='from'||key==='to')search.set(key,String(Date.parse(value+(key==='from'?'T00:00:00.000+08:00':'T23:59:59.999+08:00'))));
    else search.set(key,value.trim());
  }
  const url='/virtual/history?'+search;
  useEffect(()=>{
    let live=true;
    api(url).then(value=>{if(live){setReport(value);setError('')}}).catch(err=>{if(live)setError(err.message)});
    return()=>{live=false};
  },[api,url,revision]);
  useEffect(()=>{let live=true;api('/virtual/stats?accountId='+accountId).then(value=>{if(live)setStats(value)}).catch(err=>{if(live)setError(err.message)});return()=>{live=false}},[api,accountId,revision]);
  async function exportCsv(){
    setExporting(true);
    try{
      const rows=[['仓位ID','合约','方向','策略','决策价','模拟成交价','开仓时间','平仓时间','净收益USDT','手续费USDT']];
      let cursor:string|null=null;
      do{
        const data=await api(url+(cursor?'&cursor='+encodeURIComponent(cursor):''));
        for(const p of data.items)rows.push([p.id,p.symbol,p.direction,p.decision.strategy,p.decision.price,p.entry,time(p.openedAt),time(p.closedAt),p.net,p.fees]);
        cursor=data.nextCursor;
      }while(cursor);
      const value=(cell:string)=>'"'+( /^[=+@\-]/.test(cell)&&! /^-?\d+(\.\d+)?$/.test(cell)?"'"+cell:cell).replaceAll('"','""')+'"';
      const blob=URL.createObjectURL(new Blob(['\ufeff',rows.map(row=>row.map(value).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
      const a=document.createElement('a');a.href=blob;a.download='QuantOS-virtual-history.csv';a.click();setTimeout(()=>URL.revokeObjectURL(blob),1000);
    }catch(err){setError((err as Error).message)}finally{setExporting(false)}
  }
  return <>
    {stats&&<div className="metrics virtual-metrics">{[['已平仓',stats.count],['胜率',rate(stats.winRate)],['交易期望 USDT',money(stats.expectancy)],['平均盈利 / 亏损',money(stats.averageGain)+' / '+money(stats.averageLoss)],['盈亏比',money(stats.payoffRatio)],['最大回撤',rate(stats.drawdown)]].map(([label,value])=><div className="metric" key={label}><div>{label}</div><b>{value}</b></div>)}</div>}
    <section className="panel"><div className="panelhead"><h2>虚拟交易历史</h2><button disabled={exporting} onClick={()=>void exportCsv()}><Download size={15}/> {exporting?'正在导出':'导出 CSV'}</button></div>
      <div className="virtual-filters">
        {([['symbol','币种'],['strategy','策略版本'],['from','开始日期'],['to','结束日期']] as const).map(([key,label])=><label key={key}>{label}<input type={key==='from'||key==='to'?'date':'text'} value={filter[key]} onChange={event=>setFilter({...filter,[key]:event.target.value})}/></label>)}
        <label>方向<select value={filter.direction} onChange={event=>setFilter({...filter,direction:event.target.value})}><option value="">全部</option><option value="LONG">做多</option><option value="SHORT">做空</option></select></label>
        <label>盈亏<select value={filter.result} onChange={event=>setFilter({...filter,result:event.target.value})}><option value="">全部</option><option value="win">盈利</option><option value="loss">亏损</option></select></label>
        <label>平仓原因<select value={filter.reason} onChange={event=>setFilter({...filter,reason:event.target.value})}><option value="">全部</option>{['TAKE_PROFIT','STOP_LOSS','MANUAL_CLOSE','MARGIN_EXHAUSTED'].map(key=><option key={key} value={key}>{kinds[key]}</option>)}</select></label>
      </div>
      {error&&<div className="alert">{error}</div>}<PositionTable items={report?.items??[]} onSelect={onSelect}/>
      {report?.nextCursor&&<div className="history-footer"><button onClick={()=>void api(url+'&cursor='+encodeURIComponent(report.nextCursor)).then(data=>setReport({...data,items:[...report.items,...data.items]})).catch(err=>setError(err.message))}>加载更多</button></div>}
    </section>
    {!!stats?.groups?.length&&<section className="panel"><div className="panelhead"><h2>分组表现</h2>{stats.truncated&&<p>最近 1,000 笔</p>}</div><div className="tablewrap"><table><thead><tr><th>维度</th><th>名称</th><th>笔数</th><th>胜率</th><th>净收益</th></tr></thead><tbody>{stats.groups.map((g:any)=><tr key={g.dimension+g.key}><td>{{symbol:'币种',direction:'多空',strategy:'策略',hour:'开仓小时'}[g.dimension as 'symbol']}</td><td>{g.key}</td><td>{g.count}</td><td>{rate(g.winRate)}</td><td>{money(g.net)}</td></tr>)}</tbody></table></div></section>}
  </>;
}

function AccountSettings({account,busy,onSave}:{account:any;busy:boolean;onSave:(data:any)=>void}) {
  const [create,setCreate]=useState(false);
  function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();const form=new FormData(event.currentTarget);
    onSave({...(create?{}:{id:account.id}),name:form.get('name'),initial:form.get('initial'),feeBps:Number(form.get('fee')),slipBps:Number(form.get('slip')),deviationBps:Number(form.get('deviation'))});
  }
  return <section className="panel settings"><h2>虚拟实验账户</h2><div className="actions"><button type="button" onClick={()=>setCreate(false)}>调整当前账户</button><button type="button" onClick={()=>setCreate(true)}>新建实验账户</button></div>
    <form key={String(create)} className="virtual-filters" onSubmit={submit}>
      <label>账户名称<input name="name" required maxLength={60} defaultValue={create?'新实验':account.name}/></label>
      <label>初始本金 USDT<input name="initial" required type="number" step="0.01" min="0.01" defaultValue={create?'80':account.initial}/></label>
      <label>手续费 基点<input name="fee" required type="number" min="0" max="100" defaultValue={account.fee_bps}/></label>
      <label>滑点 基点<input name="slip" required type="number" min="0" max="100" defaultValue={account.slip_bps}/></label>
      <label>允许成交偏差 基点<input name="deviation" required type="number" min="1" max="500" defaultValue={account.deviation_bps}/></label>
      <button className="primary" disabled={busy}>{create?'创建账户':'保存设置'}</button>
    </form><p>开仓后如需调整初始本金，可另建实验账户。手续费和滑点设置用于后续开仓。</p>
  </section>;
}

function PositionDetail({api,id,onClose,onChange}:{api:Api;id:string;onClose:()=>void;onChange:()=>void}) {
  const [detail,setDetail]=useState<any>(null),[market,setMarket]=useState<any>(null),[error,setError]=useState(''),[chartError,setChartError]=useState(''),[busy,setBusy]=useState(false),[edit,setEdit]=useState(false);
  const [pending,setPending]=useState<any>(null);
  const load=()=>api('/virtual/position?id='+id).then(setDetail);
  useEffect(()=>{let live=true;api('/virtual/position?id='+id).then(async data=>{
    if(!live)return;setDetail(data);
    try{const chart=await api('/virtual/market?symbol='+encodeURIComponent(data.position.symbol));if(live)setMarket(chart)}catch(err){if(live)setChartError((err as Error).message)}
  }).catch(err=>{if(live)setError(err.message)});return()=>{live=false}},[api,id]);
  async function execute(data:any){
    setError('');setBusy(true);setPending(data);
    try{await api('/virtual/trade',data);setPending(null);await load();onChange();setEdit(false)}catch(err){setError((err as Error).message)}finally{setBusy(false)}
  }
  const p=detail?.position;
  return <div className="overlay"><section className="panel dialog virtual-detail" role="dialog" aria-modal="true" aria-label="虚拟仓位详情">
    <div className="virtual-controls"><h2>{p?.symbol??'仓位详情'} {p?.direction}</h2><button onClick={onClose}>关闭</button></div>
    {error&&<div role="alert" className="alert">{error}</div>}
    {pending&&<div className="actions"><button disabled={busy} onClick={()=>void execute(pending)}>用原请求重试</button><button disabled={busy} onClick={()=>setPending(null)}>返回</button></div>}
    {p&&<>
      <p>{p.decision.strategy} · {time(p.openedAt)} · 行情时间 {time(p.marketTime)}</p>
      <p className="virtual-reason">{p.decision.reason}</p>
      <div className="virtual-summary"><span>决策价 {p.decision.price}</span><span>模拟成交 {p.entry}</span><span>成交偏差 {p.priceDifference}</span><span>最新价 {p.current}</span><span>最大浮盈 {money(p.mfe)}</span><span>最大浮亏 {money(p.mae)}</span><span>累计手续费 {money(p.fees)}</span><span className={tone(p.net)}>净收益 {money(p.net)}</span></div>
      {Object.keys(p.decision.analysis).length>0&&<details><summary>开仓分析</summary><pre>{JSON.stringify(p.decision.analysis,null,2)}</pre></details>}
      {market?.intraday?.length>0?<PriceChart bars={market.intraday} position={p}/>:chartError&&<p>15 分钟行情暂不可用 · {chartError}</p>}
      <h3>保护规则</h3><p>统一止损 {p.stopLoss} · 剩余 {rate(p.remainingRatio)}</p>
      <ul>{p.tiers.map((tier:any,i:number)=><li key={i}>{tier.price} · {tier.percent}% · {Number(tier.filled)>0?'已止盈 '+tier.filled:p.closedAt?'已结束':'等待触发'}</li>)}</ul>
      <h3>成交时间线</h3><ol className="virtual-events">{detail.events.map((event:any)=><li key={event.id}><b>{kinds[event.kind]??event.kind}</b> · {time(event.time)}
       {event.kind!=='UPDATE_PROTECTION'&&<small>触发 {event.triggerPrice??'—'} · 行情 {event.price} · 成交 {event.fillPrice} · 数量 {event.quantity} · 已实现 {event.realized} · 手续费 {event.fee} · 剩余 {event.remaining}</small>}
       {event.executionAmbiguity&&<small className="amber">同根 K 线双触发，已按不利方向处理</small>}</li>)}</ol>
      <h3>影子对照</h3><ul>{detail.shadows.map((shadow:any)=><li key={shadow.id}>{shadow.variant==='single'?'单一止盈止损':'宽止损与分批止盈'} · {shadow.closedAt?'已结束':'进行中'} · 净收益 {money(shadow.net)} USDT</li>)}</ul>
      {!p.closedAt&&<div className="actions"><button disabled={busy||!!pending} onClick={()=>setEdit(value=>!value)}>修改止盈止损</button><button className="danger" disabled={busy||!!pending} onClick={()=>{if(window.confirm('确认按最新币安成交价虚拟关闭剩余仓位？'))void execute({action:'CLOSE',positionId:id,requestId:crypto.randomUUID()})}}>虚拟平仓</button></div>}
      {edit&&!p.closedAt&&<form className="virtual-filters" onSubmit={event=>{
        event.preventDefault();const data=new FormData(event.currentTarget);
        const tiers=String(data.get('tiers')).split('\n').filter(line=>line.trim()).map(line=>{const [percent,price]=line.split(',');return {percent:Number(percent),price:price?.trim()}});
        if(window.confirm('确认从当前行情游标起修改剩余仓位的统一止损和止盈档？'))void execute({action:'UPDATE_PROTECTION',positionId:id,requestId:crypto.randomUUID(),stopLoss:data.get('stop'),tiers});
      }}><label>统一止损<input name="stop" required defaultValue={p.stopLoss}/></label><label>止盈档（每行：比例,价格）<textarea name="tiers" required rows={5} defaultValue={p.tiers.map((t:any)=>`${t.percent},${t.price}`).join('\n')}/></label><button className="primary" disabled={busy||!!pending}>保存保护</button></form>}
    </>}
  </section></div>;
}

function PriceChart({bars,position:p}:{bars:any[];position:any}) {
  const lines=[{price:Number(p.entry),name:'开仓',color:'#537984'},{price:Number(p.stopLoss),name:'止损',color:'#a54d61'},...p.tiers.map((tier:any,i:number)=>({price:Number(tier.price),name:'止盈 '+(i+1),color:'#4e805e'}))];
  const min=Math.min(...bars.map(b=>Number(b.low)),...lines.map(l=>l.price));
  const max=Math.max(...bars.map(b=>Number(b.high)),...lines.map(l=>l.price));
  const y=(price:number)=>12+(max-price)/(max-min||1)*150;
  const step=460/bars.length;
  return <div className="virtual-chart"><p>币安成交价 · 已收盘 15 分钟 K 线</p><svg viewBox="0 0 540 178" role="img" aria-label="币安 K 线及开仓止盈止损价格">
    {bars.map((b,i)=>{const x=step*(i+.5),open=y(Number(b.open)),close=y(Number(b.close)),color=close<=open?'#4c8b65':'#bd6875';return <g key={b.time} stroke={color}><line x1={x} x2={x} y1={y(Number(b.high))} y2={y(Number(b.low))}/><rect x={x-step*.27} y={Math.min(open,close)} width={step*.54} height={Math.max(1,Math.abs(open-close))} fill={color}/></g>})}
    {lines.map(line=><g key={line.name}><line x1="0" x2="464" y1={y(line.price)} y2={y(line.price)} stroke={line.color} strokeDasharray="4 3"/><text x="468" y={y(line.price)+4} fill={line.color}>{line.name}</text></g>)}
  </svg></div>;
}
