export type Candle={time:number;open:number;high:number;low:number;close:number;volume:number};
export type Funding={time:number;rate:number;mark:number|null};
export type Rules={tick:string;quantityStep:string;minQty:number;maxQty:number;minNotional:number;minPrice:number;maxPrice:number;marketMinQty:number};
export type GridMarket={symbol:string;interval:string;step:number;requestedFrom:number;from:number;to:number;rules:Rules;candles:Candle[];funding:Funding[]|null};
export type Breakout='CLOSE'|'HOLD'|'PAUSE';
export type Side='LONG'|'SHORT';
export type GridConfig={
 lower:number;upper:number;upperAngle?:number;lowerAngle?:number;count:number;spacing:'LINEAR'|'GEOMETRIC';direction:Side|'NEUTRAL';capital:number;leverage:number;
 size:number;sizeMode:'MARGIN'|'QUANTITY';maxPositions:number;up:Breakout;down:Breakout;stopUpper:number;stopLower:number;
 maxLoss:number;drawdown:number;trailing:number;disableOnBreak:boolean;maker:number;taker:number;slippage:number;
 maintenance:number;fundingMode:'HISTORY'|'FIXED'|'OFF';fundingRate:number;
};
export const defaults:GridConfig={lower:0,upper:0,count:6,spacing:'LINEAR',direction:'SHORT',capital:80,leverage:10,size:5,
 sizeMode:'MARGIN',maxPositions:3,up:'CLOSE',down:'CLOSE',stopUpper:0,stopLower:0,maxLoss:8,drawdown:20,trailing:0,
 disableOnBreak:true,maker:0.02,taker:0.05,slippage:0.05,maintenance:0.5,fundingMode:'HISTORY',fundingRate:0};
const precision=(s:string)=>s.split('.')[1]?.replace(/0+$/,'').length??0;
export const priceFormat=(value:number,tick:string)=>value.toFixed(Math.min(16,pricePrecision(tick)));
const pricePrecision=(tick:string)=>tick.includes('e-')?Number(tick.split('e-')[1]):precision(tick);
function units(value:number,increment:string,down=false){
 const amount=value/Number(increment);
 if(!Number.isFinite(amount)||Math.abs(amount)>Number.MAX_SAFE_INTEGER)throw Error('价格或数量超出可处理精度');
 const count=down?Math.floor(amount+Number.EPSILON*amount*2):Math.round(amount);
 return Number((count*Number(increment)).toFixed(Math.min(16,pricePrecision(increment))));
}
export const snapPrice=(value:number,rules:Rules)=>units(value,rules.tick);
export function gridLevels(c:Pick<GridConfig,'lower'|'upper'|'count'|'spacing'>,rules:Rules){
 if(!Number.isInteger(c.count)||c.count<2||c.count>100||!Number.isFinite(c.lower)||c.lower<=0||!Number.isFinite(c.upper)||c.upper<=c.lower)
  throw Error('请输入有效的箱体上下限及 2–100 格。');
 const min=units(c.lower,rules.tick),max=units(c.upper,rules.tick);
 if(min<=0||min<rules.minPrice||max>rules.maxPrice)throw Error('箱体价格超出合约范围。');
 const prices=Array.from({length:c.count+1},(_,i)=>units(c.spacing==='LINEAR'?min+(max-min)*i/c.count:min*Math.exp(Math.log(max/min)*i/c.count),rules.tick));
 if(prices.some((price,i)=>i>0&&price<=prices[i-1]))throw Error('这段价格范围放不下这么多格，请减少格数或扩大箱体。');
 return prices;
}

