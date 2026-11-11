import { useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import './equity-animation.css';

export const scenes = [
  { id: 'stone', name: '石头', range: '亏损 10% 及以上' },
  { id: 'coins', name: '钢镚堆', range: '亏损不足 10%' },
  { id: 'note', name: '一张红钞票', range: '与本金持平' },
  { id: 'change', name: '红钞票和钢镚', range: '盈利不足 5%' },
  { id: 'stack', name: '红钞票堆', range: '盈利 5% 及以上' },
] as const;

export function equityState(equity: unknown, capital: unknown) {
  if (equity == null || equity === '' || capital == null || capital === '') return null;
  const current = Number(equity);
  const principal = Number(capital);
  if (!Number.isFinite(current) || !Number.isFinite(principal) || principal <= 0) return null;
  const change = (current - principal) / principal;
  const index = change <= -0.1 ? 0 : change < 0 ? 1 : change === 0 ? 2 : change < 0.05 ? 3 : 4;
  return { change, scene: scenes[index] };
}

const percent = new Intl.NumberFormat('zh-CN', {
  style: 'percent',
  signDisplay: 'exceptZero',
  maximumFractionDigits: 2,
});

export default function EquityAnimation({ equity, capital, stale, onConfigure }: {
  equity: unknown;
  capital?: string | null;
  stale?: boolean;
  onConfigure: () => void;
}) {
  const state = equityState(equity, capital);
  const scene = state?.scene ?? scenes[2];

  return (
    <section className="equity-animation" aria-label="账户权益相对本金">
      <div className="equity-art" aria-hidden="true">
        {scenes.map(item => (
          <picture key={item.id} className={item.id === scene.id ? 'equity-frame visible' : 'equity-frame'}>
            <source media="(prefers-reduced-motion: reduce)" srcSet={'/assets/equity-animation/' + item.id + '.webp?v=2'} />
            <img src={'/assets/equity-animation/' + item.id + '.gif?v=2'} alt="" width="256" height="144" />
          </picture>
        ))}
      </div>
      <div className="equity-caption">
        <div className="equity-label">
          <span>权益较本金</span>
          <button type="button" onClick={onConfigure} aria-label="设置本金基准" title="设置本金基准"><ArrowUpRight size={14}/></button>
        </div>
        {state ? (
          <div className="equity-reading">
            <strong className={state.change < 0 ? 'today-loss' : state.change > 0 ? 'today-gain' : ''}>{percent.format(state.change)}</strong>
            <span>{scene.name}{stale ? ' · 最近快照' : ''}</span>
          </div>
        ) : <p>{capital ? '等待账户权益同步' : '设置本金后显示涨跌'}</p>}
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
      <p>按（总权益 − 本金）÷ 本金切换场景。总权益包含浮动盈亏。入金或出金后，可更新本金基准。</p>
      <form onSubmit={event => { event.preventDefault(); onSave(value.trim()); }}>
        <label htmlFor="capital-usd">本金基准（USD）</label>
        <div className="capital-input">
          <input id="capital-usd" type="number" min="0.01" max="999999999999.99" step="0.01"
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
