import {connect} from '../scripts/lib/cdp.mjs';
import {DEBUG,openBrowser} from './browser.mjs';
import {availabilityAllowed,verifyNames,verifyTotal,parseBookingConfirmation} from './validation.mjs';

const HOME='/eticket/train-search', RESULTS='/eticket/booking/train-list', DETAILS='/eticket/booking/psgninput', REVIEW='/eticket/booking/reviewBooking', PAYMENT='/eticket/payment/bkgPaymentOptions';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// All mutations use visible website controls. No private booking API replay.
export class IRCTCDriver {
  constructor(c,signal,pause) {this.c=c;this.signal=signal;this.pause=pause;}
  async read() {
    return this.c.evaluate(()=>{
      const visible=e=>!!e.getClientRects().length;
      const buttons=[...document.querySelectorAll('button,a')].filter(visible).map(e=>e.innerText.trim());
      const inputs=[...document.querySelectorAll('input')].filter(visible);
      return {path:location.pathname,login:buttons.includes('LOGIN'),
        password:inputs.some(e=>e.type==='password'&&e.id==='password'),
        challenge:inputs.some(e=>/captcha|\botp\b|one.time.password|verification code/i.test([e.name,e.id,e.placeholder,e.getAttribute('formcontrolname')].join(' '))),
        buttons,passengers:[...document.querySelectorAll('.passenger-header-row .passenger-name')].filter(visible).map(e=>e.innerText.trim()),
        errors:[...document.querySelectorAll('[role="alert"],.error-message,.p-toast-detail,app-control-messages')].filter(visible).map(e=>e.innerText.trim()).filter(Boolean)};
    });
  }
  async guard() {
    this.signal.throwIfAborted();
    const s=await this.read();
    this.signal.throwIfAborted();
    if(s.path==='/eticket/error')throw Error('IRCTC ended the session. Start a new run and sign in again; this run will not submit anything else.');
    if(s.challenge){await this.c.bringToFront();await this.pause('Complete the OTP or CAPTCHA directly on IRCTC, then click Resume here.');return this.guard();}
    return s;
  }
  async until(check,label,ms=30000,{verification=true}={}) {
    const end=Date.now()+ms;
    while(true){this.signal.throwIfAborted();if(verification)await this.guard();const result=await check();if(result)return result;if(Date.now()>end)throw Error(`IRCTC did not finish ${label}. Check the browser before starting another run; nothing will be resubmitted automatically.`);await sleep(500);}
  }
  async click(selector) {
    await this.guard();
    const clicked=await this.c.evaluate(selector=>{
      const es=[...document.querySelectorAll(selector)].filter(e=>e.getClientRects().length);
      if(es.length!==1||es[0].disabled)return false;es[0].click();return true;
    },selector);
    if(!clicked)throw Error('An expected IRCTC control is missing or ambiguous. Check the browser.');
  }
  async button(text,{last=false}={}) {
    await this.guard();
    const clicked=await this.c.evaluate(({text,last})=>{
      const es=[...document.querySelectorAll('button,a')].filter(e=>e.getClientRects().length&&e.innerText.trim()===text&&!e.disabled);
      if(!es.length||(!last&&es.length!==1))return false;es.at(last?-1:0).click();return true;
    },{text,last});
    if(!clicked)throw Error(`The “${text}” control is unavailable. Check IRCTC in Chromium.`);
  }
  async fill(selector,value) {
    await this.guard();
    const focused=await this.c.evaluate(({selector,length})=>{
      const es=[...document.querySelectorAll(selector)].filter(e=>e.getClientRects().length);
      if(es.length!==1||es[0].disabled||es[0].readOnly||es[0].maxLength>0&&length>es[0].maxLength)return false;
      const e=es[0];e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'');e.dispatchEvent(new Event('input',{bubbles:true}));return true;
    },{selector,length:String(value).length});
    if(!focused)throw Error('An IRCTC field is unavailable or its length limit is exceeded. Review the details in Chromium.');
    this.signal.throwIfAborted();await this.c.insertText(String(value));
    const matched=await this.c.evaluate(({selector,value})=>{const e=document.querySelector(selector);const ok=e?.value===value;e?.blur();return ok;},{selector,value:String(value)});
    if(!matched)throw Error('A field did not retain the requested value. The booking has been stopped.');
  }
  async home() {
    this.signal.throwIfAborted();
    const location=await this.c.location();
    this.signal.throwIfAborted();
    if(location.origin!=='https://www.irctc.co.in')throw Error('Finish or reconcile the payment already open in Chromium.');
    if(location.path==='/eticket/error'){
      await this.c.evaluate(()=>{const link=[...document.querySelectorAll('a')].find(e=>e.innerText.trim()==='Click here to login');if(link)link.click();});
    }else if(location.path!==HOME){
      await this.c.evaluate(()=>{const a=document.querySelector('a[href="/eticket/train-search"]');if(a)a.click();else location.href='https://www.irctc.co.in/eticket/train-search';});
    }
    await this.until(async()=> (await this.read()).path===HOME,'opening the search page',30000,{verification:false});
  }
  async login(credentials) {
    let s=await this.read();
    if(!s.login&&!s.password)return;
    if(s.login&&!s.password)await this.button('LOGIN');
    if(credentials.username&&credentials.password&&!s.challenge){
      await this.fill('#username',credentials.username);await this.fill('#password',credentials.password);
      await this.c.evaluate(()=>{const f=document.querySelector('#password')?.closest('form');const b=[...f.querySelectorAll('button')].find(e=>e.innerText.trim()==='LOGIN');b.click();});
      credentials.password='';credentials.username='';
      // One submission only. Invalid credentials and verification are handed to the user.
      for(let i=0;i<20;i++){await sleep(500);s=await this.read();if(!s.login&&!s.password)return;if(s.challenge)break;}
    }
    await this.c.bringToFront();
    do{await this.pause('Sign in on the official IRCTC page, including any OTP or CAPTCHA, then click Resume.');s=await this.read();}while(s.login||s.password||s.challenge);
    if(s.path!==HOME)await this.home();
  }
  async station(label,query) {
    await this.click(`[aria-label="${label}"]`);
    const searchTerm=query.match(/\(([A-Z]{1,6})\)$/i)?.[1]||query;
    await this.fill(`[aria-label="${label}"] input[placeholder="Type to search..."]`,searchTerm);
    const find=()=>this.c.evaluate(({label,query})=>{
      const root=document.querySelector(`[aria-label="${label}"]`);
      const options=[...root.querySelectorAll('[role="option"]')].filter(e=>e.getClientRects().length).map(e=>({code:e.querySelector('.option-code')?.innerText.trim(),name:e.querySelector('.option-name')?.innerText.trim()}));
      const q=query.trim().toUpperCase(), code=q.match(/\(([A-Z]{1,6})\)$/)?.[1];
      const exact=options.filter(o=>o.code===q||code&&o.code===code||o.name===q);
      return exact.length===1?exact[0]:null;
    },{label,query});
    let match;
    for(let i=0;i<24;i++){await this.guard();match=await find();if(match)break;await sleep(500);}
    if(!match){
      await this.c.bringToFront();await this.pause(`Choose the exact ${label.toLowerCase()} in IRCTC for “${query}”, then Resume.`);
      const selected=await this.c.evaluate(label=>{const e=document.querySelector(`[aria-label="${label}"]`);if(e.getAttribute('aria-expanded')==='true')return null;return e.querySelector('.select-placeholder.has-value')?.innerText.trim();},label);
      const code=selected?.match(/\s-\s([A-Z]{1,6})(?:\s|$)/)?.[1];
      if(!code)throw Error('The station selection could not be verified. Use an exact station code.');
      return {code,name:selected.split(' - ')[0]};
    }
    await this.c.evaluate(({label,code})=>{const e=[...document.querySelectorAll(`[aria-label="${label}"] [role="option"]`)].find(e=>e.querySelector('.option-code')?.innerText.trim()===code);e.click();},{label,code:match.code});
    return match;
  }
  async date(date) {
    await this.click('[aria-label="Select travel date"]');
    const [year,month,day]=date.split('-').map(Number);
    const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
    for(let attempt=0;attempt<24;attempt++){
      const shown=await this.c.evaluate(()=>({year:Number(document.querySelector('.ui-datepicker-year')?.textContent),month:document.querySelector('.ui-datepicker-month')?.textContent.trim()}));
      const delta=year*12+month-1-(shown.year*12+months.indexOf(shown.month));
      if(delta===0)break;
      if(!Number.isFinite(delta)||!shown.year||!months.includes(shown.month))throw Error('The IRCTC calendar could not be read.');
      await this.click(delta>0?'.ui-datepicker-next':'.ui-datepicker-prev');
      if(attempt===23)throw Error('The requested date is outside the supported calendar range.');
    }
    const clicked=await this.c.evaluate(day=>{const e=[...document.querySelectorAll('.ui-datepicker-calendar td:not(.ui-datepicker-other-month) a')].find(e=>e.innerText.trim()===String(day)&&!e.classList.contains('ui-state-disabled'));if(!e)return false;e.click();return true;},day);
    if(!clicked)throw Error('IRCTC does not allow selecting that date.');
    const expected=`${day} ${months[month-1].slice(0,3)} ${year}`;
    const actual=await this.c.evaluate(()=>document.querySelector('[aria-label="Select travel date"] .select-placeholder')?.innerText.trim());
    if(actual!==expected)throw Error('The selected journey date did not match.');
  }
  async quota(quota) {
    await this.click('[aria-label="Quota"]');
    const label=quota==='TQ'?'TATKAL':'GENERAL';
    const clicked=await this.c.evaluate(label=>{const e=[...document.querySelectorAll('[aria-label="Quota"] [role="option"]')].find(e=>e.innerText.trim()===label);if(!e)return false;e.click();return true;},label);
    if(!clicked)throw Error('This quota is not offered by IRCTC.');
  }
  async chooseTrain(intent) {
    await this.until(()=>this.c.evaluate(()=>document.querySelectorAll('.train-number').length>0),'loading train results');
    const numbers=await this.c.evaluate(()=>[...document.querySelectorAll('.train-number')].filter(e=>e.getClientRects().length).map(e=>e.innerText.trim()));
    const candidates=intent.trainNumber?numbers.filter(n=>n===intent.trainNumber):numbers.slice(0,20);
    if(!candidates.length)throw Error('The requested train is not in the results for these stations and date.');
    for(const number of candidates){
      await this.guard();
      const open=await this.c.evaluate(number=>{const e=[...document.querySelectorAll('.train-number')].find(e=>e.innerText.trim()===number)?.closest('.train-card__main');const b=e?.querySelector('.btn-availability');if(!b||b.disabled)return false;b.click();return true;},number);
      if(!open)continue;
      await this.until(()=>this.c.evaluate(number=>{const root=[...document.querySelectorAll('.train-number')].find(e=>e.innerText.trim()===number)?.closest('.train-card');return root&&[...root.querySelectorAll('.class-card')].some(e=>e.getClientRects().length);},number),'loading class availability');
      const choice=await this.c.evaluate(({number,classCode})=>{
        const root=[...document.querySelectorAll('.train-number')].find(e=>e.innerText.trim()===number).closest('.train-card');
        const cards=[...root.querySelectorAll('.class-card')].filter(e=>e.getClientRects().length&&e.querySelector('.class-code')?.innerText.trim().endsWith(`(${classCode})`));
        return cards.length===1?{text:cards[0].innerText,label:cards[0].querySelector('.class-code').innerText.trim()}:null;
      },{number,classCode:intent.classCode});
      if(choice&&availabilityAllowed(choice.text,intent.allowWaitlist)){
        const trainText=await this.c.evaluate(number=>[...document.querySelectorAll('.train-number')].find(e=>e.innerText.trim()===number)?.closest('.train-card__main')?.innerText,number);
        await this.c.evaluate(({number,classCode})=>{const root=[...document.querySelectorAll('.train-number')].find(e=>e.innerText.trim()===number).closest('.train-card');const e=[...root.querySelectorAll('.class-card')].find(e=>e.getClientRects().length&&e.querySelector('.class-code')?.innerText.trim().endsWith(`(${classCode})`));e.querySelector('.btn-book').click();},{number,classCode:intent.classCode});
        await this.until(async()=> (await this.read()).path===DETAILS,'opening passenger details');
        return {trainNumber:number,classLabel:choice.label,availability:choice.text.split('\n').find(x=>/AVAILABLE|AVBL|WL|RAC/i.test(x))?.trim(),trainText};
      }
    }
    throw Error(intent.trainNumber?'That train has no availability matching your class and waitlist choice.':'No eligible train was found among the first 20 results. Choose a specific train or change your availability preference.');
  }
  async dropdown(control,label) {
    await this.click(`p-dropdown[formcontrolname="${control}"] .ui-dropdown-trigger`);
    const clicked=await this.c.evaluate(label=>{const es=[...document.querySelectorAll('[role="option"],.ui-dropdown-item')].filter(e=>e.getClientRects().length&&(e.innerText.trim().toLowerCase()===label.toLowerCase()||e.getAttribute('aria-label')?.toLowerCase()===label.toLowerCase()));const e=es.find(e=>!es.some(c=>c!==e&&e.contains(c)));if(!e)return false;e.click();return true;},label);
    if(!clicked){await this.c.bringToFront();await this.pause(`IRCTC does not offer “${label}” here. Choose an applicable option in the open form, then Resume.`);}
  }
  async passengers(passengers) {
    let count=(await this.read()).passengers.length;
    // IRCTC can retain passengers when a new search is opened in the same SPA.
    // Clear only the current, unsubmitted booking rows, never the master list.
    while(count){
      await this.guard();
      const removed=await this.c.evaluate(()=>{if(location.pathname!=='/eticket/booking/psgninput')return false;const e=[...document.querySelectorAll('.passenger-content img[alt="Delete"]')].find(e=>e.getClientRects().length);if(!e)return false;e.click();return true;});
      if(!removed)throw Error('Clear the retained passengers in the IRCTC booking form, then start a new run.');
      const expected=count-1;await this.until(async()=> (await this.read()).passengers.length===expected,'clearing the previous booking passenger',5000);count=expected;
    }
    const saved=passengers.filter(p=>p.kind==='saved');
    if(saved.length){
      await this.button('Existing Passenger');
      await this.until(()=>this.c.evaluate(()=>document.querySelectorAll('.ep-passenger-row').length>0),'loading saved passengers');
      await this.c.evaluate(names=>{for(const row of document.querySelectorAll('.ep-passenger-row')){const name=row.querySelector('.ep-passenger-name')?.innerText.trim().toLowerCase();if(row.getClientRects().length&&row.querySelector('input[type="checkbox"]')?.checked&&!names.includes(name))row.querySelector('[role="checkbox"]').click();}},saved.map(p=>p.name.toLowerCase()));
      for(const p of saved){
        const result=await this.c.evaluate(name=>{const rows=[...document.querySelectorAll('.ep-passenger-row')].filter(e=>e.getClientRects().length&&e.querySelector('.ep-passenger-name')?.innerText.trim().toLowerCase()===name.toLowerCase());if(rows.length!==1)return false;const input=rows[0].querySelector('input[type="checkbox"]');if(!input.checked)rows[0].querySelector('[role="checkbox"]').click();return input.checked;},p.name);
        if(!result)throw Error('A saved passenger is missing or has duplicate names. Review the master list in IRCTC.');
      }
      await this.button('Add',{last:true});
    }
    for(const p of passengers.filter(p=>p.kind==='new')){
      await this.button('New Passenger');
      await this.fill('input[placeholder="Full Name as per Govt. ID"]',p.name);
      await this.fill('input[formcontrolname="passengerAge"]',p.age);
      await this.dropdown('passengerGender',p.gender);
      if(p.berth!=='No preference')await this.dropdown('passengerBerthChoice',p.berth);
      await this.button('Add',{last:true});
      const added=await this.c.evaluate(name=>[...document.querySelectorAll('.passenger-name')].some(e=>e.innerText.replace(/^\s*\d+[.)]\s*/,'').trim().toLowerCase()===name.toLowerCase()),p.name);
      if(!added){await this.c.bringToFront();await this.pause('Complete any extra passenger fields requested by this train and click Add in IRCTC, then Resume.');}
    }
    verifyNames((await this.read()).passengers,passengers);
    await this.verifyPassengerDetails(passengers);
  }
  async verifyPassengerDetails(passengers) {
    const rows=await this.c.evaluate(()=>[...document.querySelectorAll('.passenger-content')].filter(e=>e.getClientRects().length).map(row=>{
      const age=[...row.querySelectorAll('.detail-pair')].find(e=>e.querySelector('.detail-label')?.innerText.trim()==='Age')?.querySelector('.detail-value')?.innerText.trim();
      return {name:row.querySelector('.passenger-name')?.innerText.replace(/^\s*\d+[.)]\s*/,'').trim().toLowerCase(),age:Number(age),details:[...row.querySelectorAll('.detail-item')].map(e=>e.innerText.trim())};
    }));
    for(const p of passengers.filter(p=>p.kind==='new')){
      const row=rows.find(r=>r.name===p.name.toLowerCase());
      if(!row||row.age!==p.age||!row.details.includes(p.gender)||!row.details.includes('India'))throw Error('The age, gender or country in the passenger summary does not match your entry. Review it on IRCTC.');
    }
  }
  async preferences(intent) {
    if(intent.mobile)await this.fill('#additionalMobileNumber',intent.mobile);
    await this.guard();
    const collapsed=await this.c.evaluate(()=>document.querySelector('button[aria-label="Toggle Other Preferences"]')?.getAttribute('aria-expanded')==='false');
    if(collapsed)await this.click('button[aria-label="Toggle Other Preferences"]');
    const confirmed=await this.c.evaluate(allowWaitlist=>{
      const conf=document.querySelector('p-checkbox[formcontrolname="bookOnlyIfCnf"]');
      if(!conf||!conf.getClientRects().length)return allowWaitlist;
      const input=conf.querySelector('input');if(input.checked===allowWaitlist)conf.querySelector('[role="checkbox"]').click();
      const upgrade=document.querySelector('p-checkbox[formcontrolname="autoUpgradationSelected"]');
      if(upgrade?.querySelector('input')?.checked)upgrade.querySelector('[role="checkbox"]').click();
      return input.checked===!allowWaitlist;
    },intent.allowWaitlist);
    if(!confirmed)throw Error('The confirmed-berth-only setting could not be enabled. Review the booking preferences directly on IRCTC.');
    const result=await this.c.evaluate(({insurance})=>{
      const upi=document.querySelector('#payment-option-1');
      if(!upi||!upi.getClientRects().length)return false;
      const group=upi.closest('.payment-option')?.innerText||'';
      if(!/UPI/i.test(group))return false;
      if(!upi.checked)upi.click();
      const ins=[...document.querySelectorAll('input[name="insurance"]')].filter(e=>e.getClientRects().length);
      if(ins.length===1&&ins[0].type==='checkbox'&&ins[0].checked!==insurance)ins[0].click();
      if(insurance&&!ins.length)return 'insurance-unavailable';
      return true;
    },{insurance:intent.insurance});
    if(result!==true){await this.c.bringToFront();await this.pause(result==='insurance-unavailable'?'Travel insurance is not offered for this booking. Review the choice on IRCTC, then Resume.':'Select the requested UPI payment category and insurance choice on IRCTC, then Resume.');}
    const upiChecked=await this.c.evaluate(()=>document.querySelector('#payment-option-1')?.checked===true);
    if(!upiChecked)throw Error('The UPI payment category is not selected.');
  }
  async review(intent,selection,stations,{paymentPage=false}={}) {
    await this.guard();
    if(!paymentPage)await this.verifyPassengerDetails(intent.passengers);
    const data=await this.c.evaluate(()=>{
      const visible=e=>!!e.getClientRects().length;
      const text=document.body.innerText;
      const totals=[...document.querySelectorAll('.payable-row .payable-total')].filter(visible).map(e=>Number(e.innerText.replace(/[^\d.]/g,'')));
      const mainNames=[...document.querySelectorAll('.passenger-header-row .passenger-name')].filter(visible).map(e=>e.innerText);
      const summaryNames=[...document.querySelectorAll('.passenger-name-row .passenger-name')].filter(visible).map(e=>e.innerText);
      return {text,totals:[...new Set(totals)],names:mainNames.length?mainNames:summaryNames,summaryNames,status:text.split('\n').filter(x=>/^(?:[A-Z]*WL\s*\d|RAC\s*\d|AVAILABLE|AVBL)/i.test(x.trim()))};
    });
    verifyNames(data.names,intent.passengers);
    if(data.summaryNames.length)verifyNames(data.summaryNames,intent.passengers);
    if(data.totals.length!==1)throw Error('The final fare could not be read unambiguously. Check the IRCTC review.');
    verifyTotal(data.totals[0],intent.maxAmount);
    const [y,m,d]=intent.date.split('-').map(Number), mon=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m-1];
    const datePattern=paymentPage?new RegExp(`\\b${d}\\s+${mon}\\b`,'i'):new RegExp(`\\b${d}\\s+${mon}\\s+${y}\\b`,'i');
    if(!data.text.includes(selection.trainNumber)||!data.text.includes(selection.classLabel)||!data.text.includes(stations.from.code)||!data.text.includes(stations.to.code)||!datePattern.test(data.text))throw Error('The itinerary on IRCTC does not match the requested train, stations, class, and date.');
    if(!new RegExp(intent.quota==='TQ'?'\\bTATKAL\\b':'\\bGENERAL\\b','i').test(data.text))throw Error('The requested quota could not be verified on the review.');
    const availability=data.status.at(-1)||selection.availability;
    if(!availabilityAllowed(availability,intent.allowWaitlist))throw Error('Availability changed and no longer matches your waitlist choice.');
    return {trainNumber:selection.trainNumber,classCode:intent.classCode,quota:intent.quota,date:intent.date,from:stations.from,to:stations.to,amount:data.totals[0],availability,passengerCount:intent.passengers.length};
  }
}

