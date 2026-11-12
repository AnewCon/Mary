import { useEffect, useState, type FormEvent } from 'react';
import BinanceDemoDashboard from './BinanceDemoDashboard';
import './exchange-accounts.css';

type Api = (path: string, body?: unknown) => Promise<any>;
const reviewSource = 'quantos:binance:chat-paper-review:v1';

export function ExchangeMark({ exchange }: { exchange: 'okx' | 'binance' }) {
  const binance = exchange === 'binance';
  return <svg className={'exchange-mark ' + exchange} viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    {binance
      ? <path fill="currentColor" d="m12 1 6 6-2.5 2.5L12 6 8.5 9.5 6 7zm-8.5 8.5L6 12l-2.5 2.5L1 12zM12 9.5l2.5 2.5-2.5 2.5L9.5 12zm8.5 0L23 12l-2.5 2.5L18 12zM6 17l2.5-2.5L12 18l3.5-3.5L18 17l-6 6z"/>
      : <path fill="currentColor" d="M2 2h6v6H2zm14 0h6v6h-6zM9 9h6v6H9zM2 16h6v6H2zm14 0h6v6h-6z"/>}
  </svg>;
}

export function BinanceWorkspace({ api }: { api: Api }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [review, setReview] = useState<{ text: string; savedAt: string }>();
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void api('/binance-demo/status').then(status => {
      if (active) setEnabled(status.enabled === true);
    }).catch(() => { if (active) setEnabled(false); });
    void api('/ai/logs').then((records: { data: string; created_at: string }[]) => {
      for (const row of records) {
        try {
          const log = JSON.parse(row.data);
          if (log.source === reviewSource && typeof log.content === 'string') {
            if (active) setReview({ text: log.content, savedAt: row.created_at });
            break;
          }
        } catch { /* Skip old malformed log entries. */ }
      }
    }).catch(() => { if (active) setError('暂时无法读取已保存的复盘。'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || saving) return;
    setSaving(true);
    setError('');
    try {
      await api('/ai/logs', { source: reviewSource, content });
      setReview({ text: content, savedAt: new Date().toISOString() });
      setDraft('');
    } catch {
      setError('复盘保存失败，请重试。');
    } finally {
      setSaving(false);
    }
  }

  return <div className="exchange-workspace">
    <section className="panel exchange-panel">
      <div className="panelhead"><div><h2><ExchangeMark exchange="binance"/>币安虚拟账户 · Chat 账本</h2>
        <p>Chat 复盘时计算币安虚拟账户的余额、持仓和盈亏。这里保留你发布的复盘快照。</p></div>
        <span className="badge exchange-binance">按次发布</span></div>
      <div className="exchange-body">
        {loading ? <p>正在读取上次复盘…</p> : review ? <>
          <p>快照保存于 {new Date(review.savedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（北京时间）</p>
          <pre>{review.text}</pre>
        </> : <p>暂无已发布的复盘。</p>}
        <form onSubmit={save}>
          <label htmlFor="binance-review">粘贴 Chat 复盘摘要</label>
          <textarea id="binance-review" value={draft} onChange={event => setDraft(event.target.value)}
            placeholder="建议包含账户余额、未平仓仓位、已实现盈亏，以及本次复盘时间" maxLength={4000} rows={4}/>
          <button className="primary" disabled={loading || saving || !draft.trim()}>{saving ? '保存中…' : '保存复盘快照'}</button>
        </form>
        {error && <p role="alert">{error}</p>}
      </div>
    </section>
    <section className="panel exchange-panel">
      <div className="panelhead"><div><h2><ExchangeMark exchange="binance"/>币安 USDⓈ-M 模拟盘 · API 接入</h2>
        <p>交易所模拟账户。接入后独立展示余额、仓位和未实现盈亏。</p></div>
        <span className="badge exchange-binance">{enabled === null ? '检查配置中' : enabled ? '接口已启用' : '待接入'}</span></div>
      {enabled === false && <div className="exchange-body"><p>预留给未来的 VPS。需部署币安模拟盘后端，并在服务端配置模拟盘凭证；启用前不会发起币安账户请求。</p></div>}
    </section>
    {enabled && <BinanceDemoDashboard api={api}/>}
  </div>;
}
