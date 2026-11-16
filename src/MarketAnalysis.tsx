import { useState } from 'react';
import FoldPanel from './FoldPanel';

type Quote={ key:string;source:string;status:string;asOf:string|number|null;fetchedAt:string|number|null;data?:any;error?:string };
type Analysis={observed:Quote[];estimated:Quote[];derived:{oiHistory:Quote|null};interpretation:{recommendation:string;entryScore:number|null;directionScore:number|null;risks:string[];missing:string[]}};
const time=(value:string|number|null)=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'—';
const percent=(value:number|null|undefined)=>typeof value==='number'&&Number.isFinite(value)?value.toLocaleString('en-US',{maximumFractionDigits:4,signDisplay:'exceptZero'})+'%':'—';

export default function MarketAnalysis({api}:{api:(path:string,body?:unknown)=>Promise<any>}) {
  return <FoldPanel title="衍生品分析"><MarketPanel api={api}/></FoldPanel>;
}
function MarketPanel({api}:{api:(path:string,body?:unknown)=>Promise<any>}) {
  const [symbol,setSymbol]=useState('BTC');
  const [data,setData]=useState<Analysis|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  async function refresh() {
    setBusy(true);setError('');
    try{setData(await api('/market/analyze',{symbol: symbol.trim().toUpperCase()}));}
    catch{setError('暂时无法完成市场分析。');}
    finally{setBusy(false);}
  }
  const quote=data?.observed.find(x=>x.key==='derivatives');
  const events=data?.observed.find(x=>x.key==='recent_liquidations');
  const heatmap=data?.estimated[0];
  const oi=data?.derived.oiHistory;
  const ticker=quote?.data?.ticker;
  return <div className="exchange-body">
    <form onSubmit={event=>{event.preventDefault();void refresh();}}>
      <label>币种 <input aria-label="分析币种" value={symbol} pattern="[a-zA-Z0-9]{1,20}" required onChange={event=>{setSymbol(event.target.value);setData(null);}}/></label>
      <button type="submit" disabled={busy}>{busy?'分析中…':'运行分析'}</button>
    </form>
    {error&&<p role="alert">{error}</p>}
    {data&&<>
      <article className="phone-position">
        <div><strong>{symbol.toUpperCase()} · 合约快照</strong><span>{quote?.status}</span></div>
        <dl>
          <div><dt>最新成交价 / 24h</dt><dd>{ticker?.lastPrice??'—'} · {ticker?.price24hPcnt ? percent(Number(ticker.price24hPcnt)*100) : '—'}</dd></div>
          <div><dt>未平仓量</dt><dd>{ticker?.openInterest??'—'}</dd></div>
          <div><dt>资金费率 / 下次结算（北京）</dt><dd>{ticker?.fundingRate ? percent(Number(ticker.fundingRate)*100) : '—'} · {time(Number(ticker?.nextFundingTime))}</dd></div>
          <div><dt>一小时多 / 空账户占比</dt><dd>{quote?.data?.accountRatio ? [quote.data.accountRatio.buyRatio,quote.data.accountRatio.sellRatio].map((value:string)=>percent(Number(value)*100)).join(' / ') : '—'}</dd></div>
          {Object.entries(oi?.data?.changes??{}).map(([window,value])=>{
            const change=value as {changePct?:number;status:string};
            return <div key={window}><dt>{window} OI</dt><dd>{change.status==='OK'?percent(change.changePct):'数据不足'}</dd></div>;
          })}
        </dl>
      </article>
      <article className="phone-position">
        <div><strong>潜在清算价位（估算）</strong><span>{heatmap?.status}</span></div>
        {heatmap?.data?.latest&&(['long','short'] as const).map(side=><p key={side}>{side==='long'?'多头':'空头'}：{heatmap.data.latest[side].slice(0,3).map((row:any)=>row.bucketLowUsd+' USD').join('、')||'—'}</p>)}
        <div><strong>近期爆仓样本</strong><span>{events?.status}</span></div>
        {events?.data?.events?.slice(0,4).map((row:any,index:number)=><p key={index}>{time(row.ts)} · {row.exchange} · {row.side==='long_liquidated'?'多头':row.side==='short_liquidated'?'空头':row.side} · {row.notional} USD</p>)}
      </article>
      <article className="phone-position">
        <div><strong>V2.5 实验分析 · {data.interpretation.recommendation}</strong><span>方向 {data.interpretation.directionScore??'—'} / 入场 {data.interpretation.entryScore??'—'}</span></div>
        {[...data.interpretation.missing,...data.interpretation.risks].map(reason=><p key={reason}>{reason}</p>)}
      </article>
      {[quote,oi,heatmap,events].filter(Boolean).map(row=><p key={row!.key}>{row!.source} · {time(row!.asOf)} · {row!.error??row!.status}</p>)}
    </>}
  </div>;
}
