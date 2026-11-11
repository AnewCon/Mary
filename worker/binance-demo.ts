import { Failure } from './exchange';

export interface BinanceDemoEnv {
  DB: D1Database;
  BINANCE_DEMO_ENABLED?: string;
  BINANCE_DEMO_API_KEY?: string;
  BINANCE_DEMO_SECRET_KEY?: string;
  BINANCE_DEMO_TRADING_ENABLED?: string;
}

const origin = 'https://demo-fapi.binance.com';
const snapshotKey = 'binance_demo_snapshot';
const encoder = new TextEncoder();
const configured = (env: BinanceDemoEnv) => Boolean(env.BINANCE_DEMO_API_KEY && env.BINANCE_DEMO_SECRET_KEY);

export async function demoRequest(path: string, apiKey?: string, method = 'GET'): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(origin + path, {
      headers: apiKey ? { 'X-MBX-APIKEY': apiKey } : undefined,
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new Failure('BINANCE_DEMO_UNREACHABLE', 502);
  }
  const data: unknown = await response.json().catch(() => null);
  const code = (data as { code?: unknown } | null)?.code;
  if (!response.ok || (typeof code === 'number' && code < 0)) {
    throw new Failure(typeof code === 'number' && Number.isSafeInteger(code) && code < 0
      ? 'BINANCE_DEMO_API_' + code
      : 'BINANCE_DEMO_HTTP_' + response.status, 502);
  }
  return data;
}

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Failure('BINANCE_DEMO_INVALID_RESPONSE', 502);
  }
  return value as Record<string, unknown>;
}

function decimal(value: unknown): string {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) {
    throw new Failure('BINANCE_DEMO_INVALID_RESPONSE', 502);
  }
  return value;
}

export async function fetchDemoSnapshot(env: BinanceDemoEnv) {
  const startedAt = new Date().toISOString();
  const signed = await demoSigner(env);
  const [accountData, positionData] = await Promise.all([
    signed('GET', '/fapi/v3/account'), signed('GET', '/fapi/v3/positionRisk'),
  ]);
  const account = row(accountData);
  if (!Array.isArray(account.assets)) throw new Failure('BINANCE_DEMO_INVALID_RESPONSE', 502);
  const usdt = account.assets.map(row).find(asset => asset.asset === 'USDT');
  return {
    updatedAt: startedAt,
    account: usdt ? {
      walletBalance: decimal(usdt.walletBalance),
      availableBalance: decimal(usdt.availableBalance),
      marginBalance: decimal(usdt.marginBalance),
      unrealizedPnl: decimal(usdt.unrealizedProfit),
    } : null,
    positions: parseDemoPositions(positionData),
  };
}

type ReadPath = '/fapi/v3/account' | '/fapi/v3/positionRisk' | '/fapi/v1/positionSide/dual' | '/fapi/v1/order';
type WritePath = '/fapi/v1/order' | '/fapi/v1/leverage';

export async function demoSigner(env: BinanceDemoEnv) {
  if (!configured(env)) throw new Failure('BINANCE_DEMO_CREDENTIALS_INCOMPLETE', 503);
  const { serverTime } = row(await demoRequest('/fapi/v1/time'));
  if (typeof serverTime !== 'number' || !Number.isSafeInteger(serverTime) || serverTime <= 0) {
    throw new Failure('BINANCE_DEMO_INVALID_RESPONSE', 502);
  }
  const syncedAt = Date.now();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(env.BINANCE_DEMO_SECRET_KEY!), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return async (...[method, path, params]: ['GET', ReadPath, Record<string, string>?] | ['POST', WritePath, Record<string, string>]) => {
    const query = new URLSearchParams({
      ...params, timestamp: String(serverTime + Date.now() - syncedAt), recvWindow: '5000',
    }).toString();
    const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(query));
    const signature = Array.from(new Uint8Array(signed), byte => byte.toString(16).padStart(2, '0')).join('');
    return demoRequest(path + '?' + query + '&signature=' + signature, env.BINANCE_DEMO_API_KEY, method);
  };
}

export function parseDemoPositions(data: unknown) {
  if (!Array.isArray(data)) throw new Failure('BINANCE_DEMO_INVALID_RESPONSE', 502);
  return data.map(row).filter(position => Number(decimal(position.positionAmt)) !== 0).map(position => {
    const { symbol, positionSide, marginAsset } = position;
    if (typeof symbol !== 'string' || !/^[A-Z0-9_-]{1,32}$/.test(symbol)
      || typeof marginAsset !== 'string' || !/^[A-Z0-9_-]{1,32}$/.test(marginAsset)
      || (positionSide !== 'BOTH' && positionSide !== 'LONG' && positionSide !== 'SHORT')) {
      throw new Failure('BINANCE_DEMO_INVALID_RESPONSE', 502);
    }
    const quantity = decimal(position.positionAmt);
    return {
      symbol, quantity, marginAsset, positionSide,
      side: positionSide === 'BOTH' ? (Number(quantity) > 0 ? 'LONG' : 'SHORT') : positionSide,
      entryPrice: decimal(position.entryPrice),
      markPrice: decimal(position.markPrice),
      unrealizedPnl: decimal(position.unRealizedProfit),
    };
  });
}

type Snapshot = Awaited<ReturnType<typeof fetchDemoSnapshot>>;

export async function syncBinanceDemo(env: BinanceDemoEnv) {
  const snapshot = await fetchDemoSnapshot(env);
  await env.DB.prepare(
    "INSERT INTO system_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE json_extract(system_settings.value,'$.updatedAt')<=?",
  ).bind(snapshotKey, JSON.stringify(snapshot), snapshot.updatedAt).run();
  return readBinanceDemo(env);
}

export async function readBinanceDemo(env: BinanceDemoEnv) {
  if (!configured(env)) return { configured: false, tradingEnabled: false, stale: true, snapshot: null };
  const stored = await env.DB.prepare('SELECT value FROM system_settings WHERE key=?')
    .bind(snapshotKey).first<{ value: string }>();
  const snapshot: Snapshot | null = stored ? JSON.parse(stored.value) : null;
  return {
    configured: true,
    tradingEnabled: env.BINANCE_DEMO_TRADING_ENABLED === 'true',
    stale: !snapshot || Date.now() - Date.parse(snapshot.updatedAt) > 120000,
    snapshot,
  };
}
