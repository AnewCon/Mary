const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const symbol = { type: 'string', pattern: '^[A-Z0-9]{2,24}USDT$' };
const side = { type: 'string', enum: ['LONG', 'SHORT'] };
const id = { type: 'string', pattern: '^[a-f0-9]{32}$', description: '每笔操作使用唯一的 32 位十六进制 ID。超时后保留原 ID。' };
const confirm = { type: 'boolean', const: true, description: '仅在用户明确确认当前模拟盘操作后填 true。' };
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

export const binanceDemoTools = [
  { name: 'binance_demo_get_account', description: '读取币安模拟盘余额、保证金和当前合约仓位。',
    inputSchema: schema({}), annotations: read },
  { name: 'binance_demo_get_action', description: '用原请求 ID 查询模拟盘订单结果。queued 表示等待 VPS 领取，running 表示处理中。查询原编号直到确认结果，切勿用新编号重发。',
    inputSchema: schema({ id }, ['id']), annotations: read },
  { name: 'binance_demo_open', description: '币安模拟盘市价开仓。先确认合约、方向和数量。提交后返回排队状态，请用同一 ID 查询成交结果。',
    inputSchema: schema({ id, symbol, side, confirm, quantity: { type: 'string' } }, ['id', 'symbol', 'side', 'quantity', 'confirm']),
    annotations: write, kind: 'open' },
  { name: 'binance_demo_close', description: '按最新仓位的百分比在币安模拟盘市价减仓。先让用户确认方向和比例。',
    inputSchema: schema({ id, symbol, side, confirm, percent: { type: 'integer', minimum: 1, maximum: 100 } },
      ['id', 'symbol', 'side', 'percent', 'confirm']), annotations: write, kind: 'close' },
  { name: 'binance_demo_set_leverage', description: '设置币安模拟盘合约的杠杆倍数。先让用户确认合约和倍数。',
    inputSchema: schema({ id, symbol, confirm, leverage: { type: 'integer', minimum: 1, maximum: 125 } },
      ['id', 'symbol', 'leverage', 'confirm']), annotations: write, kind: 'leverage' },
];

