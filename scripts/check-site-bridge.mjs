import process from 'node:process';
process.stdout.write('Ready for private Site verification input (hidden).\n');
if(process.stdin.isTTY)process.stdin.setRawMode(true);
const input=await new Promise((resolve,reject)=>{let s='';process.stdin.resume();process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{s+=chunk;if(s.includes('\n')||s.includes('\r')){process.stdin.pause();if(process.stdin.isTTY)process.stdin.setRawMode(false);try{resolve(JSON.parse(s.trim()))}catch(e){reject(e)}}})});
const base='https://quantos-snow-mcp-20261110.evenbroth3.chatgpt.site';
for(const method of ['server/discover','tools/list']){const r=await fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json','OAI-Sites-Authorization':'Bearer '+input.token},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{}}),signal:AbortSignal.timeout(30000)});const text=await r.text();let j;try{j=JSON.parse(text)}catch{throw Error('Site returned non-JSON: '+r.status)}console.log(JSON.stringify({method,http:r.status,versions:j.result?.supportedVersions,toolCount:j.result?.tools?.length,error:j.error}));if(!r.ok||j.error)process.exitCode=1}
