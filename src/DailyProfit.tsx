export default function DailyProfit({data}:{data:any}){
 const amount=data?.currencies?.find((c:any)=>c.currency==='USDT');
 const value=amount?Number(amount.net):null;
 const formatted=value===null?'—':(value>0?'+':'')+value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:4});
 return <div className="today-profit" aria-label="北京时间今日总收益"><span className="today-label">今日总收益</span><strong className={value!==null&&value<0?'today-loss':'today-gain'}>{formatted}<small> USDT</small></strong><p>北京时间 00:00 起 · 已实现净收益</p><small className="today-status">{!data?'等待收益同步':data.error?'同步异常 · 保留已同步收益':!data.complete?'今日数据待同步 / 同步中':'含手续费与资金费 · 不含浮动盈亏'}</small></div>
}
