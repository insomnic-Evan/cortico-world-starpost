import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HubAuth } from '../src/hub-auth.ts';
import { officialTransport, starpostIdentityOrigin, hubIdentityOrigin } from '../src/transport.ts';

test('only exact official HTTPS origins use IP, retaining custom server boundaries', () => {
  assert.equal(officialTransport('https://starpost.com.cn/rpc').href,'https://8.148.13.225/rpc');
  assert.equal(officialTransport('https://ffahub.net/v1/introspect').href,'https://8.148.13.225:8443/v1/introspect');
  for(const value of ['https://other.example/rpc','https://starpost.com.cn:9443/rpc','https://starpost.com.cn.evil.example/rpc','http://127.0.0.1:1234/rpc']) assert.equal(officialTransport(value).href,value);
  assert.equal(starpostIdentityOrigin('https://8.148.13.225'),'https://starpost.com.cn');
  assert.equal(hubIdentityOrigin('https://8.148.13.225:8443'),'https://ffahub.net');
});

test('old official Hub login survives IP switch without rewriting its token or issuer', async t => {
  const dir=mkdtempSync(join(tmpdir(),'starpost-ip-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const saved={version:1,server:'https://starpost.com.cn',issuer:'https://ffahub.net',botId:'10001',subject:'ffa_test',installationId:'test-install',deviceId:'test-device',accessToken:'a'.repeat(40),expiresAt:Date.now()+60000};
  const file=join(dir,'starpost-hub-session.json'),raw=JSON.stringify(saved);writeFileSync(file,raw);
  const hub=new HubAuth(dir,()=> 'https://8.148.13.225',()=> 'https://8.148.13.225:8443',async url=>{
    assert.equal(url.href,'https://8.148.13.225/hub/session');
    return {status:200,body:{ok:true,result:{subject:saved.subject,issuer:saved.issuer,botId:saved.botId,isPrimary:true,routeEpoch:2}}};
  });
  assert.equal(hub.session()?.issuer,'https://ffahub.net');
  assert.equal((await hub.headers()).authorization,'Bearer '+saved.accessToken);
  assert.equal(readFileSync(file,'utf8'),raw);
  const other=new HubAuth(dir,()=> 'https://other.example',()=> 'https://8.148.13.225:8443',async()=>{throw Error('must not call')});
  assert.throws(()=>other.session(),/其他服务地址/);
});
