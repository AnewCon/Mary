import fs from 'node:fs';
const base=process.argv[2]||'https://quantos.313919971.workers.dev';
const password=fs.readFileSync('.dev.vars','utf8').match(/^ADMIN_PASSWORD="([^"]+)"/m)[1];
const page=await fetch(base);console.log('HTML',page.status,(await page.text()).includes('QuantOS'));
const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({password})});console.log('LOGIN',login.status);if(!login.ok)throw Error(await login.text());
const cookie=login.headers.get('set-cookie').split(';')[0];
for(const path of ['/status','/account','/positions','/keys','/ai/decisions']){const r=await fetch(base+'/api'+path,{headers:{Cookie:cookie}});const data=await r.json();console.log(path,r.status,data.ok,path==='/status'?JSON.stringify(data.data):'');if(!r.ok||!data.ok)throw Error('Smoke check failed')}
const logout=await fetch(base+'/api/logout',{method:'POST',headers:{Cookie:cookie,Origin:base},body:'{}'});console.log('LOGOUT',logout.status);
