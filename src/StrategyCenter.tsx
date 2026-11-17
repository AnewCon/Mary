import { useEffect, useRef, useState } from 'react';
import { BookOpen, GitCompare, History, ShieldCheck } from 'lucide-react';
import './strategy-center.css';

type Api=(path:string,body?:unknown)=>Promise<any>;
type Version={strategyId:string;version:string;name:string;state:string;revision:number;contentHash:string;createdAt:number;publishedAt:number|null;activatedAt:number|null;changeNote:string;source:string;document?:string;config?:any;capabilities?:Record<string,string>;environment?:string;softwareVersion?:string};
const stateText:Record<string,string>={DRAFT:'草稿',VALIDATED:'结构已校验',PUBLISHED:'已发布',ACTIVE:'已启用',ARCHIVED:'已归档'};
const eventText:Record<string,string>={CREATE:'创建',EDIT:'编辑',VALIDATED:'校验',PUBLISHED:'发布',ACTIVATE:'启用',ROLLBACK:'回滚'};
const stamp=(value:number|null|undefined)=>value==null?'—':new Date(value).toLocaleString('zh-CN',{hour12:false});
const blank={strategyId:'',version:'',name:'',document:'',config:'{}',changeNote:'',source:'MANUAL',parentVersion:'',revision:0};
const query=(id:string,version:string)=>new URLSearchParams({strategyId:id,version});
const errorText:Record<string,string>={
 STRATEGY_ACTIVE_CHANGED:'启用版本刚刚发生变化，请刷新后重试。',
 STRATEGY_REVISION_OR_STATE_CONFLICT:'草稿已更新，请刷新后重新编辑。',
 STRATEGY_VERSION_CONFLICT:'这个版本号已存在。',
 STRATEGY_INVALID_DRAFT:'草稿字段不完整，或 JSON 中的策略 ID、版本号与表单不一致。'
};
const errorMessage=(err:unknown)=>errorText[(err as Error).message]??(err as Error).message??'请求失败';

