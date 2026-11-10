export const onRequest:PagesFunction<{MCP:Fetcher}>=({request,env})=>env.MCP.fetch(request);
