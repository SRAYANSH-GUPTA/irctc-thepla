import test from 'node:test';
import assert from 'node:assert/strict';
import {validateIntent,availabilityAllowed,verifyNames,verifyTotal,todayIST,parseBookingConfirmation} from '../app/validation.mjs';
import {JobManager} from '../app/jobs.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPendingStore,createApp} from '../app/server.mjs';
import http from 'node:http';
import {IRCTCDriver} from '../app/irctc.mjs';

const valid=()=>({from:'NDLS',to:'MBDP',date:'2026-10-14',classCode:'2A',quota:'GN',maxAmount:2000,passengers:[{kind:'new',name:'Example Person',age:25,gender:'Male',berth:'No preference'}]});
const now=new Date('2026-10-13T09:00:00Z');
test('booking input rejects dates, ambiguous passenger identities, unsupported classes and insufficient limits',()=>{
  assert.equal(validateIntent(valid(),now).autoPayment,false);
  for(const patch of [{date:'2026-02-30'},{date:'2026-10-12'},{from:'MBDP'},{classCode:'BUS'},{maxAmount:''},{maxAmount:-10},{trainNumber:'12'}, {passengers:[]},{passengers:[...valid().passengers,...valid().passengers]}])assert.throws(()=>validateIntent({...valid(),...patch},now));
  assert.throws(()=>validateIntent({...valid(),passengers:[{kind:'new',name:'Baby Example',age:2,gender:'Male'}]},now));
  assert.equal(todayIST(new Date('2026-10-13T20:00:00Z')),'2026-10-14');
});
test('availability never treats unavailable as available and requires explicit RAC or waitlist acceptance',()=>{
  for(const s of ['NOT AVAILABLE','NOT AVBL','REGRET','AVAILABLE-0','Booking not open','PQWL4/WL2','RAC 4'])assert.equal(availabilityAllowed(s,false),false,s);
  for(const s of ['AVAILABLE-0012','AVAILABLE 12','AVBL 3'])assert.equal(availabilityAllowed(s,false),true,s);
  assert.equal(availabilityAllowed('PQWL4/WL2',true),true);assert.equal(availabilityAllowed('RAC 4',true),true);
  assert.equal(availabilityAllowed('REGRET/WL10',true),false);assert.equal(availabilityAllowed('Unknown',true),false);
});
test('exact passenger set and final total are required',()=>{
  assert.doesNotThrow(()=>verifyNames(['1. Example Person'],valid().passengers));
  assert.throws(()=>verifyNames(['1. Example Person','2. Other Person'],valid().passengers));
  assert.throws(()=>verifyNames(['Example'],valid().passengers));
  assert.throws(()=>verifyTotal(2000.01,2000));assert.throws(()=>verifyTotal(NaN,2000));assert.doesNotThrow(()=>verifyTotal(1478.60,2000));
});
test('gateway success, an old ticket, or a different passenger cannot count as this issued ticket',()=>{
  const result={recognized:true,origin:'https://www.irctc.co.in',path:'/eticket/payment/confirmation',text:'Ticket booked successfully\nPNR: 1234567890\n15128\nNDLS to MBDP\n14 Oct 2026\nExample Person'};
  const trip={trainNumber:'15128',from:{code:'NDLS'},to:{code:'MBDP'}};
  assert.equal(parseBookingConfirmation(result,valid(),trip),'1234567890');
  for(const patch of [{origin:'https://secure.paytmpayments.com'},{path:'/eticket/history/booked'},{text:result.text.replace('14 Oct 2026','13 Oct 2026')},{text:result.text.replace('Example Person','Example Person Junior')},{text:'Payment successful\nPNR: 1234567890'}])assert.equal(parseBookingConfirmation({...result,...patch},valid(),trip),null);
});
function store(){let value=null;return {read:()=>value,write:v=>{if(value)throw Error('Exists');value=v;},clear:()=>{value=null;}};}
const summary={trainNumber:'15128',amount:1478.6};
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject};}
test('only one active run; a second payment click never reaches the provider',async()=>{
  let calls=0,finishPay;const pending=store();
  const m=new JobManager({pendingStore:pending,prepare:async()=>summary,pay:()=>{calls++;return new Promise(r=>finishPay=r)},check:async()=>({status:'unknown'})});
  const id=m.start(valid(),{password:'test-secret'});assert.throws(()=>m.start(valid()),/active|stopping/);await m.job.task;
  assert.equal(m.job.status,'ready');assert.ok(!JSON.stringify(m.snapshot()).includes('test-secret'));
  const first=m.openPayment(id);assert.ok(pending.read());assert.throws(()=>m.openPayment(id),/only once/);assert.throws(()=>m.cancel(id),/Payment has started/);
  assert.equal(calls,1);finishPay();await first;assert.equal(m.job.status,'payment_pending');
});
test('unknown payment outcomes and process restarts remain locked until reconciliation',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rail-test-'));
  try{const pending=createPendingStore(dir);const m=new JobManager({pendingStore:pending,prepare:async()=>summary,pay:async()=>{throw Error('Transport lost')},check:async()=>({status:'unknown'})});
    const id=m.start(valid());await m.job.task;await m.openPayment(id);assert.equal(m.job.status,'needs_check');
    const restart=new JobManager({pendingStore:createPendingStore(dir),prepare:async()=>summary});assert.throws(()=>restart.start(valid()),/previous payment/);
    await m.checkResult(id);assert.ok(pending.read());assert.throws(()=>m.reconcile('pending'));
    m.reconcile('not_booked');assert.equal(pending.read(),null);assert.equal(m.job.status,'failed');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('OTP pause resumes once; cancelling the pause prevents subsequent work',async()=>{
  let continued=0;const m=new JobManager({pendingStore:store(),prepare:async(j,{pause})=>{await pause('Complete OTP');continued++;return summary;}});
  const id=m.start(valid());await new Promise(r=>setImmediate(r));assert.equal(m.job.status,'waiting');m.cancel(id);await m.job.task;assert.equal(continued,0);assert.equal(m.job.status,'cancelled');
  const id2=m.start(valid());await new Promise(r=>setImmediate(r));m.resume(id2);assert.throws(()=>m.resume(id2));await m.job.task;assert.equal(continued,1);
});
test('automatic payment uses the same guard, while default preparation cannot initiate payment',async()=>{
  let calls=0;const m=new JobManager({pendingStore:store(),prepare:async()=>summary,pay:async()=>{calls++;},check:async()=>({status:'complete',pnr:'1234567890'})});
  let id=m.start(valid());await m.job.task;assert.equal(calls,0);m.cancel(id);
  id=m.start({...valid(),autoPayment:true});await m.job.task;assert.equal(calls,1);await m.checkResult(id);assert.equal(m.job.status,'complete');assert.equal(m.pendingStore.read(),null);
});
test('payment handoff and receipt checks cannot race reconciliation or overwrite a final result',async()=>{
  const payment=deferred(),receipt=deferred();let checks=0;
  const m=new JobManager({pendingStore:store(),prepare:async()=>summary,pay:()=>payment.promise,check:()=>{checks++;return receipt.promise;}});
  const id=m.start(valid());await m.job.task;
  const handoff=m.openPayment(id);
  assert.equal(m.snapshot().job.paymentHandoff,true);
  await assert.rejects(m.checkResult(id),/still opening/);
  assert.throws(()=>m.reconcile('not_booked'),/handoff/);assert.equal(checks,0);
  payment.resolve();await handoff;
  const checking=m.checkResult(id);assert.equal(m.snapshot().job.resultChecking,true);
  await assert.rejects(m.checkResult(id),/already running/);
  assert.throws(()=>m.reconcile('not_booked'),/check is still running/);
  assert.throws(()=>m.start(valid()),/previous payment/);
  receipt.resolve({status:'complete',pnr:'1234567890'});await checking;
  assert.equal(m.job.status,'complete');assert.equal(m.job.summary.pnr,'1234567890');assert.equal(m.snapshot().job.resultChecking,false);
  await assert.rejects(m.checkResult(id),/already been resolved/);assert.equal(checks,1);
  const next=m.start(valid());await m.job.task;await m.openPayment(next);
  await assert.rejects(m.checkResult(id),/no longer active/);assert.equal(m.pendingStore.read().id,next);
});
test('failed result checks release the read lock but keep the uncertain payment journal',async()=>{
  const m=new JobManager({pendingStore:store(),prepare:async()=>summary,pay:async()=>{},check:async()=>{throw Error('Browser closed');}});
  const id=m.start(valid());await m.job.task;await m.openPayment(id);
  await assert.rejects(m.checkResult(id),/Browser closed/);
  assert.equal(m.snapshot().job.resultChecking,false);assert.equal(m.pendingStore.read().id,id);
  m.reconcile('not_booked');await assert.rejects(m.checkResult(id),/already been resolved/);
});
test('a cancelled worker cannot start a new run or resurrect its old status while stopping',async()=>{
  const browser=deferred();let calls=0;
  const m=new JobManager({pendingStore:store(),prepare:async(j,{update})=>{calls++;await browser.promise;update('search','Late update');return summary;}});
  const id=m.start(valid());await new Promise(r=>setImmediate(r));m.cancel(id);
  assert.equal(m.snapshot().job.working,true);assert.throws(()=>m.start(valid()),/still stopping/);
  browser.resolve();await m.job.task;
  assert.equal(m.job.status,'cancelled');assert.equal(m.job.summary,null);assert.equal(m.snapshot().job.working,false);
  const next=m.start(valid());m.cancel(next);await m.job.task;assert.equal(calls,1);
});
test('stopping during a page read prevents the next browser click',async()=>{
  const page=deferred(),controller=new AbortController();let commands=0;
  const driver=new IRCTCDriver({evaluate:()=>{commands++;return page.promise;}},controller.signal,async()=>{});
  const click=driver.click('button');controller.abort();page.resolve({path:'/eticket/train-search',challenge:false});
  await assert.rejects(click,{name:'AbortError'});assert.equal(commands,1);
});
test('local API rejects cross-origin mutations and host rebinding',async()=>{
  const manager=new JobManager({pendingStore:store(),prepare:async()=>summary});
  const server=createApp({manager,port:4399,status:async()=>({connected:false}),open:async()=>{}});
  await new Promise(r=>server.listen(4399,'127.0.0.1',r));
  try{
    const base='http://127.0.0.1:4399';const state=await(await fetch(base+'/api/state')).json();
    const post=headers=>fetch(base+'/api/browser/open',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:'{}'});
    assert.equal((await post({})).status,403);
    assert.equal((await post({'X-Rail-Token':state.token,Origin:'https://example.com'})).status,403);
    assert.equal((await post({'X-Rail-Token':state.token,Origin:base})).status,200);
    const rebound=await new Promise((resolve,reject)=>http.get(base+'/api/state',{headers:{Host:'evil.example:4399'}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject));
    assert.equal(rebound,403);
    assert.equal((await fetch(base+'/api/state',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
    const root=await fetch(base);assert.match(root.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  }finally{await new Promise(r=>server.close(r));}
});