export default function StrategyCenter({api}:{api:Api}){
 const [library,setLibrary]=useState<Version[]>([]),[generation,setGeneration]=useState(0);
 const [active,setActive]=useState<Version|null>(null),[selected,setSelected]=useState<Version|null>(null),[current,setCurrent]=useState<Version|null>(null);
 const [history,setHistory]=useState<any[]>([]),[performance,setPerformance]=useState<any>(null);
 const [editor,setEditor]=useState<typeof blank|null>(null),[compare,setCompare]=useState(''),[diff,setDiff]=useState<any>(null);
 const [filter,setFilter]=useState(''),[status,setStatus]=useState(''),[busy,setBusy]=useState(false);
 const [error,setError]=useState(''),[validation,setValidation]=useState<string[]>([]),[notice,setNotice]=useState('');
 const sequence=useRef(0), analysis=useRef(0), importing=useRef(0);
 async function refresh(target?:Version){
  const ordinal=++sequence.current;
  const params=new URLSearchParams({limit:'50'});
  if(filter.trim())params.set('name',filter.trim());if(status)params.set('state',status);
  const [list,enabled]=await Promise.all([api('/strategies/list?'+params),api('/strategies/active').catch(e=>{if(e.message==='STRATEGY_NO_ACTIVE')return null;throw e;})]);
  if(ordinal!==sequence.current)return;
  setLibrary(list.items);setGeneration(list.generation);setActive(enabled);
  setSelected(prior=>target??prior??enabled??list.items[0]??null);
 }
 useEffect(()=>{void refresh().catch(e=>setError(errorMessage(e)));return ()=>{sequence.current++;};},[api,filter,status]);
 useEffect(()=>{
  setCurrent(null);setDiff(null);setCompare('');setHistory([]);setPerformance(null);
  const ordinal=++analysis.current;
  if(!selected)return;
  const params=query(selected.strategyId,selected.version);
  void Promise.all([api('/strategies/get?'+params),api('/strategies/history?'+params),api('/strategies/performance?'+params)]).then(([detail,audit,stats])=>{
   if(ordinal!==analysis.current)return;
   setCurrent(detail);setHistory(audit.items);setPerformance(stats);
  }).catch(e=>{if(ordinal===analysis.current)setError(errorMessage(e));});
  return ()=>{analysis.current++;};
 },[api,selected]);
 async function act(operation:()=>Promise<void>){
  setBusy(true);setError('');setNotice('');
  try{await operation();}catch(err){setError(errorMessage(err));}finally{setBusy(false);}
 }
 function openEditor(row:Version|null,fork=false){
  importing.current++;setValidation([]);setDiff(null);setCompare('');
  if(!row){setEditor({...blank});return;}
  setEditor({strategyId:row.strategyId,version:fork?'':row.version,name:row.name,document:row.document??'',
   config:JSON.stringify(fork?{...row.config,version:''}:row.config,null,2),changeNote:'',source:fork?'FORK':row.source,
   parentVersion:fork?row.version:'',revision:fork?0:row.revision});
 }
 function edit(key:keyof typeof blank,value:string){setEditor(prev=>prev?{...prev,[key]:value}:prev);}
 async function importFile(file:File){
  const request=++importing.current;setValidation([]);setDiff(null);setCompare('');
  if(file.size>36000)throw Error('导入文件超过 36 KB。');
  const raw=await file.text();
  if(request!==importing.current)return;
  if(/\.json$/i.test(file.name)){
   const data=JSON.parse(raw),config=data.config??data;
   if(!config||Array.isArray(config)||typeof config!=='object')throw Error('JSON 文件应包含策略对象。');
   setEditor({...blank,strategyId:config.strategyId??'',version:config.version??'',name:typeof data.name==='string'?data.name:'',
    document:typeof data.document==='string'?data.document:'',config:JSON.stringify(config,null,2),source:'JSON_IMPORT'});
  }else setEditor({...blank,document:raw,source:'MARKDOWN_IMPORT'});
 }
 function config(){
  if(!editor)return null;
  return JSON.parse(editor.config);
 }
 async function save(){
  if(!editor)return;
  const {parentVersion,...fields}=editor;
  const draft=await api('/strategies/'+(editor.revision?'edit':'create'),{...fields,config:config(),...(parentVersion?{parentVersion}:{})});
  importing.current++;setEditor(null);setValidation([]);await refresh(draft);setNotice('草稿已保存。');
 }
 async function transition(op:string,label:string){
  if(!current)return;
  const sensitive=op!=='validate';
  if(sensitive&&!window.confirm(`确认${label} ${current.name} v${current.version}？`))return;
  await act(async()=>{
   const result=await api('/strategies/'+op,{strategyId:current.strategyId,version:current.version,revision:current.revision,generation,confirm:sensitive});
   if(result.validated===false){setValidation(result.errors);return;}
   setValidation([]);await refresh(result);setNotice(label+'成功。');
  });
 }
 async function compareTo(){
  if(!current||!compare)return;
  const params=new URLSearchParams({strategyId:current.strategyId,fromVersion:compare,toVersion:current.version});
  const ordinal=analysis.current;
  const result=await api('/strategies/compare?'+params);
  if(ordinal===analysis.current)setDiff(result);
 }
 return <section className="strategy-center" aria-label="交易策略">
  <section className="panel strategy-active">
   <div className="panelhead"><h2><ShieldCheck size={19}/>当前启用策略</h2>
    <button type="button" disabled={busy} onClick={()=>void act(()=>refresh(current??undefined))}>刷新</button></div>
   <div className="strategy-content">{active?<><h3>{active.name} <span className="badge">v{active.version} · 已启用</span></h3>
    <p>Binance Demo 永续合约 · 分析与人工复核 · 风险等级 {active.config?.riskLevel}</p>
    <dl className="strategy-facts"><div><dt>发布时间</dt><dd>{stamp(active.publishedAt)}</dd></div><div><dt>最近启用</dt><dd>{stamp(active.activatedAt)}</dd></div>
     <div><dt>杠杆 / 持仓上限</dt><dd>{active.config?.riskManagement.leverage}× / {active.config?.positionManagement.maxSymbols} 个</dd></div>
     <div><dt>组合最大计划止损</dt><dd>{active.config?.riskManagement.portfolioLossUsdt} USDT</dd></div></dl>
    <p>PathMatch {active.capabilities?.pathMatch==='SHADOW_ONLY'?'影子观察':'关闭'} · 策略下单待独立验收 · 数据源在分析时检查</p>
    <code className="strategy-hash">{active.contentHash}</code><p className="strategy-excerpt">{active.document}</p>
    <button type="button" onClick={()=>setSelected(active)}>查看完整策略</button>
   </>:<p>当前没有启用策略。请从版本库选择已发布策略启用。</p>}</div>
  </section>
  {error&&<p className="alert" role="alert">{error}</p>}
  {notice&&<p role="status">{notice}</p>}
  {!!validation.length&&<ul className="alert">{validation.map((item,i)=><li key={i}>{item}</li>)}</ul>}
  <div className="strategy-layout">
   <section className="panel">
    <div className="panelhead"><h2><BookOpen size={18}/>策略版本库</h2></div>
    <div className="strategy-content strategy-library">
     <button type="button" className="primary" onClick={()=>openEditor(null)}>新建草稿</button>
     <label className="strategy-import">导入 JSON / Markdown<input type="file" accept=".json,.md,.markdown,.txt" onChange={event=>{
      const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(file)void act(()=>importFile(file));
     }}/></label>
     <input aria-label="按策略名称筛选" placeholder="搜索策略名称" value={filter} onChange={e=>setFilter(e.target.value)}/>
     <select aria-label="按策略状态筛选" value={status} onChange={e=>setStatus(e.target.value)}><option value="">全部状态</option>
      {Object.entries(stateText).map(([key,label])=><option value={key} key={key}>{label}</option>)}</select>
     {library.map(r=><button type="button" className="strategy-record" key={r.strategyId+'@'+r.version}
      aria-pressed={r.strategyId===selected?.strategyId&&r.version===selected.version} onClick={()=>{setValidation([]);setSelected(r);}}>
       <strong>{r.name}</strong><small>v{r.version} · {stateText[r.state]} · {stamp(r.createdAt)}</small>
     </button>)}
     {!library.length&&<p>没有符合条件的版本。</p>}
    </div>
   </section>
   <div className="strategy-detail">
    {editor&&<section className="panel">
     <div className="panelhead"><h2>{editor.revision?'编辑草稿':'审核并保存草稿'}</h2><button type="button" onClick={()=>{importing.current++;setEditor(null);setValidation([]);}}>关闭</button></div>
     <form className="strategy-content strategy-form" onSubmit={e=>{e.preventDefault();void act(save);}}>
      {editor.source==='MARKDOWN_IMPORT'&&<p>已载入原文。缺失或有冲突的字段请在校验后核对并补齐。</p>}
      <div className="strategy-fields">
       {([['name','策略名称'],['strategyId','策略 ID'],['version','版本号'],['changeNote','变更原因']] as const).map(([key,label])=><label key={key}>{label}
        <input value={editor[key]} required readOnly={(key==='strategyId'||key==='version')&&!!editor.revision||key==='strategyId'&&!!editor.parentVersion}
         onChange={e=>{
          const value=e.target.value;
          if(key==='version'||key==='strategyId'){
           setEditor(prev=>{if(!prev)return prev;try{return {...prev,[key]:value,config:JSON.stringify({...JSON.parse(prev.config),[key]:value},null,2)};}catch{return {...prev,[key]:value};}});
          }else edit(key,value);
         }}/></label>)}
      </div>
      <label>策略原文<textarea value={editor.document} required rows={7} onChange={e=>edit('document',e.target.value)}/></label>
      <label>结构化配置 JSON<textarea value={editor.config} required rows={15} spellCheck={false} onChange={e=>edit('config',e.target.value)}/></label>
      <div className="actions"><button type="button" disabled={busy} onClick={()=>void act(async()=>{
       const data=await api('/strategies/preview',{config:config()});setValidation(data.errors);
       if(data.compatible)setNotice('配置结构校验通过。');
      })}>检查配置</button><button type="submit" className="primary" disabled={busy}>保存草稿</button></div>
     </form>
    </section>}
    {current&&<section className="panel">
     <div className="panelhead"><h2>{current.name} · v{current.version}</h2><span className="badge">{stateText[current.state]}</span></div>
     <div className="strategy-content">
      <p>{current.changeNote}</p><p>来源 {current.source} · 创建 {stamp(current.createdAt)} · 发布 {stamp(current.publishedAt)}</p>
      <p>配置 Schema {current.config?.schemaVersion??'—'} · 软件 {current.softwareVersion??'—'}</p>
      <code className="strategy-hash">{current.contentHash}</code>
      <div className="actions strategy-actions">
       {current.state==='DRAFT'&&<><button type="button" disabled={busy} onClick={()=>openEditor(current)}>编辑</button><button type="button" disabled={busy} onClick={()=>void transition('validate','校验')}>校验草稿</button></>}
       {current.state==='VALIDATED'&&<button type="button" disabled={busy} onClick={()=>void transition('publish','发布')}>发布</button>}
       {current.state==='PUBLISHED'&&<button type="button" disabled={busy} onClick={()=>void transition('activate','启用')}>启用</button>}
       {current.state==='ARCHIVED'&&<button type="button" disabled={busy} onClick={()=>void transition('rollback','回滚')}>回滚至此版本</button>}
       <button type="button" disabled={busy} onClick={()=>openEditor(current,true)}>从此版本创建草稿</button>
      </div>
      <details open><summary>策略文档</summary><p className="strategy-document">{current.document}</p></details>
      <details><summary>结构化配置</summary><pre>{JSON.stringify(current.config,null,2)}</pre></details>
      <details><summary><GitCompare size={15}/>比较版本</summary><div className="actions">
       <select aria-label="旧版本" value={compare} onChange={e=>{setCompare(e.target.value);setDiff(null);}}><option value="">选择旧版本</option>
        {library.filter(r=>r.strategyId===current.strategyId&&r.version!==current.version).map(r=><option key={r.version}>{r.version}</option>)}</select>
       <button type="button" disabled={!compare||busy} onClick={()=>void act(compareTo)}>比较</button>
      </div>{diff&&<><p>策略文档{diff.documentChanged?'有变更':'一致'}</p><pre>{JSON.stringify(diff.changes,null,2)}</pre></>}</details>
      <details><summary><History size={15}/>版本历史</summary>{history.map(r=><p key={r.id}>{stamp(r.occurred_at)} · {eventText[r.operation]??r.operation} · {r.actor} · {r.detail}{r.prior_version&&' · 上一版本 '+r.prior_version}</p>)}</details>
     </div>
    </section>}
    {performance&&<section className="panel">
     <div className="panelhead"><h2>策略绩效</h2></div>
     <div className="strategy-content"><p>{stamp(performance.from)} 至 {stamp(performance.to)}</p>
      <dl className="strategy-facts"><div><dt>影子观察</dt><dd>{performance.shadow.count} 条 · {performance.shadow.finalized} 条完成{performance.shadow.status==='INSUFFICIENT_DATA'?' · 样本不足':''}</dd></div>
       <div><dt>模拟成交</dt><dd>样本不足</dd></div><div><dt>历史回测</dt><dd>样本不足</dd></div></dl>
      {performance.shadow.similarityDistribution&&<details><summary>拟合度分布</summary>
       {Object.entries(performance.shadow.similarityDistribution).map(([range,count])=><p key={range}>{range}% · {String(count)} 条</p>)}
       <p>平均轨迹相似度 {performance.shadow.meanPathSimilarity.toFixed(1)}%</p></details>}
      {!!performance.shadow.recent.length&&<details><summary>近期影子预测</summary>
       {performance.shadow.recent.map((r:any)=><p key={r.id}>{r.symbol} · {stamp(r.created_at)} · {r.state} · {r.similarity??'—'}{r.similarity!=null?'%':''}</p>)}</details>}
     </div>
    </section>}
   </div>
  </div>
 </section>;
}
