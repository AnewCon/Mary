export const environment='BINANCE_DEMO_FUTURES';
export const schemaVersion=1;
export const safetyLimits={maxLeverage:10,maxSymbols:5,maxBudgetUsdt:80,maxMarginUsdt:32,maxPortfolioLossUsdt:2,maxSingleLossUsdt:0.35,minNetRewardRisk:1.8,minDirection:80,minEntry:80};
const number=(minimum:number,maximum:number,type='number')=>({type,minimum,maximum});
const integer=(minimum:number,maximum:number)=>number(minimum,maximum,'integer');
const values=(...choices:(string|number|boolean)[])=>({enum:choices});
const string=(maxLength:number)=>({type:'string',minLength:1,maxLength});
const obj=(properties:Record<string,any>)=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const array=(items:any,minItems:number,maxItems:number,uniqueItems=false)=>({type:'array',items,minItems,maxItems,uniqueItems});
export const strategyConfigSchema={
  $schema:'https://json-schema.org/draft/2020-12/schema',
  ...obj({
    schemaVersion:values(schemaVersion),
    strategyId:{type:'string',pattern:'^[a-z][a-z0-9-]{2,47}$',maxLength:48},
    version:{type:'string',pattern:'^[0-9]+[.][0-9]+[.][0-9]+(-[a-zA-Z0-9.-]+)?$',maxLength:40},
    market:values(environment),
    riskLevel:values('LOW','MEDIUM','HIGH'),
    timeframes:obj({primary:values('5m','15m','1h'),entry:values('5m'),confirmation:array(values('15m','1h','4h'),3,3,true),pathValidation:values('1m')}),
    screening:obj({contract:values('USDT_PERPETUAL'),limit:integer(1,50),minQuoteVolumeUsdt:number(0,1e12),excludedConditions:array(string(240),1,12)}),
    indicators:obj({trendWeight:number(0,100),derivativesWeight:number(0,100),liquidationWeight:number(0,100),positioningWeight:number(0,100),liquidityWeight:number(0,100)}),
    scoring:obj({method:values('INDEPENDENT_DIRECTION_AND_ENTRY'),minimumDirection:integer(80,100),minimumEntry:integer(80,100),gradeA:integer(80,100),gradeB:integer(0,99)}),
    entryRules:obj({orderType:values('LIMIT'),trendAligned:values(true),structureRequired:values(true),timingRequired:values(true),longCondition:string(500),shortCondition:string(500)}),
    exitRules:obj({stopRequired:values(true),takeProfitRequired:values(true),trigger:values('MARK_PRICE','CONTRACT_PRICE'),invalidation:string(500)}),
    riskManagement:obj({leverage:integer(1,10),budgetUsdt:number(0.01,80),marginUsdt:number(0.01,32),portfolioLossUsdt:number(0.01,2),singleLossUsdt:number(0.01,0.35),minNetRewardRisk:number(1.8,100)}),
    positionManagement:obj({maxSymbols:integer(1,5),maxSameDirectionCorrelation:number(0,0.85)}),
    anomalyFilters:obj({dailyBars:integer(14,30),dailyGainPct:number(1,300),intradayRangePct:number(1,400),cooldownBars:integer(7,30)}),
    pathMatch:obj({enabled:values(true,false),mode:values('SHADOW'),forecast5mCount:values(3),forecast1mCount:values(15),windowMinutes:values(15),minClosedCandles:integer(3,10),similarityThreshold:number(85,100),atrTolerance:number(0.1,0.5),invalidations:values('HARD_PRICE_AND_CHANNEL'),outperformance:values('REVIEW_ONLY'),requireClosedUtcCandles:values(true),expiry:values('FIXED_WINDOW')}),
    execution:obj({mode:values('REVIEW_ONLY'),cancelAfterMinutes:values(45),onStaleData:values('WAIT'),onNetworkError:values('RECONCILE'),onProtectionFailure:values('PAUSE_AND_CANCEL_REMAINDER')}),
    dataRequirements:obj({requiredSources:array(values('BINANCE_KLINES','BINANCE_DEMO_ACCOUNT','BYBIT','OI_HISTORY','BLOCKMETRIC','MARGINPAD'),1,6,true),maxAgeSeconds:integer(15,300)}),
    featureFlags:obj({derivativesExperimental:values(true,false),pathMatchAuto:values(false)})
  })
};
function check(schema:any,value:any,path:string,errors:string[]){
  if(schema.enum){if(!schema.enum.includes(value))errors.push(path+': 不支持的值');return;}
  if(schema.type==='object'){
    if(!value||typeof value!=='object'||Array.isArray(value)){errors.push(path+': 必须为对象');return;}
    for(const key of Object.keys(value))if(!Object.hasOwn(schema.properties,key))errors.push(path+'.'+key+': 未知字段');
    for(const key of schema.required)check(schema.properties[key],value[key],path+'.'+key,errors);
  }else if(schema.type==='array'){
    if(!Array.isArray(value)||value.length<schema.minItems||value.length>schema.maxItems){errors.push(path+': 数量不符合要求');return;}
    if(schema.uniqueItems&&new Set(value).size!==value.length)errors.push(path+': 存在重复值');
    value.forEach((item,i)=>check(schema.items,item,path+'['+i+']',errors));
  }else if(schema.type==='string'){
    if(typeof value!=='string'||!value.trim()||value.length>(schema.maxLength??Infinity)||(schema.pattern&&!new RegExp(schema.pattern).test(value)))errors.push(path+': 无效文本');
  }else if(!Number.isFinite(value)||(schema.type==='integer'&&!Number.isInteger(value))||value<schema.minimum||value>schema.maximum)errors.push(path+': 数值超出范围或缺失');
}
export function configErrors(config:any){
  const errors:string[]=[];
  check(strategyConfigSchema,config,'config',errors);
  if(errors.length)return errors;
  if(Math.abs(Object.values(config.indicators).reduce<number>((sum,v)=>sum+Number(v),0)-100)>1e-9)errors.push('config.indicators: 权重之和必须为 100');
  const r=config.riskManagement;
  if(r.marginUsdt>r.budgetUsdt||r.singleLossUsdt>r.portfolioLossUsdt)errors.push('config.riskManagement: 单项上限超过组合预算');
  if(config.anomalyFilters.cooldownBars>config.anomalyFilters.dailyBars)errors.push('config.anomalyFilters: 观察范围必须覆盖冷却期');
  if(config.scoring.gradeA<=config.scoring.gradeB)errors.push('config.scoring: A 级阈值须高于 B 级');
  if(!config.dataRequirements.requiredSources.includes('BINANCE_KLINES'))errors.push('config.dataRequirements: 缺少 Binance K 线');
  return errors;
}
export function canonical(value:any):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
export async function contentHash(name:string,document:string,config:any) {
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical({name,document,config})));
  return Array.from(new Uint8Array(hash),value=>value.toString(16).padStart(2,'0')).join('');
}
