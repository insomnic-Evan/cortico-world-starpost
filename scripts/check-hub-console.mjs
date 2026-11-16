// Browser-only UI regression fixture. No credentials or real accounts are used.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const html = `<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module">
import bundle from '/console.js';
const h=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n};
const ui={h,msgline:t=>h('div','msgline',t),rowbar:()=>h('div'),section:(a,b)=>h('div',null,a+' '+b),input:o=>Object.assign(h('input'),o),sheet:({title})=>{const el=h('section'),body=h('div');el.append(h('h3',null,title),body);return{el,body}},button:(text,o={})=>{const n=h('button',null,text);n.onclick=o.onClick;return n}};
let mode='legacy',pending=null;window.calls=[];
async function invoke(method){window.calls.push(method);
 if(method==='hubBegin')pending={shortCode:'TEST1234',verificationUri:'https://ffahub.net/?pair=isolated'};
 if(method==='hubFinish'){mode='hub';pending=null;return{status:'connected',botId:'10001'}};
 if(method==='hubCancel')pending=null;
 if(['hubBegin','hubStatus','hubCancel'].includes(method))return{mode,botId:'10001',pending};
 if(method==='status')return{registered:true,botId:'10001'};
 if(method==='mobileLoginInfo')return{botId:'10001',credential:mode==='hub'?'':'TEST-LEGACY-ONLY',authMode:mode,hubUrl:'https://ffahub.net'};
 if(method==='teenControl'){if(mode==='hub')throw Error('Hub mode must not call owner control');return{enabled:false,pending:[],friends:[],groups:[]}};
 if(method==='overview')return{botId:'10001',profile:{nickname:'隔离 bot'},friendProfiles:[],friends:[],requests:[],groups:[],conversations:[],posts:[],bottles:[],square:[]};
 if(method==='gameList')return[];
 if(method==='gameRules')return{usedToday:0,dailyLimit:5,remainingToday:5};
 throw Error('Unsupported fixture call '+method);
}
bundle.panels.viewer.mount({root:document.querySelector('#root'),ui,invoke,signal:new AbortController().signal,memo:{get:(k,d)=>d,set:()=>{}},interval:()=>{}});
window.clickText=text=>[...document.querySelectorAll('button')].find(n=>n.textContent===text).click();
</script>`;
const server = createServer((req,res) => { res.setHeader('Content-Type', req.url === '/console.js' ? 'text/javascript' : 'text/html; charset=utf-8');res.end(req.url === '/console.js' ? readFileSync(new URL('../dist/console.js',import.meta.url)) : html); });
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const dir=mkdtempSync(join(tmpdir(),'starpost-hub-browser-'));
const browser=spawn(process.env.STARPOST_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new','--disable-gpu','--no-first-run','--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+dir,'about:blank'], {windowsHide:true,stdio:'ignore'});
const delay=ms=>new Promise(r=>setTimeout(r,ms));let ws;
try {
  const portFile=join(dir,'DevToolsActivePort');for(let n=0;n<100&&!existsSync(portFile);n++)await delay(100);
  const port=readFileSync(portFile,'utf8').split('\n')[0];
  const target=await(await fetch('http://127.0.0.1:'+port+'/json/new?about:blank',{method:'PUT'})).json();
  ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
  let seq=0;const pending=new Map(),errors=[];
  ws.onmessage=e=>{const data=JSON.parse(e.data);if(data.id){const p=pending.get(data.id);pending.delete(data.id);data.error?p.reject(Error(data.error.message)):p.resolve(data.result)}else if(data.method==='Runtime.exceptionThrown')errors.push(data.params.exceptionDetails.text)};
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
  const js=async expression=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value};
  const until=async expression=>{for(let n=0;n<100;n++){if(await js(expression))return;await delay(100)}throw Error('UI timeout: '+expression)};
  await cdp('Runtime.enable');await cdp('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});
  await until("document.body.textContent.includes('聊天与动态只读')");
  await js("document.querySelector('details').open=true;clickText('开始 / 重新授权')");
  await until("document.body.textContent.includes('TEST1234')");
  assert.equal(await js("[...document.links].find(n=>n.textContent.includes('TEST1234')).href"),'https://ffahub.net/?pair=isolated');
  await js("clickText('已确认，完成登录')");
  await until("document.body.textContent.includes('Hub 登录成功') && document.body.textContent.includes('FFA hub 已登录') && document.body.textContent.includes('聊天与动态只读')");
  assert.equal(await js("document.querySelector('#root').textContent.includes('TEST-LEGACY-ONLY')"),false);
  assert.equal(await js("calls.filter(x=>x==='teenControl').length"),1);
  assert.equal(await js("calls.filter(x=>x==='overview').length"),2);
  assert.deepEqual(errors,[]);
  console.log('PASS: Cortico console pairing link, completion, credential display and post-login chat view');
} finally {
  ws?.close();browser.kill();server.closeAllConnections();await new Promise(r=>server.close(r));
  // Delete only the exact temporary browser profile created by this fixture.
  if(resolve(dir).startsWith(resolve(tmpdir())+ '\\') || resolve(dir).startsWith(resolve(tmpdir())+'/')) {
    for(let n=0;n<30;n++){try{rmSync(dir,{recursive:true,force:true});break}catch{await delay(100)}}
  }
}
