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
  const bundle = await build({ entryPoints: ['worker/index.ts'], bundle: true, write: false, format: 'esm' });
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-11-01',
    d1Databases: ['DB'],
    bindings: {
      ADMIN_PASSWORD: 'test', SESSION_SECRET: 'test', BINANCE_DEMO_ENABLED: 'true',
      BINANCE_DEMO_API_KEY: apiKey, BINANCE_DEMO_SECRET_KEY: secretKey,
    },
    outboundService(request) {
      const url = new URL(request.url);
      seen.push(url.pathname);
      assert.equal(url.origin, 'https://demo-fapi.binance.com');
      assert.equal(request.method, 'GET');
      if (url.pathname === '/fapi/v1/time') {
        assert.equal(request.headers.has('X-MBX-APIKEY'), false);
        if (blocked) return new Response('<h1>403 Forbidden</h1>', { status: 403 });
        return Response.json({ serverTime: timestamp });
      }
      assert.equal(request.headers.get('X-MBX-APIKEY'), apiKey);
      const query = `timestamp=${timestamp}&recvWindow=5000`;
      const signature = createHmac('sha256', secretKey).update(query).digest('hex');
      assert.equal(url.search, `?${query}&signature=${signature}`);
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
    const schema = await readFile('migrations/0001.sql', 'utf8');
    for (const sql of schema.split(';').map(part => part.trim()).filter(Boolean)) await db.prepare(sql).run();
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
  } finally {
    await mf.dispose();
  }
});
