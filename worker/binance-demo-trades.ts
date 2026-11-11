import { demoRequest, demoSigner, parseDemoPositions, type BinanceDemoEnv } from './binance-demo';
import { Failure } from './exchange';
import { abs, decimal, min, positive, roundDown, text } from './virtual-decimal';

type OrderSide = 'LONG' | 'SHORT';
type DemoAction =
  | { kind: 'open'; symbol: string; side: OrderSide; quantity: string }
  | { kind: 'close'; symbol: string; side: OrderSide; percent: number }
  | { kind: 'leverage'; symbol: string; leverage: number };
type ActionRecord = { id: string; payload: string; state: string; result: string | null };

function requestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{32}$/.test(value)) throw new Failure('INVALID_REQUEST_ID');
  return value;
}

function decode(input: unknown): { id: string; action: DemoAction } {
  if (!input || typeof input !== 'object') throw new Failure('INVALID_DEMO_ACTION');
  const { kind, id, symbol, side, quantity, leverage, percent, confirm } = input as Record<string, unknown>;
  if (confirm !== true) throw new Failure('BINANCE_DEMO_CONFIRMATION_REQUIRED');
  if (typeof symbol !== 'string' || !/^[A-Z0-9]{2,24}USDT$/.test(symbol)) throw new Failure('INVALID_SYMBOL');
  const request = requestId(id);
  if (kind === 'leverage' && typeof leverage === 'number' && Number.isInteger(leverage) && leverage >= 1 && leverage <= 125) {
    return { id: request, action: { kind, symbol, leverage } };
  }
  if (kind === 'open' && (side === 'LONG' || side === 'SHORT')) {
    return { id: request, action: { kind, symbol, side, quantity: text(positive(quantity)) } };
  }
  if (kind === 'close' && (side === 'LONG' || side === 'SHORT') &&
    typeof percent === 'number' && Number.isInteger(percent) && percent >= 1 && percent <= 100) {
    return { id: request, action: { kind, symbol, side, percent } };
  }
  throw new Failure('INVALID_DEMO_ACTION');
}

const actionRow = (env: BinanceDemoEnv, id: string) => env.DB
  .prepare('SELECT id,payload,state,result FROM binance_demo_actions WHERE id=?').bind(id).first<ActionRecord>();

async function closeQuantity(symbol: string, quantity: string, percent: number) {
  type Filter = { filterType: string; stepSize: string; minQty: string; maxQty: string };
  const info = await demoRequest('/fapi/v1/exchangeInfo') as {
    symbols?: { symbol: string; filters: Filter[] }[];
  } | null;
  const contract = info?.symbols?.find(row => row.symbol === symbol);
  const lot = contract?.filters.find(row => row.filterType === 'LOT_SIZE');
  const market = contract?.filters.find(row => row.filterType === 'MARKET_LOT_SIZE');
  if (!lot || !market) throw new Failure('BINANCE_DEMO_MARKET_RULES_UNAVAILABLE', 502);
  const amount = abs(decimal(quantity)) * BigInt(percent) / 100n;
  const step = decimal(market.stepSize) || positive(lot.stepSize);
  const maximum = min(positive(market.maxQty), positive(lot.maxQty));
  const sized = roundDown(amount, step);
  if (sized > maximum) throw new Failure('BINANCE_DEMO_CLOSE_ABOVE_MAX');
  if (sized < positive(lot.minQty) || sized < decimal(market.minQty)) throw new Failure('BINANCE_DEMO_CLOSE_BELOW_MIN');
  return text(sized);
}

function outcome(record: ActionRecord) {
  return { id: record.id, state: record.state, result: record.result && JSON.parse(record.result) };
}

function orderResult(data: unknown, id: string, symbol: string) {
  const row = data as Record<string, unknown> | null;
  if (!row || row.symbol !== symbol || row.clientOrderId !== 'qos_' + id || typeof row.status !== 'string') {
    throw new Failure('BINANCE_DEMO_INVALID_RESPONSE', 502);
  }
  return {
    orderId: String(row.orderId),
    exchangeStatus: row.status,
    executedQuantity: String(row.executedQty ?? '0'),
    averagePrice: String(row.avgPrice ?? '0'),
  };
}

