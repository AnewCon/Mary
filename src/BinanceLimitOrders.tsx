import { useEffect, useState } from 'react';
import FoldPanel from './FoldPanel';

type Leg = { status: string; code?: string };
type Order = {
  id: string; state: string; submittedAt: string;
  action: {symbol: string; side: string; quantity: string; strategyVersion?: string};
  result: null | {
    orderState?: string; exchangeStatus?: string; exchangeOrderId?: string; createdAt?: number; expiresAt?: number;
    executedQuantity?: string; averagePrice?: string; cancelResult?: string; protection?: { stopLoss?: Leg; takeProfit?: Leg };
    triggerType?: string; riskBlocked?: boolean; code?: string; errors?: {time: number; step: string; code: string}[];
  };
};
const format = (time: number) => new Date(time).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'});
const leg = (value?: Leg) => value?.status === 'NEW' ? '已挂单' : value ? [value.status, value.code].filter(Boolean).join(' · ') : '待安装';

export default function BinanceLimitOrders({api}: {api:(path:string)=>Promise<Order[]>}) {
  return <FoldPanel title="模拟盘限价订单"><OrderList api={api}/></FoldPanel>;
}

function OrderList({api}: {api:(path:string)=>Promise<Order[]>}) {
  const [orders,setOrders]=useState<Order[]|null>(null);
  const [error,setError]=useState(false);
  const [now,setNow]=useState(Date.now);
  useEffect(()=>{
    let active=true;
    const load=async()=>{
      try{const data=await api('/binance-demo/limits');if(active){setOrders(data);setError(false);}}
      catch{if(active)setError(true);}
    };
    void load();
    const refresh=window.setInterval(load,10000), clock=window.setInterval(()=>setNow(Date.now()),1000);
    return ()=>{active=false;window.clearInterval(refresh);window.clearInterval(clock);};
  },[api]);
  return <div className="exchange-body">
    <p>限价入场验收期间暂停新挂单。已有订单继续跟踪。</p>
    {error && <p role="alert">暂时无法读取订单状态。</p>}
    {!orders?.length && <p>{orders ? '暂无限价订单。' : '正在读取订单。'}</p>}
    {orders?.map(order=>{
      const data=order.result;
      const status=data?.orderState ?? data?.exchangeStatus ?? (['rejected','unknown'].includes(order.state)||order.state==='queued'&&now-Date.parse(order.submittedAt)>120000?'ERROR':'PENDING');
      const seconds=data?.expiresAt ? Math.max(0,Math.ceil((data.expiresAt-now)/1000)) : null;
      const pending=['NEW','PARTIALLY_FILLED','CANCEL_PENDING'].includes(status);
      return <article key={order.id} className="phone-position" style={{marginBottom:10}}>
        <div><strong>{order.action.symbol} · {order.action.side==='LONG'?'多':'空'} · {status}</strong><small>{data?.exchangeOrderId ?? order.id}</small></div>
        <dl>
          <div><dt>交易所创建时间</dt><dd>{data?.createdAt ? format(data.createdAt) : '待确认'}</dd></div>
          <div><dt>剩余有效期</dt><dd>{!pending||seconds===null?'—':seconds>0?Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0'):'已到期，等待交易所确认'}</dd></div>
          <div><dt>委托 / 成交数量</dt><dd>{order.action.quantity} / {data?.executedQuantity ?? '—'}</dd></div>
          <div><dt>实际成交均价</dt><dd>{data?.executedQuantity && Number(data.executedQuantity)>0 ? data.averagePrice : '—'}</dd></div>
          <div><dt>撤单确认</dt><dd>{data?.cancelResult ?? '—'}</dd></div>
          <div><dt>策略版本</dt><dd>{order.action.strategyVersion ?? '旧版'}</dd></div>
          <div><dt>止损</dt><dd>{leg(data?.protection?.stopLoss)}</dd></div>
          <div><dt>止盈</dt><dd>{leg(data?.protection?.takeProfit)}</dd></div>
          <div><dt>保护触发价格</dt><dd>{data?.triggerType==='CONTRACT_PRICE'?'最新成交价':'标记价格'}</dd></div>
        </dl>
        {data?.riskBlocked && <p className="red">保护状态待核查，已暂停新开仓。</p>}
        {data?.code && <small>{data.code}</small>}
        {data?.errors?.map((entry,index)=><p key={index}><small>{format(entry.time)} · {entry.step} · {entry.code}</small></p>)}
      </article>;
    })}
  </div>;
}
