import { Failure } from './exchange';
import { positive } from './virtual-decimal';

export const minute = 60000;
export const source = 'Binance USDⓈ-M';
export const priceType = 'last_trade';
const host = 'https://fapi.binance.com';
const cache = new Map<string, { until: number; value: Promise<any> }>();
let backoffUntil = 0;
type Endpoint = 'exchangeInfo' | 'ticker/price' | 'klines' | 'aggTrades' | 'premiumIndex' | 'openInterest';
export interface MarketBudget { remaining:number; deadline:number }

function marketPath(endpoint:Endpoint,params:Record<string,string|number>) {
  const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));
  return `/fapi/${endpoint === 'ticker/price' ? 'v2' : 'v1'}/${endpoint}?${query}`;
}

async function market(endpoint: Endpoint, params: Record<string, string | number> = {}, ttl = 0, budget?:MarketBudget) {
  const path=marketPath(endpoint,params);
  const hit = cache.get(path);
  if (hit && hit.until > Date.now()) return hit.value;
  if (Date.now() < backoffUntil) throw new Failure('BINANCE_RATE_BACKOFF', 503);
  if(budget){
    if(budget.remaining<=0||Date.now()+5000>budget.deadline)throw new Failure('VIRTUAL_CATCHUP_PENDING',503);
    budget.remaining--;
  }
  const value = (async () => {
    let response: Response;
    try { response = await fetch(host + path, { method: 'GET', signal: AbortSignal.timeout(4500), redirect: 'manual' }); }
    catch { throw new Failure('BINANCE_NETWORK', 503); }
    if ([429, 418].includes(response.status)) {
      const seconds = Number(response.headers.get('Retry-After'));
      backoffUntil = Date.now() + Math.max(60, Number.isFinite(seconds) ? seconds : 0) * 1000;
    }
    if (!response.ok) throw new Failure(`BINANCE_HTTP_${response.status}`, 503);
    try { return await response.json(); }
    catch { throw new Failure('BINANCE_INVALID_RESPONSE', 503); }
  })();
  if (ttl) {
    if (cache.size > 180) cache.clear();
    cache.set(path, { until: Date.now() + ttl, value });
  }
  try { return await value; }
  catch (error) { cache.delete(path); throw error; }
}

export function symbolId(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Z0-9]{2,22}USDT$/.test(value)) throw new Failure('INVALID_USDT_PERPETUAL');
  return value;
}

export async function contract(symbol: string) {
  const data = await market('exchangeInfo', {}, 600000);
  const item = data?.symbols?.find((row: any) => row.symbol === symbol);
  if (item?.status !== 'TRADING' || item.contractType !== 'PERPETUAL' || item.marginAsset !== 'USDT') throw new Failure('CONTRACT_NOT_TRADING');
  const lot = item.filters.find((row: any) => row.filterType === 'MARKET_LOT_SIZE');
  const price = item.filters.find((row: any) => row.filterType === 'PRICE_FILTER');
  const minimum = item.filters.find((row: any) => row.filterType === 'MIN_NOTIONAL');
  for (const value of [lot?.stepSize, lot?.minQty, lot?.maxQty, price?.tickSize]) positive(value);
  return { step: lot.stepSize as string, minQty: lot.minQty as string, maxQty: lot.maxQty as string,
    tick: price.tickSize as string, minNotional: (minimum?.notional ?? '0') as string };
}

export async function quote(symbol: string,budget?:MarketBudget) {
  const row = await market('ticker/price', { symbol }, 1200,budget);
  if (row?.symbol !== symbol || !Number.isSafeInteger(row.time) || row.time > Date.now() + 500 || Date.now() - row.time > 15000)
    throw new Failure('STALE_BINANCE_QUOTE', 503);
  positive(row.price);
  return { symbol, price: row.price as string, time: row.time as number, source, priceType };
}

export interface Candle { time: number; end: number; open: string; high: string; low: string; close: string; volume: string }

