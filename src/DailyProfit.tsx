import { RotateCcw } from 'lucide-react';

export type DailyEarnings = {
  currencies: { currency: string; net: string; earned?: string; lost?: string }[];
  updatedAt: string | null;
  resetAt?: string | null;
  complete: boolean;
  error: string | null;
};

export function dailyUsdt(data?: DailyEarnings) {
  if (!data?.updatedAt && !data?.resetAt) return undefined;
  return data.currencies.find(currency => currency.currency === 'USDT');
}

const amountFormat = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
  signDisplay: 'exceptZero',
});

const timeFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function amountText(value?: string) {
  if (!value || !Number.isFinite(Number(value))) return '—';
  return amountFormat.format(Number(value));
}

export default function DailyProfit({ data, onReset, resetDisabled }: {
  data?: DailyEarnings;
  onReset: () => void;
  resetDisabled: boolean;
}) {
  const amount = dailyUsdt(data);
  const total = Number(amount?.net);
  const totalTone = total < 0 ? 'today-loss' : total > 0 ? 'today-gain' : '';
  const from = data?.resetAt ? timeFormat.format(new Date(data.resetAt)) : '00:00';

  return (
    <section className="today-profit" aria-label="北京时间今日收益（USDT）">
      <div className="today-heading">
        <span className="today-label">今日总收益</span>
        <span className="today-unit">USDT</span>
      </div>
      <strong className={'today-net ' + totalTone}>{amountText(amount?.net)}</strong>
      <dl className="today-breakdown">
        <div>
          <dt>今日赚取</dt>
          <dd className="today-gain">{amountText(amount?.earned)}</dd>
        </div>
        <div>
          <dt>今日亏损</dt>
          <dd className="today-loss">{amountText(amount?.lost)}</dd>
        </div>
      </dl>
      <p>北京时间 {from} 起 · 含手续费与资金费</p>
      {(!data?.complete || data.error) && (
        <small className="today-status">{data?.error ? '同步异常 · 展示已同步账单' : '今日账单同步中'}</small>
      )}
      <button type="button" className="today-reset" disabled={resetDisabled || !data} onClick={onReset}>
        <RotateCcw size={12} aria-hidden="true" />重置今日收益
      </button>
    </section>
  );
}
