import { Failure } from './exchange';
import { canonical, configErrors, contentHash, environment, safetyLimits, strategyConfigSchema } from './strategy-schema';

type StrategyRow={strategy_id:string;version:string;name:string;document:string;config:string;content_hash:string;state:string;
 revision:number;created_at:number;updated_at:number;published_at:number|null;activated_at:number|null;change_note:string;source:string;parent_version:string|null;generation:number|null};
export type StrategyBinding={strategyId:string;version:string;contentHash:string;generation:number;config:any};
const columns="v.*,a.generation";
const joined=" FROM strategy_versions v LEFT JOIN strategy_active a ON a.strategy_id=v.strategy_id AND a.version=v.version";
const state="CASE WHEN a.generation IS NOT NULL THEN 'ACTIVE' WHEN v.activated_at IS NOT NULL THEN 'ARCHIVED' ELSE v.state END";
const identifier=(x:unknown)=>typeof x==='string'&&/^[a-z][a-z0-9-]{2,47}$/.test(x);
const versionNumber=(x:unknown)=>typeof x==='string'&&x.length<=40&&/^[0-9]+[.][0-9]+[.][0-9]+(-[a-zA-Z0-9.-]+)?$/.test(x);
const plain=(x:unknown,max:number)=>typeof x==='string'&&x.trim().length>0&&x.length<=max;
function key(id:unknown,version:unknown){
 if(!identifier(id)||!versionNumber(version))throw new Failure('STRATEGY_INVALID_KEY');
}
async function row(db:D1Database,id:string,version:string){
 key(id,version);
 const found=await db.prepare('SELECT '+columns+joined+' WHERE v.strategy_id=? AND v.version=?').bind(id,version).first<StrategyRow>();
 if(!found)throw new Failure('STRATEGY_NOT_FOUND',404);
 return found;
}
function summary(r:StrategyRow){
 return {strategyId:r.strategy_id,version:r.version,name:r.name,state:r.generation?'ACTIVE':r.activated_at!==null?'ARCHIVED':r.state,
  revision:r.revision,contentHash:r.content_hash,createdAt:r.created_at,updatedAt:r.updated_at,publishedAt:r.published_at,
  activatedAt:r.activated_at,generation:r.generation,changeNote:r.change_note,source:r.source,parentVersion:r.parent_version};
}
async function full(r:StrategyRow){
 const config=JSON.parse(r.config);
 if(await contentHash(r.name,r.document,config)!==r.content_hash)throw new Failure('STRATEGY_INTEGRITY_ERROR',503);
 return {...summary(r),environment,executionAuthorized:false,
  capabilities:{pathMatch:config.pathMatch?.enabled===true?'SHADOW_ONLY':'DISABLED',strategyExecution:'PENDING_INDEPENDENT_ACCEPTANCE',dataSources:'CHECK_AT_ANALYSIS_TIME'},
  document:r.document,config,safetyLimits};
}
export async function activeStrategy(db:D1Database){
 const r=await db.prepare('SELECT '+columns+joined+' WHERE a.environment=?').bind(environment).first<StrategyRow>();
 if(!r)throw new Failure('STRATEGY_NO_ACTIVE',404);
 return full(r);
}
export async function activeBinding(db:D1Database,input:any):Promise<StrategyBinding>{
 const active=await activeStrategy(db);
 if(!input||input.strategyId!==active.strategyId||input.version!==active.version||input.contentHash!==active.contentHash||input.generation!==active.generation)
  throw new Failure('STRATEGY_CHANGED_OR_UNBOUND',409);
 return {strategyId:active.strategyId,version:active.version,contentHash:active.contentHash,generation:active.generation!,config:active.config};
}

