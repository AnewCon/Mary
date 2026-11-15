
const id={type:'string',pattern:'^[a-f0-9]{32}$'};
const schema=(properties:Record<string,unknown>,required:string[]=[])=>({type:'object',properties,required,additionalProperties:false});
const read={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
export const liveTools=[
  {name:'binance_live_desktop_status',description:'查询真实账户本地面板在线状态。',inputSchema:schema({}),annotations:read},
  {name:'binance_live_desktop_get_request',description:'查询真实账户请求状态。pending 等待本地确认，unknown 时在交易所人工核对，禁止新编号重发。',inputSchema:schema({id},['id']),annotations:read},
  {name:'binance_live_desktop_submit',description:'用户明确指定真实账户、合约、方向、数量与订单类型后，发一条请求到 Windows 面板，由用户本地再次确认。此工具不会直接向交易所下单。平仓传 reduceOnly=true。数量为标的币数量。仅支持单向持仓。',inputSchema:schema({
    id,symbol:{type:'string'},side:{type:'string',enum:['BUY','SELL']},type:{type:'string',enum:['MARKET','LIMIT']},
    quantity:{type:'string'},price:{type:'string'},reduceOnly:{type:'boolean'},confirm:{type:'boolean',const:true},
  },['id','symbol','side','type','quantity','reduceOnly','confirm']),annotations:{...read,readOnlyHint:false,destructiveHint:true}},
];
