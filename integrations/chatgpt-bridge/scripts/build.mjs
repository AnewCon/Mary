import fs from 'node:fs';
fs.mkdirSync('dist/server',{recursive:true});fs.mkdirSync('dist/.openai',{recursive:true});
fs.copyFileSync('worker/index.js','dist/server/index.js');fs.copyFileSync('.openai/hosting.json','dist/.openai/hosting.json');
const manifest=JSON.parse(fs.readFileSync('dist/.openai/hosting.json','utf8'));if(!manifest.project_id||!manifest.capabilities.includes('mcp'))throw Error('Invalid MCP manifest');console.log('Private MCP bridge built');
