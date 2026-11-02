export const CLASSES = ['SL', '2S', '3E', '3A', '2A', '1A', 'CC', 'EC'];
export const BERTHS = ['No preference', 'Lower', 'Middle', 'Upper', 'Side Lower', 'Side Upper', 'Window Side'];
export function todayIST(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Kolkata', year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
}
function required(value, label, max = 100) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) throw Error(`Enter a valid ${label}.`);
  return value.trim();
}
export function validateIntent(input, now = new Date()) {
  if (!input || typeof input !== 'object') throw Error('Enter your journey details.');
  const from = required(input.from, 'departure station');
  const to = required(input.to, 'destination station');
  if (from.toLowerCase() === to.toLowerCase()) throw Error('Choose different departure and destination stations.');
  const date = required(input.date, 'journey date', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date || date < todayIST(now)) throw Error('Choose a valid journey date, today or later in India.');
  if (!CLASSES.includes(input.classCode)) throw Error('Choose a supported travel class.');
  if (!['GN','TQ'].includes(input.quota)) throw Error('Choose General or Tatkal quota.');
  const trainNumber = String(input.trainNumber || '').trim();
  if (trainNumber && !/^\d{5}$/.test(trainNumber)) throw Error('Train number must contain five digits, or leave it empty.');
  if (input.maxAmount === '' || !Number.isFinite(Number(input.maxAmount)) || Number(input.maxAmount) <= 0 || Number(input.maxAmount) > 100000) throw Error('Set a maximum total fare between ₹1 and ₹100,000.');
  const maxPassengers = input.quota === 'TQ' ? 4 : 6;
  if (!Array.isArray(input.passengers) || input.passengers.length < 1 || input.passengers.length > maxPassengers) throw Error(`Add between 1 and ${maxPassengers} passengers for this quota.`);
  const passengers = input.passengers.map(p => {
    const name = required(p.name, 'passenger name', 60);
    if (!['saved','new'].includes(p.kind)) throw Error('Choose a saved or new passenger.');
    if (p.kind === 'saved') return {kind:'saved', name};
    const age = Number(p.age);
    if (!Number.isInteger(age) || age < 5 || age > 125) throw Error('New passengers must be age 5–125. Add younger children directly on IRCTC.');
    if (!['Male','Female','Transgender'].includes(p.gender)) throw Error('Select a gender for each new passenger.');
    if (!BERTHS.includes(p.berth || 'No preference')) throw Error('Select a listed berth preference.');
    return {kind:'new', name, age, gender:p.gender, berth:p.berth || 'No preference'};
  });
  if (new Set(passengers.map(p=>p.name.toLowerCase())).size !== passengers.length) throw Error('Passenger names must be distinct so selection can be verified.');
  const mobile = String(input.mobile || '').trim();
  if (mobile && !/^[6-9]\d{9}$/.test(mobile)) throw Error('Enter a valid 10-digit Indian mobile number, or use the IRCTC account number.');
  return {from,to,date,classCode:input.classCode,quota:input.quota,trainNumber,maxAmount:Math.round(Number(input.maxAmount)*100)/100,
    allowWaitlist:input.allowWaitlist === true, insurance:input.insurance === true, autoPayment:input.autoPayment === true, mobile, passengers};
}
export function availabilityAllowed(text, allowWaitlist) {
  const value=String(text).toUpperCase();
  if (/NOT AVAILABLE|NOT AVBL|REGRET|CANCELLED|DEPARTED|NOT OPEN|BOOKING CLOSED/.test(value)) return false;
  const available=value.match(/\b(?:AVAILABLE|AVBL)\s*[-:]?\s*(\d+)/);
  if (available && Number(available[1])>0) return true;
  return allowWaitlist && /\b(?:[A-Z]*WL|RAC)\s*\d|\b(?:[A-Z]*WL|RAC)\s*\//.test(value);
}
export function verifyTotal(amount, maxAmount) {
  if (!Number.isFinite(amount) || amount <= 0) throw Error('IRCTC did not show a verifiable total fare.');
  if (Math.round(amount*100) > Math.round(maxAmount*100)) throw Error(`The total ₹${amount.toFixed(2)} exceeds your limit of ₹${maxAmount.toFixed(2)}.`);
}
export function verifyNames(actual, passengers) {
  const norm=s=>s.replace(/^\s*\d+[.)]\s*/, '').trim().replace(/\s+/g,' ').toLowerCase();
  const a=actual.map(norm).sort(), b=passengers.map(p=>norm(p.name)).sort();
  if (JSON.stringify(a)!==JSON.stringify(b)) throw Error('The passengers on IRCTC do not match this booking. Review them in the browser.');
}
export function parseBookingConfirmation(result, intent, summary) {
  if(!result?.recognized||result.origin!=='https://www.irctc.co.in'||/history|train-search|psgninput|reviewBooking|bkgPaymentOptions/.test(result.path||''))return null;
  const text=result.text||'';
  const issued=/ticket\s+(?:has\s+been\s+)?booked\s+successfully|booking\s+(?:is\s+)?successful|successfully\s+booked/i.test(text);
  const pnr=text.match(/\bPNR(?:\s+(?:No\.?|Number))?\s*[:#-]?\s*(\d{10})\b/i)?.[1];
  const [year,month,day]=intent.date.split('-').map(Number), mon=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][month-1];
  const datePattern=new RegExp(`\\b(?:0?${day}[\\s/-]+${mon}[\\s/-]+${year}|0?${day}[-/]0?${month}[-/]${year}|${intent.date})\\b`,'i');
  const lines=text.split('\n').map(s=>s.replace(/^\s*\d+[.)]\s*/,'').trim().replace(/\s+/g,' ').toLowerCase());
  const namesMatch=intent.passengers.every(p=>lines.includes(p.name.trim().replace(/\s+/g,' ').toLowerCase()));
  if(!issued||!pnr||!namesMatch||!datePattern.test(text)||!text.includes(summary.trainNumber)||!text.includes(summary.from.code)||!text.includes(summary.to.code))return null;
  return pnr;
}
