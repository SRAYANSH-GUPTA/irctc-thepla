import test from 'node:test';
import assert from 'node:assert/strict';
import {JobManager} from '../app/jobs.mjs';
import {BookingQueue} from '../app/queue.mjs';
import {StationCatalog,sanitizeStations} from '../app/stations.mjs';
import {createApp} from '../app/server.mjs';
import {todayIST} from '../app/validation.mjs';

const nextTurn=()=>new Promise(r=>setImmediate(r));
const request=(name='First Person',extra={})=>({from:'NDLS',to:'MBDP',date:'2026-10-14',trainNumber:'15128',classCode:'2A',quota:'GN',maxAmount:2000,autoPayment:true,passengers:[{kind:'new',name,age:25,gender:'Male',berth:'No preference'}],...extra});
const receipt={trainNumber:'15128',amount:1400,from:{code:'NDLS'},to:{code:'MBDP'}};
function fixture({prepare=async()=>receipt,pay=async()=>{},check=async()=>({status:'complete',pnr:'1234567890'}),checkIntervalMs=0}={}){
  let pending=null;
  const manager=new JobManager({prepare,pay,check,pendingStore:{read:()=>pending,write:v=>{assert.equal(pending,null);pending=v;},clear:()=>pending=null}});
  const queue=new BookingQueue(manager,{now:()=>new Date('2026-10-13T09:00:00Z'),checkIntervalMs});return {manager,queue};
}
test('station search uses the fetched catalog, exact codes rank first, ambiguous names require a code',()=>{
  const rows=sanitizeStations([{sc:'NDLS',en:'NEW DELHI',hi:'नई दिल्ली',ec:'NEW DELHI',se:'DELHI',token:'never copy'},{sc:'MMCT',en:'MUMBAI CENTRAL'},{sc:'BCT',en:'MUMBAI CENTRAL'},null,{sc:'<bad>',en:'INVALID'}]);
  assert.equal(rows.length,3);assert.ok(!JSON.stringify(rows).includes('never copy'));
  const stations=new StationCatalog({data:{stations:rows,fetchedAt:'test'}});
  assert.equal(stations.search('NDLS').stations[0].code,'NDLS');assert.equal(stations.search('नई दिल्ली').stations[0].code,'NDLS');
  assert.equal(stations.resolve('New Delhi (NDLS)'),'NDLS');assert.throws(()=>stations.resolve('Mumbai Central'),/exact station/);
  assert.throws(()=>stations.resolve('not a station'),/exact station/);
  const real=new StationCatalog();assert.ok(real.metadata().total>8000);assert.equal(real.search('MBDP').stations[0].name,'MA BELHADEVI DP');
});
test('queue stores each journey passenger set, strips credentials, prevents duplicates, supports edit/remove',()=>{
  const {queue}=fixture();
  const first=queue.add({...request(),credentials:{password:'not-in-list'}});const second=queue.add(request('Second Person'));
  assert.ok(!JSON.stringify(queue.snapshot()).includes('not-in-list'));
  assert.throws(()=>queue.add(request('FIRST PERSON',{from:'New Delhi (NDLS)'})),/already in the list/);
  queue.edit(second,request('Changed Person',{trainNumber:'12345'}));assert.equal(queue.get(first).request.passengers[0].name,'First Person');assert.equal(queue.get(second).request.passengers[0].name,'Changed Person');
  queue.remove(first);assert.equal(queue.snapshot().remaining,1);assert.equal(queue.snapshot().totalLimit,2000);queue.close();
});
test('two journeys run sequentially with separate passengers; no second booking starts until first payment is resolved',async()=>{
  const seen=[],secrets=[];
  const {manager,queue}=fixture({prepare:async j=>{seen.push(j.intent.passengers[0].name);secrets.push(j.credentials.password);return receipt;},check:async()=>({status:'unknown'})});
  queue.add(request());queue.add(request('Second Person'));queue.start({password:'first-run-only'});await manager.job.task;await nextTurn();
  assert.deepEqual(seen,['First Person']);assert.throws(()=>manager.start(request('Separate')),/list is running/);
  assert.throws(()=>queue.start(),/in progress/);assert.throws(()=>queue.remove(queue.items[1].id),/Stop the booking list/);
  await manager.checkResult(manager.job.id);await nextTurn();assert.equal(seen.length,1);assert.ok(manager.pendingStore.read());
  manager.check=async()=>({status:'complete',pnr:'1234567890'});
  await manager.checkResult(manager.job.id);await nextTurn();await manager.job.task;await nextTurn();
  assert.deepEqual(seen,['First Person','Second Person']);assert.deepEqual(secrets,['first-run-only',undefined]);
  assert.equal(queue.items[0].summary.pnr,'1234567890');assert.equal(queue.items[1].status,'payment_pending');
  await manager.checkResult(manager.job.id);await nextTurn();assert.equal(queue.status,'finished');assert.equal(queue.currentId,null);assert.equal(manager.queueOwner,null);queue.close();
});
test('a preparation error pauses the list; continuing skips the failed row without retrying it',async()=>{
  let calls=0;const {manager,queue}=fixture({prepare:async()=>{if(++calls===1)throw Error('Train unavailable');return receipt;}});
  queue.add(request());queue.add(request('Second Person'));queue.start();await manager.job.task;await nextTurn();
  assert.equal(queue.status,'paused');assert.equal(queue.items[0].status,'error');assert.equal(queue.items[1].status,'queued');
  queue.start();await manager.job.task;assert.equal(calls,2);queue.stop();manager.reconcile('not_booked');await nextTurn();queue.close();
});
test('stopping a list during payment preserves the pending guard and never starts remaining journeys',async()=>{
  let calls=0;const {manager,queue}=fixture({prepare:async()=>{calls++;return receipt;}});
  queue.add(request());queue.add(request('Second Person'));queue.start();await manager.job.task;queue.stop();
  assert.equal(queue.status,'stopped');assert.ok(manager.pendingStore.read());assert.equal(calls,1);
  await manager.checkResult(manager.job.id);await nextTurn();assert.equal(queue.items[0].status,'complete');assert.equal(queue.items[1].status,'queued');assert.equal(calls,1);queue.close();
});
test('stopping at OTP cancels that worker before another journey can start',async()=>{
  let calls=0;const {manager,queue}=fixture({prepare:async(j,{pause})=>{calls++;await pause('OTP needed');return receipt;}});
  queue.add(request());queue.add(request('Second Person'));queue.start();await nextTurn();queue.stop();
  assert.throws(()=>queue.start(),/in progress/);await manager.job.task;await nextTurn();
  assert.equal(manager.job.status,'cancelled');assert.equal(queue.currentId,null);assert.equal(calls,1);assert.equal(queue.items[1].status,'queued');queue.close();
});
test('all queued dates are revalidated before the list starts',()=>{
  const {queue,manager}=fixture();queue.add(request());queue.now=()=>new Date('2026-10-15T09:00:00Z');
  assert.throws(()=>queue.start(),/journey date/);assert.equal(manager.job,null);assert.equal(queue.status,'idle');queue.close();
});
test('closing the queue during a result read cannot start the next journey',async()=>{
  let finish,calls=0;const {manager,queue}=fixture({prepare:async()=>{calls++;return receipt;},check:()=>new Promise(r=>finish=r)});
  queue.add(request());queue.add(request('Second Person'));queue.start();await manager.job.task;
  const checking=manager.checkResult(manager.job.id);queue.close();finish({status:'complete',pnr:'1234567890'});await checking;await nextTurn();
  assert.equal(calls,1);assert.equal(queue.items[1].status,'queued');assert.equal(manager.queueOwner,null);
});
test('a browser error stops automatic result reads while retaining the payment lock',async()=>{
  let reads=0;const {manager,queue}=fixture({checkIntervalMs:5,check:async()=>{reads++;throw Error('Browser closed');}});
  queue.add(request());queue.add(request('Second Person'));queue.start();await manager.job.task;
  for(let n=0;n<100&&!queue.autoCheckStopped;n++)await new Promise(r=>setTimeout(r,5));
  await new Promise(r=>setTimeout(r,30));assert.equal(reads,1);assert.equal(queue.items[1].status,'queued');assert.ok(manager.pendingStore.read());
  queue.close();
});
test('automatic read-only result checking advances the list only after an issued ticket',async()=>{
  let checks=0;const {manager,queue}=fixture({checkIntervalMs:5,check:async(j,options)=>{assert.equal(options.focus,false);checks++;return {status:'complete',pnr:'1234567890'};}});
  queue.add(request());queue.add(request('Second Person'));queue.start();
  for(let n=0;n<100&&queue.status!=='finished';n++)await new Promise(r=>setTimeout(r,5));
  assert.equal(queue.status,'finished');assert.equal(checks,2);assert.equal(manager.pendingStore.read(),null);queue.close();
});
test('local queue API normalizes stations and exposes only sanitized passenger requests',async()=>{
  const {manager,queue}=fixture();const server=createApp({manager,queue,port:4396,status:async()=>({connected:true})});await new Promise(r=>server.listen(4396,'127.0.0.1',r));
  try{
    const base='http://127.0.0.1:4396',state=await(await fetch(base+'/api/state')).json();
    const post=(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Rail-Token':state.token,Origin:base},body:JSON.stringify(body)});
    const lookup=await(await fetch(base+'/api/stations?q=NDLS')).json();assert.equal(lookup.stations[0].code,'NDLS');
    const payload={...request(),date:todayIST(),from:'NEW DELHI (NDLS)',credentials:{password:'never-queue-this'}};
    assert.equal((await post('/api/queue/add',payload)).status,201);assert.equal((await post('/api/queue/add',payload)).status,400);
    const current=await(await fetch(base+'/api/state')).json();assert.equal(current.queue.items[0].request.from,'NDLS');assert.ok(!JSON.stringify(current.queue).includes('never-queue-this'));
    assert.equal((await post('/api/queue/add',{...payload,from:'UNKNOWN STATION'})).status,400);
  }finally{await new Promise(r=>server.close(r));}
});
