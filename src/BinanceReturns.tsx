import type { ReactNode } from 'react';
import FoldPanel from './FoldPanel';

export type Totals = { net: string; gains: string; losses: string };
type Bill = { kind: 'REALIZED_PNL' | 'COMMISSION' | 'FUNDING_FEE'; income: string; symbol: string; time: number; tranId: string; tradeId?: string };
export type BinanceLedger = {
  asOf: number; dayStart: number; resetAt?: number; rangeStart: number; complete: boolean;
  today: Totals; period: Totals; bills: Bill[]; closed: Bill[];
};

const local = (date: number) => new Date(date).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'});
const labels = { REALIZED_PNL: '已实现盈亏', COMMISSION: '手续费', FUNDING_FEE: '资金费' };
const color = (value?: string) => Number(value) > 0 ? 'green' : Number(value) < 0 ? 'red' : '';
const format = (value?: string) => value === undefined ? '—' : Number(value).toLocaleString('en-US', {maximumFractionDigits: 6, minimumFractionDigits: 2, signDisplay: 'exceptZero'});

export function TodayReturns({value, detail, updated, action}: {value?: Totals; detail: string; updated?: number; action?: ReactNode}) {
  return <section className="panel binance-today" aria-label="今日收益">
    <div className="panelhead"><div><h2>今日收益</h2><p>{detail}</p></div><div className="actions"><span className="badge">USDT</span>{action}</div></div>
    <div className="binance-today-values">
      <div className="today-net"><span>今日净收益</span><b className={color(value?.net)}>{format(value?.net)}</b></div>
      <div><span>今日赚取</span><b className={color(value?.gains)}>{format(value?.gains)}</b></div>
      <div><span>今日亏损</span><b className={color(value?.losses)}>{format(value?.losses)}</b></div>
    </div>
    {updated !== undefined && <p className="binance-today-time">收益更新 · {local(updated)}</p>}
  </section>;
}

export function BinanceReturns({ledger, view, waiting, todayResetAt = 0, resetAction}: {ledger?: BinanceLedger; todayResetAt?: number; resetAction?: ReactNode; view: 'all' | 'earnings' | 'positions'; waiting: string}) {
  const todayStart = Math.floor((Date.now() + 28_800_000) / 86_400_000) * 86_400_000 - 28_800_000;
  const resetAt = todayResetAt >= todayStart ? todayResetAt : 0;
  const waitingForReset = resetAt > 0 && (ledger?.resetAt !== resetAt || ledger.asOf < resetAt);
  const today = waitingForReset ? {net:'0', gains:'0', losses:'0'}
    : ledger?.complete && ledger.dayStart === todayStart ? ledger.today : undefined;
  const detail = resetAt ? `北京时间 ${new Date(resetAt).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})} 重置`
    + (waitingForReset ? ' · 等待同步重置后的流水' : !ledger?.complete ? ' · 流水待完整同步' : ' · 已实现盈亏、手续费与资金费')
    : today ? '北京时间 00:00 起 · 已实现盈亏、手续费与资金费'
    : ledger && !ledger.complete ? '流水超过同步上限，等待完整数据'
    : ledger && ledger.dayStart !== todayStart ? '等待同步今天的收益' : waiting;
  return <>
    {view !== 'positions' && <TodayReturns value={today} detail={detail} updated={waitingForReset ? undefined : ledger?.asOf} action={resetAction}/>}
    {view !== 'earnings' && <FoldPanel title="历史仓位 · 平仓记录">
      <BillList rows={ledger?.closed} waiting={waiting} closed/>
    </FoldPanel>}
    {view !== 'positions' && <FoldPanel title="历史收益账单">
      {ledger && <div className="exchange-body binance-bill-summary">
        <span>近 7 个自然日净收益</span><b className={color(ledger.period.net)}>{ledger.complete ? format(ledger.period.net) : '—'} USDT</b>
      </div>}
      <BillList rows={ledger?.bills} waiting={waiting}/>
    </FoldPanel>}
  </>;
}

function BillList({rows, waiting, closed = false}: {rows?: Bill[]; waiting: string; closed?: boolean}) {
  return <div className="exchange-body binance-bills">
    <p>{closed ? '近 7 个自然日 · 最近 40 笔已实现平仓盈亏' : '近 7 个自然日 · 最近 40 笔收益流水'}</p>
    {rows?.length ? <div className="phone-position-list">
      {rows.map(row => <article key={row.kind + ':' + row.tranId} className="phone-position">
        <div><strong>{row.symbol || labels[row.kind]}</strong><b className={color(row.income)}>{format(row.income)} USDT</b></div>
        <small>{local(row.time)} · {labels[row.kind]}{closed && row.tradeId ? ' · 成交 ' + row.tradeId : ''}</small>
      </article>)}
    </div> : <p>{rows ? '这段时间暂无记录。' : waiting}</p>}
  </div>;
}
