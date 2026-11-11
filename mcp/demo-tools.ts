const read={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
const change={readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:false};
const requestId={type:'string',format:'uuid',description:'本次操作唯一UUID。超时或重试必须沿用同一值，不得以新ID盲目重发。'};
const instId={type:'string',description:'欧意永续合约名称，如 DOGE-USDT-SWAP。仅模拟盘SWAP。'};
const percent={type:'integer',minimum:1,maximum:100,description:'持仓比例，1至100。'};
const takeProfit={type:'string',description:'止盈触发价，正十进制字符串；基于标记价格，触发后市价执行。'};
const stopLoss={type:'string',description:'止损触发价，正十进制字符串；基于标记价格，触发后市价执行。'};
const schema=(properties:any,required:string[])=>({type:'object',properties,required,additionalProperties:false});
export const demoTools=[
 {
  name:'quantos_demo_set_protection_tiers',title:'设置模拟盘分段止盈止损',
  description:'对已有欧意模拟永续仓位一次指定2至5档。每档占调用时原始仓位的比例，总计最多100%，按合约步长向下取整。每档至少一个触发价，同档同时设置止盈与止损时使用OCO，触发其中一个后取消同档另一边。标记价触发、市价减仓。已有保护单会阻止提交，先查询委托，获得用户授权才撤改旧单。返回各档的张数、状态和algoId。发生部分提交或UNKNOWN时查询原requestId，不得用新ID盲目重发。',
  inputSchema:schema({requestId,positionId:{type:'string'},tiers:{type:'array',minItems:2,maxItems:5,items:schema({percent,takeProfit,stopLoss},['percent'])}},['requestId','positionId','tiers']),
  annotations:change
 },
 {name:'quantos_demo_get_leverage',title:'查询模拟盘合约杠杆',description:'读取指定永续合约和保证金模式的当前配置杠杆、持仓模式和合约最大杠杆参考值。先查询再按用户明确倍数修改。',inputSchema:schema({instId,marginMode:{type:'string',enum:['cross','isolated']}},['instId','marginMode']),annotations:read},
 {name:'quantos_demo_set_leverage',title:'设置模拟盘合约杠杆',description:'按用户明确指定的倍数设置欧意模拟盘永续杠杆，并查询确认；不会下单或切换保证金/持仓模式。全仓杠杆可能影响该合约/品种现有双向持仓。逐仓双向模式必须指定long或short；全仓和净持仓模式省略posSide。结果UNKNOWN时只查询原requestId，禁止新ID重发。',inputSchema:schema({requestId,instId,marginMode:{type:'string',enum:['cross','isolated']},leverage:{type:'string',description:'用户明确指定的杠杆倍数，正十进制字符串，至少1倍；不可自行选择最大倍数。'},posSide:{type:'string',enum:['net','long','short']}},['requestId','instId','marginMode','leverage']),annotations:change},
 {name:'quantos_demo_get_context',title:'读取模拟盘交易规则',description:'下单前读取最新合约张数步长、最小/最大数量、价格刻度、标记价与持仓模式。不会修改杠杆。',inputSchema:schema({instId},['instId']),annotations:read},
 {name:'quantos_demo_get_orders',title:'读取模拟盘委托和止盈止损',description:'读取普通未成交委托及conditional/oco保护单。可能截断标志为真时不要声称已读取全部订单。',inputSchema:schema({instId},[]),annotations:read},
 {name:'quantos_demo_place_order',title:'欧意模拟盘下单',description:'按用户指定方向和合约张数提交模拟盘市价或限价开仓/加仓单。不是实盘，不改变杠杆。净持仓有相反方向仓位时必须先明确平仓；不隐式反转。下单可能改变模拟账户持仓。',inputSchema:schema({requestId,instId,direction:{type:'string',enum:['long','short']},marginMode:{type:'string',enum:['cross','isolated']},orderType:{type:'string',enum:['market','limit']},size:{type:'string',description:'下单张数，必须满足lotSz和minSz；不是币数量、USDT金额或保证金金额。'},price:{type:'string',description:'仅限价单必填。市价单不要填写。'}},['requestId','instId','direction','marginMode','orderType','size']),annotations:change},
 {name:'quantos_demo_close_position',title:'模拟盘卖出/买入减仓',description:'按用户指定比例市价平仓。服务端重新查询真实仓位：多单卖出，空单买入，净持仓强制只减仓，不开反向仓。',inputSchema:schema({requestId,positionId:{type:'string'},percent},['requestId','positionId','percent']),annotations:change},
 {name:'quantos_demo_set_protection',title:'设置模拟盘止盈止损',description:'为已有持仓新增市价触发止盈/止损。两项同时设置时使用OCO，单项使用conditional；100%按整仓保护。已有保护单时先读委托，使用修改工具，不擅自撤旧单。',inputSchema:schema({requestId,positionId:{type:'string'},percent,takeProfit,stopLoss},['requestId','positionId','percent']),annotations:change},
 {name:'quantos_demo_amend_protection',title:'修改模拟盘止盈止损',description:'修改已存在且未触发的conditional/oco减仓保护单价格。修改失败不自动撤单。不改变保护单种类。至少提供止盈或止损一项。',inputSchema:schema({requestId,instId,algoId:{type:'string'},takeProfit,stopLoss},['requestId','instId','algoId']),annotations:change},
 {name:'quantos_demo_cancel_protection',title:'撤销模拟盘保护单',description:'按用户明确指定的algoId撤销模拟账户减仓保护单。此操作会移除该订单保护，不会平仓。',inputSchema:schema({requestId,instId,algoId:{type:'string'}},['requestId','instId','algoId']),annotations:change},
 {name:'quantos_demo_cancel_order',title:'撤销模拟盘普通委托',description:'撤销模拟账户指定未成交普通订单；已成交部分不会撤销或反向成交。',inputSchema:schema({requestId,instId,orderId:{type:'string'}},['requestId','instId','orderId']),annotations:change},
 {name:'quantos_demo_get_action',title:'查询模拟盘操作结果',description:'超时后查询原requestId的交易所状态与实际成交量，不重新发单。',inputSchema:schema({requestId},['requestId']),annotations:read}
];
export const demoPaths:Record<string,string>={quantos_demo_set_protection_tiers:'/api/demo/protect_tiers',quantos_demo_set_leverage:'/api/demo/leverage',quantos_demo_place_order:'/api/demo/place',quantos_demo_close_position:'/api/demo/close',quantos_demo_set_protection:'/api/demo/protect',quantos_demo_amend_protection:'/api/demo/amend_protection',quantos_demo_cancel_protection:'/api/demo/cancel_protection',quantos_demo_cancel_order:'/api/demo/cancel_order'};
