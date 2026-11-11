import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { fetch, ProxyAgent } from 'undici';

const root = new URL('../', import.meta.url);
const localConfig = fileURLToPath(new URL('.env.binance-mcp', root));
if (existsSync(localConfig)) process.loadEnvFile(localConfig);
const { BINANCE_DEMO_API_KEY, BINANCE_DEMO_SECRET_KEY, BINANCE_DEMO_PROXY } = process.env;
if (!BINANCE_DEMO_API_KEY || !BINANCE_DEMO_SECRET_KEY || !BINANCE_DEMO_PROXY) {
  console.error('Configure BINANCE_DEMO_API_KEY, BINANCE_DEMO_SECRET_KEY and BINANCE_DEMO_PROXY.');
  process.exit(1);
}
const proxy = new URL(BINANCE_DEMO_PROXY);
if (!['http:', 'https:'].includes(proxy.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(proxy.hostname)) {
  console.error('BINANCE_DEMO_PROXY must be a local HTTP proxy.');
  process.exit(1);
}
const dispatcher = new ProxyAgent(proxy.toString());
const token = randomUUID();
const storage = fileURLToPath(new URL('.wrangler/binance-mcp', root));
const worker = await build({
  entryPoints: [fileURLToPath(new URL('mcp/binance-local.ts', root))],
  bundle: true, format: 'esm', write: false,
});
const mf = new Miniflare(convertV4MiniflareOptions({
  host: '127.0.0.1',
  modules: true,
  script: worker.outputFiles[0].text,
  compatibilityDate: '2026-11-01',
  d1Databases: { DB: 'quantos-binance-mcp' },
  d1Persist: storage,
  bindings: {
    MCP_LOCAL_TOKEN: token, BINANCE_DEMO_API_KEY, BINANCE_DEMO_SECRET_KEY,
    BINANCE_DEMO_TRADING_ENABLED: process.env.BINANCE_DEMO_TRADING_ENABLED ?? 'false',
  },
  async outboundService(request) {
    const url = new URL(request.url);
    if (url.origin !== 'https://demo-fapi.binance.com') return new Response(null, { status: 403 });
    try {
      const apiKey = request.headers.get('X-MBX-APIKEY');
      const result = await fetch(url, {
        dispatcher, method: request.method, headers: apiKey ? { 'X-MBX-APIKEY': apiKey } : undefined,
        redirect: 'manual', signal: AbortSignal.timeout(8_000),
      });
      return new Response(await result.text(), { status: result.status, headers: { 'Content-Type': result.headers.get('content-type') ?? '' } });
    } catch {
      return new Response(null, { status: 502 });
    }
  },
}));

try {
  const db = await mf.getD1Database('DB');
  const migration = await readFile(new URL('migrations/0007_binance_demo.sql', root), 'utf8');
  await db.prepare(migration.trim()).run();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'INVALID_JSON' } }) + '\n');
      continue;
    }
    try {
      const result = await mf.dispatchFetch('http://127.0.0.1/mcp', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-QuantOS-Local': token },
        body: JSON.stringify(message),
      });
      if (result.status !== 204) process.stdout.write(await result.text() + '\n');
    } catch {
      if (message?.id !== undefined) process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'MCP_LOCAL_UNAVAILABLE' },
      }) + '\n');
    }
  }
} finally {
  await mf.dispose();
  await dispatcher.close();
}
