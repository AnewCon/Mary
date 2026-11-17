const id={type:'string',pattern:'^[a-f0-9]{32}$'};
const symbol={type:'string',pattern:'^[A-Z0-9]{2,20}USDT$'};
const make=(name:string,description:string,properties:Record<string,unknown>,required:string[],read:boolean)=>({
  name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},
  annotations:{readOnlyHint:read,destructiveHint:name==='quantos_prediction_cancel',idempotentHint:true,openWorldHint:false}
});
export const predictionTools=[
 make('quantos_prediction_reference','读取 Binance Demo 真实已收盘 1m 锚点。创建预测时 referenceTime 填该根 K 线结束边界，referencePrice 填收盘价。',{symbol},['symbol'],true),
 make('quantos_prediction_create','保存新的不可覆写预测草稿。plan 需要完整的参考时间、三根 5m、价格、风险、验证条件和判断证据。仅支持 Binance Demo 的 SHADOW 影子观察。',{id,plan:{type:'object',description:'完整 PathMatch JSON，参考 docs/pathmatch-v26.md'}},['id','plan'],false),
 make('quantos_prediction_arm','用户明确授权后启用这个预测的 SHADOW 观察。服务器核对已收盘锚点并锁定 ATR。',{id,mode:{type:'string',enum:['SHADOW']},confirm:{type:'boolean',const:true}},['id','mode','confirm'],false),
 make('quantos_prediction_status','读取预测状态、相似度和实际收盘路径。',{id},['id'],true),
 make('quantos_prediction_cancel','明确确认后停止影子预测观察。历史与已采集曲线保留。',{id,confirm:{type:'boolean',const:true}},['id','confirm'],false),
 make('quantos_prediction_history','按币种、版本、状态及 UTC 毫秒时间范围读取历史预测。',{symbol,version:{type:'string'},state:{type:'string'},from:{type:'integer'},to:{type:'integer'},limit:{type:'integer',minimum:1,maximum:50}},[],true)
];
export const predictionPaths:Record<string,string>=Object.fromEntries(['reference','create','arm','status','cancel','history']
  .map(key=>['quantos_prediction_'+key,key]));
