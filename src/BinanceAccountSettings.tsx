
import { useEffect,useState } from 'react';

type Api=(path:string,body?:unknown)=>Promise<any>;

export default function BinanceAccountSettings({api}:{api:Api}){
  const [mode,setMode]=useState('');
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  useEffect(()=>{
    void api('/binance-demo/sync-mode')
      .then(sync=>setMode(sync.mode))
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
  </>;
}
