import { useCallback, useEffect, useState } from 'react';

type Position = { symbol: string; side: string; quantity: string; entryPrice: string; markPrice: string; unrealizedPnl: string; marginAsset: string };
type Snapshot = {
  updatedAt: string;
  account: { walletBalance: string; availableBalance: string; marginBalance: string; unrealizedPnl: string } | null;
  positions: Position[];
};
type Api = (path: string, body?: unknown) => Promise<unknown>;

export default function BinanceLiveDashboard({ api, view = 'all' }: { api: Api; view?: 'all' | 'positions' | 'earnings' }) {
  const [agent,setAgent]=useState<boolean|null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    setError(false);
    try { const data=await api('/binance-demo/live-account') as {snapshot:Snapshot|null;ready:boolean};setSnapshot(data.snapshot);setAgent(data.ready); }
    catch { setError(true); }
    finally { setBusy(false); }
  }, [api]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);
  return <section className="panel exchange-panel">
    <div className="panelhead"><div><h2>币安真实账户</h2>
      <p>{agent===null?'检查本地面板':agent?'本地面板在线 · 可接收待确认请求':'本地面板离线或未就绪'}</p>
      {snapshot && <p>北京时间 {new Date(snapshot.updatedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}
        {Date.now() - Date.parse(snapshot.updatedAt) > 600_000 ? ' · 快照待更新' : ''}</p>}
    </div><button type="button" disabled={busy} onClick={() => void load()}>{busy ? '读取中…' : '刷新快照'}</button></div>
    <div className="exchange-body">
      {error && <p role="alert">暂时无法读取真实账户，请重试。</p>}
      {!snapshot && !busy && !error && <p>尚未收到真实账户数据，请在 Windows 打开 QuantOS 本地面板并验证真实账户 API。</p>}
      {snapshot && view !== 'positions' && <div className="metrics">{([
        ['钱包余额', snapshot.account?.walletBalance], ['可用余额', snapshot.account?.availableBalance],
        ['保证金余额', snapshot.account?.marginBalance], ['未实现盈亏', snapshot.account?.unrealizedPnl],
      ] as const).map(([label, value]) => <div className="metric" key={label}><div>{label}</div><b>{value ?? '—'}</b><small>USDT</small></div>)}</div>}
      {snapshot && view !== 'earnings' && (snapshot.positions.length ? <div className="phone-position-list">{snapshot.positions.map(p =>
        <article className="phone-position" key={p.symbol + ':' + p.side}>
          <div><strong>{p.symbol}</strong><span>{p.side === 'LONG' ? '多仓' : '空仓'}</span></div>
          <dl><div><dt>数量</dt><dd>{p.quantity}</dd></div><div><dt>开仓价</dt><dd>{p.entryPrice}</dd></div>
            <div><dt>标记价</dt><dd>{p.markPrice}</dd></div><div><dt>未实现盈亏</dt><dd className={Number(p.unrealizedPnl)<0?'red':'green'}>{p.unrealizedPnl} {p.marginAsset}</dd></div></dl>
        </article>)}</div> : <p>当前没有持仓。</p>)}
    </div>
  </section>;
}
