import test from 'node:test';
import assert from 'node:assert/strict';
import {HubSso} from '../server/hub-sso.mjs';
import {createHash} from 'node:crypto';
function setup(){
 const rows=new Map(),store={get:(c,k)=>rows.get(c+':'+k),put:(c,k,v)=>rows.set(c+':'+k,v),remove:(c,k)=>rows.delete(c+':'+k),transaction:fn=>fn(),statement:()=>({run(){}})};
 let now=1000;
 const bridge={accounts:{throttle:{take(){}}},request:async()=>({links:[{kind:'human',external_id:'10001H'}]}),signInIdentity:async()=>({humanId:'10001H',accessToken:'isolated-token'})};
 const sso=new HubSso({jwks:{keys:[]},publicOrigin:'https://starpost.com.cn',issuer:'https://ffahub.net'},{store,bridge,clock:()=>now});
 const response=()=>({writeHead(status,headers){this.status=status;this.headers=headers},end(body){this.body=body}});
 return{sso,store,bridge,response,advance:()=>{now+=600001}};
}
test('Hub browser login canonicalizes alternate host before issuing browser state',async()=>{
 const f=setup(),res=f.response();await f.sso.handle({url:'/web/hub/start?account=10001H',headers:{host:'8.148.13.225'}},res);
 assert.equal(res.status,303);assert.equal(res.headers.Location,'https://starpost.com.cn/web/hub/start?account=10001H');assert.equal(res.headers['Set-Cookie'],undefined);
});
test('Native authorization expires and only one concurrent browser approval wins',async()=>{
 const f=setup(),verifier='a'.repeat(43),challenge=createHash('sha256').update(verifier).digest('base64url');
 const flow=await f.sso.mobile('start',{challenge},'test');
 const finished=await Promise.allSettled(['ffa_a','ffa_b'].map(subject=>f.sso.finish({mobile:flow.flowId,subject},'10001H',f.response(),()=>'')));
 assert.equal(finished.filter(x=>x.status==='fulfilled').length,1);assert.equal(finished.find(x=>x.status==='rejected').reason.status,409);
 const polled=await f.sso.mobile('poll',{flowId:flow.flowId,verifier},'test');assert.equal(polled.status,'complete');
 await assert.rejects(()=>f.sso.mobile('poll',{flowId:flow.flowId,verifier},'test'),e=>e.status===410);
 const expired=await f.sso.mobile('start',{challenge},'test');f.advance();await assert.rejects(()=>f.sso.mobile('poll',{flowId:expired.flowId,verifier},'test'),e=>e.status===410);
});