export async function prepareBooking(job,{update,pause}) {
  job.controller.signal.throwIfAborted();
  await openBrowser();
  job.controller.signal.throwIfAborted();
  const c=await connect(DEBUG);job.tabId=c.tabId;
  const d=new IRCTCDriver(c,job.controller.signal,pause);
  try{
    await d.home();update('login','Checking your IRCTC sign-in…');await d.login(job.credentials);
    update('search','Selecting stations, date, and quota…');
    const stations={from:await d.station('From station',job.intent.from),to:await d.station('To station',job.intent.to)};
    if(stations.from.code===stations.to.code)throw Error('The selected stations resolve to the same station.');
    await d.date(job.intent.date);await d.quota(job.intent.quota);await d.button('Search Trains');
    await d.until(async()=> (await d.read()).path===RESULTS,'searching trains');
    update('availability','Checking the requested class and availability…');const selection=await d.chooseTrain(job.intent);
    job.selection=selection;job.stations=stations;
    update('passengers','Adding and verifying your passengers…');await d.passengers(job.intent.passengers);await d.preferences(job.intent);
    update('fare','Calculating the final fare. IRCTC may require a waiting period…');await d.button('Calculate Fare');
    await d.until(async()=> (await d.read()).path===REVIEW,'calculating the fare',180000);
    const summary=await d.review(job.intent,selection,stations);
    update('review',`Verified ${summary.passengerCount} passenger(s), ${summary.availability}, total ₹${summary.amount.toFixed(2)}.`);
    await d.button('Continue To Payment');await d.until(async()=> (await d.read()).path===PAYMENT,'opening payment options');
    await c.bringToFront();return summary;
  }finally{c.close();}
}

