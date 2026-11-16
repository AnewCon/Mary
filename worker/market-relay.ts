type Job = {
  id: string; provider: string; target: string;
  finish: (response: Response) => void; assigned: boolean;
};

export class MarketRelay {
  private jobs = new Map<string,Job>();
  private waiting: ((job: Job|null)=>void) | undefined;

  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === '/request') {
      const {provider,target}=await request.json() as {provider:string;target:string};
      const id=crypto.randomUUID();
      return new Promise<Response>(resolve=>{
        const timer=setTimeout(()=>{this.jobs.delete(id);resolve(new Response(null,{status:504}));},12000);
        const job={id,provider,target,assigned:false,finish:(response:Response)=>{
          clearTimeout(timer);this.jobs.delete(id);resolve(response);
        }};
        this.jobs.set(id,job);
        if (this.waiting) {job.assigned=true;this.waiting(job);}
      });
    }
    if (path === '/poll') {
      const ready=[...this.jobs.values()].find(job=>!job.assigned);
      if (ready) {ready.assigned=true;return Response.json({id:ready.id,provider:ready.provider,target:ready.target});}
      return new Promise<Response>(resolve=>{
        this.waiting?.(null);
        const finish=(job:Job|null)=>{
          clearTimeout(timer);if(this.waiting===finish)this.waiting=undefined;
          resolve(job?Response.json({id:job.id,provider:job.provider,target:job.target}):new Response(null,{status:204}));
        };
        const timer=setTimeout(()=>finish(null),18000);
        this.waiting=finish;
      });
    }
    if (path === '/result') {
      const id=request.headers.get('X-QuantOS-Market-Id') || '';
      const status=Number(request.headers.get('X-QuantOS-Market-Status'));
      const job=this.jobs.get(id);
      if(!job?.assigned)return new Response(null,{status:404});
      if(!Number.isInteger(status)||(status!==200&&(status<400||status>599)))return new Response(null,{status:400});
      const body=await request.arrayBuffer();
      if(body.byteLength>2_500_000)return new Response(null,{status:413});
      job.finish(new Response(body,{status,headers:{'Content-Type':'application/json'}}));
      return new Response(null,{status:204});
    }
    return new Response(null,{status:404});
  }
}
