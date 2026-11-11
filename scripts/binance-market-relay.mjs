import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';

const binance='https://fapi.binance.com';
const sourceHeader='X-QuantOS-Market-Source';
const symbol=/^[A-Z0-9]{2,22}USDT$/;
const uint=/^\d{1,16}$/;
const rules=new Map([
  ['/fapi/v1/time',[]], ['/fapi/v1/exchangeInfo',[]],
  ['/fapi/v2/ticker/price',['symbol']], ['/fapi/v1/premiumIndex',['symbol']], ['/fapi/v1/openInterest',['symbol']],
  ['/fapi/v1/klines',['symbol','interval','limit','startTime','endTime']],
  ['/fapi/v1/aggTrades',['symbol','limit','startTime','endTime','fromId']],
]);

function validQuery(path,query,allowed){
  for(const [key,value] of query){
    if(!allowed.includes(key)||query.getAll(key).length!==1)return false;
    if(key==='symbol'&&!symbol.test(value))return false;
    if(key==='interval'&&!['1m','15m','1d'].includes(value))return false;
    if(!['symbol','interval'].includes(key)&&(!uint.test(value)||!Number.isSafeInteger(Number(value))))return false;
  }
  if(allowed.includes('symbol')&&!query.has('symbol'))return false;
  if(path.endsWith('/klines')&&!query.has('interval'))return false;
  if(query.has('limit')&&(Number(query.get('limit'))<1||Number(query.get('limit'))>(path.endsWith('/klines')?90:1000)))return false;
  if(query.has('startTime')!==query.has('endTime'))return false;
  if(query.has('startTime')&&Number(query.get('endTime'))<Number(query.get('startTime')))return false;
  if(query.has('fromId')&&query.has('startTime'))return false;
  return true;
}

const error=(status,code)=>Response.json({code},{status,headers:{'Cache-Control':'no-store'}});

export function createMarketRelay(token,{fetchUpstream=fetch,now=Date.now}={}){
  if(!/^[A-Za-z0-9_-]{32,128}$/.test(token??''))throw new Error('Set QUANTOS_MARKET_RELAY_TOKEN to a random base64url token (32–128 characters).');
  const authorization=Buffer.from('Bearer '+token);
  let windowStart=0,used=0,inFlight=0;
  return async request=>{
    if(request.method!=='GET')return error(405,'METHOD_NOT_ALLOWED');
    const sent=Buffer.from(request.headers.get('Authorization')??'');
    if(sent.length!==authorization.length||!timingSafeEqual(sent,authorization))return error(401,'UNAUTHORIZED');
    const url=new URL(request.url);
    const allowed=rules.get(url.pathname);
    if(!allowed)return error(404,'PUBLIC_MARKET_ROUTE_ONLY');
    if(!validQuery(url.pathname,url.searchParams,allowed))return error(400,'INVALID_MARKET_QUERY');
    const window=Math.floor(now()/60000);
    if(window!==windowStart){windowStart=window;used=0}
    if(used>=90||inFlight>=8)return new Response(null,{status:429,headers:{'Retry-After':'60'}});
    used++;inFlight++;
    try{
      const upstream=await fetchUpstream(binance+url.pathname+url.search,{
        method:'GET',redirect:'manual',signal:AbortSignal.timeout(3500),headers:{Accept:'application/json'},
      });
      if(!upstream.ok){
        const retry=upstream.headers.get('Retry-After');
        await upstream.body?.cancel();
        const status=upstream.status>=400?upstream.status:502;
        return new Response(null,{status,headers:retry?{'Retry-After':retry}:{}});
      }
      if(!upstream.headers.get('Content-Type')?.toLowerCase().includes('application/json')){
        await upstream.body?.cancel();return error(502,'INVALID_BINANCE_RESPONSE');
      }
      const body=await upstream.text();
      if(body.length>2_000_000)return error(502,'BINANCE_RESPONSE_TOO_LARGE');
      return new Response(body,{headers:{'Content-Type':'application/json','Cache-Control':'no-store',[sourceHeader]:'binance-usdm'}});
    }catch{return error(502,'BINANCE_NETWORK')}
    finally{inFlight--}
  };
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const handle=createMarketRelay(process.env.QUANTOS_MARKET_RELAY_TOKEN);
  const port=Number(process.env.QUANTOS_MARKET_RELAY_PORT??8796);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid QUANTOS_MARKET_RELAY_PORT');
  createServer(async (req,res)=>{
    try{
      if(!req.url?.startsWith('/')||req.url.startsWith('//')||req.url.length>1500){res.writeHead(400).end();return;}
      const reply=await handle(new Request('http://127.0.0.1'+req.url,{method:req.method,headers:req.headers}));
      res.writeHead(reply.status,Object.fromEntries(reply.headers));
      if(reply.body)Readable.fromWeb(reply.body).pipe(res);else res.end();
    }catch{res.writeHead(502).end()}
  }).listen(port,'127.0.0.1',()=>console.log('QuantOS public-market relay on loopback port '+port));
}
