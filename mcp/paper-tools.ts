const string = {type:'string'};
export const paperTools = [
  {name:'quantos_paper_list_orders',description:'读取网站保存的币安虚拟账户及订单。跨聊天继续时先调用；读取不会更新行情或结算。',inputSchema:{type:'object',properties:{},additionalProperties:false},
    annotations:{readOnlyHint:true,openWorldHint:false}},
  {name:'quantos_paper_write_order',description:'只写入 QuantOS 币安虚拟账本。INITIALIZE 需要用户指定初始资金 initial；OPEN 需要 symbol、side、margin；MARK 更新估值，CLOSE 平掉整笔，二者需要 symbol、orderId。OPEN/MARK/CLOSE 都必须从币安行情插件取得实际 price 和 UTC 毫秒 priceTime。每次变更使用新 UUID，重试沿用原 UUID。只有 COMMITTED 才算保存。不开交易所订单；每笔按 1 倍计算，不含手续费、资金费、滑点。',inputSchema:{type:'object',properties:{
    action:{type:'string',enum:['INITIALIZE','OPEN','MARK','CLOSE']},requestId:{type:'string',format:'uuid'},
    initial:string,symbol:string,side:{type:'string',enum:['LONG','SHORT']},margin:string,orderId:string,price:string,priceTime:{type:'integer'}
  },required:['action','requestId'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:false}},
];
