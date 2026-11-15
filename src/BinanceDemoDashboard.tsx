import { BinanceReturns, type BinanceLedger } from './BinanceReturns';
import FoldPanel from './FoldPanel';
import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import BinanceDemoTradeForm from './BinanceDemoTradeForm';

interface DemoAccount {
  configured: boolean;
  tradingEnabled: boolean;
  stale: boolean;
  snapshot: {
    updatedAt: string;
    ledger?: BinanceLedger;
    account: {
      walletBalance: string;
      availableBalance: string;
      marginBalance: string;
      unrealizedPnl: string;
    } | null;
    positions: {
      symbol: string;
      side: 'LONG' | 'SHORT';
      quantity: string;
      entryPrice: string;
      markPrice: string;
      unrealizedPnl: string;
      marginAsset: string;
    }[];
  } | null;
}

const metrics = [
  ['钱包余额', 'walletBalance'],
  ['可用余额', 'availableBalance'],
  ['保证金余额', 'marginBalance'],
  ['未实现盈亏', 'unrealizedPnl'],
] as const;

const amount = (value?: string) => value == null ? '—' : Number(value).toLocaleString('en-US', {
  maximumFractionDigits: 12,
});

export default function BinanceDemoDashboard({ api, view = 'all' }: {
  api: (path: string, body?: unknown) => Promise<any>;
  view?: 'all' | 'positions' | 'earnings';
}) {
  const [data, setData] = useState<DemoAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const result = await api('/binance-demo/account');
        if (mounted) {
          setData(current => (current?.snapshot?.updatedAt ?? '') > (result.snapshot?.updatedAt ?? '') && result.configured
            ? current : result);
          setReadError('');
        }
      } catch (err) {
        if (mounted) setReadError((err as Error).message);
      }
    }
    void load();
    const timer = setInterval(load, 60_000);
    return () => { mounted = false; clearInterval(timer); };
  }, [api]);

  async function refresh() {
    setBusy(true);
    setRefreshError('');
    try {
      const {id} = await api('/binance-demo/sync', {});
      const deadline = Date.now() + 45_000;
      let updated = false;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 3_000));
        const request = await api('/binance-demo/action?id=' + encodeURIComponent(id));
        if (request.state === 'acknowledged') {
          const result: DemoAccount = await api('/binance-demo/account');
          setData(current => (current?.snapshot?.updatedAt ?? '') > (result.snapshot?.updatedAt ?? '') && result.configured ? current : result);
          updated = true;
          break;
        }
        if (request.state === 'rejected') throw new Error('VPS 无法拉取模拟盘数据');
        if (!['queued', 'running'].includes(request.state)) break;
      }
      if (!updated) throw new Error('等待 VPS 更新超时，请稍后查看同步时间。');
      setReadError('');
    } catch (err) {
      setRefreshError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const snapshot = data?.snapshot;
  const updated = snapshot && new Date(snapshot.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  return <>
    <div className="panel">
      <div className="panelhead">
        <div>
          <h2>币安 USDⓈ-M 模拟账户{data?.snapshot && <span className="count">{data.snapshot.positions.length} 个仓位</span>}</h2>
          <p>{updated ? `北京时间 ${updated} · ${data.stale ? '数据待更新' : 'VPS 已同步'}`
            : data?.configured === false ? '等待配置模拟盘密钥' : '等待首次同步'}</p>
        </div>
        <button className="primary" disabled={busy || !data?.configured} onClick={() => void refresh()}>
          <RefreshCw size={15}/>{busy ? '同步中…' : '立即同步'}
        </button>
      </div>
    </div>
    {(refreshError || readError) && <div className="alert" role="alert">同步失败 · {refreshError || readError}</div>}
    {view !== 'positions' && <BinanceReturns ledger={snapshot?.ledger} view={view === 'all' ? 'earnings' : view} waiting="等待 VPS 同步收益流水"/>}
    {view !== 'positions' && <div className="metrics">
      {metrics.map(([label, field]) => <div className="metric" key={field}>
        <div>{label}</div><b>{amount(snapshot?.account?.[field])}</b><small>USDT</small>
      </div>)}
    </div>}
    {view !== 'earnings' && <div className="panel">
      <div className="panelhead"><h2>模拟盘当前持仓</h2><span className="badge">币安模拟盘</span></div>
      {snapshot?.positions.length ? view === 'positions' ? <div className="exchange-body phone-position-list">
        {snapshot.positions.map(position => <article className="phone-position" key={position.symbol + ':' + position.side}>
          <div><strong>{position.symbol}</strong><span>{position.side === 'LONG' ? '多仓' : '空仓'}</span></div>
          <dl><div><dt>数量</dt><dd>{amount(position.quantity)}</dd></div><div><dt>开仓价</dt><dd>{amount(position.entryPrice)}</dd></div>
          <div><dt>标记价</dt><dd>{amount(position.markPrice)}</dd></div>
          <div><dt>未实现盈亏</dt><dd className={Number(position.unrealizedPnl) < 0 ? 'red' : 'green'}>{amount(position.unrealizedPnl)} {position.marginAsset}</dd></div></dl>
        </article>)}
      </div> : <div className="tablewrap"><table>
        <thead><tr>{['合约', '方向', '数量', '开仓价', '标记价', '未实现盈亏'].map(label => <th key={label}>{label}</th>)}</tr></thead>
        <tbody>{snapshot.positions.map(position => <tr key={position.symbol + ':' + position.side}>
          <td><b>{position.symbol}</b></td><td>{position.side === 'LONG' ? '多' : '空'}</td>
          <td>{amount(position.quantity)}</td><td>{amount(position.entryPrice)}</td><td>{amount(position.markPrice)}</td>
          <td className={Number(position.unrealizedPnl) < 0 ? 'red' : 'green'}>
            {amount(position.unrealizedPnl)} {position.marginAsset}
          </td>
        </tr>)}</tbody>
      </table></div> : <div className="empty">{snapshot ? (data?.stale ? '上次同步时没有持仓，请立即同步确认。' : '当前没有持仓') : '等待账户数据'}</div>}
    </div>}
    {view !== 'earnings' && <BinanceReturns ledger={snapshot?.ledger} view="positions" waiting="等待 VPS 同步平仓记录"/>}
    {view === 'all' && data?.configured && data.tradingEnabled && <FoldPanel title="模拟盘交易"><BinanceDemoTradeForm api={api} positions={snapshot?.positions ?? []}
      onApplied={() => void refresh()} /></FoldPanel>}
  </>;
}
