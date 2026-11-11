import {test,after,before} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import fs from 'node:fs';
let mf,cookie,key,id;
before(async()=>{const out=await build({entryPoints:['worker/index.ts'],bundle:true,write:false,format:'esm',platform:'browser'});mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'quantos',modules:true,script:out.outputFiles[0].text,compatibilityDate:'2026-11-01',d1Databases:['DB'],bindings:{ADMIN_PASSWORD:'test-password-not-production',SESSION_SECRET:'test-session-secret'}}]}));const db=await mf.getD1Database('DB');for(const statement of fs.readFileSync('migrations/0001.sql','utf8').split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(statement).run()});
after(async()=>{await mf?.dispose()});
async function request(path,body,token,session=true,origin){const headers={};if(session&&cookie)headers.Cookie=cookie;if(token)headers.Authorization='Bearer '+token;if(origin)headers.Origin=origin;const r=await mf.dispatchFetch('https://quantos.test/api'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});return {r,j:await r.json()}}
test('private data requires authentication',async()=>{assert.equal((await request('/account',undefined,undefined,false)).r.status,401)});
test('login sets a protected session; wrong password fails',async()=>{assert.equal((await request('/login',{password:'bad'})).r.status,401);const {r}=await request('/login',{password:'test-password-not-production'});assert.equal(r.status,200);cookie=r.headers.get('set-cookie').split(';')[0];assert.match(r.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Strict/)});
test('unconfigured exchange shows no fabricated data',async()=>{const s=await request('/status');assert.equal(s.j.data.configured,false);assert.equal(s.j.data.stale,true);assert.equal((await request('/account')).j.data,null);assert.equal((await request('/sync',{})).j.error.code,'OKX_CREDENTIALS_INCOMPLETE')});
test('session mutation rejects cross origin',async()=>{assert.equal((await request('/system/halt',{},undefined,true,'https://evil.test')).r.status,403)});
test('platform key is shown once and stored only as hash',async()=>{const created=await request('/keys',{name:'test',scopes:['read','write']});key=created.j.data.key;id=created.j.data.id;assert.match(key,/^qos_[a-f0-9]{64}$/);const listed=await request('/keys');assert.ok(!JSON.stringify(listed.j).includes(key));const db=await mf.getD1Database('DB');assert.notEqual((await db.prepare('SELECT hash FROM api_keys WHERE id=?').bind(id).first()).hash,key)});
test('API read/write works but keys cannot control trades or halt',async()=>{assert.equal((await request('/status',undefined,key,false)).r.status,200);const saved=await request('/ai/decisions',{content:'Integration test',symbol:'BTC-USDT-SWAP',source:'test'},key,false);assert.equal(saved.r.status,200);assert.equal((await request('/ai/decisions',undefined,key,false)).j.data.length,1);assert.equal((await request('/system/halt',{},key,false)).r.status,401);assert.equal((await request('/trades/test/close',{confirm:true},key,false)).r.status,401);assert.equal((await request('/keys',undefined,key,false)).r.status,401)});
test('trade scopes and invalid records are rejected',async()=>{assert.equal((await request('/keys',{name:'unsafe',scopes:['trade']})).r.status,400);assert.equal((await request('/ai/logs',{content:3},key,false)).r.status,400);assert.equal((await request('/ai/logs',{content:'x'.repeat(17000)},key,false)).r.status,413)});
test('read-only keys cannot write and revocation takes effect',async()=>{const read=await request('/keys',{name:'reader',scopes:['read']});assert.equal((await request('/ai/logs',{content:'denied'},read.j.data.key,false)).r.status,401);await request('/keys/'+id+'/revoke',{});assert.equal((await request('/status',undefined,key,false)).r.status,401)});
test('capital reference persists and is editable only with an authenticated session',async()=>{
 assert.equal((await request('/status')).j.data.capitalUsd,null);
 const platform=(await request('/keys',{name:'capital-test',scopes:['read','write']})).j.data.key;
 assert.equal((await request('/settings/capital',{capitalUsd:'100000'},platform,false)).r.status,401);
 for(const capitalUsd of ['0','-1','1e4','12.345',100])assert.equal((await request('/settings/capital',{capitalUsd})).r.status,400);
 assert.equal((await request('/settings/capital',{capitalUsd:'100000'})).j.data.capitalUsd,'100000.00');
 assert.equal((await request('/status')).j.data.capitalUsd,'100000.00');
});
test('logout invalidates the session',async()=>{await request('/logout',{});assert.equal((await request('/status')).r.status,401)});


