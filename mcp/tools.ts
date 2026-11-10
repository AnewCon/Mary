const read={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
const empty={type:'object',properties:{},additionalProperties:false};
export const tools=[
 {name:'quantos_get_account',title:'读取 QuantOS 账户',description:'读取欧意模拟账户权益、余额、快照与实际同步时间，不执行交易。',inputSchema:empty,annotations:read},
 {name:'quantos_get_positions',title:'读取当前仓位',description:'读取当前欧意模拟盘永续持仓。返回真实同步时间和过期标志；不是实盘账户。',inputSchema:empty,annotations:read},
 {name:'quantos_get_status',title:'检查同步状态',description:'读取账户连接、同步时间、错误及模拟盘状态。',inputSchema:empty,annotations:read},
 {name:'quantos_get_performance',title:'读取收益账本',description:'读取按币种区分的累计净收益和北京时间今日收益；不将浮盈或划转当作已实现收益。',inputSchema:empty,annotations:read},
 {name:'quantos_list_plans',title:'读取交易计划',description:'读取最近100条已保存交易计划。计划只是笔记，不代表已下单。',inputSchema:empty,annotations:read},
 {name:'quantos_write_plan',title:'保存交易计划（不下单）',description:'保存用户请求的分析和交易计划到 QuantOS。不会提交、修改或取消交易所订单。requestId 必须为 UUID；重试使用同一个值，避免重复记录。',inputSchema:{type:'object',properties:{requestId:{type:'string',format:'uuid'},symbol:{type:'string',minLength:1,maxLength:80},direction:{type:'string',enum:['long','short','observe']},content:{type:'string',minLength:1,maxLength:8000},entry:{type:'string',description:'可选计划入场价，正十进制字符串'},stopLoss:{type:'string',description:'可选计划止损价，正十进制字符串'},takeProfit:{type:'string',description:'可选计划止盈价，正十进制字符串'},expiresAt:{type:'string',format:'date-time'}},required:['requestId','symbol','direction','content'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}}
];
export const readPaths:Record<string,string>={quantos_get_account:'/api/account',quantos_get_status:'/api/status',quantos_get_performance:'/api/performance',quantos_list_plans:'/api/ai/plans'};
