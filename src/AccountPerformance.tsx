import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { BinancePaperLedger, ExchangeMark } from './ExchangeAccounts';
import Performance from './Performance';
import PaperReviews from './PaperReviews';

type Props = Parameters<typeof Performance>[0] & {
  api: (path: string, body?: unknown) => Promise<unknown>;
};

const accounts = [
  { exchange: 'okx', title: '欧易账户', detail: '净收益、手续费、资金费和成交记录' },
  { exchange: 'binance', title: '币安虚拟账户', detail: '模拟盈亏、余额和虚拟订单' },
] as const;

export default function AccountPerformance({ api, ...performance }: Props) {
  const [selected, select] = useState<'okx' | 'binance'>('okx');
  return <>
    <div className="account-ledger-switcher" role="group" aria-label="选择收益账本">
      {accounts.map(({ exchange, title, detail }) => <button
        key={exchange} type="button" className={'account-ledger-choice ' + exchange}
        aria-pressed={selected === exchange} aria-controls="account-ledger-panel"
        onClick={() => select(exchange)}
      >
        <span className="account-ledger-mark"><ExchangeMark exchange={exchange}/></span>
        <span className="account-ledger-choice-text"><strong>{title}</strong><small>{detail}</small></span>
        <ArrowRight size={17} aria-hidden="true" className="account-ledger-arrow"/>
      </button>)}
    </div>
    <div id="account-ledger-panel">
      {selected === 'okx' ? <Performance {...performance}/> : <><BinancePaperLedger api={api}/><PaperReviews api={api}/></>}
    </div>
  </>;
}
