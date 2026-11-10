export const encode=(x:ArrayBuffer)=>btoa(String.fromCharCode(...new Uint8Array(x)));
export async function hash(s:string){return encode(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))}
export async function sign(secret:string,s:string){const k=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);return encode(await crypto.subtle.sign('HMAC',k,new TextEncoder().encode(s)))}
export function randomKey(){return 'qos_'+Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('')}
export function scopeAllowed(scopes:string[],scope:string){return scopes.includes(scope)&&scope!=='trade'}
