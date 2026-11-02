// Requires local Chromium debug port 9222. Uses a fake booking adapter; makes no IRCTC requests.
import {createApp} from '../app/server.mjs';
import {JobManager} from '../app/jobs.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const handoff=deferred(),receipt=deferred();
let pending=null,received=null,payCount=0;
const manager=new JobManager({pendingStore:{read:()=>pending,write:v=>pending=v,clear:()=>pending=null},prepare:async j=>{received=j.intent;return {trainNumber:'12345',classCode:j.intent.classCode,quota:j.intent.quota,date:j.intent.date,from:{name:'Test Origin',code:'AAA'},to:{name:'Test Destination',code:'BBB'},amount:500,availability:'AVAILABLE-10',passengerCount:j.intent.passengers.length};},pay:async()=>{if(++payCount===1)await handoff.promise;},check:()=>receipt.promise});
const server=createApp({manager,port:4397,status:async()=>({connected:true}),open:async()=>{}});await new Promise(r=>server.listen(4397,'127.0.0.1',r));
const base='http://127.0.0.1:9222';const tab=await(await fetch(base+'/json/new?'+encodeURIComponent('http://127.0.0.1:4397/'),{method:'PUT'})).json();const ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);let id=0;const pendingCalls=new Map();ws.onmessage=({data})=>{const m=JSON.parse(data),p=pendingCalls.get(m.id);if(p){pendingCalls.delete(m.id);m.error?p.reject(Error('CDP failed')):p.resolve(m.result);}};const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pendingCalls.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error('UI script failed');return r.result.value;};
async function uiUntil(expression,label){
 for(let n=0;n<100;n++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,100));}
 throw Error(`UI timed out: ${label}`);
}
try{
 for(let n=0;n<40;n++){if(await evaluate("document.querySelectorAll('#passengers .passenger').length===1"))break;await new Promise(r=>setTimeout(r,100));}
 const prepared=await evaluate(`(()=>{
  const fill=(s,v)=>{const e=document.querySelector(s);e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));};
  fill('#from','AAA');fill('#to','BBB');document.querySelector('#swap').click();const swapped=document.querySelector('#from').value==='BBB';document.querySelector('#swap').click();
  fill('#classCode','2A');fill('#maxAmount','1500');fill('.passenger-input-name','Example Person');fill('.passenger-age','25');fill('.passenger-gender','Male');
  document.querySelector('#add-passenger').click();fill('#passengers .passenger:last-child .passenger-kind','saved');fill('#passengers .passenger:last-child .passenger-input-name','Saved Example');
  const savedValid=document.querySelector('#passengers .passenger:last-child .passenger-age').disabled;
  document.querySelector('#add-passenger').click();document.querySelector('#passengers .passenger:last-child .remove-passenger').click();
  document.querySelector('#autoPayment').checked=false;
  const valid=document.querySelector('#booking-form').reportValidity();if(valid)document.querySelector('#booking-form').requestSubmit(document.querySelector('#start'));
  return {swapped,savedValid,valid,count:document.querySelectorAll('#passengers .passenger').length};
 })()`);
 for(let n=0;n<50;n++){if(manager.job?.status==='ready')break;await new Promise(r=>setTimeout(r,100));}
 await new Promise(r=>setTimeout(r,2200));
 const ui=await evaluate(`({payVisible:!document.querySelector('#pay').hidden,locked:document.querySelector('#booking-fields').disabled,message:document.querySelector('#job-message').textContent})`);
 if(!prepared.swapped||!prepared.savedValid||!prepared.valid||prepared.count!==2||manager.job?.status!=='ready'||received.passengers.length!==2||payCount!==0||!ui.payVisible||!ui.locked)throw Error('UI workflow assertion failed');
 await evaluate("document.querySelector('#pay').click()");
 await uiUntil("!document.querySelector('#check-result').hidden && document.querySelector('#check-result').disabled && document.querySelector('#reconcile-confirm').disabled",'handoff locks');
 assert.equal(payCount,1);assert.equal(manager.job.paymentHandoff,true);
 handoff.resolve();
 await uiUntil("!document.querySelector('#check-result').disabled && !document.querySelector('#reconcile-confirm').disabled",'handoff completion');
 await evaluate("document.querySelector('#reconcile-confirm').click()");
 assert.equal(await evaluate("document.querySelector('#not-booked').disabled"),false);
 await evaluate("document.querySelector('#check-result').click()");
 await uiUntil("document.querySelector('#reconcile-confirm').disabled && document.querySelector('#not-booked').disabled && document.querySelector('#was-booked').disabled",'result-check locks');
 receipt.resolve({status:'complete',pnr:'1234567890'});
 await uiUntil("!document.querySelector('#receipt').hidden && document.querySelector('#receipt-pnr').textContent==='1234567890' && !document.querySelector('#start').disabled",'verified receipt');
 assert.equal(pending,null);
 await send('Page.reload');
 await uiUntil("document.querySelector('#receipt-pnr')?.textContent==='1234567890' && !document.querySelector('#receipt').hidden",'receipt after page refresh');
 assert.equal(await evaluate("document.querySelector('#check-result').hidden"),true);
 assert.equal(await evaluate("document.querySelector('#reconcile-confirm').checked"),false);
 for(const width of [1365,390]){
  await send('Emulation.setDeviceMetricsOverride',{width,height:1100,deviceScaleFactor:1,mobile:false});
  await new Promise(r=>setTimeout(r,100));
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false,`No overflow at ${width}px`);
  if(process.env.RAIL_UI_SCREENSHOTS==='1'){
   await mkdir('artifacts',{recursive:true});const shot=await send('Page.captureScreenshot',{format:'png'});
   await writeFile(`artifacts/confirmation-test-${width}.png`,Buffer.from(shot.data,'base64'));
  }
 }
 // A new payment must never inherit the previous outcome checkbox.
 await evaluate("document.querySelector('#booking-form').requestSubmit(document.querySelector('#start'))");
 await uiUntil("!document.querySelector('#pay').hidden && document.querySelector('#receipt').hidden",'second booking');
 await evaluate("document.querySelector('#pay').click()");
 await uiUntil("!document.querySelector('#reconcile').hidden && !document.querySelector('#reconcile-confirm').disabled",'second reconciliation');
 assert.equal(payCount,2);assert.equal(await evaluate("document.querySelector('#reconcile-confirm').checked"),false);
 assert.equal(await evaluate("document.querySelector('#not-booked').disabled && document.querySelector('#was-booked').disabled"),true);
 await evaluate("document.querySelector('#reconcile-confirm').click();document.querySelector('#not-booked').click()");
 await uiUntil("document.querySelector('#reconcile').hidden && !document.querySelector('#start').disabled",'manual resolution');
 assert.equal(manager.job.status,'failed');assert.equal(pending,null);
 assert.equal(await evaluate("document.querySelector('#check-result').hidden && document.querySelector('#receipt').hidden"),true);
 // An already-open tab must reflect a booking started from another tab/script.
 manager.start({...received,from:'CCC',to:'DDD',classCode:'CC',passengers:[{kind:'new',name:'Fresh Example',age:26,gender:'Female',berth:'No preference'}]});
 await uiUntil("document.querySelector('#from').value==='CCC' && document.querySelector('#to').value==='DDD' && document.querySelector('#classCode').value==='CC' && document.querySelector('.passenger-input-name').value==='Fresh Example' && document.querySelector('#passengers').children.length===1",'external booking synchronization');
 assert.equal(payCount,2);assert.equal(await evaluate("document.querySelector('#booking-fields').disabled"),true);
 manager.cancel(manager.job.id);
 await uiUntil("!document.querySelector('#booking-fields').disabled",'external booking stopped');
 await evaluate("document.querySelector('#from').value='EEE';document.querySelector('#from').dispatchEvent(new Event('input',{bubbles:true}))");
 await new Promise(r=>setTimeout(r,2200));
 assert.equal(await evaluate("document.querySelector('#from').value"),'EEE','Polling must preserve the next journey draft');
 await evaluate(`(()=>{
  const fill=(id,value)=>{const e=document.querySelector(id);e.value=value;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));};
  fill('#from','NDLS');fill('#to','MBDP');fill('#trainNumber','15128');fill('#classCode','2A');fill('.passenger-input-name','Queue Alpha');fill('.passenger-age','25');fill('.passenger-gender','Male');document.querySelector('#autoPayment').checked=false;
 })()`);
 await uiUntil("[...document.querySelectorAll('#from-stations option')].some(o=>o.value==='NEW DELHI (NDLS)')",'station lookup');
 await evaluate("document.querySelector('#from').value='NEW DELHI (NDLS)';document.querySelector('#booking-form').requestSubmit(document.querySelector('#queue-add'))");
 await uiUntil("document.querySelectorAll('.journey-row').length===1 && document.querySelector('.passenger-input-name').value===''",'first queued journey');
 await evaluate(`(()=>{
  const fill=(id,value)=>{const e=document.querySelector(id);e.value=value;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));};
  fill('#from','MBDP');fill('#to','NDLS');fill('#trainNumber','15127');fill('#classCode','3A');fill('.passenger-kind','saved');fill('.passenger-input-name','Queue Beta');
  document.querySelector('#booking-form').requestSubmit(document.querySelector('#queue-add'));
 })()`);
 await uiUntil("document.querySelectorAll('.journey-row').length===2",'second queued journey');
 await evaluate("[...document.querySelectorAll('.journey-row:last-child button')].find(b=>b.textContent==='Edit').click()");
 assert.equal(await evaluate("document.querySelector('.passenger-input-name').value"),'Queue Beta');
 assert.equal(await evaluate("document.querySelector('.passenger-kind').value"),'saved');
 await evaluate("document.querySelector('#maxAmount').value='1800';document.querySelector('#booking-form').requestSubmit(document.querySelector('#queue-add'))");
 await uiUntil("document.querySelector('#queue-total').textContent.includes('3,300') && document.querySelector('#queue-add').textContent==='Add to booking list'",'editing one journey');
 assert.ok((await evaluate("document.querySelector('.journey-row:first-child').textContent")).includes('Queue Alpha'));
 assert.ok(!(await evaluate("document.querySelector('.journey-row:first-child').textContent")).includes('Queue Beta'));
 for(const width of [1365,390]){
  await send('Emulation.setDeviceMetricsOverride',{width,height:1100,deviceScaleFactor:1,mobile:false});
  await evaluate('scrollTo(0,0)');await new Promise(r=>setTimeout(r,100));
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false,`Queue fits ${width}px`);
  if(process.env.RAIL_UI_SCREENSHOTS==='1'){
   await mkdir('artifacts',{recursive:true});const shot=await send('Page.captureScreenshot',{format:'png'});
   await writeFile(`artifacts/booking-list-test-${width}.png`,Buffer.from(shot.data,'base64'));
  }
 }
 await evaluate("document.querySelector('#queue-start').click()");
 await uiUntil("!document.querySelector('#pay').hidden && document.querySelector('.passenger-input-name').value==='Queue Alpha' && !document.querySelector('#queue-stop').hidden",'queue first journey');
 assert.equal(payCount,2,'Preparation mode must wait for payment action');
 await evaluate("document.querySelector('#pay').click()");
 await uiUntil("!document.querySelector('#pay').hidden && document.querySelector('.passenger-input-name').value==='Queue Beta' && document.querySelector('.journey-row:first-child').dataset.status==='complete'",'automatic next journey after first receipt');
 assert.equal(payCount,3);assert.equal(manager.job.intent.passengers.length,1);assert.equal(manager.job.intent.passengers[0].kind,'saved');
 await evaluate("document.querySelector('#pay').click()");
 await uiUntil("document.querySelectorAll('.journey-row[data-status=complete]').length===2 && document.querySelector('#queue-stop').hidden",'queue complete');
 assert.equal(payCount,4);assert.equal(pending,null);
 await evaluate("[...document.querySelectorAll('.journey-row:last-child button')].find(b=>b.textContent==='Remove').click()");
 await uiUntil("document.querySelectorAll('.journey-row').length===1",'removing a finished journey');
 console.log('UI checks passed: station suggestions, per-journey passengers, queue editing/removal, two sequential bookings, automatic result checks, payment locks, page refresh, draft preservation, desktop/mobile layouts. Simulated bookings only.');
}catch(e){console.log({error:e.message,jobStatus:manager.job?.status});process.exitCode=1;}
finally{handoff.resolve();receipt.resolve({status:'unknown'});ws.close();await fetch(base+'/json/close/'+tab.id);await new Promise(r=>server.close(r));}
