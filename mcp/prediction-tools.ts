import { strategyRef } from './strategy-tools';

const id={type:'string',pattern:'^[a-f0-9]{32}$'};
const symbol={type:'string',pattern:'^[A-Z0-9]{2,20}USDT$'};
const make=(name:string,description:string,properties:Record<string,unknown>,required:string[],read:boolean)=>({
  name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},
  annotations:{readOnlyHint:read,destructiveHint:name==='quantos_prediction_cancel',idempotentHint:true,openWorldHint:false}
});
export const predictionTools=[
 make('quantos_prediction_reference','读取 Binance Demo 真实已收盘 1m 锚点。返回 referenceTime、referencePrice 和 suggestedStartAt。以 suggestedStartAt 为首根预测 K 线的 time。',{symbol},['symbol'],true),
 make('quantos_prediction_create','先读取 quantos_strategy_active，再提交不可覆写的预测草稿与其版本、哈希及 generation。forecast.interval=1m，必须给出连续 15 根 {time,open,high,low,close}，time 为 UTC 毫秒。首根 time 使用 suggestedStartAt。plan 同时填写入场、失效和风险参数。确认前请在 Chat 中把同一组 OHLC 画成红绿蜡烛图，含实体与上下影线。',{id,strategy:strategyRef,plan:{type:'object',description:'完整 PathMatch JSON，参考 docs/pathmatch-v26.md'}},['id','strategy','plan'],false),
 make('quantos_prediction_arm','用户明确授权后启用这个预测的 SHADOW 观察。服务器核对已收盘锚点并锁定 ATR。',{id,mode:{type:'string',enum:['SHADOW']},confirm:{type:'boolean',const:true}},['id','mode','confirm'],false),
 make('quantos_prediction_status','读取冻结预测与已收盘实际 OHLC、轨迹相似度、高低区间重合度、趋势一致度与综合拟合度；用同一时间及价格坐标绘制两组蜡烛。收齐 15 根后才返回最终结果。result.adaptive 包含按已收盘 1m 滚动选参、未来 OHLC、锁定时间和上一轮预测的实测均分。REVIEW 表示待人工复核。',{id},['id'],true),
 make('quantos_prediction_cancel','明确确认后停止影子预测观察。历史与已采集曲线保留。',{id,confirm:{type:'boolean',const:true}},['id','confirm'],false),
 make('quantos_prediction_history','按币种、版本、状态及 UTC 毫秒时间范围读取历史预测。',{symbol,version:{type:'string'},state:{type:'string'},from:{type:'integer'},to:{type:'integer'},limit:{type:'integer',minimum:1,maximum:50}},[],true)
];
export const predictionPaths:Record<string,string>=Object.fromEntries(['reference','create','arm','status','cancel','history']
  .map(key=>['quantos_prediction_'+key,key]));
