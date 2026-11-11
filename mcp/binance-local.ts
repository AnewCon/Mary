import { fetchDemoSnapshot, type BinanceDemoEnv } from '../worker/binance-demo';
import { demoActionStatus, submitDemoAction } from '../worker/binance-demo-trades';
import { Failure } from '../worker/exchange';

interface Env extends BinanceDemoEnv {
  MCP_LOCAL_TOKEN: string;
}

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const symbol = { type: 'string', pattern: '^[A-Z0-9]{2,24}USDT$' };
const side = { type: 'string', enum: ['LONG', 'SHORT'] };
const id = { type: 'string', pattern: '^[a-f0-9]{32}$', description: '每笔操作使用唯一的 32 位十六进制 ID。超时后保留原 ID。' };
const confirm = { type: 'boolean', const: true, description: '仅在用户明确确认当前模拟盘操作后填 true。' };
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

const tools = [
  { name: 'binance_demo_get_account', description: '读取币安模拟盘余额、保证金和当前合约仓位。',
    inputSchema: schema({}), annotations: read },
  { name: 'binance_demo_get_action', description: '用原请求 ID 查询模拟盘订单结果。超时后先查询原请求。',
    inputSchema: schema({ id }, ['id']), annotations: read },
  { name: 'binance_demo_open', description: '币安模拟盘市价开仓。先让用户确认合约、方向和数量。',
    inputSchema: schema({ id, symbol, side, confirm, quantity: { type: 'string' } }, ['id', 'symbol', 'side', 'quantity', 'confirm']),
    annotations: write, kind: 'open' },
  { name: 'binance_demo_close', description: '按最新仓位的百分比在币安模拟盘市价减仓。先让用户确认方向和比例。',
    inputSchema: schema({ id, symbol, side, confirm, percent: { type: 'integer', minimum: 1, maximum: 100 } },
      ['id', 'symbol', 'side', 'percent', 'confirm']), annotations: write, kind: 'close' },
  { name: 'binance_demo_set_leverage', description: '设置币安模拟盘合约的杠杆倍数。先让用户确认合约和倍数。',
    inputSchema: schema({ id, symbol, confirm, leverage: { type: 'integer', minimum: 1, maximum: 125 } },
      ['id', 'symbol', 'leverage', 'confirm']), annotations: write, kind: 'leverage' },
];

function output(data: unknown, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: { data }, isError };
}

const versions = ['2025-11-25', '2025-06-18', '2025-03-26'];
const info = { name: 'QuantOS Binance Demo', version: '1.0.0' };

export default {
  async fetch(request: Request, env: Env) {
    if (request.method !== 'POST' || request.headers.get('X-QuantOS-Local') !== env.MCP_LOCAL_TOKEN) {
      return new Response(null, { status: 403 });
    }
    const msg = await request.json() as {
      jsonrpc?: unknown; id?: unknown; method?: string;
      params?: { name?: unknown; protocolVersion?: string; arguments?: Record<string, unknown> };
    };
    const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id: msg?.id ?? null, result });
    const fail = (code: number, message: string) => Response.json({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code, message } });
    if (msg?.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'INVALID_REQUEST');
    if (msg.id === undefined) return new Response(null, { status: 204 });
    const trading = env.BINANCE_DEMO_TRADING_ENABLED === 'true';
    const available = tools.filter(tool => trading || !tool.kind);
    if (msg.method === 'initialize') {
      const offered = msg.params?.protocolVersion;
      return reply({
        protocolVersion: offered && versions.includes(offered) ? offered : versions[0],
        capabilities: { tools: {} }, serverInfo: info,
        instructions: '工具固定连接币安模拟盘。请在用户明确确认具体操作参数后再调用写工具。',
      });
    }
    if (msg.method === 'ping') return reply({});
    if (msg.method === 'tools/list') {
      return reply({ tools: available.map(({ name, description, inputSchema, annotations }) => ({
        name, description, inputSchema, annotations,
      })) });
    }
    if (msg.method !== 'tools/call') return fail(-32601, 'METHOD_NOT_FOUND');
    const tool = available.find(item => item.name === msg.params?.name);
    if (!tool) return fail(-32602, 'UNKNOWN_TOOL');
    const args = msg.params?.arguments ?? {};
    if (!args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some(key => !Object.hasOwn(tool.inputSchema.properties, key))
      || tool.inputSchema.required.some(key => !Object.hasOwn(args, key))) {
      return fail(-32602, 'INVALID_ARGUMENTS');
    }
    try {
      if (tool.name === 'binance_demo_get_account') {
        return reply(output({ exchange: 'Binance', mode: 'demo', ...await fetchDemoSnapshot(env) }));
      }
      if (tool.name === 'binance_demo_get_action') return reply(output(await demoActionStatus(env, args.id)));
      return reply(output(await submitDemoAction(env, { ...args, kind: tool.kind })));
    } catch (error) {
      return reply(output({ code: error instanceof Failure ? error.code : 'BINANCE_DEMO_MCP_FAILURE' }, true));
    }
  },
};
