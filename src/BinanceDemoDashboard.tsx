import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';

interface DemoAccount {
  configured: boolean;
  stale: boolean;
  snapshot: {
    updatedAt: string;
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

export default function BinanceDemoDashboard({ api }: {
  api: (path: string, body?: unknown) => Promise<DemoAccount>;
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
      setData(await api('/binance-demo/sync', {}));
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
          <h2>币安 USDⓈ-M 模拟账户</h2>
          <p>{updated ? `北京时间 ${updated} · ${data.stale ? '数据待更新' : '每 60 秒同步'}`
            : data?.configured === false ? '等待配置模拟盘密钥' : '等待首次同步'}</p>
        </div>
        <button className="primary" disabled={busy || !data?.configured} onClick={() => void refresh()}>
          <RefreshCw size={15}/>{busy ? '同步中…' : '立即刷新'}
        </button>
      </div>
    </div>
    {(refreshError || readError) && <div className="alert" role="alert">同步失败 · {refreshError || readError}</div>}
    <div className="metrics">
      {metrics.map(([label, field]) => <div className="metric" key={field}>
        <div>{label}</div><b>{amount(snapshot?.account?.[field])}</b><small>USDT</small>
      </div>)}
    </div>
    <div className="panel">
      <div className="panelhead"><h2>模拟盘当前持仓</h2><span className="badge">只读</span></div>
      {snapshot?.positions.length ? <div className="tablewrap"><table>
        <thead><tr>{['合约', '方向', '数量', '开仓价', '标记价', '未实现盈亏'].map(label => <th key={label}>{label}</th>)}</tr></thead>
        <tbody>{snapshot.positions.map(position => <tr key={position.symbol + ':' + position.side}>
          <td><b>{position.symbol}</b></td><td>{position.side === 'LONG' ? '多' : '空'}</td>
          <td>{amount(position.quantity)}</td><td>{amount(position.entryPrice)}</td><td>{amount(position.markPrice)}</td>
          <td className={Number(position.unrealizedPnl) < 0 ? 'red' : 'green'}>
            {amount(position.unrealizedPnl)} {position.marginAsset}
          </td>
        </tr>)}</tbody>
      </table></div> : <div className="empty">{snapshot ? '当前没有持仓' : '等待账户数据'}</div>}
    </div>
  </>;
}
