import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {localDebugUrl,isOfficial} from '../scripts/lib/cdp.mjs';

export const DEBUG=localDebugUrl(process.env.IRCTC_DEBUG_URL);
export async function targets() {
  const r=await fetch(`${DEBUG}/json/list`,{signal:AbortSignal.timeout(2000)});
  if(!r.ok)throw Error('Chromium is unavailable.');
  return (await r.json()).filter(t=>t.type==='page');
}
export async function browserStatus() {
  try {const tabs=await targets();return {connected:true,irctcTabs:tabs.filter(t=>isOfficial(t.url)&&t.url.includes('/eticket/')).length};}
  catch{return {connected:false,irctcTabs:0};}
}
export async function focusBooking(tabId) {
  const tab=(await targets()).find(t=>t.id===tabId);
  const allowed=new Set(['https://www.irctc.co.in','https://www.wps.irctc.co.in','https://secure.paytmpayments.com']);
  if(!tab||!allowed.has(new URL(tab.url).origin))throw Error('The booking tab is closed or has left IRCTC/payment. Check IRCTC before retrying the booking.');
  await fetch(`${DEBUG}/json/activate/${tab.id}`);
}
export async function openBrowser() {
  try {await targets();} catch {
    if(new URL(DEBUG).port!=='9222')throw Error('Start Chromium with the configured local debug port.');
    const profile=resolve('.runtime/chromium');await mkdir(profile,{recursive:true,mode:0o700});
    const child=spawn(process.env.IRCTC_CHROMIUM || '/usr/bin/chromium',[
      `--user-data-dir=${profile}`,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=9222',
      '--no-first-run','--no-default-browser-check','https://www.irctc.co.in/eticket/train-search'
    ],{detached:true,stdio:'ignore'});
    let launchError;child.on('error',()=>{launchError=true});child.unref();
    for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,300));if(launchError)throw Error('Chromium could not start. Set IRCTC_CHROMIUM to its executable path.');if((await browserStatus()).connected)break;}
  }
  const tabs=await targets();
  const matches=tabs.filter(t=>isOfficial(t.url)&&t.url.includes('/eticket/'));
  if(matches.length>1)throw Error('Keep one IRCTC booking tab open in the controlled Chromium window.');
  if(matches.length){await fetch(`${DEBUG}/json/activate/${matches[0].id}`);return {connected:true};}
  await fetch(`${DEBUG}/json/new?${encodeURIComponent('https://www.irctc.co.in/eticket/train-search')}`,{method:'PUT'});
  return {connected:true};
}