export function channelBox(c:Pick<GridConfig,'lower'|'upper'|'upperAngle'|'lowerAngle'>,progress:number){
 const height=c.upper-c.lower;
 const shift=(angle:number)=>Math.tan(angle*Math.PI/180)*height*Math.min(1,Math.max(0,progress));
 const upperAngle=c.upperAngle??0,lowerAngle=c.lowerAngle??0;
 if(![upperAngle,lowerAngle].every(x=>Number.isFinite(x)&&Math.abs(x)<=80))throw Error('角度须在 -80° 到 80° 之间。');
 return {lower:c.lower+shift(lowerAngle),upper:c.upper+shift(upperAngle)};
}
export function moveChannelStart(c:GridConfig,rules:Rules,edge:'upper'|'lower',price:number,progress:number){
 if(!Number.isFinite(price)||progress<0||progress>=.995)throw Error('请在靠近左端的位置调整。');
 const end=channelBox(c,1);
 const start=units((price-progress*end[edge])/(1-progress),rules.tick);
 const next={...c,[edge]:start};
 const height=next.upper-next.lower;
 if(height<=0)throw Error('箱体上下沿不能交叉。');
 const degrees=(shift:number)=>Math.atan(shift/height)*180/Math.PI;
 next.upperAngle=degrees(end.upper-next.upper);
 next.lowerAngle=degrees(end.lower-next.lower);
 channelLevels(next,rules,0);
 channelLevels(next,rules,1);
 return {upper:next.upper,lower:next.lower,upperAngle:next.upperAngle,lowerAngle:next.lowerAngle};
}
export function channelLevels(c:GridConfig,rules:Rules,progress:number){
 return gridLevels({...c,...channelBox(c,progress)},rules);
}

type Open={id:number;slot:number;side:Side;qty:number;entry:number;openedAt:number;margin:number;openFee:number;funding:number;best:number;bar:number};
export type Trade=Omit<Open,'best'|'bar'>&{exit:number;closedAt:number;closeFee:number;fees:number;gross:number;net:number;reason:string};
export type GridEvent={time:number;price:number;kind:'OPEN'|'CLOSE'|'BREAKOUT'|'STOP';side?:Side;id?:number;net?:number;reason?:string};
export type Frame={time:number;price:number;equity:number;available:number;margin:number;realized:number;floating:number;net:number;
 fees:number;funding:number;drawdown:number;open:Open[];done:number;wins:number;events:GridEvent[];state:string};

