import http from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {validateIntent} from './validation.mjs';
import {JobManager} from './jobs.mjs';
import {prepareBooking,startPayment,checkPayment} from './irctc.mjs';
import {browserStatus,openBrowser,focusBooking} from './browser.mjs';
import {BookingQueue} from './queue.mjs';
import {StationCatalog} from './stations.mjs';

const publicDir=fileURLToPath(new URL('../web/',import.meta.url));
export function createPendingStore(directory) {
  fs.mkdirSync(directory,{recursive:true,mode:0o700});const path=join(directory,'pending-payment.json');
  return {
    read(){try{return JSON.parse(fs.readFileSync(path,'utf8'));}catch(e){if(e.code==='ENOENT')return null;return {unknown:true};}},
    write(value){fs.writeFileSync(path,JSON.stringify(value),{mode:0o600,flag:'wx'});},
    clear(){fs.rmSync(path,{force:true});}
  };
}
export function createApp({manager,port=4317,status=browserStatus,open=openBrowser,queue=new BookingQueue(manager),stations=new StationCatalog()}={}) {
  const token=randomBytes(32).toString('hex');
  const hosts=new Set([`127.0.0.1:${port}`,`localhost:${port}`]);
  const json=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));};
  const credentialsFrom=input=>{
    const credentials=input.credentials||{};
    if(typeof credentials!=='object'||Array.isArray(credentials)||['username','password'].some(k=>credentials[k]!==undefined&&(typeof credentials[k]!=='string'||credentials[k].length>128)))throw Error('Enter valid sign-in details.');
    if(Boolean(credentials.username)!==Boolean(credentials.password))throw Error('Enter both username and password, or sign in through Chromium.');
    return {username:credentials.username,password:credentials.password};
  };
  const queueRequest=input=>({...input,from:stations.resolve(input.from),to:stations.resolve(input.to)});
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if(!hosts.has(req.headers.host)||req.headers['sec-fetch-site']==='cross-site')return json(res,403,{error:'Open Rail desk from its local address.'});
    const url=new URL(req.url,`http://${req.headers.host}`);
    try{
      if(req.method==='GET'){
        if(url.pathname==='/api/state')return json(res,200,{token,...manager.snapshot(),queue:queue.snapshot(),stations:stations.metadata(),browser:await status()});
        if(url.pathname==='/api/stations')return json(res,200,stations.search(url.searchParams.get('q')||''));
        const files={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css']};
        const file=files[url.pathname];if(!file)return json(res,404,{error:'Not found.'});
        res.writeHead(200,{'Content-Type':`${file[1]}; charset=utf-8`});return res.end(await readFile(join(publicDir,file[0])));
      }
      if(req.method!=='POST')return json(res,405,{error:'Method not allowed.'});
      const sent=Buffer.from(req.headers['x-rail-token']||'');
      if(sent.length!==token.length||!timingSafeEqual(sent,Buffer.from(token))||req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`)return json(res,403,{error:'Refresh the local page before continuing.'});
      if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return json(res,415,{error:'JSON is required.'});
      let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>65536)return json(res,413,{error:'Request too large.'});}
      let input;try{input=JSON.parse(body||'{}');}catch{return json(res,400,{error:'Invalid JSON.'});}
      if(!input||typeof input!=='object'||Array.isArray(input))return json(res,400,{error:'Enter valid request details.'});
      if(url.pathname==='/api/stations/refresh')return json(res,200,await stations.refresh());
      if(url.pathname==='/api/queue/add')return json(res,201,{id:queue.add(queueRequest(input))});
      if(url.pathname==='/api/queue/edit'){queue.edit(input.id,queueRequest(input));return json(res,200,{ok:true});}
      if(url.pathname==='/api/queue/remove'){queue.remove(input.id);return json(res,200,{ok:true});}
      if(url.pathname==='/api/queue/start'){queue.start(credentialsFrom(input));return json(res,202,{ok:true});}
      if(url.pathname==='/api/queue/stop'){queue.stop();return json(res,200,{ok:true});}
      if(url.pathname==='/api/browser/open'){
        if(manager.job?.tabId&&!['error','cancelled','failed','complete'].includes(manager.job.status))await focusBooking(manager.job.tabId);else await open();
        return json(res,200,{ok:true});
      }
      if(url.pathname==='/api/jobs'){
        const intent=validateIntent(input);
        const id=manager.start(intent,credentialsFrom(input));return json(res,202,{id});
      }
      if(url.pathname==='/api/jobs/resume'){manager.resume(input.id);return json(res,200,{ok:true});}
      if(url.pathname==='/api/jobs/cancel'){manager.cancel(input.id);return json(res,200,{ok:true});}
      if(url.pathname==='/api/jobs/pay'){
        // Start synchronously to acquire the once-only guard before responding.
        const task=manager.openPayment(input.id);task.catch(()=>{});return json(res,202,{ok:true});
      }
      if(url.pathname==='/api/jobs/check'){await manager.checkResult(input.id);return json(res,200,{ok:true});}
      if(url.pathname==='/api/reconcile'){manager.reconcile(input.outcome);return json(res,200,{ok:true});}
      return json(res,404,{error:'Not found.'});
    }catch(e){return json(res,400,{error:e.message || 'The request could not be completed.'});}
  });
  server.on('close',()=>queue.close());
  return server;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const port=Number(process.env.PORT||4317);
  if(!Number.isInteger(port)||port<1024||port>65535)throw Error('PORT must be between 1024 and 65535.');
  const runtime=resolve('.runtime');await mkdir(runtime,{recursive:true,mode:0o700});
  const manager=new JobManager({prepare:prepareBooking,pay:startPayment,check:checkPayment,pendingStore:createPendingStore(runtime)});
  const server=createApp({manager,port});
  server.listen(port,'127.0.0.1',()=>console.log(`Rail desk is ready at http://127.0.0.1:${port}`));
  server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'Rail desk is already running, or its port is occupied.':'The local server could not start.');process.exitCode=1;});
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{manager.job?.controller.abort();server.close(()=>process.exit());setTimeout(()=>process.exit(),2000).unref();});
}
