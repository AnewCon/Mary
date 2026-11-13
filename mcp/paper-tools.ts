const string = {type:'string'};
export const paperTools = [
  {name:'quantos_paper_save_review',description:'当用户结束本轮币安虚拟交易并要求复盘时，先读取网站账本，再保存复盘到网站的「币安交易复盘」。区分本轮交易与账户累计数据，无法确认的成交不写成已执行。保存后返回 SAVED 与复盘编号，重试沿用同一 UUID。',inputSchema:{type:'object',properties:{
    requestId:{type:'string',format:'uuid'},title:{type:'string',maxLength:100},
    summary:{type:'string',maxLength:2500},lessons:{type:'string',maxLength:1500},nextSteps:{type:'string',maxLength:1500}
  },required:['requestId','title','summary','lessons','nextSteps'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
  {name:'quantos_paper_list_orders',description:'读取网站保存的币安虚拟账户及订单。跨聊天继续时先调用；读取不会更新行情或结算。',inputSchema:{type:'object',properties:{},additionalProperties:false},
    annotations:{readOnlyHint:true,openWorldHint:false}},
  {name:'quantos_paper_write_order',description:'写入 QuantOS 币安虚拟账本。INITIALIZE 指定初始资金 initial；OPEN 指定 symbol、side、margin 和 leverage（默认 1）；ADD 指定 symbol、orderId 和新增 margin，沿用原杠杆并按数量加权均价；MARK 和 CLOSE 指定 symbol、orderId。除 INITIALIZE 外均需要币安行情插件的 price 和 UTC 毫秒 priceTime。保证金以 USDT 计。每次变更用新 UUID，重试沿用原 UUID。以 COMMITTED 和服务器返回的数量、均价、marginRoiPct 及 liquidationPrice 为准。模拟逐仓按固定 0.5% 维持保证金率提示风险，不自动强平，不计手续费、资金费、滑点。',inputSchema:{type:'object',properties:{
    action:{type:'string',enum:['INITIALIZE','OPEN','ADD','MARK','CLOSE']},requestId:{type:'string',format:'uuid'},
    leverage:{type:'integer',minimum:1,maximum:125,description:'虚拟开仓杠杆倍数。加仓沿用原仓倍数。'},
    initial:string,symbol:string,side:{type:'string',enum:['LONG','SHORT']},margin:string,orderId:string,price:string,priceTime:{type:'integer'}
  },required:['action','requestId'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:false}},
];
