import { useEffect, useState } from 'react';
import BinanceDemoDashboard from './BinanceDemoDashboard';
import PaperReviews from './PaperReviews';
import './exchange-accounts.css';

type Api = (path: string, body?: unknown) => Promise<any>;

export function ExchangeMark({ exchange }: { exchange: 'okx' | 'binance' }) {
  const binance = exchange === 'binance';
  return <svg className={'exchange-mark ' + exchange} viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    {binance
      ? <path fill="currentColor" d="m12 1 6 6-2.5 2.5L12 6 8.5 9.5 6 7zm-8.5 8.5L6 12l-2.5 2.5L1 12zM12 9.5l2.5 2.5-2.5 2.5L9.5 12zm8.5 0L23 12l-2.5 2.5L18 12zM6 17l2.5-2.5L12 18l3.5-3.5L18 17l-6 6z"/>
      : <path fill="currentColor" d="M2 2h6v6H2zm14 0h6v6h-6zM9 9h6v6H9zM2 16h6v6H2zm14 0h6v6h-6z"/>}
  </svg>;
}

type PaperOrder = { id:string; symbol:string; side:string; quantity:string; entry:string; mark:string; pnl:string; markAt:number; closedAt?:number;
  leverage?:number; marginRoiPct?:string; liquidationPrice?:string|null; liquidationRisk?:string|null };
type PaperLedger = { initial:string|null; balance:string|null; available:string|null; realized:string; unrealized:string; orders:PaperOrder[]; closedCount:number };
const beijingTime = (time:number) => new Date(time).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'});

export function BinancePaperLedger({ api, positionsOnly = false }: { api: Api; positionsOnly?: boolean }) {
  const [ledger, setLedger] = useState<PaperLedger|null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void api('/paper/orders').then(data => {if(active) setLedger(data);})
      .catch(() => {if(active) setError('暂时无法读取虚拟订单。');})
      .finally(() => {if(active) setLoading(false);});
    return () => {active = false;};
  }, [api]);

  async function refresh() {
    setLoading(true); setError('');
    try { setLedger(await api('/paper/orders')); }
    catch { setError('暂时无法读取虚拟订单。'); }
    finally { setLoading(false); }
  }

  const lastQuote = ledger?.orders.reduce((latest, order) => Math.max(latest, order.markAt), 0) ?? 0;
  const openOrders = ledger?.orders.filter(order => !order.closedAt) ?? [];
  return <section className="panel exchange-panel">
      <div className="panelhead"><div><h2><ExchangeMark exchange="binance"/>{positionsOnly ? '币安虚拟持仓' : '币安虚拟账户收益'}</h2>
        <p>{lastQuote ? '最近记录行情 · ' + beijingTime(lastQuote) + '（北京时间）' : '订单估值随 Chat 写入更新'}</p></div>
        <button disabled={loading} onClick={() => void refresh()}>{loading ? '读取中…' : '读取最新记录'}</button></div>
      <div className="exchange-body">
        {error && <p role="alert">{error}</p>}
        {ledger?.initial === null && <p>尚未设置初始资金。请在 Chat 中指定模拟本金后开仓。</p>}
        {positionsOnly && ledger?.initial != null && (openOrders.length ? <div className="phone-position-list">
          {openOrders.map(order => <article className="phone-position" key={order.id}>
            <div><strong>{order.symbol}</strong><span>{order.side === 'LONG' ? '多仓' : '空仓'} · {order.leverage ?? 1}×</span></div>
            <dl><div><dt>数量</dt><dd>{order.quantity}</dd></div><div><dt>开仓价</dt><dd>{order.entry}</dd></div>
              <div><dt>最新记录价</dt><dd>{order.mark}</dd></div><div><dt>浮动盈亏</dt><dd className={Number(order.pnl) < 0 ? 'red' : Number(order.pnl) > 0 ? 'green' : undefined}>{order.pnl} USDT</dd></div>
              <div><dt>保证金收益率</dt><dd>{order.marginRoiPct == null ? '—' : order.marginRoiPct + '%'}</dd></div>
              <div><dt>预估强平价</dt><dd>{order.liquidationPrice ?? '—'}</dd></div></dl>
            {order.liquidationRisk === 'AT_RISK' && <p className="red">已触及模拟强平线</p>}
          </article>)}
        </div> : <p>暂无未平仓订单。</p>)}
        {positionsOnly && openOrders.length > 0 && <p>模拟逐仓 · 维持保证金率 0.5% · 仅提示风险</p>}
        {!positionsOnly && ledger?.initial != null && <><div className="metrics">
          {([['已实现盈亏',ledger.realized,true],['未实现盈亏',ledger.unrealized,true],['账户余额',ledger.balance,false],['可用余额',ledger.available,false]] as const).map(([name,value,isPnl]) =>
            <div className="metric" key={name}><div>{name}</div><b className={isPnl&&Number(value)!==0?(Number(value)<0?'red':'green'):undefined}>{value}</b><small>USDT</small></div>)}
        </div>
        <p>模拟逐仓，维持保证金率固定为 0.5%，仅提示强平风险。收益不计手续费、资金费和滑点。</p>
        {ledger.orders.length ? <div className="tablewrap"><table><thead><tr>
          {['合约','方向 / 杠杆','状态','数量','开仓均价','最新记录价','盈亏 (USDT)','保证金收益率','预估强平价','行情时间（北京）'].map(name=><th key={name}>{name}</th>)}
        </tr></thead><tbody>{ledger.orders.map(o=><tr key={o.id}>
          <td>{o.symbol}<small>{o.id}</small></td><td>{o.side==='LONG'?'多':'空'} · {o.leverage ?? 1}×</td><td>{o.closedAt?'已平仓':'持仓中'}</td>
          <td>{o.quantity}</td><td>{o.entry}</td><td>{o.mark}</td><td className={Number(o.pnl)<0?'red':Number(o.pnl)>0?'green':undefined}>{o.pnl}</td>
          <td>{o.marginRoiPct == null ? '—' : o.marginRoiPct + '%'}</td><td>{o.liquidationPrice ?? '—'}{o.liquidationRisk === 'AT_RISK' && <small className="red">已触及强平线</small>}</td><td>{beijingTime(o.markAt)}</td>
        </tr>)}</tbody></table></div> : <p>暂无虚拟订单。</p>}</>}
      </div>
    </section>;
}

export function BinanceWorkspace({ api }: { api: Api }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    void api('/binance-demo/status').then(status => {
      if (active) setEnabled(status.enabled === true);
    }).catch(() => { if (active) setEnabled(false); });
    return () => { active = false; };
  }, [api]);

  return <div className="exchange-workspace">
    <BinancePaperLedger api={api}/>
    <PaperReviews api={api}/>
    <section className="panel exchange-panel">
      <div className="panelhead"><div><h2><ExchangeMark exchange="binance"/>币安 USDⓈ-M 模拟盘 · API 接入</h2>
        <p>交易所模拟账户。接入后独立展示余额、仓位和未实现盈亏。</p></div>
        <span className="badge exchange-binance">{enabled === null ? '检查配置中' : enabled ? '接口已启用' : '待接入'}</span></div>
      {enabled === false && <div className="exchange-body"><p>预留给未来的 VPS。需部署币安模拟盘后端，并在服务端配置模拟盘凭证。</p></div>}
    </section>
    {enabled && <BinanceDemoDashboard api={api}/>}
  </div>;
}