function filters(q:URLSearchParams){
 const where:string[]=[],args:(number|string)[]=[];
 const id=q.get('strategyId'),name=q.get('name'),version=q.get('version'),status=q.get('state');
 if(id){if(!identifier(id))throw new Failure('STRATEGY_INVALID_FILTER');where.push('v.strategy_id=?');args.push(id);}
 if(version){if(!versionNumber(version))throw new Failure('STRATEGY_INVALID_FILTER');where.push('v.version=?');args.push(version);}
 if(name){if(!plain(name,80))throw new Failure('STRATEGY_INVALID_FILTER');where.push('instr(lower(v.name),lower(?))>0');args.push(name);}
 if(status){if(!['DRAFT','VALIDATED','PUBLISHED','ACTIVE','ARCHIVED'].includes(status))throw new Failure('STRATEGY_INVALID_FILTER');where.push('('+state+')=?');args.push(status);}
 for(const [field,operator] of [['from','>='],['to','<=']]){
  const val=q.get(field);if(val!==null){if(!/^\d{1,13}$/.test(val))throw new Failure('STRATEGY_INVALID_FILTER');where.push('v.created_at'+operator+'?');args.push(Number(val));}
 }
 return {where,args};
}
function pageLimit(q:URLSearchParams){
 const size=Number(q.get('limit')??20);
 if(!Number.isInteger(size)||size<1||size>50)throw new Failure('STRATEGY_INVALID_FILTER');
 return size;
}
function differences(a:any,b:any,path='',changes:any[]=[]){
 if(canonical(a)===canonical(b))return changes;
 if(a&&b&&typeof a==='object'&&typeof b==='object'&&!Array.isArray(a)&&!Array.isArray(b)){
  for(const k of new Set([...Object.keys(a),...Object.keys(b)]))differences(a[k],b[k],path?path+'.'+k:k,changes);
 }else changes.push({path,before:a??null,after:b??null});
 return changes;
}
async function performance(db:D1Database,id:string,version:string,q:URLSearchParams){
 await row(db,id,version);
 const to=Number(q.get('to')??Date.now()),from=Number(q.get('from')??to-30*86400000);
 if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||from>to||to-from>366*86400000)throw new Failure('STRATEGY_INVALID_WINDOW');
 const records=await db.prepare(`SELECT p.id,p.symbol,p.state,p.created_at,p.deleted_at,
   json_extract(p.result,'$.fit.similarity') similarity,
   json_extract(p.result,'$.fit.pathSimilarity') path_similarity,
   json_extract(p.result,'$.decision') decision
   FROM strategy_prediction_links l JOIN pathmatch_predictions p ON p.id=l.prediction_id
   WHERE l.strategy_id=? AND l.version=? AND p.created_at BETWEEN ? AND ?
   ORDER BY p.created_at DESC LIMIT 501`).bind(id,version,from,to).all<any>();
 const samples=records.results.slice(0,500);
 const scored=samples.filter(r=>r.state==='COMPLETED'&&typeof r.similarity==='number');
 const reviewed=scored.filter(r=>r.decision==='REVIEW').length;
 const bins={'0-<75':0,'75-<85':0,'85-100':0};
 for(const r of scored)bins[r.similarity<75?'0-<75':r.similarity<85?'75-<85':'85-100']++;
 return {from,to,cohort:'CURRENTLY_LINKED_RECORDS',truncated:records.results.length>500,
  shadow:{status:scored.length<5?'INSUFFICIENT_DATA':'AVAILABLE',count:samples.length,finalized:scored.length,reviewed,
   reviewRate:scored.length>=5?reviewed/scored.length:null,waitRate:scored.length>=5?(scored.length-reviewed)/scored.length:null,
   similarityDistribution:scored.length?bins:null,meanPathSimilarity:scored.length?scored.reduce((n,r)=>n+Number(r.path_similarity??r.similarity),0)/scored.length:null,
   recent:samples.slice(0,30).map(({deleted_at,...r})=>({...r,removedFromPredictionList:deleted_at!==null}))},
  demo:{status:'INSUFFICIENT_DATA',trades:[],reason:'ATTRIBUTED_SETTLEMENT_UNAVAILABLE'},
  backtest:{status:'INSUFFICIENT_DATA',reason:'NO_VERIFIED_BACKTEST_RUNS'},live:{status:'OUT_OF_SCOPE'}};
}
export async function readStrategy(db:D1Database,op:string,q:URLSearchParams,softwareVersion:string|null){
 const id=q.get('strategyId')??'',version=q.get('version')??'';
 if(q.has('environment')&&q.get('environment')!==environment)throw new Failure('STRATEGY_ENVIRONMENT_FORBIDDEN',403);
 if(op==='schema')return strategyConfigSchema;
 if(op==='active')return {...await activeStrategy(db),softwareVersion};
 if(op==='get')return {...await full(await row(db,id,version)),softwareVersion};
 if(op==='performance')return performance(db,id,version,q);
 if(op==='list'){
  const {where,args}=filters(q);
  const results=await db.prepare('SELECT '+columns+joined+(where.length?' WHERE '+where.join(' AND '):'')+' ORDER BY v.created_at DESC,v.strategy_id,v.version LIMIT ?')
   .bind(...args,pageLimit(q)).all<StrategyRow>();
  const active=await db.prepare('SELECT generation FROM strategy_active WHERE environment=?').bind(environment).first<number>('generation');
  return {items:results.results.map(summary),generation:active??0,environment};
 }
 if(op==='compare'){
  const [a,b]=await Promise.all([row(db,id,q.get('fromVersion')??''),row(db,id,q.get('toVersion')??'')]);
  await Promise.all([full(a),full(b)]);
  return {from:summary(a),to:summary(b),documentChanged:a.document!==b.document,changes:differences(JSON.parse(a.config),JSON.parse(b.config))};
 }
 if(op==='history'){
  if(!identifier(id)||(version&&!versionNumber(version)))throw new Failure('STRATEGY_INVALID_KEY');
  const where=version?' AND version=?':'';
  const result=await db.prepare('SELECT id,strategy_id,version,prior_strategy_id,prior_version,operation,actor,occurred_at, CASE WHEN operation=\'EDIT\' THEN json_extract(detail,\'$.note\') ELSE detail END detail FROM strategy_audit WHERE strategy_id=?'+where+' ORDER BY id DESC LIMIT ?')
   .bind(...(version?[id,version]:[id]),pageLimit(q)).all();
  return {items:result.results};
 }
 throw new Failure('STRATEGY_UNKNOWN_OPERATION',404);
}

