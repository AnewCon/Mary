import { useState, type FormEvent } from 'react';

type Outcome = {
  id: string;
  state: string;
  result: {
    code?: string;
    exchangeStatus?: string;
    executedQuantity?: string;
    leverage?: number;
  } | null;
};
type Side = 'LONG' | 'SHORT';
const states: Record<string, string> = {
  pending: '等待交易所确认', acknowledged: '交易所已回应',
  unknown: '结果待确认，请查询原请求', rejected: '交易所拒绝请求',
};

export default function BinanceDemoTradeForm({ api, positions, onApplied }: {
  api: (path: string, body?: unknown) => Promise<Outcome>;
  positions: { symbol: string; side: Side; quantity: string }[];
  onApplied: () => void;
}) {
  const [kind, setKind] = useState('open');
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [side, setSide] = useState<Side>('LONG');
  const [quantity, setQuantity] = useState('');
  const [percent, setPercent] = useState(100);
  const [leverage, setLeverage] = useState('1');
  const [busy, setBusy] = useState(false);
  const [id, setId] = useState(() => sessionStorage.getItem('quantos.binanceDemoAction') || '');
  const [result, setResult] = useState<Outcome | null>(null);
  const [error, setError] = useState('');
  const position = positions.find(row => row.symbol === symbol && row.side === side);

  async function run(action: () => Promise<Outcome>) {
    setBusy(true);
    setError('');
    try {
      const outcome = await action();
      setResult(outcome);
      if (outcome.state === 'acknowledged') onApplied();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const direction = side === 'LONG' ? '多单' : '空单';
    const summary = kind === 'close' ? `市价平掉 ${percent}% 的 ${direction}`
      : kind === 'open' ? `市价开${direction}，数量 ${quantity}` : `设置杠杆为 ${leverage} 倍`;
    if (!window.confirm(`币安模拟盘 · ${symbol.toUpperCase()} · ${summary}`)) return;
    const next = crypto.randomUUID().replace(/-/g, '');
    setId(next);
    sessionStorage.setItem('quantos.binanceDemoAction', next);
    void run(() => api('/binance-demo/action', {
      id: next, kind, symbol: symbol.toUpperCase(), side, quantity, percent, leverage: Number(leverage), confirm: true,
    }));
  }

  function clear() {
    if (result?.state !== 'rejected' && result?.state !== 'acknowledged' &&
      !window.confirm('请先在币安模拟盘核对原请求的结果。确定创建新的独立操作？')) return;
    sessionStorage.removeItem('quantos.binanceDemoAction');
    setId('');
    setResult(null);
    setError('');
  }

  return <section className="panel">
    <div className="panelhead"><h2>模拟盘交易</h2><span className="badge">币安 USDⓈ-M</span></div>
    {id ? <div className="pad">
      <p>{result ? states[result.state] : '交易请求已记录'}</p>
      <p>请求编号 <code>{id}</code></p>
      {result?.result?.exchangeStatus && <p>{result.result.exchangeStatus} · 已成交 {result.result.executedQuantity}</p>}
      {result?.result?.leverage && <p>已设置杠杆 {result.result.leverage}×</p>}
      {result?.result?.code && <p>{result.result.code}</p>}
      <div className="actions">
        <button disabled={busy} onClick={() => void run(() => api('/binance-demo/action?id=' + id))}>查询原请求</button>
        <button disabled={busy} onClick={clear}>新建操作</button>
      </div>
    </div> : <form className="pad" onSubmit={submit}>
      <div className="virtual-controls">
        <label>操作 <select value={kind} onChange={event => setKind(event.target.value)}>
          <option value="open">市价开仓</option><option value="close">市价平仓</option><option value="leverage">调整杠杆</option>
        </select></label>
        <label>合约 <input value={symbol} onChange={event => setSymbol(event.target.value.toUpperCase())}
          pattern="[A-Z0-9]{2,24}USDT" required /></label>
        {kind !== 'leverage' && <label>仓位方向 <select value={side} onChange={event => setSide(event.target.value as Side)}>
          <option value="LONG">多</option><option value="SHORT">空</option>
        </select></label>}
        {kind === 'open' && <label>数量 <input inputMode="decimal" value={quantity} required
          onChange={event => setQuantity(event.target.value)} /></label>}
        {kind === 'close' && <label>平仓比例 {percent}% <input type="range" min={1} max={100} value={percent}
          onChange={event => setPercent(Number(event.target.value))} /></label>}
        {kind === 'leverage' && <label>杠杆倍数 <input type="number" min={1} max={125} step={1} required value={leverage}
          onChange={event => setLeverage(event.target.value)} /></label>}
        <button className="primary" disabled={busy || (kind === 'close' && !position)}>确认操作</button>
      </div>
      {kind === 'close' && <p>{position ? `当前仓位 ${position.quantity}。提交时按最新仓位和合约步长计算。` : '该方向当前没有已同步仓位。'}</p>}
    </form>}
    {error && <div className="alert" role="alert">{error}</div>}
  </section>;
}
