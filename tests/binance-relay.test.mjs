import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarketRelay } from '../scripts/binance-market-relay.mjs';

const token='fixture-only-public-market-token-42';
const request=(path,tokenValue=token,method='GET')=>new Request('https://relay.example'+path,{method,headers:{Authorization:'Bearer '+tokenValue}});

test('relay only forwards authenticated public Binance market reads without forwarding credentials',async()=>{
 const upstream=[];
 const handle=createMarketRelay(token,{fetchUpstream:async(url,options)=>{
  upstream.push({url,options});return Response.json({symbol:'BTCUSDT',price:'123.4',time:1794390000000});
 }});
 assert.equal((await handle(request('/fapi/v2/ticker/price?symbol=BTCUSDT','incorrect'))).status,401);
 assert.equal((await handle(request('/fapi/v2/ticker/price?symbol=BTCUSDT',token,'POST'))).status,405);
 assert.equal((await handle(request('/fapi/v1/order?symbol=BTCUSDT'))).status,404);
 assert.equal((await handle(request('/fapi/v3/account'))).status,404);
 assert.equal((await handle(request('/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=90&symbol=ETHUSDT'))).status,400);
 assert.equal((await handle(request('/fapi/v1/aggTrades?symbol=BTCUSDT&startTime=10&endTime=20&fromId=22'))).status,400);
 assert.equal((await handle(request('/fapi/v2/ticker/price?symbol=BTCUSDT&destination=https://example.org'))).status,400);
 const result=await handle(request('/fapi/v2/ticker/price?symbol=BTCUSDT'));
 assert.equal(result.headers.get('X-QuantOS-Market-Source'),'binance-usdm');
 assert.equal((await result.json()).price,'123.4');
 assert.equal(upstream.length,1);
 assert.equal(upstream[0].url,'https://fapi.binance.com/fapi/v2/ticker/price?symbol=BTCUSDT');
 assert.deepEqual(upstream[0].options.headers,{Accept:'application/json'});
 assert.equal(upstream[0].options.redirect,'manual');
});

test('relay preserves failures and refuses redirect and non-JSON responses',async()=>{
 const responses=[new Response('blocked',{status:403}),new Response(null,{status:429,headers:{'Retry-After':'72'}}),
  new Response(null,{status:302,headers:{Location:'https://example.org'}}),new Response('<html>blocked</html>')];
 const handle=createMarketRelay(token,{fetchUpstream:async()=>responses.shift()});
 const query='/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=2';
 assert.equal((await handle(request(query))).status,403);
 assert.equal((await handle(request(query))).headers.get('Retry-After'),'72');
 assert.equal((await handle(request(query))).status,502);
 assert.equal((await handle(request(query))).status,502);
});
