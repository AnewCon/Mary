const strategyId={type:'string',pattern:'^[a-z][a-z0-9-]{2,47}$'};
const version={type:'string',maxLength:40};
const environment={type:'string',const:'BINANCE_DEMO_FUTURES'};
const date={type:'integer',minimum:0};
const limit={type:'integer',minimum:1,maximum:50};
const string={type:'string'};
const record={type:'object'};
const array={type:'array',items:record};
const definition=(op:string,description:string,properties:Record<string,unknown>,required:string[],result:Record<string,unknown>)=>({
 name:'quantos_strategy_'+op,description,
 inputSchema:{type:'object',additionalProperties:false,properties,required},
 outputSchema:{type:'object',required:['data'],properties:{data:{type:'object',properties:result,required:Object.keys(result)}}},
 annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}
});
export const strategyRef={type:'object',additionalProperties:false,required:['strategyId','version','contentHash','generation'],properties:{strategyId,version,contentHash:{type:'string',pattern:'^[a-f0-9]{64}$'},generation:{type:'integer',minimum:1}}};
const details={strategyId,version,state:string,contentHash:{type:'string',pattern:'^[a-f0-9]{64}$'},config:record,document:string,executionAuthorized:{type:'boolean'},capabilities:record,safetyLimits:record,environment};
export const strategyTools=[
 definition('active','每次开始分析或交易前调用。返回当前 Binance Demo 已启用策略全文、配置和校验值。没有启用版本或校验失败时停止自动下单。读取策略不构成下单授权。',{environment},[],{...details,generation:{type:'integer',minimum:1},publishedAt:date,activatedAt:date}),
 definition('list','读取策略版本库，支持名称、状态、版本及创建时间。',{strategyId,name:{type:'string',maxLength:80},version,state:{enum:['DRAFT','VALIDATED','PUBLISHED','ACTIVE','ARCHIVED']},from:date,to:date,limit},[],{items:array,generation:{type:'integer'}}),
 definition('get','读取指定策略的完整文档和配置，含归档版本。',{strategyId,version},['strategyId','version'],details),
 definition('history','读取策略创建、变更、验证、发布和切换审计记录。',{strategyId,version,limit},['strategyId'],{items:array}),
 definition('compare','比较同一策略的两个版本，返回结构化字段变化。',{strategyId,fromVersion:version,toVersion:version},['strategyId','fromVersion','toVersion'],{from:record,to:record,changes:array}),
 definition('performance','读取策略版本的样本、时间范围和独立绩效来源。',{strategyId,version,from:date,to:date},['strategyId','version'],{shadow:record,demo:record,backtest:record,live:record})
];