function requireRevision(revision:unknown){
 if(!Number.isSafeInteger(revision)||Number(revision)<1)throw new Failure('STRATEGY_REVISION_REQUIRED',409);
}
export async function manageStrategy(db:D1Database,op:string,body:any){
 if(!body||Array.isArray(body)||typeof body!=='object')throw new Failure('STRATEGY_INVALID_DRAFT');
 const {strategyId:id,version}=body;
 if(op==='preview'){
  const errors=configErrors(body.config);
  return {errors,compatible:errors.length===0,missingOrAmbiguous:errors.length?'UNKNOWN':'NONE_REPORTED',saved:false};
 }
 key(id,version);
 const now=Date.now();
 if(op==='create'||op==='edit'){
  const {name,document,config,changeNote,source='MANUAL',parentVersion}=body as any;
  if(!plain(name,80)||!plain(document,9000)||!plain(changeNote,500)||!['MANUAL','JSON_IMPORT','MARKDOWN_IMPORT','FORK'].includes(source)||
     !config||Array.isArray(config)||typeof config!=='object'||config.strategyId!==id||config.version!==version)
   throw new Failure('STRATEGY_INVALID_DRAFT');
  if(parentVersion!==undefined){if(parentVersion===version)throw new Failure('STRATEGY_INVALID_PARENT');await row(db,id,parentVersion);}
  const hash=await contentHash(name,document,config);
  const saved=op==='create'?await db.prepare(`INSERT INTO strategy_versions(strategy_id,version,name,document,config,content_hash,state,
      change_note,source,parent_version,created_at,updated_at) VALUES(?,?,?,?,?,?,'DRAFT',?,?,?,?,?)
      ON CONFLICT(strategy_id,version) DO NOTHING`).bind(id,version,name,document,canonical(config),hash,changeNote,source,parentVersion??null,now,now).run():
   await (async()=>{
    requireRevision(body.revision);
    return db.prepare(`UPDATE strategy_versions SET name=?,document=?,config=?,content_hash=?,change_note=?,updated_at=?,revision=revision+1
       WHERE strategy_id=? AND version=? AND state='DRAFT' AND revision=?`)
      .bind(name,document,canonical(config),hash,changeNote,now,id,version,body.revision).run();
   })();
  if(!saved.meta.changes)throw new Failure(op==='create'?'STRATEGY_VERSION_CONFLICT':'STRATEGY_REVISION_OR_STATE_CONFLICT',409);
  return full(await row(db,id,version));
 }
 if(op==='validate'||op==='publish'){
  requireRevision(body.revision);
  const current=await row(db,id,version),expected=op==='validate'?'DRAFT':'VALIDATED';
  if(current.state!==expected||current.revision!==body.revision)throw new Failure('STRATEGY_REVISION_OR_STATE_CONFLICT',409);
  const draft=await full(current);
  const errors=configErrors(draft.config);
  if(errors.length)return {validated:false,errors};
  if(op==='publish'&&body.confirm!==true)throw new Failure('STRATEGY_CONFIRMATION_REQUIRED',409);
  const update=await db.prepare(`UPDATE strategy_versions SET state=?,published_at=?,updated_at=?,revision=revision+1
       WHERE strategy_id=? AND version=? AND state=? AND revision=? AND content_hash=?`)
   .bind(op==='validate'?'VALIDATED':'PUBLISHED',op==='publish'?now:null,now,id,version,expected,body.revision,current.content_hash).run();
  if(!update.meta.changes)throw new Failure('STRATEGY_REVISION_OR_STATE_CONFLICT',409);
  return {...await full(await row(db,id,version)),validated:true};
 }
 if(op==='activate'||op==='rollback'){
  if(body.confirm!==true||!Number.isSafeInteger(body.generation)||body.generation<0)throw new Failure('STRATEGY_CONFIRMATION_REQUIRED',409);
  const target=await row(db,id,version);
  await full(target);
  if(target.state!=='PUBLISHED'||(op==='rollback'&&target.activated_at===null))throw new Failure('STRATEGY_TARGET_NOT_ELIGIBLE',409);
  if(target.generation!==null)throw new Failure('STRATEGY_ALREADY_ACTIVE',409);
  const action=op==='activate'?'ACTIVATE':'ROLLBACK';
  const query=body.generation===0?
   db.prepare('INSERT INTO strategy_active(environment,strategy_id,version,generation,activated_at,operation) VALUES(?,?,?,1,?,?) ON CONFLICT(environment) DO NOTHING')
    .bind(environment,id,version,now,action):
   db.prepare('UPDATE strategy_active SET strategy_id=?,version=?,generation=generation+1,activated_at=?,operation=? WHERE environment=? AND generation=?')
    .bind(id,version,now,action,environment,body.generation);
  if(!(await query.run()).meta.changes)throw new Failure('STRATEGY_ACTIVE_CHANGED',409);
  return full(await row(db,id,version));
 }
 throw new Failure('STRATEGY_UNKNOWN_OPERATION',404);
}
