const $=id=>document.getElementById(id);
let token='',job=null,pending=null,renderedJobId=null,polling=false,pendingKey='',online=false,queue=null,editingId=null,queueRenderKey='';
const busyActions=new Set();
const money=n=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:2}).format(Number(n)||0);
const prettyDate=v=>v?new Intl.DateTimeFormat('en-IN',{day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Kolkata'}).format(new Date(v+'T12:00:00+05:30')):'Choose a date';
const finalStates=['cancelled','error','complete','failed'];
function notify(message=''){ $('notice').textContent=message;$('notice').hidden=!message; }
async function api(path,body){
  const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Rail-Token':token},body:JSON.stringify(body)});
  const result=await r.json();if(!r.ok)throw Error(result.error||'The action could not be completed.');return result;
}
function readPassengers(){return [...$('passengers').children].map(row=>({kind:row.querySelector('.passenger-kind').value,name:row.querySelector('.passenger-input-name').value.trim(),age:row.querySelector('.passenger-age').value,gender:row.querySelector('.passenger-gender').value,berth:row.querySelector('.passenger-berth').value}));}
function request(){const {username,password,...data}=Object.fromEntries(new FormData($('booking-form')));return {...data,passengers:readPassengers(),allowWaitlist:$('allowWaitlist').checked,insurance:$('insurance').checked,autoPayment:$('autoPayment').checked,credentials:{username:$('username').value.trim(),password:$('password').value}};}
function addPassenger(p={}){
  if($('passengers').children.length>=($('quota').value==='TQ'?4:6)){notify('The passenger limit for this quota has been reached.');return;}
  const row=$('passenger-template').content.firstElementChild.cloneNode(true);
  const kind=row.querySelector('.passenger-kind');kind.value=p.kind||'new';
  row.querySelector('.passenger-input-name').value=p.name||'';row.querySelector('.passenger-age').value=p.age||'';row.querySelector('.passenger-gender').value=p.gender||'';row.querySelector('.passenger-berth').value=p.berth||'No preference';
  const toggle=()=>{const saved=kind.value==='saved';row.querySelector('.passenger-extra').hidden=saved;row.querySelector('.saved-note').hidden=!saved;row.querySelectorAll('.passenger-extra input,.passenger-extra select').forEach(e=>e.disabled=saved);};
  kind.addEventListener('change',()=>{toggle();updateSummary();});toggle();
  row.querySelector('.remove-passenger').addEventListener('click',()=>{row.remove();renumber();updateSummary();});
  $('passengers').append(row);renumber();updateSummary();
}
function renumber(){[...$('passengers').children].forEach((row,i)=>{row.querySelector('.passenger-label').textContent=`Passenger ${i+1}`;row.querySelector('.remove-passenger').hidden=$('passengers').children.length===1;});}
function updateSummary(){
  if(job?.summary&&!finalStates.includes(job.status))return renderSummary(job.summary,job.request);
  $('summary-from').textContent=$('from').value.trim()||'Departure station';$('summary-to').textContent=$('to').value.trim()||'Destination station';
  $('summary-date').textContent=prettyDate($('date').value);$('summary-class').textContent=$('classCode').selectedOptions[0].textContent;
  $('summary-quota').textContent=$('quota').selectedOptions[0].textContent;$('quota-note').hidden=$('quota').value!=='TQ';
  const n=$('passengers').children.length;$('summary-passengers').textContent=`${n} passenger${n===1?'':'s'}`;
  $('summary-train').textContent=$('trainNumber').value||'First eligible';$('fare-caption').textContent='Your total fare limit';$('summary-fare').textContent=money($('maxAmount').value);$('availability').hidden=true;
}
function renderSummary(s,r){$('summary-from').textContent=`${s.from.name} (${s.from.code})`;$('summary-to').textContent=`${s.to.name} (${s.to.code})`;$('summary-date').textContent=prettyDate(s.date);$('summary-class').textContent=s.classCode;$('summary-quota').textContent=s.quota==='TQ'?'Tatkal':'General';$('summary-passengers').textContent=`${s.passengerCount} passenger${s.passengerCount===1?'':'s'}`;$('summary-train').textContent=s.trainNumber;$('fare-caption').textContent='Verified total';$('summary-fare').textContent=money(s.amount);$('availability').textContent=s.pnr?`PNR ${s.pnr} · Check berth status on IRCTC`:`Availability: ${s.availability}`;$('availability').hidden=false;}
function restore(r){for(const id of ['from','to','date','classCode','quota','trainNumber','maxAmount','mobile'])$(id).value=r[id]??'';for(const id of ['allowWaitlist','insurance','autoPayment'])$(id).checked=!!r[id];$('passengers').replaceChildren();r.passengers.forEach(addPassenger);}
function clearJourney(){
  editingId=null;for(const id of ['from','to','trainNumber'])$(id).value='';
  $('allowWaitlist').checked=false;$('insurance').checked=false;$('passengers').replaceChildren();addPassenger();updateSummary();refreshActions();
}
function renderQueue(){
  if(!queue)return;
  $('queue-count').textContent=`${queue.items.length} journey${queue.items.length===1?'':'s'}`;
  $('queue-message').textContent=queue.message;$('queue-total').textContent=`Total fare limits: ${money(queue.totalLimit)}`;
  $('queue-empty').hidden=queue.items.length>0;$('queue-stop').hidden=queue.status!=='running';
  const key=JSON.stringify(queue);if(key===queueRenderKey)return;queueRenderKey=key;
  const labels={queued:'Queued',running:'In progress',waiting:'Needs your input',ready:'Ready for payment',payment_pending:'Awaiting payment',needs_check:'Check payment',complete:'Booked',failed:'No ticket reported',error:'Stopped with an error',cancelled:'Cancelled'};
  const text=(tag,content,className)=>{const e=document.createElement(tag);e.textContent=content;if(className)e.className=className;return e;};
  $('queue-items').replaceChildren(...queue.items.map((item,index)=>{
    const r=item.request,row=document.createElement('li');row.className='journey-row';row.dataset.id=item.id;row.dataset.status=item.status;
    const trip=text('div','', 'list-trip');trip.append(text('span',String(index+1).padStart(2,'0'),'journey-index'),text('strong',`${r.from} → ${r.to}`),text('small',`${r.trainNumber||'First eligible train'} · ${prettyDate(r.date)} · ${r.classCode} / ${r.quota==='TQ'?'Tatkal':'General'}`));
    const passengers=text('div','','list-passengers');passengers.append(text('small','Passengers'),text('span',r.passengers.map(p=>p.name).join(', ')));
    const fare=text('div','','list-fare');fare.append(text('small','Fare limit'),text('strong',money(r.maxAmount)),text('small',r.autoPayment?'Automatic QR':'Stop at payment options'));
    const status=text('div','','list-status');status.append(text('span',item.status==='complete'&&!item.summary?.pnr?'Reported booked':labels[item.status]||item.status,'status-badge'),text('small',item.summary?.pnr?`PNR ${item.summary.pnr}`:item.message));
    const actions=text('div','','list-row-actions');
    if(item.status==='queued'){
      const edit=text('button','Edit','button text-button');edit.type='button';edit.disabled=queue.status==='running'||!!queue.currentId;
      edit.addEventListener('click',()=>{editingId=item.id;restore(item.request);refreshActions();$('booking-form').scrollIntoView({behavior:'smooth',block:'start'});$('from').focus({preventScroll:true});});actions.append(edit);
    }
    const remove=text('button','Remove','button text-button');remove.type='button';remove.disabled=queue.status==='running'||!!queue.currentId;
    remove.addEventListener('click',async()=>{remove.disabled=true;notify();try{await api('/api/queue/remove',{id:item.id});if(editingId===item.id)clearJourney();queueRenderKey='';await poll();}catch(e){notify(e.message);remove.disabled=false;}});actions.append(remove);
    row.append(trip,passengers,fare,status,actions);return row;
  }));
}
function refreshActions(){
  const active=!!job&&!finalStates.includes(job.status),busyPayment=!!job?.paymentHandoff||!!job?.resultChecking;
  const locked=active||!!pending||!!job?.working||queue?.status==='running'||!!queue?.currentId;
  $('booking-fields').disabled=locked;
  $('start').disabled=!online||locked||busyActions.has('start');
  $('start').textContent=job?.status==='cancelled'&&job.working?'Stopping…':active?'Booking in progress…':'Book only this journey';
  $('start').hidden=!!editingId||!!queue?.items.length;
  $('queue-add').disabled=!online||locked||busyActions.has('queue-add');$('queue-add').textContent=editingId?'Save journey':'Add to booking list';
  $('journey-form-title').textContent=editingId?'Edit journey':'Add a journey';$('queue-edit-cancel').hidden=!editingId;$('queue-edit-cancel').disabled=locked;
  $('queue-start').disabled=!online||locked||!!editingId||!queue?.remaining||busyActions.has('queue-start');
  $('queue-start').textContent=queue?.status==='paused'||queue?.status==='stopped'?'Continue remaining journeys':'Start booking list';
  $('queue-stop').disabled=!online||busyActions.has('queue-stop');$('refresh-stations').disabled=!online||busyActions.has('refresh-stations');
  for(const id of ['open-browser','resume','cancel','pay'])$(id).disabled=!online||busyActions.has(id);
  $('check-result').disabled=!online||busyPayment||busyActions.has('check-result');
  $('check-result').textContent=job?.resultChecking?'Checking booking…':job?.paymentHandoff?'Opening payment…':'Check booking result';
  $('reconcile-confirm').disabled=busyPayment;
  for(const id of ['not-booked','was-booked'])$(id).disabled=!online||busyPayment||busyActions.has('not-booked')||busyActions.has('was-booked')||!$('reconcile-confirm').checked;
}
function render(state){
  token=state.token;job=state.job;pending=state.pending;queue=state.queue;
  if(state.stations)$('station-status').textContent=state.stations.total?`${state.stations.total.toLocaleString('en-IN')} IRCTC stations · names and codes`:'Open IRCTC, then refresh to load station suggestions.';
  const nextPendingKey=pending?(pending.id||'unknown'):'';
  if(nextPendingKey!==pendingKey){pendingKey=nextPendingKey;$('reconcile-confirm').checked=false;}
  const connected=state.browser.connected;
  $('connection-label').lastChild.textContent=connected?' Chromium connected':' Chromium not connected';$('connection-label').parentElement.classList.toggle('connected',connected);
  // Another local tab or a script can start a run after this page has loaded.
  // Restore once per job, while preserving edits to a future journey between polls.
  if(job?.request&&job.id!==renderedJobId){renderedJobId=job.id;editingId=null;restore(job.request);}
  if(!job)renderedJobId=null;
  const active=!!job&&!finalStates.includes(job.status);
  const receipt=job?.status==='complete'&&job.summary?.pnr;
  document.body.classList.toggle('has-active-job',active||!!pending||!!receipt);
  $('resume').hidden=!job?.canResume;$('pay').hidden=job?.status!=='ready';$('check-result').hidden=!job?.paymentStarted||finalStates.includes(job.status);$('cancel').hidden=!active||!!job?.paymentStarted;
  $('reconcile').hidden=!pending;$('event-details').hidden=!job;
  $('job-message').textContent=job?.status==='cancelled'&&job.working?'Stopping this run. Waiting for the current browser operation to finish…':job?.message||(pending?'A previous payment needs checking on IRCTC before another run.':'Ready when you are. No booking has started.');
  $('receipt').hidden=!receipt;
  if(receipt){const s=job.summary;$('receipt-pnr').textContent=s.pnr;$('receipt-trip').textContent=`${s.trainNumber} · ${s.from.code} → ${s.to.code} · ${prettyDate(s.date)} · ${money(s.amount)}`;}
  const stageMap={connect:0,login:0,search:1,availability:1,passengers:2,fare:3,review:3,payment:4,complete:5};
  const current=job?stageMap[job.stage]:-1;
  [...$('progress').children].forEach((e,i)=>{e.classList.toggle('active',i===current&&job?.status!=='complete');e.classList.toggle('done',i<current||job?.status==='complete');});
  $('events').replaceChildren(...(job?.events||[]).slice(-10).map(event=>{const li=document.createElement('li');const time=new Date(event.at).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Kolkata'});li.textContent=`${time} — ${event.message}`;return li;}));
  if(job?.summary&&!finalStates.includes(job.status))renderSummary(job.summary,job.request);else updateSummary();
  renderQueue();refreshActions();
}
async function poll(){if(polling)return;polling=true;try{const r=await fetch('/api/state');if(!r.ok)throw Error();const state=await r.json();online=true;render(state);}catch{online=false;refreshActions();$('connection-label').lastChild.textContent=' Local app disconnected';$('job-message').textContent='The local server is unavailable. Restart it with npm start. Check IRCTC before repeating any payment.';}finally{polling=false;}}
function action(id,path,body){$(id).addEventListener('click',async()=>{notify();busyActions.add(id);refreshActions();try{await api(path,typeof body==='function'?body():body);await poll();}catch(e){notify(e.message);}finally{busyActions.delete(id);refreshActions();}});}
const istDay=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
$('date').min=istDay;$('date').value=istDay;addPassenger();
$('booking-form').addEventListener('input',updateSummary);$('booking-form').addEventListener('change',updateSummary);
$('add-passenger').addEventListener('click',()=>addPassenger());
$('swap').addEventListener('click',()=>{const from=$('from').value;$('from').value=$('to').value;$('to').value=from;updateSummary();});
$('booking-form').addEventListener('submit',async e=>{
  e.preventDefault();notify();const single=e.submitter?.id==='start',busy=single?'start':'queue-add';
  if(busyActions.has(busy)||!$('booking-form').reportValidity())return;
  const details=request();busyActions.add(busy);refreshActions();
  try{
    if(single){await api('/api/jobs',details);$('password').value='';$('username').value='';}
    else{delete details.credentials;await api(editingId?'/api/queue/edit':'/api/queue/add',{...details,id:editingId});clearJourney();}
    await poll();
  }catch(e){notify(e.message);}finally{busyActions.delete(busy);refreshActions();}
});
$('queue-edit-cancel').addEventListener('click',clearJourney);
$('queue-start').addEventListener('click',async()=>{
  notify();busyActions.add('queue-start');refreshActions();
  try{await api('/api/queue/start',{credentials:{username:$('username').value.trim(),password:$('password').value}});$('password').value='';$('username').value='';await poll();}
  catch(e){notify(e.message);}finally{busyActions.delete('queue-start');refreshActions();}
});
action('queue-stop','/api/queue/stop',{});action('refresh-stations','/api/stations/refresh',{});
for(const id of ['from','to']){
  let timer,controller;
  const lookup=()=>{
    clearTimeout(timer);controller?.abort();const query=$(id).value;
    timer=setTimeout(async()=>{
      controller=new AbortController();
      try{const r=await fetch('/api/stations?q='+encodeURIComponent(query),{signal:controller.signal});if(!r.ok)throw Error();const data=await r.json();if($(id).value!==query)return;
        $(id+'-stations').replaceChildren(...data.stations.map(s=>{const o=document.createElement('option');o.value=`${s.name} (${s.code})`;o.label=[s.city,s.state].filter(Boolean).join(' · ');return o;}));
      }catch(e){if(e.name!=='AbortError')$('station-status').textContent='Station lookup is unavailable. Try refreshing the station list.';}
    },200);
  };
  $(id).addEventListener('input',lookup);$(id).addEventListener('focus',lookup);
}
action('open-browser','/api/browser/open',{});action('resume','/api/jobs/resume',()=>({id:job.id}));action('cancel','/api/jobs/cancel',()=>({id:job.id}));action('pay','/api/jobs/pay',()=>({id:job.id}));action('check-result','/api/jobs/check',()=>({id:job.id}));
$('reconcile-confirm').addEventListener('change',refreshActions);
action('not-booked','/api/reconcile',{outcome:'not_booked'});action('was-booked','/api/reconcile',{outcome:'booked'});
await poll();setInterval(poll,2000);
