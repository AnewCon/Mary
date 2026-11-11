import { useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { dailyUsdt, type DailyEarnings } from './DailyProfit';
import './equity-animation.css';

export const scenes = [
  { id: 'stone', name: '石头', range: '亏损 10% 及以上' },
  { id: 'coins', name: '钢镚堆', range: '亏损不足 10%' },
  { id: 'note', name: '一张红钞票', range: '今日净收益为零' },
  { id: 'change', name: '红钞票和钢镚', range: '盈利不足 5%' },
  { id: 'stack', name: '红钞票堆', range: '盈利 5% 及以上' },
] as const;

function dailyReturnState(net: string | undefined, capital: string | null | undefined) {
  if (!net || !capital) return null;
  const profit = Number(net);
  const principal = Number(capital);
  if (!Number.isFinite(profit) || !Number.isFinite(principal) || principal <= 0) return null;
  const change = profit / principal;
  const index = change <= -0.1 ? 0 : change < 0 ? 1 : change === 0 ? 2 : change < 0.05 ? 3 : 4;
  return { change, scene: scenes[index] };
}

const percent = new Intl.NumberFormat('zh-CN', {
  style: 'percent',
  signDisplay: 'exceptZero',
  maximumFractionDigits: 2,
});

export default function EquityAnimation({ today, capital, onConfigure }: {
  today?: DailyEarnings;
  capital?: string | null;
  onConfigure: () => void;
}) {
  const state = dailyReturnState(dailyUsdt(today)?.net, capital);
  const scene = state?.scene ?? scenes[2];
  const syncLabel = today?.error ? ' · 已同步账单' : !today?.complete ? ' · 账单同步中' : '';

  return (
    <section className="panel equity-animation" aria-labelledby="equity-animation-title">
      <div className="equity-art" aria-hidden="true">
        {scenes.map(item => (
          <picture key={item.id} className={item.id === scene.id ? 'equity-frame visible' : 'equity-frame'}>
            <source media="(prefers-reduced-motion: reduce)" srcSet={'/assets/equity-animation/' + item.id + '.webp?v=2'} />
            <img src={'/assets/equity-animation/' + item.id + '.gif?v=2'} alt="" width="256" height="144" />
          </picture>
        ))}
      </div>
      <div className="equity-caption">
        <h2 id="equity-animation-title">盈收状态</h2>
        {state ? (
          <>
            <div className="equity-label">今日净收益 ÷ 本金基准</div>
            <div className="equity-reading">
              <strong className={state.change < 0 ? 'red' : state.change > 0 ? 'green' : ''}>{percent.format(state.change)}</strong>
              <span>{scene.name}{syncLabel}</span>
            </div>
          </>
        ) : <p>{capital ? '等待今日收益同步' : '设置本金后显示今日收益率'}</p>}
        <button type="button" className="equity-configure" onClick={onConfigure}>
          {capital ? '调整本金' : '设置本金'} <ArrowUpRight size={14} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

export function CapitalSettings({ capital, busy, onSave }: {
  capital?: string | null;
  busy: boolean;
  onSave: (capital: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? capital ?? '';
  return (
    <section className="panel settings capital-settings">
      <h2>盈收动画</h2>
      <p>按（今日赚取 + 今日亏损）÷ 本金基准切换场景。今日亏损按负数计。</p>
      <form onSubmit={event => { event.preventDefault(); onSave(value.trim()); }}>
        <label htmlFor="capital-reference">本金基准（USDT）</label>
        <div className="capital-input">
          <input id="capital-reference" type="number" min="0.01" max="999999999999.99" step="0.01"
            inputMode="decimal" value={value} required onChange={event => setDraft(event.target.value)}/>
          <button className="primary" disabled={busy}>保存本金</button>
        </div>
      </form>
      <dl className="equity-legend">
        {scenes.map(scene => <div key={scene.id}><dt>{scene.name}</dt><dd>{scene.range}</dd></div>)}
      </dl>
    </section>
  );
}
