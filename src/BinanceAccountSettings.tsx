
import { useEffect,useState } from 'react';

type Api=(path:string,body?:unknown)=>Promise<any>;
type LiveSnapshot={updatedAt:string; account?:{walletBalance:string;unrealizedPnl:string};positions:{symbol:string;quantity:string;unrealizedPnl:string;marginAsset:string}[]};

export default function BinanceAccountSettings({api}:{api:Api}){
  const [mode,setMode]=useState('');
  const [live,setLive]=useState<LiveSnapshot|null>(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  useEffect(()=>{
    void Promise.all([api('/binance-demo/sync-mode'),api('/binance-demo/live-account')])
      .then(([sync,account])=>{setMode(sync.mode);setLive(account.snapshot)})
      .catch(()=>setError('暂时无法读取币安账户设置。'));
  },[api]);
  async function change(value:string){
    setBusy(true);setError('');
    try{setMode((await api('/binance-demo/sync-mode',{mode:value})).mode)}
    catch{setError('同步设置保存失败。')}
    finally{setBusy(false)}
  }
  return <>
    <section className="panel settings">
      <h2>币安模拟账户同步</h2>
      <select aria-label="币安同步模式" value={mode} disabled={!mode||busy} onChange={e=>void change(e.target.value)}>
        <option value="" disabled>读取中</option>
        <option value="on_open">开仓触发</option><option value="always">持续同步</option><option value="paused">暂停账户同步</option>
      </select>
      <p>开仓触发模式从 QuantOS 或 Chat 提交开仓后开始同步，仓位和入场挂单都结束时停止。挂单保护监控独立运行。</p>
      {error&&<p role="alert">{error}</p>}
    </section>
    <section className="panel settings">
      <h2>币安真实账户 · 只读</h2>
      {live?<><p>上次同步 {new Date(live.updatedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}（北京时间）</p>
        <p>钱包余额 {live.account?.walletBalance??'—'} USDT · 未实现盈亏 {live.account?.unrealizedPnl??'—'} USDT</p>
        {live.positions.map(p=><div className="setting" key={p.symbol+':'+p.quantity}><span>{p.symbol} · {p.quantity}</span><b>{p.unrealizedPnl} {p.marginAsset}</b></div>)}</>:<p>待接入。将只读 HMAC 凭证配置到 VPS 的 /etc/quantos-binance/live-readonly.json。字段为 key 和 secret，文件权限设为 600。</p>}
    </section>
  </>;
}