export function simulateGrid(market:GridMarket,c:GridConfig){
 const {candles,rules,step}=market,initialLevels=gridLevels(c,rules);
 const acceptable=(v:number,min:number,max:number)=>Number.isFinite(v)&&v>=min&&v<=max;
 if(!candles.length||![c.capital,c.size].every(x=>acceptable(x,0.00000001,1e9))||!Number.isInteger(c.leverage)||
  !acceptable(c.leverage,1,125)||!Number.isInteger(c.maxPositions)||!acceptable(c.maxPositions,1,100)||
  ![c.maker,c.taker,c.slippage,c.maintenance].every(v=>acceptable(v,0,10))||
  ![c.drawdown,c.trailing].every(v=>acceptable(v,0,100))||!acceptable(c.maxLoss,0,1e9)||
  !acceptable(c.fundingRate,-10,10))throw Error('请检查资金、杠杆、费率及风控参数。');
 const endpoint=channelLevels(c,rules,1);
 const minBoundary=Math.min(initialLevels[0],endpoint[0]),maxBoundary=Math.max(initialLevels.at(-1)!,endpoint.at(-1)!);
 const isTilted=!!(c.upperAngle||c.lowerAngle);
 const barLevels=isTilted?candles.map(b=>channelLevels(c,rules,(b.time-market.from)/(market.to-market.from))):null;
 const minStop=c.stopLower?units(c.stopLower,rules.tick):0,maxStop=c.stopUpper?units(c.stopUpper,rules.tick):0;
 if((c.stopLower&&!(minStop>=rules.minPrice&&minStop>0&&minStop<minBoundary))||(c.stopUpper&&!(maxStop>maxBoundary&&maxStop<=rules.maxPrice)))
  throw Error('硬止损应位于箱体外，且满足合约价格范围。');
 if(c.fundingMode==='HISTORY'&&!market.funding)throw Error('历史资金费率缺失。可改用自定义或关闭后重新模拟。');

 const funding=c.fundingMode==='FIXED'?candles.flatMap(b=>b.time%28800000===0?[{time:b.time,rate:c.fundingRate/100,mark:null}]:[]):
  c.fundingMode==='HISTORY'?market.funding!:[];
 const positions=new Map<number,Open>(),trades:Trade[]=[],frames:Frame[]=[];
 let sequence=0,realized=0,fees=0,fundingNet=0,peak=c.capital,maxDrawdown=0,stops=0,settlement=0,wins=0,rejectedOrders=0;
 let state='RUNNING',entryOff=false,previousUp=false,previousDown=false;
 const pivot=candles[0].open;
 const gross=(p:Open,price:number)=>(price-p.entry)*p.qty*(p.side==='LONG'?1:-1);
 const float=(price:number)=>[...positions.values()].reduce((sum,p)=>sum+gross(p,price),0);
 const margin=()=>[...positions.values()].reduce((sum,p)=>sum+p.margin,0);
 const equity=(price:number)=>c.capital+realized-fees+fundingNet+float(price);
 const finish=(p:Open,raw:number,time:number,events:GridEvent[],reason:string,limit:boolean)=>{
  const slip=limit?0:c.slippage/100;
  const price=limit?raw:units(raw*(p.side==='LONG'?1-slip:1+slip),rules.tick);
  const charged=price*p.qty*(limit?c.maker:c.taker)/100;
  const proceeds=gross(p,price),net=proceeds-p.openFee-charged+p.funding;
  realized+=proceeds;fees+=charged;if(net>0)wins++;
  positions.delete(p.slot);
  trades.push({...p,exit:price,closedAt:time,closeFee:charged,fees:p.openFee+charged,gross:proceeds,net,reason});
  events.push({id:p.id,time,price,side:p.side,kind:'CLOSE',reason,net});
 };
 for(const [index,b] of candles.entries()){
  if(state==='HALTED'||state==='PAUSED')break;
  const levels=barLevels?.[index]??initialLevels;
  const low=levels[0],high=levels.at(-1)!;
  const events:GridEvent[]=[];
  const previous=candles[index-1]?.close??b.open;
  while(funding[settlement]&&funding[settlement].time<b.time+step){
   const f=funding[settlement++];
   // Charge observable positions at the candle boundary before any simulated intrabar fill.
   const mark=f.mark??b.open;
   for(const p of positions.values()){
    const charge=p.qty*mark*f.rate*(p.side==='LONG'?-1:1);
    p.funding+=charge;fundingNet+=charge;
   }
  }
  const adverse=[...positions.values()].reduce((n,p)=>n+gross(p,p.side==='LONG'?b.low:b.high),0);
  const worst=c.capital+realized-fees+fundingNet+adverse;
  const riskDrawdown=positions.size?Math.max(0,(peak-worst)/peak*100):0;
  const upperStop=maxStop>0&&b.high>=maxStop,lowerStop=minStop>0&&b.low<=minStop;
  const stopPrice=(p:Open)=>p.side==='LONG'&&lowerStop?Math.min(b.open,minStop):
   p.side==='SHORT'&&upperStop?Math.max(b.open,maxStop):p.side==='LONG'?b.low:b.high;
  const liquidation=[...positions.values()].some(p=>{
   const price=upperStop||lowerStop?stopPrice(p):p.side==='LONG'?b.low:b.high;
   return p.margin+gross(p,price)+p.funding<=p.qty*price*c.maintenance/100;
  });
  let reason=liquidation?'ESTIMATED_LIQUIDATION':upperStop||lowerStop?'HARD_STOP':
   c.maxLoss>0&&worst<=c.capital-c.maxLoss?'LOSS_LIMIT':
   c.drawdown>0&&riskDrawdown>=c.drawdown?'DRAWDOWN_LIMIT':'';
  if(reason){
   stops++;state='HALTED';
   events.push({kind:'STOP',time:b.time,price:upperStop?maxStop:lowerStop?minStop:b.close,reason});
   for(const p of [...positions.values()]){
    const fallback=p.side==='LONG'?b.low:b.high;
    finish(p,reason==='HARD_STOP'?stopPrice(p):fallback,b.time,events,reason,false);
   }
  }else{
   const crossedUp=b.high>high,crossedDown=b.low<low;
   const breached=crossedUp||crossedDown;
   if(crossedUp&&!previousUp||crossedDown&&!previousDown){
    if(crossedUp)events.push({kind:'BREAKOUT',time:b.time,price:high,reason:'UPPER_BREAKOUT'});
    if(crossedDown)events.push({kind:'BREAKOUT',time:b.time,price:low,reason:'LOWER_BREAKOUT'});
    const policies=[...(crossedUp?[c.up]:[]),...(crossedDown?[c.down]:[])];
    if(policies.includes('CLOSE')||policies.includes('PAUSE')){
     const pause=!policies.includes('CLOSE');
     reason=pause?'REDRAW_REQUIRED':'BREAKOUT_EXIT';state=pause?'PAUSED':'HALTED';
     for(const p of [...positions.values()]){
      const upperExit=Math.max(high,b.open),lowerExit=Math.min(low,b.open);
      const price=crossedUp&&crossedDown?(p.side==='LONG'?lowerExit:upperExit):crossedUp?upperExit:lowerExit;
      finish(p,price,b.time,events,reason,false);
     }
    }else if(c.disableOnBreak)entryOff=true;
   }
   previousUp=crossedUp;previousDown=crossedDown;
   if(state==='RUNNING'){
    for(const p of [...positions.values()]){
     const long=p.side==='LONG',target=levels[p.slot+(long?1:0)];
     const trailing=long?p.best*(1-c.trailing/100):p.best*(1+c.trailing/100);
     const trailHit=c.trailing>0&&(long?trailing>p.entry&&b.low<=trailing:trailing<p.entry&&b.high>=trailing);
     if(trailHit){finish(p,long?Math.min(b.open,trailing):Math.max(b.open,trailing),b.time,events,'TRAILING_STOP',false);continue;}
     if(long?b.high>=target:b.low<=target)finish(p,target,b.time,events,'GRID_TARGET',true);
    }
    if(!breached&&!entryOff){
     const closedThisBar=new Set(trades.slice(Math.max(0,trades.length-events.length)).filter(p=>p.closedAt===b.time).map(p=>p.slot));
     const possible:{slot:number;side:Side;entry:number}[]=[];
     for(let slot=0;slot<levels.length-1;slot++){
      const [lower,upper]=levels.slice(slot,slot+2);
      const neutralSide=initialLevels[slot+1]<=pivot?'LONG':initialLevels[slot]>=pivot?'SHORT':null;
      const side=c.direction==='NEUTRAL'?neutralSide:c.direction;
      if(!side||positions.has(slot)||closedThisBar.has(slot))continue;
      const entry=side==='LONG'?lower:upper;
      if(side==='LONG'?previous>=entry&&b.low<=entry:previous<=entry&&b.high>=entry)possible.push({slot,side,entry});
     }
     possible.sort((a,b)=>Math.abs(a.entry-previous)-Math.abs(b.entry-previous)||a.slot-b.slot);
     for(const order of possible){
      if(positions.size>=c.maxPositions)break;
      // Neutral owns each grid interval once, with one net side at a time.
      if(c.direction==='NEUTRAL'&&[...positions.values()].some(p=>p.side!==order.side))continue;
      const qty=units(c.sizeMode==='MARGIN'?c.size*c.leverage/order.entry:c.size,rules.quantityStep,true);
      const cost=qty*order.entry/c.leverage,fee=qty*order.entry*c.maker/100;
      if(qty<rules.minQty||qty<rules.marketMinQty||qty>rules.maxQty||qty*order.entry<rules.minNotional||
       cost+fee>Math.max(0,equity(order.entry)-margin())){rejectedOrders++;continue;}
      const p:Open={id:++sequence,slot:order.slot,side:order.side,qty,entry:order.entry,openedAt:b.time,margin:cost,openFee:fee,funding:0,best:order.entry,bar:index};
      positions.set(p.slot,p);fees+=fee;
      events.push({kind:'OPEN',time:b.time,price:p.entry,side:p.side,id:p.id});
     }
    }
    for(const p of positions.values())if(p.bar<index)p.best=p.side==='LONG'?Math.max(p.best,b.close):Math.min(p.best,b.close);
   }
  }
  const value=equity(b.close);
  peak=Math.max(peak,value);
  maxDrawdown=Math.max(maxDrawdown,riskDrawdown,(peak-value)/peak*100);
  frames.push({time:b.time,price:b.close,equity:value,available:Math.max(0,value-margin()),margin:margin(),realized,floating:float(b.close),
   net:value-c.capital,fees,funding:fundingNet,drawdown:maxDrawdown,open:[...positions.values()].map(p=>({...p})),
   done:trades.length,wins,events,state:reason||state});
 }
 const last=frames[frames.length-1];
 return {frames,trades,last,stops,rejectedOrders,state,best:trades.length?Math.max(...trades.map(p=>p.net)):null,
  worst:trades.length?Math.min(...trades.map(p=>p.net)):null,returnPct:last.net/c.capital*100};
}
export type GridResult=ReturnType<typeof simulateGrid>;
