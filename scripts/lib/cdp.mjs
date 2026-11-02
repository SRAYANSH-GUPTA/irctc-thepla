const OFFICIAL = 'https://www.irctc.co.in';
const PAYMENT_ORIGINS = new Set([OFFICIAL, 'https://www.wps.irctc.co.in', 'https://secure.paytmpayments.com']);

export function isOfficial(url) {
  try { return new URL(url).origin === OFFICIAL; } catch { return false; }
}

export function localDebugUrl(value = 'http://127.0.0.1:9222') {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('The Chromium debug endpoint must be local HTTP.');
  }
  return url.origin;
}

export async function connect(debugUrl, tabId, {payment = false} = {}) {
  const base = localDebugUrl(debugUrl);
  const response = await fetch(`${base}/json/list`, {signal: AbortSignal.timeout(5000)});
  if (!response.ok) throw new Error('Chromium target discovery failed.');
  const pages = (await response.json()).filter(p => p.type === 'page');
  const candidates = tabId ? pages.filter(p => p.id === tabId) : pages.filter(p => isOfficial(p.url) && new URL(p.url).pathname.startsWith('/eticket/'));
  if (candidates.length !== 1) throw new Error('Open one IRCTC /eticket/ tab, or select it with --tab. A payment gateway tab is not a booking tab.');
  const target = candidates[0];
  if (!isOfficial(target.url) && !(payment && PAYMENT_ORIGINS.has(new URL(target.url).origin))) throw new Error('The selected tab is not the official IRCTC site.');
  const socketUrl = new URL(target.webSocketDebuggerUrl);
  if (socketUrl.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(socketUrl.hostname)) throw new Error('Unexpected debug WebSocket address.');
  const socket = new WebSocket(socketUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {socket.close(); reject(new Error('Debug connection timed out.'));}, 5000);
    socket.addEventListener('open', () => {clearTimeout(timer); resolve();}, {once:true});
    socket.addEventListener('error', () => {clearTimeout(timer); reject(new Error('Debug connection failed.'));}, {once:true});
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', ({data}) => {
    const message = JSON.parse(data);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    clearTimeout(call.timer);
    message.error ? call.reject(new Error('Browser command failed.')) : call.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const call of pending.values()) {clearTimeout(call.timer); call.reject(new Error('Browser connection closed.'));}
    pending.clear();
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {pending.delete(id); reject(new Error(`Browser command timed out: ${method}`));}, 10000);
      pending.set(id, {resolve, reject, timer});
      socket.send(JSON.stringify({id, method, params}));
    });
  }
  return {
    tabId: target.id,
    async evaluate(fn, arg) {
      // This is JavaScript serialization for CDP, not shell interpolation.
      const expression = `(() => { if(location.origin!==${JSON.stringify(OFFICIAL)}) throw new Error('Unexpected origin'); return (${fn.toString()})(${JSON.stringify(arg ?? null)}); })()`;
      const result = await send('Runtime.evaluate', {expression, returnByValue:true, awaitPromise:true});
      if (result.exceptionDetails) throw new Error('Page action failed or the browser left IRCTC. Inspect the page before continuing.');
      return result.result.value;
    },
    async insertText(text) { await send('Input.insertText', {text}); },
    async bringToFront() { await send('Page.bringToFront'); },
    async location() {
      const r=await send('Runtime.evaluate',{expression:'({origin:location.origin,path:location.pathname})',returnByValue:true});
      return r.result.value;
    },
    async paymentResult() {
      const r=await send('Runtime.evaluate',{expression:`(() => {
        if (!${JSON.stringify([...PAYMENT_ORIGINS])}.includes(location.origin)) return {recognized:false};
        const text=document.body.innerText;
        return {recognized:true,origin:location.origin,path:location.pathname,text:text.slice(0,25000)};
      })()`,returnByValue:true});
      return r.result.value;
    },
    close() {socket.close();},
  };
}

export async function waitFor(check, description, timeoutMs = 60000) {
  const until = Date.now() + timeoutMs;
  while (true) {
    const result = await check();
    if (result) return result;
    if (Date.now() >= until) throw new Error(`Timed out waiting for ${description}. Inspect the page; do not blindly resubmit.`);
    await new Promise(resolve => setTimeout(resolve, 750));
  }
}
