import { Failure } from './exchange';
import { decimal, positive, text, mul, div } from './virtual-decimal';

type Order = {
  id: string; symbol: string; side: 'LONG'|'SHORT'; quantity: string;
  entry: string; mark: string; margin: string; openedAt: number; markAt: number;
  leverage?: number; entryCostRaw?: string;
  closedAt?: number;
};
type Ledger = {
  initial: string; orders: Order[]; receipts: Record<string, string>;
};
const key = 'binance_chat_paper_orders_v1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scale = decimal('1');
const maintenanceRate = decimal('0.005');
const entryCost = (order: Order) => order.entryCostRaw === undefined
  ? decimal(order.entry) * decimal(order.quantity) : BigInt(order.entryCostRaw);
const pnl = (order: Order) => (order.side === 'LONG' ? 1n : -1n) *
  ((decimal(order.mark) * decimal(order.quantity) - entryCost(order)) / scale);

function orderView(order: Order) {
  const profit = pnl(order);
  const margin = decimal(order.margin);
  const quantity = decimal(order.quantity);
  const long = order.side === 'LONG';
  const maintenance = mul(mul(decimal(order.mark), quantity), maintenanceRate);
  const numerator = long ? entryCost(order) - margin * scale : entryCost(order) + margin * scale;
  const denominator = quantity * (long ? scale - maintenanceRate : scale + maintenanceRate);
  const liquidationPrice = numerator > 0n ? numerator * scale / denominator : null;
  const { entryCostRaw: _cost, ...fields } = order;
  return {
    ...fields, leverage: order.leverage ?? 1, pnl: text(profit),
    entryNotional: text(entryCost(order) / scale),
    marginRoiPct: text(div(profit, margin) * 100n),
    liquidationPrice: order.closedAt || liquidationPrice === null ? null : text(liquidationPrice),
    liquidationRisk: order.closedAt ? null : margin + profit <= maintenance ? 'AT_RISK' : 'ABOVE_MAINTENANCE',
  };
}
function view(state: Ledger|null) {
  const orders = state?.orders ?? [];
  const realized = orders.reduce((n,o) => n + (o.closedAt ? pnl(o) : 0n), 0n);
  const floating = orders.reduce((n,o) => n + (!o.closedAt ? pnl(o) : 0n), 0n);
  const held = orders.reduce((n,o) => n + (!o.closedAt ? decimal(o.margin) : 0n), 0n);
  const cash = state ? decimal(state.initial) + realized : 0n;
  return { account: '币安虚拟账户', mode: 'paper', currency: 'USDT', initial: state?.initial ?? null,
    balance: state ? text(cash) : null, available: state ? text(cash-held) : null,
    realized: text(realized), unrealized: text(floating), closedCount:orders.filter(o=>o.closedAt).length,
    maintenanceMarginRatePct: '0.5',
    orders: [...orders.filter(o=>!o.closedAt), ...orders.filter(o=>o.closedAt).reverse().slice(0,40)].map(orderView) };
}
async function read(db: D1Database) {
  return (await db.prepare('SELECT value FROM system_settings WHERE key=?').bind(key).first<string>('value')) ?? null;
}
export async function paperOrders(db:D1Database) {
  const raw = await read(db);
  return view(raw ? JSON.parse(raw) : null);
}
export async function writePaperOrder(db:D1Database, input:any) {
  if (!input || typeof input.requestId !== 'string' || !uuid.test(input.requestId)) throw new Failure('PAPER_REQUEST_ID_REQUIRED');
  const {action,requestId,initial,symbol,side,margin,orderId,price,priceTime,leverage} = input;
  if ([action,initial,symbol,side,margin,orderId,price].some(v=>v!==undefined&&(typeof v!=='string'||v.length>60))
    || (priceTime!==undefined&&!Number.isSafeInteger(priceTime))) throw new Failure('PAPER_INVALID_INPUT');
  if (leverage !== undefined && (action !== 'OPEN' && action !== 'ADD' ||
      !Number.isInteger(leverage) || leverage < 1 || leverage > 125)) throw new Failure('PAPER_INVALID_LEVERAGE');
  const id = requestId.toLowerCase();
  const fingerprint = JSON.stringify([action,initial,symbol,side,margin,orderId,price,priceTime,
    ...(leverage === undefined || action === 'OPEN' && leverage === 1 ? [] : [leverage])]);
  const raw = await read(db);
  let state: Ledger|null = raw ? JSON.parse(raw) : null;
  if (state?.receipts[id] !== undefined) {
    if (state.receipts[id] !== fingerprint) throw new Failure('PAPER_REQUEST_CONFLICT',409);
    return {requestId:id,status:'COMMITTED',...view(state)};
  }
  if (state && Object.keys(state.receipts).length >= 2000) throw new Failure('PAPER_LEDGER_LIMIT',409);
  if (action === 'INITIALIZE') {
    if (state) throw new Failure('PAPER_ALREADY_INITIALIZED',409);
    state = {initial:text(positive(initial)),orders:[],receipts:{}};
  } else {
    if (!state) throw new Failure('PAPER_INITIAL_BALANCE_REQUIRED',409);
    const mark = positive(price);
    const now = Date.now();
    if (!Number.isSafeInteger(priceTime) || priceTime > now+10000 || priceTime < now-300000)
      throw new Failure('PAPER_RECENT_PRICE_REQUIRED');
    if (action === 'OPEN') {
      if (state.orders.filter(o=>!o.closedAt).length >= 30) throw new Failure('PAPER_OPEN_ORDER_LIMIT',409);
      if (typeof symbol !== 'string' || !/^[A-Z0-9]{2,22}USDT$/.test(symbol) || !['LONG','SHORT'].includes(side))
        throw new Failure('PAPER_INVALID_CONTRACT');
      const stake = positive(margin);
      if (stake > decimal(view(state).available)) throw new Failure('PAPER_INSUFFICIENT_BALANCE',409);
      const multiple = leverage ?? 1;
      const quantity = div(stake * BigInt(multiple),mark);
      if (quantity <= 0n) throw new Failure('PAPER_QUANTITY_TOO_SMALL');
      state.orders.push({id,symbol,side,leverage:multiple,quantity:text(quantity),entry:text(mark),mark:text(mark),margin:text(stake),openedAt:now,markAt:priceTime});
    } else if (action === 'ADD' || action === 'MARK' || action === 'CLOSE') {
      const order = state.orders.find(o=>o.id===orderId);
      if (!order || order.closedAt) throw new Failure('PAPER_OPEN_ORDER_NOT_FOUND',404);
      if (symbol !== order.symbol) throw new Failure('PAPER_SYMBOL_MISMATCH');
      if (priceTime < order.markAt) throw new Failure('PAPER_PRICE_OUT_OF_ORDER',409);
      if (action === 'ADD') {
        const multiple = order.leverage ?? 1;
        if (leverage !== undefined && leverage !== multiple) throw new Failure('PAPER_LEVERAGE_MISMATCH',409);
        if (side !== undefined && side !== order.side) throw new Failure('PAPER_SIDE_MISMATCH',409);
        const stake = positive(margin);
        if (stake > decimal(view(state).available)) throw new Failure('PAPER_INSUFFICIENT_BALANCE',409);
        const added = div(stake * BigInt(multiple),mark);
        if (added <= 0n) throw new Failure('PAPER_QUANTITY_TOO_SMALL');
        const quantity = decimal(order.quantity) + added;
        const cost = entryCost(order) + added * mark;
        order.entryCostRaw = cost.toString();
        order.quantity = text(quantity);
        order.entry = text(cost / quantity);
        order.margin = text(decimal(order.margin) + stake);
        order.leverage = multiple;
      }
      order.mark = text(mark);
      order.markAt = priceTime;
      if (action === 'CLOSE') order.closedAt = now;
    } else throw new Failure('PAPER_UNKNOWN_ACTION');
  }
  state.receipts[id] = fingerprint;
  const next = JSON.stringify(state);
  const changed = raw === null
    ? await db.prepare('INSERT OR IGNORE INTO system_settings (key,value) VALUES (?,?)').bind(key,next).run()
    : await db.prepare('UPDATE system_settings SET value=? WHERE key=? AND value=?').bind(next,key,raw).run();
  if (changed.meta.changes !== 1) throw new Failure('PAPER_CONCURRENT_UPDATE_RETRY_SAME_ID',409);
  return {requestId:id,status:'COMMITTED',...view(state)};
}
