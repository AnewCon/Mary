import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('local Binance MCP reads demo balances and requires confirmation before sending a single order', async () => {
  const bundle = await build({ entryPoints: ['mcp/binance-local.ts'], bundle: true, write: false, format: 'esm' });
  let submitted = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-11-01', d1Databases: ['DB'],
    bindings: {
      MCP_LOCAL_TOKEN: 'test-local-token', BINANCE_DEMO_TRADING_ENABLED: 'true',
      BINANCE_DEMO_API_KEY: 'fixture-api-key', BINANCE_DEMO_SECRET_KEY: 'fixture-secret',
    },
    outboundService(request) {
      const url = new URL(request.url);
      assert.equal(url.origin, 'https://demo-fapi.binance.com');
      assert.equal(request.headers.get('X-MBX-APIKEY'), 'fixture-api-key');
      assert.match(url.searchParams.get('signature'), /^[a-f0-9]{64}$/);
      if (url.pathname === '/fapi/v3/account') return Response.json({ assets: [{
        asset: 'USDT', walletBalance: '100', availableBalance: '100', marginBalance: '100', unrealizedProfit: '0',
      }] });
      if (url.pathname === '/fapi/v3/positionRisk') return Response.json([]);
      if (url.pathname === '/fapi/v1/positionSide/dual') return Response.json({ dualSidePosition: false });
      assert.equal(url.pathname, '/fapi/v1/order');
      assert.equal(request.method, 'POST');
      assert.equal(url.searchParams.get('side'), 'BUY');
      assert.equal(url.searchParams.get('quantity'), '0.001');
      submitted++;
      return Response.json({ orderId: 1, status: 'FILLED', symbol: 'BTCUSDT',
        clientOrderId: url.searchParams.get('newClientOrderId'), executedQty: '0.001', avgPrice: '80000' });
    },
  }));
  try {
    const db = await mf.getD1Database('DB');
    await db.prepare((await readFile('migrations/0007_binance_demo.sql', 'utf8')).trim()).run();
    const send = (method, params, authorized = true) => mf.dispatchFetch('http://localhost/mcp', {
      method: 'POST', headers: authorized ? { 'X-QuantOS-Local': 'test-local-token' } : {},
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const invoke = async (name, args) => {
      const result = await (await send('tools/call', { name, arguments: args })).json();
      return result.result.structuredContent.data;
    };
    assert.equal((await send('tools/list', {}, false)).status, 403);
    const list = await (await send('tools/list')).json();
    const open = list.result.tools.find(tool => tool.name === 'binance_demo_open');
    assert.equal(open.annotations.destructiveHint, true);
    const snapshot = await invoke('binance_demo_get_account', {});
    assert.equal(snapshot.mode, 'demo');
    assert.equal(snapshot.account.walletBalance, '100');
    assert.equal(JSON.stringify(snapshot).includes('fixture-'), false);
    const args = { id: 'f'.repeat(32), symbol: 'BTCUSDT', side: 'LONG', quantity: '0.001', confirm: false };
    assert.deepEqual(await invoke('binance_demo_open', args), { code: 'BINANCE_DEMO_CONFIRMATION_REQUIRED' });
    assert.equal(submitted, 0);
    assert.equal((await invoke('binance_demo_open', { ...args, confirm: true })).result.exchangeStatus, 'FILLED');
    assert.equal((await invoke('binance_demo_open', { ...args, confirm: true })).result.exchangeStatus, 'FILLED');
    assert.equal(submitted, 1);
  } finally {
    await mf.dispose();
  }
});
