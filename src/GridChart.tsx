import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { priceFormat, type Candle, type Frame } from './grid-engine';

export type DrawingPoint={time:number;price:number};
type Segment={start:DrawingPoint;end:DrawingPoint};
export type Drawing={id:number;price:number}|({id:number}&Segment);

function segmentDistance(x:number,y:number,x1:number,y1:number,x2:number,y2:number){
 const dx=x2-x1,dy=y2-y1;
 const fraction=Math.max(0,Math.min(1,((x-x1)*dx+(y-y1)*dy)/(dx*dx+dy*dy||1)));
 return Math.hypot(x-(x1+dx*fraction),y-(y1+dy*fraction));
}
type Props={bars:Candle[];tick:string;step:number;levels:number[];stops:number[];lines:Drawing[];selected:number|null;locked:boolean;
 tool:'PAN'|'LINE'|'BOX'|'SEGMENT'|'ANGLE';anchor:number|null;frame?:Frame;frames?:Frame[];onPrice:(price:number)=>void;onSelect:(id:number)=>void;onSegment:(segment:Segment)=>void;
 onDrag:(which:'upper'|'lower',price:number,commit:boolean,angleTime?:number)=>void; angled:boolean; levelsAt?:(time:number)=>number[]};
const axisTime=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
export const fullTime=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
export default function GridChart(p:Props){
 const canvas=useRef<HTMLCanvasElement>(null);
 const geom=useRef<{left:number;right:number;top:number;bottom:number;index:(x:number)=>number;price:(y:number)=>number;y:(price:number)=>number;timeAt:(x:number)=>number;timeX:(time:number)=>number}|null>(null);
 const drag=useRef<{which?:'upper'|'lower';x:number;end:number;price?:number;toPrice?:(y:number)=>number;angleTime?:number;moving?:boolean;segment?:DrawingPoint}|null>(null);
 const [size,setSize]=useState({width:0,height:0});
 const [zoom,setZoom]=useState(110),[offset,setOffset]=useState(0);
 const [preview,setPreview]=useState<Segment|null>(null);
 const [cursor,setCursor]=useState<{x:number;y:number}|null>(null);
 const end=Math.max(1,p.bars.length-Math.min(offset,Math.max(0,p.bars.length-5)));
 const start=Math.max(0,end-zoom);
 const viewed=p.bars.slice(start,end);
 useEffect(()=>{
  const node=canvas.current!;
  const obs=new ResizeObserver(([entry])=>setSize({width:entry.contentRect.width,height:entry.contentRect.height}));
  obs.observe(node);
  const wheel=(e:WheelEvent)=>{e.preventDefault();setZoom(n=>Math.round(Math.min(420,Math.max(12,n*(e.deltaY<0?.84:1.19)))));};
  node.addEventListener('wheel',wheel,{passive:false});
  return ()=>{obs.disconnect();node.removeEventListener('wheel',wheel);};
 },[]);
 useEffect(()=>{
  const node=canvas.current;const {width,height}=size;
  if(!node||width<120||height<130)return;
  const ratio=window.devicePixelRatio||1;
  node.width=Math.round(width*ratio);node.height=Math.round(height*ratio);
  const ctx=node.getContext('2d');
  if(!ctx)return;
  ctx.scale(ratio,ratio);
  ctx.fillStyle='#111e23';ctx.fillRect(0,0,width,height);
  ctx.font='11px system-ui';
  if(!viewed.length){geom.current=null;return;}
  const right=width-81,left=10,top=19,bottom=height-91,volumeBottom=height-23;
  const visible=Math.max(viewed.length,8),dx=(right-left)/visible;
  const gridByBar=p.levelsAt?viewed.map(bar=>p.levelsAt!(bar.time)):null;
  const prices=[...viewed.flatMap(b=>[b.low,b.high]),...(gridByBar?gridByBar.flat():p.levels)];
  const lower=Math.min(...prices),upper=Math.max(...prices);
  const pad=(upper-lower||upper*.002)*.075;
  const min=lower-pad,max=upper+pad;
  const y=(n:number)=>top+(max-n)/(max-min)*(bottom-top);
  const price=(py:number)=>max-(py-top)/(bottom-top)*(max-min);
  const x=(index:number)=>left+(index+.5)*dx;
  const ix=(px:number)=>Math.min(viewed.length-1,Math.max(0,Math.floor((px-left)/dx)));
  const timeX=(time:number)=>x((time-viewed[0].time)/p.step);
  const timeAt=(px:number)=>viewed[0].time+((px-left)/dx-.5)*p.step;
  geom.current={left,right,top,bottom,index:ix,price,y,timeAt,timeX};
  const line=(x1:number,y1:number,x2:number,y2:number,color:string)=>{ctx.strokeStyle=color;ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();};
  for(let i=0;i<=5;i++){
   const yy=top+(bottom-top)*i/5;
   line(left,yy,right,yy,'#29393d');
   ctx.fillStyle='#a5bab8';ctx.fillText(priceFormat(price(yy),p.tick),right+5,yy+4);
  }
  const labels=Math.max(2,Math.min(6,Math.floor((right-left)/90)));
  for(let i=0;i<labels;i++){
   const index=Math.floor((viewed.length-1)*i/Math.max(1,labels-1)),px=x(index);
   line(px,top,px,volumeBottom,'#233438');
   ctx.fillStyle='#a5bab8';ctx.fillText(axisTime.format(viewed[index].time),Math.min(right-54,Math.max(left,px-26)),height-7);
  }
  line(right,top,right,volumeBottom,'#405458');
  const totalVolume=Math.max(1,...viewed.map(row=>row.volume));
  const times=new Map<number,number>();
  viewed.forEach((b,i)=>{
   const px=x(i),color=b.close>=b.open?'#72d2aa':'#ef7f88',body=Math.max(1.4,Math.abs(y(b.close)-y(b.open)));
   times.set(b.time,px);
   if(b.time===p.frame?.time){ctx.fillStyle='#dbc17424';ctx.fillRect(px-dx/2,top,dx,volumeBottom-top);}
   line(px,y(b.high),px,y(b.low),color);
   const ww=Math.max(1,Math.min(12,dx*.66));
   ctx.fillStyle=color;ctx.fillRect(px-ww/2,Math.min(y(b.open),y(b.close)),ww,body);
   ctx.globalAlpha=.48;
   const vol=(volumeBottom-bottom-7)*b.volume/totalVolume;
   ctx.fillRect(px-ww/2,volumeBottom-vol,ww,vol);ctx.globalAlpha=1;
  });
  const mark=(v:number,color:string,dash:number[]=[],highlight=false)=>{
   const py=y(v);
   if(py<top||py>bottom)return;
   ctx.lineWidth=highlight?2:1;ctx.setLineDash(dash);
   line(left,py,right,py,color);
   ctx.setLineDash([]);ctx.lineWidth=1;
  };
  const newest=p.frame?.events??[];
  if(gridByBar&&gridByBar.length>1){
   ctx.save();ctx.beginPath();ctx.rect(left,top,right-left,bottom-top);ctx.clip();
   const latest=gridByBar[gridByBar.length-1];
   for(let i=0;i<latest.length;i++){
    const outer=i===0||i===latest.length-1;
    ctx.strokeStyle=i===0?'#67ce9e':i===latest.length-1?'#ed8791':'#719caf';
    ctx.lineWidth=newest.some(e=>e.kind==='OPEN'&&e.price===latest[i])?2:1;
    ctx.setLineDash(outer?[]:[3,4]);ctx.beginPath();
    gridByBar.forEach((levels,index)=>{if(index===0)ctx.moveTo(x(index),y(levels[i]));else ctx.lineTo(x(index),y(levels[i]));});
    ctx.stroke();
   }
   ctx.restore();
  }else p.levels.forEach((level,i)=>mark(level,i===0?'#67ce9e':i===p.levels.length-1?'#ed8791':'#719caf',
   i===0||i===p.levels.length-1?[]:[3,4],newest.some(e=>e.kind==='OPEN'&&e.price===level)));
  p.stops.forEach(v=>{if(v>0)mark(v,'#edaf68',[5,4]);});
  ctx.save();
  ctx.beginPath();ctx.rect(left,top,right-left,bottom-top);ctx.clip();
  const renderSegment=(s:Segment,color:string,handles:boolean)=>{
   const x1=timeX(s.start.time),y1=y(s.start.price),x2=timeX(s.end.time),y2=y(s.end.price);
   ctx.lineWidth=handles?2:1.5;
   line(x1,y1,x2,y2,color);
   if(handles){
    ctx.fillStyle=color;
    for(const [px,py] of [[x1,y1],[x2,y2]]){ctx.beginPath();ctx.arc(px,py,3,0,Math.PI*2);ctx.fill();}
   }
   ctx.lineWidth=1;
  };
  for(const drawing of p.lines){
   const selected=drawing.id===p.selected;
   if('price' in drawing)mark(drawing.price,selected?'#fff0b8':'#babca8',[4,2],selected);
   else renderSegment(drawing,selected?'#fff0b8':'#b7d4fa',selected);
  }
  if(preview)renderSegment(preview,'#f2cf84',true);
  ctx.restore();
  if(p.anchor)mark(p.anchor,'#e8ca83',[3,3],true);
  const openDrawn=new Map<number,{x:number;y:number}>();
  for(const frame of p.frames?.slice(start,end)??[]){
   const px=times.get(frame.time);
   if(px===undefined)continue;
   for(const e of frame.events){
    const yy=y(e.price);
    if(yy<top||yy>bottom)continue;
    const which=e.kind==='OPEN'?'▲':e.kind==='CLOSE'?'▼':'◆';
    const color=e.kind==='OPEN'?'#cdb1ff':e.kind==='CLOSE'?'#f2cf84':'#ffab7c';
    if(e.id&&e.kind==='OPEN')openDrawn.set(e.id,{x:px,y:yy});
    if(e.id&&e.kind==='CLOSE'){
      const prev=openDrawn.get(e.id);
      if(prev){ctx.setLineDash([2,4]);line(prev.x,prev.y,px,yy,color);ctx.setLineDash([]);}
    }
    ctx.fillStyle=color;ctx.fillText(which,px-4,yy-4);
   }
  }
  if(p.frame){
   const py=y(p.frame.price);
   if(py>=top&&py<=bottom){
    mark(p.frame.price,'#d6be76',[3,4]);ctx.fillStyle='#e5ca80';ctx.fillRect(right,py-8,width-right,16);
    ctx.fillStyle='#142023';ctx.fillText(priceFormat(p.frame.price,p.tick),right+4,py+4);
   }
  }
  if(cursor&&cursor.x>=left&&cursor.x<=right&&cursor.y>=top&&cursor.y<=volumeBottom){
   const i=ix(cursor.x);
   ctx.setLineDash([3,3]);line(x(i),top,x(i),volumeBottom,'#7e9695');line(left,cursor.y,right,cursor.y,'#7e9695');ctx.setLineDash([]);
   ctx.fillStyle='#31494c';ctx.fillRect(right,cursor.y-8,width-right,16);ctx.fillStyle='#dbefec';
   ctx.fillText(priceFormat(Math.max(0,price(cursor.y)),p.tick),right+4,cursor.y+4);
  }
 },[size,p,zoom,offset,cursor,preview]);
 function position(e:ReactPointerEvent<HTMLCanvasElement>){
  const rect=e.currentTarget.getBoundingClientRect();
  return {x:e.clientX-rect.left,y:e.clientY-rect.top};
 }
 function drawingPoint(pos:{x:number;y:number},g:NonNullable<typeof geom.current>){
  const x=Math.min(g.right,Math.max(g.left,pos.x)),y=Math.min(g.bottom,Math.max(g.top,pos.y));
  return {time:g.timeAt(x),price:Math.max(Number(p.tick),g.price(y))};
 }
 function move(e:ReactPointerEvent<HTMLCanvasElement>){
  const pos=position(e),g=geom.current,d=drag.current;
  if(!g)return;
  setCursor(pos);
  if(!d)return;
  if(d.segment){
   const end=drawingPoint(pos,g);
   if(e.shiftKey)end.price=d.segment.price;
   setPreview({start:d.segment,end});
   return;
  }
  if(d.which){
   d.price=(d.toPrice??g.price)(Math.min(g.bottom,Math.max(g.top,pos.y)));
   d.moving=true;p.onDrag(d.which,d.price,false,d.angleTime);
  }else if(p.tool==='PAN'){
   const delta=pos.x-d.x;
   if(Math.abs(delta)>4)d.moving=true;
   if(d.moving)setOffset(Math.max(0,Math.min(p.bars.length-5,d.end+Math.round(delta/((g.right-g.left)/Math.max(8,viewed.length))))));
  }
 }
 function down(e:ReactPointerEvent<HTMLCanvasElement>){
  const pos=position(e),g=geom.current;
  if(e.button!==0||!e.isPrimary||!g||pos.x<g.left||pos.x>g.right||pos.y<g.top||pos.y>g.bottom)return;
  if(p.tool==='SEGMENT'&&!p.locked){
   const start=drawingPoint(pos,g);
   drag.current={x:pos.x,end:offset,segment:start};
   setPreview({start,end:start});
   e.currentTarget.setPointerCapture(e.pointerId);
   return;
  }
  const at=viewed[g.index(pos.x)]?.time;
  const levels=(p.levelsAt&&at!==undefined?p.levelsAt(at):p.levels);
  const upper=levels.at(-1),lower=levels[0];
  const canDrag=!p.locked&&(p.tool==='ANGLE'||p.tool==='PAN'&&!p.angled);
  const which=canDrag&&upper&&Math.abs(pos.y-g.y(upper))<9?'upper':
   canDrag&&lower&&Math.abs(pos.y-g.y(lower))<9?'lower':undefined;
  drag.current={x:pos.x,end:offset,which,toPrice:g.price,angleTime:p.tool==='ANGLE'?at:undefined};
  e.currentTarget.setPointerCapture(e.pointerId);
 }
 function up(e:ReactPointerEvent<HTMLCanvasElement>){
  const d=drag.current,g=geom.current,pos=position(e);drag.current=null;
  if(!d||!g)return;
  if(d.segment){
   setPreview(null);
   const end=drawingPoint(pos,g);
   if(e.shiftKey)end.price=d.segment.price;
   if(Math.hypot(g.timeX(end.time)-g.timeX(d.segment.time),g.y(end.price)-g.y(d.segment.price))>=4)
    p.onSegment({start:d.segment,end});
   return;
  }
  if(d.which&&d.moving&&d.price!==undefined){p.onDrag(d.which,d.price,true,d.angleTime);return;}
  if(d.moving||pos.y<g.top||pos.y>g.bottom)return;
  if((p.tool==='LINE'||p.tool==='BOX')&&!p.locked){p.onPrice(g.price(pos.y));return;}
  const line=[...p.lines].reverse().find(l=>'price' in l?Math.abs(pos.y-g.y(l.price))<8:
   segmentDistance(pos.x,pos.y,g.timeX(l.start.time),g.y(l.start.price),g.timeX(l.end.time),g.y(l.end.price))<8);
  p.onSelect(line?.id??0);
 }
 const hovered=cursor&&geom.current&&viewed[geom.current.index(cursor.x)];
 const candle=hovered||viewed.at(-1);
 return <div className="grid-chart-pane">
  {candle&&<div className="grid-chart-ohlc"><span>{axisTime.format(candle.time)}</span>
   {([['开',candle.open],['高',candle.high],['低',candle.low],['收',candle.close]] as const).map(([label,v])=><span key={label}>{label} {priceFormat(v,p.tick)}</span>)}
   <span>量 {candle.volume.toLocaleString('zh-CN',{maximumFractionDigits:2})}</span></div>}
  <canvas aria-label="历史蜡烛图与成交量" ref={canvas} className={'grid-chart grid-tool-'+p.tool.toLowerCase()}
   onPointerMove={move} onPointerDown={down} onPointerUp={up} onPointerLeave={()=>setCursor(null)}
   onPointerCancel={()=>{if(drag.current?.which&&drag.current.price!==undefined)p.onDrag(drag.current.which,drag.current.price,true,drag.current.angleTime);drag.current=null;setPreview(null);}}/>
  {offset>0&&<button className="grid-return-chart" type="button" onClick={()=>setOffset(0)}>回到最新</button>}
 </div>;
}
