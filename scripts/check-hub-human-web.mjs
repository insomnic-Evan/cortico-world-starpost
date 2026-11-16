import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
const root=resolve('.deployment/hub-human-preview');mkdirSync(root,{recursive:true});
const dir=mkdtempSync(join(root,'browser-'));
const proxy=createServer((req,res)=>{
  if(req.url==='/web/login-info'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,result:{hubOnly:true,issuer:'https://ffahub.net'}}));return}
  if(req.method!=='GET'){res.writeHead(401,{'content-type':'application/json'});res.end('{"ok":false,"error":"请登录"}');return}
  const path=new URL(req.url,'http://localhost').pathname,file=/^\/[\w.-]+\.(js|css|json|svg)$/.test(path)?path.slice(1):'index.html',full=resolve('web',file);
  if(!existsSync(full)){res.writeHead(404);res.end();return}
  res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html');res.end(readFileSync(full));
});await new Promise(r=>proxy.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${proxy.address().port}`;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const browser=spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${dir}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
let ws;
try{
  const portFile=join(dir,'DevToolsActivePort');for(let i=0;i<100&&!existsSync(portFile);i++)await delay(200);
  const port=readFileSync(portFile,'utf8').split('\n')[0],target=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json();
  ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});let seq=0;const pending=new Map(),errors=[];
  const cdp=(method,params={})=>new Promise((r,j)=>{const id=++seq;pending.set(id,{r,j});ws.send(JSON.stringify({id,method,params}))});
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.j(Error(JSON.stringify(m.error))):p.r(m.result)}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails)};
  const js=async expression=>{const r=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value};
  await cdp('Runtime.enable');await cdp('Page.enable');
  for(const [width,height,theme]of [[1280,900,'light'],[390,844,'dark']]){
    await cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<500});
    await cdp('Page.navigate',{url:base+'/login'});
    for(let i=0;i<80;i++){if(await js('!!document.querySelector(".login-panel a")'))break;await delay(100)}
    assert.equal(await js('document.querySelector(".login-panel a").textContent'),'使用 FFA hub 登录 / 注册 →');
    assert.equal(await js('document.querySelectorAll(".login-panel input").length'),0);
    await js(`starpostAppearance.set(${JSON.stringify(theme)})`);await delay(100);
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth+1'),true,'no horizontal overflow');
    writeFileSync(join(root,`login-${width}-${theme}.png`),Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  }
  await js('renderEmailLogin("legacy")');assert.equal(await js('document.querySelector(".login-panel input[type=password]")!==null'),true);
  await js('renderEmailLogin()');
  const isolation=await js(`(async()=>{
    state.account={humanId:'10001H',hubSubject:'ffa_a',hubIssuer:'https://ffahub.net'};
    const a=accountContentScope();await starpostBackground.setScope(a);starpostBackground.setMask(.8);
    const db=await stickerDb();await new Promise(r=>{const t=db.transaction('images','readwrite');t.objectStore('images').put({hash:'test',mime:'image/png',base64:'AA=='});t.oncomplete=r});db.close();
    async function count(){const db=await stickerDb();const n=await new Promise(r=>{const q=db.transaction('images').objectStore('images').count();q.onsuccess=()=>r(q.result)});db.close();return n}
    state.account={...state.account,humanId:'10002H'};await starpostBackground.setScope(accountContentScope());const b=[await count(),starpostBackground.mask];
    state.account={...state.account,humanId:'10001H',hubSubject:'ffa_b'};await starpostBackground.setScope(accountContentScope());const c=await count();
    state.account={...state.account,hubSubject:'ffa_a'};await starpostBackground.setScope(accountContentScope());return {b,c,a:[await count(),starpostBackground.mask]};
  })()`);
  assert.deepEqual(isolation,{b:[0,.6],c:0,a:[1,.8]});assert.equal(errors.length,0,JSON.stringify(errors));
  console.log('PASS Hub login desktop/mobile themes, legacy upgrade entry and per-subject/business local storage isolation');
}finally{ws?.close();browser.kill();await new Promise(r=>proxy.close(r))}
