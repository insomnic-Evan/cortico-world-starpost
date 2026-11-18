import test from 'node:test';
import assert from 'node:assert/strict';
import {HubSso} from '../server/hub-sso.mjs';
import {createHash} from 'node:crypto';
function setup(){
 const rows=new Map(),store={get:(c,k)=>rows.get(c+':'+k),put:(c,k,v)=>rows.set(c+':'+k,v),remove:(c,k)=>rows.delete(c+':'+k),transaction:fn=>fn(),statement:()=>({run(){}})};
 let now=1000;
 const bridge={accounts:{throttle:{take(){}}},request:async()=>({links:[{kind:'human',external_id:'10001H'}]}),signInIdentity:async()=>({humanId:'10001H',accessToken:'isolated-token'})};
 const sso=new HubSso({jwks:{keys:[]},clientId:'starpost-web',clientSecret:'isolated-client-secret',projectClients:{coodock:{clientId:'coodock-starpost',clientSecret:'isolated-coodock-secret'}},publicOrigin:'https://starpost.com.cn',issuer:'https://ffahub.net'},{store,bridge,clock:()=>now});
 const response=()=>({writeHead(status,headers){this.status=status;this.headers=headers},end(body){this.body=body}});
 return{sso,store,bridge,response,advance:()=>{now+=600001}};
}
test('Hub browser login canonicalizes alternate host before issuing browser state',async()=>{
 const f=setup(),res=f.response();await f.sso.handle({url:'/web/hub/start?account=10001H',headers:{host:'8.148.13.225'}},res);
 assert.equal(res.status,303);assert.equal(res.headers.Location,'https://starpost.com.cn/web/hub/start?account=10001H');assert.equal(res.headers['Set-Cookie'],undefined);
});

test('temporary IP authorization endpoint does not change the identity issuer or return through a domain',async()=>{
 const f=setup();
 f.sso.config.publicOrigin='https://8.148.13.225';
 f.sso.config.authorizationOrigin='https://8.148.13.225:8443';
 const res=f.response();await f.sso.handle({url:'/web/hub/start',headers:{host:'8.148.13.225'}},res);
 const target=new URL(res.headers.Location);
 assert.equal(target.origin,'https://8.148.13.225:8443');
 assert.equal(target.searchParams.get('redirect_uri'),'https://8.148.13.225/web/hub/callback');
 assert.equal(f.sso.config.issuer,'https://ffahub.net');
 assert.ok(target.searchParams.get('state'));assert.ok(target.searchParams.get('nonce'));
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


test('CooDock project is consented and pinned to the PKCE flow, never supplied at send/poll',async()=>{
 const f=setup(),verifier='c'.repeat(43),challenge=createHash('sha256').update(verifier).digest('base64url');
 await assert.rejects(()=>f.sso.mobile('start',{challenge,project:'other'},'test'),e=>e.status===400);
 const flow=await f.sso.mobile('start',{challenge,project:'coodock'},'test');
 let identity;f.bridge.signInIdentity=async input=>{identity=input;return{humanId:'10001H'}};
 const res=f.response();await f.sso.finish({mobile:flow.flowId,subject:'ffa_verified'},'10001H',res,()=> '');
 assert.match(res.body,/CooDock/);assert.doesNotMatch(res.body,/io.starpost.mobile:/);
 await assert.rejects(()=>f.sso.mobile('poll',{flowId:flow.flowId,verifier:'x'.repeat(43)},'test'),e=>e.status===403);
 await f.sso.mobile('poll',{flowId:flow.flowId,verifier,project:'starpost',subject:'ffa_forged'},'test');
 assert.equal(identity.subject,'ffa_verified');assert.equal(identity.sourceProject,'coodock');
});

test('Agent prefix uses verified Hub subject and excludes email and optional blank address',async()=>{
 const {ownerIdentity,ownerPrefix}=await import('../server/owner-origin.mjs');
 const identity=ownerIdentity({sourceProject:'coodock',hubSubject:'ffa_stale'},{subject:'ffa_verified'},'https://ffahub.net');
 const text=ownerPrefix(identity,'','10001H');assert.match(text,/ffa_verified/);assert.match(text,/CooDock/);assert.doesNotMatch(text,/ffa_stale|用户填写的称呼/);
});