function candle(row: any, interval: number): Candle {
  if (!Array.isArray(row) || !Number.isSafeInteger(row[0]) || row[0] % interval || row[6] !== row[0] + interval - 1)
    throw new Failure('INVALID_CANDLE_TIME', 503);
  const [open, high, low, close] = row.slice(1, 5).map(positive);
  if (low > open || low > close || high < open || high < close) throw new Failure('INVALID_CANDLE_PRICE', 503);
  return { time: row[0], end: row[6], open: row[1], high: row[2], low: row[3], close: row[4], volume: row[5] };
}

export async function candles(symbol: string, from: number, until: number,budget?:MarketBudget) {
  const count = Math.min(90, Math.floor((until - from) / minute));
  if (count <= 0) return [];
  const params={symbol, interval:'1m', startTime:from, endTime:from+count*minute-1, limit:count};
  try {
    const rows=await market('klines',params,50000,budget);
    if(!Array.isArray(rows)||rows.length!==count)throw new Failure('BINANCE_KLINE_GAP',503);
    const parsed=rows.map(row=>candle(row,minute));
    if(parsed.some((row,index)=>row.time!==from+index*minute))throw new Failure('BINANCE_KLINE_GAP',503);
    return parsed;
  } catch(error) {
    cache.delete(marketPath('klines',params));
    throw error;
  }
}

// Aggregate trades are used for the partial candle at entry and before a manual change.
// Completed full minutes use the trade-price OHLC series, never mark-price OHLC.
export async function partialTrades(symbol: string, from: number, until: number,budget?:MarketBudget): Promise<Candle[]> {
  if (until <= from) return [];
  const result: Candle[] = [];
  let previousId: number | undefined;
  let previousTime = from - 1;
  for (let page = 0; page < 8; page++) {
    const params: Record<string, number | string> = { symbol, limit: 1000 };
    if (previousId === undefined) Object.assign(params, { startTime: from, endTime: until - 1 });
    else params.fromId = previousId + 1;
    const rows = await market('aggTrades', params, 1200,budget);
    if (!Array.isArray(rows) || rows.length > 1000) throw new Failure('INVALID_AGG_TRADES', 503);
    for (const row of rows) {
      if (!Number.isSafeInteger(row?.a) || !Number.isSafeInteger(row.T) || row.T < from || row.T < previousTime ||
          (previousId !== undefined && row.a !== previousId + 1)) throw new Failure('BINANCE_AGG_TRADE_GAP', 503);
      if (row.T >= until) return result;
      positive(row.p);
      result.push({ time: row.T, end: row.T, open: row.p, high: row.p, low: row.p, close: row.p, volume: row.q });
      previousId = row.a;
      previousTime = row.T;
    }
    if (rows.length < 1000) return result;
  }
  throw new Failure('BINANCE_PARTIAL_HISTORY_LIMIT', 503);
}

export async function marketContext(symbol: string) {
  const now = Date.now();
  const fifteen = 15 * minute, day = 24 * 60 * minute;
  const [latest, instrument, intraday, daily, mark, interest] = await Promise.all([
    quote(symbol), contract(symbol), market('klines', { symbol, interval: '15m', limit: 64 }, 45000),
    market('klines', { symbol, interval: '1d', limit: 32 }, 45000),
    market('premiumIndex', { symbol }, 10000), market('openInterest', { symbol }, 10000),
  ]);
  return { ...latest, instrument, markPrice: mark.markPrice, markTime: mark.time,
    fundingRate: mark.lastFundingRate, nextFundingTime: mark.nextFundingTime, openInterest: interest.openInterest,
    openInterestTime: interest.time, intraday: intraday.map((row: any) => candle(row, fifteen)).filter((row: Candle) => row.end < now),
    daily: daily.map((row: any) => candle(row, day)).filter((row: Candle) => row.end < now),
    policy: '15m/1d are closed trade-price candles. Virtual entries and protection use last-trade prices; mark price is context only.' };
}
