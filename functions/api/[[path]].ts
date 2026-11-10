export const onRequest: PagesFunction<{API:Fetcher}> = ({request,env}) => env.API.fetch(request);
