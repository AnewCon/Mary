import { binanceDemoTools } from './binance-demo-tools';


const id={type:'string',pattern:'^[a-f0-9]{32}$'};
const schema=(properties:Record<string,unknown>,required:string[]=[])=>({type:'object',properties,required,additionalProperties:false});
const read={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
const liveActions={
 place:'binance_live_place_order',
 close:'binance_live_close',
 leverage:'binance_live_set_leverage',
 orders:'binance_live_get_orders',
 contract:'binance_live_get_contract',
 query:'binance_live_query_order',
 protect:'binance_live_set_protection',
 cancel:'binance_live_cancel_order',
} as Record<string,string>;

export const liveActionByName=Object.fromEntries(Object.entries(liveActions).map(([kind,name])=>[name,kind]));
const advanced=binanceDemoTools.flatMap(({kind,query,description,inputSchema,annotations})=>{
  if(!kind||!liveActions[kind])return [];
  const prefix=query?'查询币安真实 USDⓈ-M 账户。':'操作币安真实 USDⓈ-M 账户，调用前须取得用户本次明确确认。';
  const effectiveSchema=kind==='query'?{...inputSchema,properties:{...inputSchema.properties,conditional:{type:'boolean'}}}:inputSchema;
  const detail=kind==='query'?' 查询条件单时传 algoId 并设 conditional=true。':'';
  return [{name:liveActions[kind],description:prefix+description.replaceAll('模拟','真实')+detail+
    ' 用原编号调用 binance_live_desktop_get_request，accepted 表示本机收到交易所回应。',inputSchema:effectiveSchema,annotations}];
});

export const liveTools=[
  ...advanced,
  {name:'binance_live_get_account',description:'读取真实 USDⓈ-M 账户余额、可用保证金和持仓快照。离线时返回最近的历史快照，检查时间和在线状态。',inputSchema:schema({}),annotations:read},
  {name:'binance_live_desktop_status',description:'查询真实账户本地面板在线状态。',inputSchema:schema({}),annotations:read},
  {name:'binance_live_desktop_get_request',description:'查询真实账户请求状态。pending 等待本地执行，unknown 时在交易所人工核对，禁止新编号重发。',inputSchema:schema({id},['id']),annotations:read},
  {name:'binance_live_desktop_submit',description:'用户明确指定真实账户、合约、方向、数量与订单类型后，提交真实订单请求。Windows 面板在线时会自动领取并执行，调用前必须取得用户在 Chat 对这笔订单的明确确认。平仓传 reduceOnly=true。数量为标的币数量。此旧接口仅用于单向持仓，由面板设置 positionSide=BOTH。新开仓使用 binance_live_place_order，按比例平仓使用 binance_live_close。',inputSchema:schema({
    id,symbol:{type:'string'},side:{type:'string',enum:['BUY','SELL']},type:{type:'string',enum:['MARKET','LIMIT']},
    quantity:{type:'string'},price:{type:'string'},reduceOnly:{type:'boolean'},confirm:{type:'boolean',const:true},
  },['id','symbol','side','type','quantity','reduceOnly','confirm']),annotations:{...read,readOnlyHint:false,destructiveHint:true}},
];
