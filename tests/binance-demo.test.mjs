import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('Binance demo sync uses signed GETs, preserves the last snapshot, and requires a session', async () => {
  const apiKey = 'fixture-demo-key';
  const secretKey = 'fixture-demo-secret';
  const timestamp = Date.now();
  const seen = [];
  let blocked = false;
  const mutations = [];
  const bundle = await build({ entryPoints: ['worker/index.ts'], bundle: true, write: false, format: 'esm' });
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-11-01',
    d1Databases: ['DB'],
    bindings: {
      ADMIN_PASSWORD: 'test', SESSION_SECRET: 'test', BINANCE_DEMO_ENABLED: 'true',
      BINANCE_DEMO_TRADING_ENABLED: 'true',
      BINANCE_DEMO_API_KEY: apiKey, BINANCE_DEMO_SECRET_KEY: secretKey,
    },
    outboundService(request) {
      const url = new URL(request.url);
      seen.push(url.pathname);
      assert.equal(url.origin, 'https://demo-fapi.binance.com');
      if (url.pathname === '/fapi/v1/time') {
        assert.equal(request.headers.has('X-MBX-APIKEY'), false);
        if (blocked) return new Response('<h1>403 Forbidden</h1>', { status: 403 });
        return Response.json({ serverTime: timestamp });
      }
      if (url.pathname === '/fapi/v1/exchangeInfo') {
        assert.equal(request.method, 'GET');
        assert.equal(request.headers.has('X-MBX-APIKEY'), false);
        return Response.json({ symbols: [{ symbol: 'BTCUSDT', filters: ['LOT_SIZE', 'MARKET_LOT_SIZE'].map(filterType => ({
          filterType, minQty: '0.001', maxQty: '100', stepSize: '0.001',
        })) }] });
      }
      assert.equal(request.headers.get('X-MBX-APIKEY'), apiKey);
      const signedAt = Number(url.searchParams.get('timestamp'));
      assert.ok(signedAt >= timestamp && signedAt < timestamp + 5_000);
      assert.equal(url.searchParams.get('recvWindow'), '5000');
      const query = url.search.slice(1).split('&signature=')[0];
      const signature = createHmac('sha256', secretKey).update(query).digest('hex');
      assert.equal(url.search, `?${query}&signature=${signature}`);
      if (url.pathname === '/fapi/v1/positionSide/dual') return Response.json({ dualSidePosition: false });
      if (url.pathname === '/fapi/v1/order') {
        const params = Object.fromEntries(url.searchParams);
        if (request.method === 'POST') {
          mutations.push(params);
          return new Response('Gateway timeout', { status: 504 });
        }
        assert.equal(params.origClientOrderId, mutations[0].newClientOrderId);
        return Response.json({
          symbol: 'BTCUSDT', clientOrderId: params.origClientOrderId, orderId: 42,
          status: 'FILLED', executedQty: '0.001', avgPrice: '72000',
        });
      }
      assert.equal(request.method, 'GET');
      if (url.pathname === '/fapi/v3/account') return Response.json({ assets: [{
        asset: 'USDT', walletBalance: '1000', availableBalance: '800', marginBalance: '990', unrealizedProfit: '-10',
      }] });
      assert.equal(url.pathname, '/fapi/v3/positionRisk');
      return Response.json([
        { symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '-0.005', entryPrice: '70000',
          markPrice: '72000', unRealizedProfit: '-10', marginAsset: 'USDT' },
        { symbol: 'ETHUSDT', positionSide: 'BOTH', positionAmt: '0' },
      ]);
    },
  }));
  try {
    const db = await mf.getD1Database('DB');
    for (const file of ['0001.sql', '0007_binance_demo.sql']) {
      const schema = await readFile('migrations/' + file, 'utf8');
      for (const sql of schema.split(';').map(part => part.trim()).filter(Boolean)) await db.prepare(sql).run();
    }
    const api = (path, init) => mf.dispatchFetch('https://quantos.test/api' + path, init);
    const login = await api('/login', { method: 'POST', body: JSON.stringify({ password: 'test' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const headers = { Cookie: cookie };
    const sync = () => api('/binance-demo/sync', { method: 'POST', headers });
    assert.equal((await api('/binance-demo/account')).status, 401);
    assert.equal((await api('/binance-demo/sync', { method: 'POST' })).status, 401);
    assert.equal((await api('/binance-demo/order', { method: 'POST', headers })).status, 404);
    assert.deepEqual(seen, []);

    const result = await sync();
    assert.equal(result.status, 200);
    const body = await result.text();
    assert.ok(!body.includes(apiKey) && !body.includes(secretKey));
    const { snapshot } = JSON.parse(body).data;
    assert.equal(snapshot.account.walletBalance, '1000');
    assert.deepEqual(snapshot.positions.map(p => [p.symbol, p.side, p.unrealizedPnl]), [['BTCUSDT', 'SHORT', '-10']]);
    assert.equal(seen[0], '/fapi/v1/time');
    assert.deepEqual(seen.slice(1).sort(), ['/fapi/v3/account', '/fapi/v3/positionRisk']);

    blocked = true;
    const failure = await sync();
    assert.equal(failure.status, 502);
    assert.equal((await failure.json()).error.code, 'BINANCE_DEMO_HTTP_403');
    assert.equal(seen.length, 4);
    assert.equal(seen.at(-1), '/fapi/v1/time');
    const cached = await api('/binance-demo/account', { headers });
    assert.deepEqual((await cached.json()).data.snapshot, snapshot);

    blocked = false;
    const id = 'b'.repeat(32);
    const action = { kind: 'close', id, symbol: 'BTCUSDT', side: 'SHORT', percent: 25, confirm: true };
    const submit = payload => api('/binance-demo/action', { method: 'POST', headers, body: JSON.stringify(payload) });
    assert.equal((await submit({ ...action, confirm: false })).status, 400);
    assert.equal((await submit({ ...action, side: 'LONG' })).status, 409);
    assert.equal(mutations.length, 0);
    const outcomes = await Promise.all([submit(action), submit(action)]);
    assert.ok(outcomes.every(response => response.ok));
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].side, 'BUY');
    assert.equal(mutations[0].reduceOnly, 'true');
    assert.equal(mutations[0].quantity, '0.001');
    assert.equal((await submit({ ...action, percent: 50 })).status, 409);
    const lookup = await api('/binance-demo/action?id=' + id, { headers });
    assert.equal((await lookup.json()).data.result.exchangeStatus, 'FILLED');
    assert.equal(mutations.length, 1);
  } finally {
    await mf.dispose();
  }
});
