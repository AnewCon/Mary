const read={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
const change={readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:false};
const string={type:'string'};
const accountId={type:'string',description:'实验账户 ID，省略使用 main'};
const schema=(properties:Record<string,unknown>,required:string[]=[])=>({type:'object',properties,required,additionalProperties:false});
const symbol={type:'string',description:'币安 USDT 永续标识，例如 BTCUSDT'};
const decimal={type:'string',description:'正十进制字符串'};

export const virtualTools=[
 {name:'get_virtual_market',description:'读取币安 USDT 永续公开行情，含最新成交价与时间、独立标记价、已闭合15分钟及日K、成交量、持仓量和资金费率。虚拟交易统一以最新成交价为基准。',inputSchema:schema({symbol},['symbol']),annotations:read},
 {name:'get_virtual_portfolio',description:'查询独立虚拟账户、持仓、余额、保证金和盈亏。',inputSchema:schema({accountId}),annotations:read},
 {name:'get_virtual_position',description:'查询虚拟仓位详情、开仓时决策、逐笔结算事件和独立影子结果。',inputSchema:schema({id:string},['id']),annotations:read},
 {name:'get_virtual_history',description:'分页读取已关闭虚拟仓位；nextCursor 非空时继续翻页。',inputSchema:schema({accountId,cursor:string,symbol,direction:{type:'string',enum:['LONG','SHORT']},strategy:string,result:{type:'string',enum:['win','loss']},reason:string,from:{type:'integer'},to:{type:'integer'}}),annotations:read},
 {name:'get_virtual_statistics',description:'读取虚拟实验账户的胜率、期望收益、平均盈亏、最大回撤和按币种、方向、策略、北京时间开仓小时分组的统计。',inputSchema:schema({accountId}),annotations:read},
 {name:'get_virtual_request_status',description:'用原请求ID查询是否已经提交。收到COMMITTED才可告知用户成功。',inputSchema:schema({id:string},['id']),annotations:read},
 {name:'sync_virtual_trade',description:'写入 QuantOS 虚拟账本。OPEN 需要币种、方向、保证金、杠杆、决策价格、决策时间、理由、策略版本、统一止损和2至5个止盈档。CLOSE 平掉剩余仓位，UPDATE_PROTECTION 为剩余仓位重设保护，二者需要 positionId。先查询币安行情并遵守用户授权，超时沿用原 UUID 查询或重试。只有 COMMITTED 代表已保存，不向交易所发单。',inputSchema:schema({
   action:{type:'string',enum:['OPEN','CLOSE','UPDATE_PROTECTION']},requestId:{type:'string',format:'uuid'},accountId,symbol,
   direction:{type:'string',enum:['LONG','SHORT']},margin:decimal,leverage:{type:'integer',minimum:1,maximum:100},
   decisionPrice:decimal,decisionTime:{type:'integer',description:'UTC Unix 毫秒'},reason:string,strategy:string,
   analysis:{type:'object',description:'保留趋势、15m结构、成交量、持仓量与变化、资金费率、情绪、策略评分和ATR等可追溯分析。'},
   positionId:string,stopLoss:decimal,tiers:{type:'array',minItems:2,maxItems:5,items:schema({percent:{type:'integer',minimum:1,maximum:100},price:decimal},['percent','price'])},
 },['action','requestId']),annotations:change},
];

const paths:Record<string,string>={get_virtual_market:'market',get_virtual_portfolio:'portfolio',get_virtual_position:'position',get_virtual_history:'history',get_virtual_statistics:'stats',get_virtual_request_status:'request'};
export function virtualPath(name:string,args:Record<string,string|number>) {
 if(name==='sync_virtual_trade')return '/api/virtual/trade';
 const query=new URLSearchParams(Object.entries(args).map(([key,value])=>[key,String(value)]));
 return '/api/virtual/'+paths[name]+'?'+query;
}
