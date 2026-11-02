import {randomUUID} from 'node:crypto';
import {validateIntent} from './validation.mjs';

const FINAL=new Set(['complete','failed','error','cancelled']);
const stationKey=s=>s.match(/\(([A-Z0-9]+)\)$/i)?.[1]?.toUpperCase()||s.trim().toUpperCase();
const fingerprint=r=>JSON.stringify([stationKey(r.from),stationKey(r.to),r.date,r.trainNumber,r.classCode,r.quota,r.passengers.map(p=>p.name.trim().replace(/\s+/g,' ').toLowerCase()).sort()]);

export class BookingQueue {
  constructor(manager,{now=()=>new Date(),checkIntervalMs=5000}={}){
    this.manager=manager;this.now=now;this.items=[];this.status='idle';this.message='Add journeys below, then start the list.';this.currentId=null;this.scheduled=false;
    this.unsubscribe=manager.subscribe(()=>this.schedule());
    this.checkIntervalMs=checkIntervalMs;this.checkTimer=null;this.autoCheckStopped=null;
  }
  snapshot(){return {status:this.status,message:this.message,currentId:this.currentId,items:this.items.map(i=>({id:i.id,request:i.request,status:i.status,message:i.message,summary:i.summary,jobId:i.jobId})),remaining:this.items.filter(i=>i.status==='queued').length,totalLimit:this.items.reduce((sum,i)=>sum+i.request.maxAmount,0)};}
  editable(){
    if(this.status==='running'||this.currentId)throw Error('Stop the booking list and finish the current booking before editing it.');
  }
  add(input){
    this.editable();if(this.items.length>=20)throw Error('The booking list can contain up to 20 journeys. Remove finished journeys to make room.');
    const request=validateIntent(input,this.now());this.unique(request);
    const item={id:randomUUID(),request,status:'queued',message:'Waiting in the list.',summary:null,jobId:null};this.items.push(item);
    this.status='idle';this.message='Ready to start the queued journeys.';return item.id;
  }
  unique(request,except){if(this.items.some(i=>i.id!==except&&!['failed','error','cancelled'].includes(i.status)&&fingerprint(i.request)===fingerprint(request)))throw Error('This journey and passenger group are already in the list.');}
  edit(id,input){
    this.editable();const item=this.get(id);if(item.status!=='queued')throw Error('Only a journey that has not started can be edited.');
    const request=validateIntent(input,this.now());this.unique(request,id);item.request=request;
  }
  remove(id){this.editable();this.get(id);this.items=this.items.filter(i=>i.id!==id);}
  get(id){const item=this.items.find(i=>i.id===id);if(!item)throw Error('That journey is no longer in the list. Refresh the page.');return item;}
  start(credentials={}){
    if(this.status==='running'||this.currentId)throw Error('The list already has a booking in progress.');
    if(this.manager.pendingStore.read())throw Error('Resolve the previous payment before starting the list.');
    const j=this.manager.job;
    if(j&&(!FINAL.has(j.status)||j.working||j.paymentHandoff||j.resultChecking))throw Error('Finish or stop the current booking before starting the list.');
    const queued=this.items.filter(i=>i.status==='queued');if(!queued.length)throw Error('Add at least one journey to the list.');
    // Validate every journey before beginning, including after midnight/restart.
    for(const item of queued)validateIntent(item.request,this.now());
    this.status='running';this.message='Processing journeys in list order.';this.manager.queueOwner=this;
    this.launch(queued[0],credentials);
  }
  launch(item,credentials={}){
    // Credentials are supplied to the first job only; later jobs reuse Chromium.
    // Each job clears its own copy after sign-in/termination.
    this.currentId=item.id;item.status='running';item.message='Starting this journey…';
    try {item.jobId=this.manager.start(item.request,credentials,this);}
    catch(e){item.status='error';item.message=e.message;this.currentId=null;this.pause('The list stopped: '+e.message);}
  }
  pause(message){this.status='paused';this.message=message;this.manager.queueOwner=null;clearTimeout(this.checkTimer);this.checkTimer=null;}
  stop(){
    if(this.status!=='running')throw Error('The booking list is not running.');
    this.status='stopped';this.manager.queueOwner=null;
    clearTimeout(this.checkTimer);this.checkTimer=null;
    const j=this.manager.job;
    if(this.currentId&&j&&!FINAL.has(j.status)&&!j.paymentStarted){this.manager.cancel(j.id);this.message='List stopped. The unsubmitted journey was cancelled; the remaining journeys are still queued.';}
    else this.message=this.currentId?'List stopped. Resolve the current payment; the remaining journeys will not start.':'List stopped. Remaining journeys are still queued.';
    this.schedule();
  }
  schedule(){
    if(this.closed||this.scheduled)return;this.scheduled=true;
    queueMicrotask(()=>{this.scheduled=false;if(this.closed)return;try{this.advance();}catch(e){this.pause('The list stopped: '+e.message);}});
  }
  advance(){
    if(!this.currentId)return;
    const item=this.get(this.currentId),j=this.manager.job;
    if(!j||j.id!==item.jobId){this.pause('The active booking changed. Check IRCTC before continuing.');return;}
    item.status=j.status;item.message=j.message;item.summary=j.summary?structuredClone(j.summary):null;
    if(!FINAL.has(j.status)||j.working||j.paymentHandoff||j.resultChecking||this.manager.pendingStore.read()){
      if(j.paymentStarted&&!j.paymentHandoff&&!j.resultChecking&&!FINAL.has(j.status))this.watch(j.id);
      return;
    }
    clearTimeout(this.checkTimer);this.checkTimer=null;
    this.currentId=null;
    if(this.status!=='running')return;
    if(j.status!=='complete'){this.pause('This journey did not complete. Review its result, then continue with the remaining journeys.');return;}
    const next=this.items.find(i=>i.status==='queued');
    if(!next){this.status='finished';this.message='All journeys in this run have been processed. Review each result below.';this.manager.queueOwner=null;return;}
    try{validateIntent(next.request,this.now());}catch(e){this.pause('The next journey needs updating: '+e.message);return;}
    this.launch(next);
  }
  watch(id){
    if(this.status!=='running'||!this.checkIntervalMs||this.checkTimer||this.autoCheckStopped===id)return;
    this.checkTimer=setTimeout(async()=>{
      this.checkTimer=null;const j=this.manager.job;
      if(this.closed||this.status!=='running'||!this.currentId||j?.id!==id||FINAL.has(j.status))return;
      if(j.paymentHandoff||j.resultChecking){this.watch(id);return;}
      try{await this.manager.checkResult(id,{focus:false});}
      catch{this.autoCheckStopped=id;clearTimeout(this.checkTimer);this.checkTimer=null;this.message='Automatic result checking stopped. Check the current booking in Chromium, then use Check booking result or report its final outcome.';}
    },this.checkIntervalMs);
    this.checkTimer.unref?.();
  }
  close(){this.closed=true;this.status='stopped';this.unsubscribe();clearTimeout(this.checkTimer);this.manager.queueOwner=null;}
}
