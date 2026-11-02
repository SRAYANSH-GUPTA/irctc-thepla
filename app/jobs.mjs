import {randomUUID} from 'node:crypto';

const FINAL = new Set(['cancelled','error','complete','failed']);
export class JobManager {
  constructor({prepare, pay, check, pendingStore}) { Object.assign(this,{prepare,pay,check,pendingStore}); this.job=null;this.listeners=new Set();this.queueOwner=null; }
  subscribe(listener){this.listeners.add(listener);return ()=>this.listeners.delete(listener);}
  changed(){for(const listener of this.listeners)listener();}
  snapshot() {
    const j=this.job;
    return {job:j?{id:j.id,status:j.status,stage:j.stage,message:j.message,events:j.events,summary:j.summary,request:j.intent,canResume:!!j.waiter,paymentStarted:!!j.paymentStarted,working:!!j.working,paymentHandoff:!!j.paymentHandoff,resultChecking:!!j.resultChecking}:null,pending:this.pendingStore.read()};
  }
  update(j,stage,message,status='running') {
    j.stage=stage;j.message=message;j.status=status;
    j.events.push({at:new Date().toISOString(),stage,message});j.events=j.events.slice(-40);
    this.changed();
  }
  async pause(j,message) {
    j.controller.signal.throwIfAborted();
    this.update(j,j.stage,message,'waiting');
    await new Promise((resolve,reject)=>{
      const abort=()=>{j.waiter=null;reject(Error('Stopped.'))};
      j.controller.signal.addEventListener('abort',abort,{once:true});
      j.waiter=()=>{j.controller.signal.removeEventListener('abort',abort);j.waiter=null;resolve();};
    });
    j.controller.signal.throwIfAborted();j.status='running';
  }
  start(intent,credentials={},owner=null) {
    if(this.queueOwner&&owner!==this.queueOwner)throw Error('The booking list is running. Stop the list before starting a separate booking.');
    if (this.pendingStore.read()) throw Error('A previous payment needs checking. Reconcile it before starting another booking.');
    if (this.job && !FINAL.has(this.job.status)) throw Error('A booking is already active. Stop it before starting another.');
    if(this.job?.working)throw Error('The previous run is still stopping. Wait for it to finish before starting another.');
    const j={id:randomUUID(),intent,credentials,stage:'connect',status:'running',events:[],controller:new AbortController(),summary:null,working:true};
    this.job=j;
    this.update(j,'connect','Connecting to IRCTC…');
    j.task=Promise.resolve().then(()=>{
      j.controller.signal.throwIfAborted();
      return this.prepare(j,{update:(s,m)=>{j.controller.signal.throwIfAborted();this.update(j,s,m);},pause:m=>this.pause(j,m)});
    }).then(async summary=>{
      j.controller.signal.throwIfAborted();j.summary=summary;this.update(j,'payment','Ready at IRCTC payment options. Review the total, then open the payment QR.','ready');
      if(j.intent.autoPayment)await this.openPayment(j.id);
    }).catch(e=>{if(j.status!=='cancelled')this.update(j,j.stage,e.message,'error');}).finally(()=>{j.credentials={};j.working=false;this.changed();});
    return j.id;
  }
  resume(id) {const j=this.get(id);if(!j.waiter)throw Error('This booking is not waiting for input.');j.waiter();}
  cancel(id) {
    const j=this.get(id);
    if (j.paymentStarted) throw Error('Payment has started. Check the result before starting another booking.');
    j.controller.abort();j.credentials={};this.update(j,j.stage,'Stopped. No further booking actions will run.','cancelled');
  }
  get(id) {if(!this.job||this.job.id!==id)throw Error('This booking is no longer active. Refresh the page.');return this.job;}
  openPayment(id) {
    const j=this.get(id);
    if(j.status!=='ready'||j.paymentStarted)throw Error('Payment can be started only once from a verified fare review.');
    // The journal is written before the click, including on an uncertain outcome.
    this.pendingStore.write({id:j.id,at:new Date().toISOString(),train:j.summary.trainNumber,date:j.intent.date,amount:j.summary.amount});
    j.paymentStarted=true;j.paymentHandoff=true;this.update(j,'payment','Opening the payment provider. Complete payment in Chromium.','payment_pending');
    return (async()=>{
      try {await this.pay(j);this.update(j,'payment','The payment provider is open in Chromium. Follow its payment instructions, then check the result here.','payment_pending');}
      catch {this.update(j,'payment','The payment handoff needs checking in Chromium. Do not submit it again.','needs_check');}
      finally {j.paymentHandoff=false;this.changed();}
    })();
  }
  async checkResult(id,{focus=true}={}) {
    const j=this.get(id);
    if(!j.paymentStarted)throw Error('No payment has started for this booking.');
    if(j.paymentHandoff)throw Error('The payment page is still opening. Wait before checking the result.');
    if(j.resultChecking)throw Error('A booking result check is already running.');
    if(FINAL.has(j.status))throw Error('This booking has already been resolved.');
    // Hold this lock through the read and state update. Reconciliation cannot
    // clear the journal while an older browser result is still in flight.
    j.resultChecking=true;
    try {
      const result=await this.check(j,{focus});
      if(result.status==='complete'){j.summary={...j.summary,pnr:result.pnr};this.pendingStore.clear();this.update(j,'complete',`Ticket issued. PNR ${result.pnr}. Check the berth status on IRCTC.`,'complete');}
      else {
        const message=result.message || 'No matching issued ticket has been verified yet. Check the IRCTC result in Chromium.';
        if(j.status!=='needs_check'||j.message!==message)this.update(j,'payment',message,'needs_check');
      }
    } finally {j.resultChecking=false;this.changed();}
  }
  reconcile(outcome) {
    if(this.job?.paymentHandoff)throw Error('The payment handoff is still running. Wait for the browser result before reconciling it.');
    if(this.job?.resultChecking)throw Error('A booking result check is still running. Wait before reconciling it.');
    if(!['not_booked','booked'].includes(outcome))throw Error('Confirm the outcome after checking IRCTC.');
    if(!this.pendingStore.read())throw Error('There is no pending payment to reconcile.');
    this.pendingStore.clear();
    if(this.job){this.job.controller.abort();this.job.credentials={};this.update(this.job,'complete',outcome==='booked'?'You reported that IRCTC issued the ticket.':'You checked IRCTC and reported that no ticket was issued.',outcome==='booked'?'complete':'failed');}
  }
}
