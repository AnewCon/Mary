import { useEffect, useState, type ReactNode } from 'react';
import { BookOpen, Layers } from 'lucide-react';
import { BinancePaperLedger, ExchangeMark } from './ExchangeAccounts';
import Performance from './Performance';
import PaperReviews from './PaperReviews';

const phoneQuery = '(max-width: 780px)';

export function usePhoneLayout() {
  const [phone, setPhone] = useState(() => window.matchMedia(phoneQuery).matches);
  useEffect(() => {
    const media = window.matchMedia(phoneQuery);
    const update = () => setPhone(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return phone;
}

type Props = {
  api: (path: string, body?: unknown) => Promise<unknown>;
  okxPositions: ReactNode;
  performance: Parameters<typeof Performance>[0];
};

export default function MobileDashboard({ api, okxPositions, performance }: Props) {
  const [panel, setPanel] = useState<'positions' | 'earnings'>('positions');
  const [exchange, setExchange] = useState<'okx' | 'binance'>('okx');
  return <section className="phone-dashboard">
    <nav className="phone-primary" aria-label="手机端板块">
      <button type="button" aria-pressed={panel === 'positions'} onClick={() => setPanel('positions')}><Layers size={17}/>仓位</button>
      <button type="button" aria-pressed={panel === 'earnings'} onClick={() => setPanel('earnings')}><BookOpen size={17}/>收益</button>
    </nav>
    <div className="phone-exchanges" role="group" aria-label="选择账户">
      <button type="button" className="okx" aria-pressed={exchange === 'okx'} onClick={() => setExchange('okx')}><ExchangeMark exchange="okx"/>欧易账户</button>
      <button type="button" className="binance" aria-pressed={exchange === 'binance'} onClick={() => setExchange('binance')}><ExchangeMark exchange="binance"/>币安虚拟账户</button>
    </div>
    {exchange === 'binance'
      ? <><BinancePaperLedger api={api} positionsOnly={panel === 'positions'}/>{panel === 'earnings' && <PaperReviews api={api}/>}</>
      : panel === 'positions' ? okxPositions : <Performance {...performance}/>}
  </section>;
}
