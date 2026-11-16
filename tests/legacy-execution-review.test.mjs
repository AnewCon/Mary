import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const {outputFiles:[file]}=await build({entryPoints:['worker/legacy-execution-review.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {reviewClosedDaily,reviewLegacyPlan,legacyLimits}=await import('data:text/javascript;base64,'+Buffer.from(file.text).toString('base64'));
const day=86400000,now=Date.UTC(2026,10,18,1);
const end=Math.floor(now/day)*day;
const normal=()=>Array.from({length:14},(_,i)=>({time:end-(14-i)*day,open:10,high:15,low:9,close:11}));
const plan={symbol:'BTCUSDT',side:'LONG',kind:'LIMIT',leverage:10,entry:'100',stopLoss:'97',takeProfit:'108',
  quantity:'0.1',lossCosts:'0.01',winCosts:'0.02',accountMode:'demo',accountVerified:true,instrumentVerified:true,
  liquidityVerified:true,protectionVerified:true,availableMargin:'20',exposures:[],directionScore:80,entryScore:80,
  scoreVersion:legacyLimits.strategyVersion,trend4h:'LONG',trend1h:'LONG',structure15m:'CONFIRMED',entry5m:'CONFIRMED'};
const review=(overrides={},bars=normal())=>reviewLegacyPlan({...plan,...overrides},bars,{now});

test('qualifying plan remains research only at exactly 80 on both axes',()=>{
  const x=review();
  assert.equal(x.result,'CANDIDATE_FOR_MANUAL_REVIEW');assert.equal(x.execute,false);
  assert.equal(x.risk.lossUsdt,'0.31');assert.equal(x.risk.marginUsdt,'1');
  assert.ok(review({entryScore:79}).reasons.includes('INDEPENDENT_LEGACY_SCORES_REQUIRED'));
  assert.ok(review({scoreVersion:'2.5-experimental',directionScore:100,entryScore:100}).reasons.includes('INDEPENDENT_LEGACY_SCORES_REQUIRED'));
});

test('daily gain and range thresholds are inclusive, seven closed bars are required',()=>{
  const bars=normal();Object.assign(bars[13],{open:10,high:41,low:9,close:40});
  assert.equal(reviewClosedDaily(bars,'SHORT',now).reason,'PUMP_COOLDOWN_ACTIVE');
  assert.equal(review({},bars).result,'WAIT');
  const atSeven=normal();Object.assign(atSeven[6],{open:10,high:41,low:9,close:40});
  assert.equal(reviewClosedDaily(atSeven,'LONG',now).reason,'DAILY_PUMP_LONG_BLOCKED');
  assert.equal(reviewClosedDaily(atSeven,'SHORT',now).status,'PASS');
  const range=normal();Object.assign(range[7],{open:10,high:45,low:9,close:11});
  assert.equal(reviewClosedDaily(range,'SHORT',now).reason,'PUMP_COOLDOWN_ACTIVE');
  const unfinished=normal();unfinished[13].time=end;
  assert.equal(reviewClosedDaily(unfinished,'LONG',now).status,'INSUFFICIENT_DATA');
});

test('high scores never waive entry, protection, costs, or exposure checks',()=>{
  for(const [overrides,reason] of [
    [{entry5m:'UNKNOWN'},'ENTRY_15M_5M_NOT_CONFIRMED'],
    [{trend1h:'SHORT'},'TREND_4H_1H_CONFLICT_OR_MISSING'],
    [{protectionVerified:false},'PROTECTION_PLAN_NOT_VERIFIED'],
    [{quantity:'0.13'},'SINGLE_LOSS_BUDGET_EXCEEDED'],
    [{takeProfit:'104'},'NET_REWARD_RISK_BELOW_1_8'],
    [{exposures:[{symbol:'ETHUSDT',side:'LONG',plannedMargin:'31.1',plannedLoss:'1.70',correlationToCandidate:0.85}]},'PORTFOLIO_LOSS_BUDGET_EXCEEDED'],
    [{exposures:[{symbol:'ETHUSDT',side:'LONG',plannedMargin:'1',plannedLoss:'0.1',correlationToCandidate:0.85}]},'SAME_DIRECTION_CORRELATION_LIMIT'],
  ]){
    const outcome=review({...overrides,directionScore:99,entryScore:99});
    assert.equal(outcome.result,'WAIT');assert.ok(outcome.reasons.includes(reason),reason);
  }
});