export async function startPayment(job,{prepareOnly=false}={}) {
  const c=await connect(DEBUG,job.tabId);const d=new IRCTCDriver(c,job.controller.signal,async()=>{throw Error('Verification is required before payment.');});
  try{
    const state=await d.guard();if(state.path!==PAYMENT)throw Error('IRCTC is no longer at payment options.');
    // The payment summary omits the year. Return through the site's own Back
    // control to verify the complete date before the transaction-changing click.
    await d.button('Back');await d.until(async()=> (await d.read()).path===REVIEW,'checking the full review date');
    const fresh=await d.review(job.intent,job.selection,job.stations);
    if(fresh.amount!==job.summary.amount)throw Error('The total changed after review.');
    await d.button('Continue To Payment');await d.until(async()=> (await d.read()).path===PAYMENT,'returning to payment options');
    await d.review(job.intent,{...job.selection,availability:fresh.availability},job.stations,{paymentPage:true});
    await d.click('img[alt="Paytm UPI"]');
    const selected=await c.evaluate(()=>{const cards=[...document.querySelectorAll('.bank-card.bank-selected')].filter(e=>e.getClientRects().length);return cards.length===1&&cards[0].querySelector('img')?.alt==='Paytm UPI';});
    if(!selected)throw Error('The selected payment provider could not be verified.');
    await d.review(job.intent,{...job.selection,availability:fresh.availability},job.stations,{paymentPage:true});
    if(prepareOnly)return {verified:true,paymentSubmitted:false};
    await c.bringToFront();await d.button('Pay & Book');
    await d.until(async()=>{const p=await c.location();return p.origin==='https://secure.paytmpayments.com'||p.origin==='https://www.wps.irctc.co.in';},'opening the payment gateway',45000,{verification:false});
  }finally{c.close();}
}

export async function checkPayment(job,{focus=true}={}) {
  const c=await connect(DEBUG,job.tabId,{payment:true});
  try{
    if(focus)await c.bringToFront();const r=await c.paymentResult();
    if(!r?.recognized)return {status:'unknown',message:'Check the payment result in the browser.'};
    // An unrelated history row, gateway success message, or QR is not an issued ticket.
    const pnr=parseBookingConfirmation(r,job.intent,job.summary);
    if(pnr)return {status:'complete',pnr};
    return {status:'unknown',message:'A matching issued ticket and PNR have not been verified. Check IRCTC booked/failed history before any retry.'};
  }finally{c.close();}
}