export async function demoActionStatus(env: BinanceDemoEnv, value: unknown) {
  const id = requestId(value);
  const record = await actionRow(env, id);
  if (!record) throw new Failure('BINANCE_DEMO_REQUEST_NOT_FOUND', 404);
  const action: DemoAction = JSON.parse(record.payload);
  if (record.state === 'rejected' || action.kind === 'leverage') return outcome(record);
  const sign = await demoSigner(env);
  try {
    const result = orderResult(await sign('GET', '/fapi/v1/order', {
      symbol: action.symbol, origClientOrderId: 'qos_' + id,
    }), id, action.symbol);
    await env.DB.prepare("UPDATE binance_demo_actions SET state='acknowledged',result=? WHERE id=?")
      .bind(JSON.stringify(result), id).run();
    return { id, state: 'acknowledged', result };
  } catch (error) {
    if (error instanceof Failure && error.code === 'BINANCE_DEMO_API_-2013') return outcome(record);
    throw error;
  }
}

export async function submitDemoAction(env: BinanceDemoEnv, input: unknown) {
  const { id, action } = decode(input);
  const payload = JSON.stringify(action);
  const existing = await actionRow(env, id);
  if (existing) {
    if (existing.payload !== payload) throw new Failure('BINANCE_DEMO_REQUEST_CONFLICT', 409);
    return outcome(existing);
  }
  const sign = await demoSigner(env);
  const params: Record<string, string> = { symbol: action.symbol };
  if (action.kind !== 'leverage') {
    const positions = parseDemoPositions(await sign('GET', '/fapi/v3/positionRisk', { symbol: action.symbol }));
    const position = positions.find(position => position.symbol === action.symbol && position.side === action.side);
    const mode = await sign('GET', '/fapi/v1/positionSide/dual') as { dualSidePosition?: unknown } | null;
    if (typeof mode?.dualSidePosition !== 'boolean') throw new Failure('BINANCE_DEMO_INVALID_RESPONSE', 502);
    if (action.kind === 'close') {
      if (!position || position.positionSide !== (mode.dualSidePosition ? action.side : 'BOTH')) {
        throw new Failure('BINANCE_DEMO_POSITION_CHANGED', 409);
      }
      params.quantity = await closeQuantity(action.symbol, position.quantity, action.percent);
      if (!mode.dualSidePosition) params.reduceOnly = 'true';
    } else if (!mode.dualSidePosition && positions.some(p => p.symbol === action.symbol && p.side !== action.side)) {
      throw new Failure('BINANCE_DEMO_OPPOSITE_POSITION', 409);
    }
    params.side = (action.side === 'LONG') === (action.kind === 'open') ? 'BUY' : 'SELL';
    params.positionSide = mode.dualSidePosition ? action.side : 'BOTH';
    if (action.kind === 'open') params.quantity = action.quantity;
    params.type = 'MARKET';
    params.newClientOrderId = 'qos_' + id;
    params.newOrderRespType = 'RESULT';
  }
  const inserted = await env.DB.prepare("INSERT OR IGNORE INTO binance_demo_actions(id,payload,state) VALUES(?,?,'pending') RETURNING id")
    .bind(id, payload).first();
  if (!inserted) {
    const record = (await actionRow(env, id))!;
    if (record.payload !== payload) throw new Failure('BINANCE_DEMO_REQUEST_CONFLICT', 409);
    return outcome(record);
  }

  let result: unknown;
  let state = 'acknowledged';
  try {
    if (action.kind === 'leverage') {
      const applied = await sign('POST', '/fapi/v1/leverage', {
        ...params, leverage: String(action.leverage),
      }) as { symbol?: unknown; leverage?: unknown } | null;
      if (applied?.symbol !== action.symbol || applied.leverage !== action.leverage) {
        throw new Failure('BINANCE_DEMO_INVALID_RESPONSE', 502);
      }
      result = { leverage: applied.leverage };
    } else {
      result = orderResult(await sign('POST', '/fapi/v1/order', params), id, action.symbol);
    }
  } catch (error) {
    const code = error instanceof Failure ? error.code : 'BINANCE_DEMO_TRADE_ERROR';
    const apiCode = /^BINANCE_DEMO_API_(-\d+)$/.exec(code)?.[1];
    state = apiCode && !['-1000', '-1001', '-1006', '-1007'].includes(apiCode) ? 'rejected' : 'unknown';
    result = { code };
  }
  await env.DB.prepare('UPDATE binance_demo_actions SET state=?,result=? WHERE id=?')
    .bind(state, JSON.stringify(result), id).run();
  return { id, state, result };
}
