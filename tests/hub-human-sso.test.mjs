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

test('iOS native flow requires original PKCE verifier and rejects another business account before redemption',async()=>{
 const f=setup(),verifier='b'.repeat(43),challenge=createHash('sha256').update(verifier).digest('base64url');
 const flow=await f.sso.mobile('start',{challenge},'isolated-ios-test');
 assert.equal(flow.authorizationUrl,'https://starpost.com.cn/web/hub/start?mobile='+flow.flowId);
 assert.deepEqual(await f.sso.mobile('poll',{flowId:flow.flowId,verifier},'isolated-ios-test'),{status:'pending'});
 await assert.rejects(()=>f.sso.mobile('poll',{flowId:flow.flowId,verifier:'c'.repeat(43)},'isolated-ios-test'),e=>e.status===403);
 await assert.rejects(()=>f.sso.finish({mobile:flow.flowId,subject:'ffa_test'},'10002H',f.response(),()=>''),e=>e.status===403);
 const res=f.response();await f.sso.finish({mobile:flow.flowId,subject:'ffa_test'},'10001H',res,()=> '');
 assert.ok(res.body.includes('io.starpost.mobile://hub/return?flow='+flow.flowId));
 assert.equal(res.body.includes('isolated-token'),false,'callback page must not expose the access token');
 await assert.rejects(()=>f.sso.mobile('poll',{flowId:flow.flowId,verifier:'c'.repeat(43)},'isolated-ios-test'),e=>e.status===403);
 const login=await f.sso.mobile('poll',{flowId:flow.flowId,verifier},'isolated-ios-test');
 assert.equal(login.humanId,'10001H');assert.equal(login.status,'complete');
 await assert.rejects(()=>f.sso.mobile('poll',{flowId:flow.flowId,verifier},'isolated-ios-test'),e=>e.status===410);
});
