const schema = (properties:Record<string,unknown>,required:string[]=[]) => ({type:'object',properties,required,additionalProperties:false});
const id={type:'string',pattern:'^[a-f0-9]{32}$',description:'请求编号，32 位十六进制。重试沿用原编号。'};
const symbol={type:'string',pattern:'^[A-Z0-9]{2,24}USDT$'};
const side={type:'string',enum:['LONG','SHORT']};
const confirm={type:'boolean',const:true};
const decimal={type:'string'};
const exchangeOrderId={type:'string',pattern:'^[0-9]{1,22}$'};
const define=(name:string, description:string, properties:Record<string,unknown>, required:string[], kind?:string, query=false)=>({
 name,description,inputSchema:schema(properties,required),kind,query,
 annotations:{readOnlyHint:!kind||query,destructiveHint:!!kind&&!query,idempotentHint:true,openWorldHint:false}
});
const open={id,symbol,side,confirm,quantity:decimal};
const account='读取币安官方 USDⓈ-M 模拟盘余额、保证金和实际模拟持仓。';
export const binanceDemoTools=[
 define('binance_demo_get_account',account,{},[]),
 define('binance_testnet_get_account',account,{},[]),
 define('binance_demo_get_action','查询原编号。排队或执行中时继续查询，结果未知时先核对交易所订单。',{id},['id']),
 define('binance_demo_open','确认后提交模拟市价开仓。',open,Object.keys(open),'open'),
 define('binance_testnet_place_order','确认后提交模拟市价或限价开仓，LIMIT 必填 price。用原编号查询模拟交易所订单号与成交状态。',{...open,orderType:{type:'string',enum:['MARKET','LIMIT']},price:decimal},[...Object.keys(open),'orderType'],'place'),
 define('binance_demo_close','确认后按百分比市价减仓。',{id,symbol,side,confirm,percent:{type:'integer',minimum:1,maximum:100}},['id','symbol','side','confirm','percent'],'close'),
 define('binance_demo_set_leverage','确认后调整模拟合约杠杆。',{id,symbol,confirm,leverage:{type:'integer',minimum:1,maximum:125}},['id','symbol','confirm','leverage'],'leverage'),
 define('binance_testnet_get_orders','查询指定合约的普通挂单、保护单及近期订单。用原编号读取查询结果。',{id,symbol},['id','symbol'],'orders',true),
 define('binance_demo_get_contract','查询合约规格、当前杠杆、保证金模式及持仓模式。用原编号读取查询结果。',{id,symbol},['id','symbol'],'contract',true),
 define('binance_demo_query_order','按交易所订单号查询成交状态。用原编号读取查询结果。',{id,symbol,exchangeOrderId},['id','symbol','exchangeOrderId'],'query',true),
 define('binance_demo_set_protection','确认后为现有模拟仓位设置整仓止盈或止损。标记价触发。两种保护分别提交、分别查询，彼此独立。',{id,symbol,side,confirm,triggerPrice:decimal,protection:{type:'string',enum:['STOP_MARKET','TAKE_PROFIT_MARKET']}},['id','symbol','side','confirm','triggerPrice','protection'],'protect'),
 define('binance_demo_cancel_order','确认后撤销指定模拟委托。保护单传 algoId 并设 conditional=true。',{id,symbol,confirm,exchangeOrderId,conditional:{type:'boolean'}},['id','symbol','confirm','exchangeOrderId'],'cancel'),
];
