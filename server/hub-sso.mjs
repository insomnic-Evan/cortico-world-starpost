import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { jwtVerify, createLocalJWKSet } from 'jose';
const random = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export class HubSso {
  constructor(config, { store, bridge, clock = Date.now }) { Object.assign(this, { config, store, bridge, clock }); this.keys = createLocalJWKSet(config.jwks); }
  post(path, data) {
    return new Promise((resolve, reject) => { const body = new URLSearchParams(data).toString(); const req = http.request(this.config.internalBase + path, { method: 'POST', headers: { Host: this.config.host, 'X-Forwarded-Proto': this.config.development ? 'http' : 'https', 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), Authorization: 'Basic ' + Buffer.from(this.config.clientId + ':' + this.config.clientSecret).toString('base64') } }, res => { let raw = ''; res.on('data', p => { raw += p; if (raw.length > 256000) req.destroy(Error('Response too large')); }); res.on('error', reject); res.on('end', () => { try { const out = JSON.parse(raw); if (res.statusCode !== 200) reject(Error('FFA 授权兑换失败')); else resolve(out); } catch { reject(Error('授权响应无效')); } }); }); req.setTimeout(5000, () => req.destroy(Error('授权请求超时'))); req.on('error', reject); req.end(body); });
  }
  async handle(req, res) {
    const c = this.config, u = new URL(req.url, c.publicOrigin), cookieName = c.development ? 'starpost_hub_flow' : '__Secure-starpost_hub_flow', cookie = (value, age) => `${cookieName}=${value}; Path=/web/hub; HttpOnly; SameSite=Lax; ${c.development ? '' : 'Secure; '}Max-Age=${age}`;
    if (u.pathname === '/web/hub/start') {
      const state = random(), nonce = random(), verifier = random(), browser = random();
      this.store.transaction(() => { this.store.statement("DELETE FROM documents WHERE collection='hubSsoFlows' AND at<?").run(new Date(this.clock()).toISOString()); this.store.put('hubSsoFlows', hash(state), { browser: hash(browser), nonce, verifier, externalId: u.searchParams.get('account'), expiresAt: this.clock() + 600000, at: new Date(this.clock() + 600000).toISOString() }); });
      const auth = new URL(c.issuer + '/auth'); auth.search = new URLSearchParams({ client_id: c.clientId, response_type: 'code', redirect_uri: c.publicOrigin + '/web/hub/callback', scope: 'openid profile email', state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'login consent' }).toString();
      res.writeHead(303, { Location: auth.href, 'Set-Cookie': cookie(browser, 600), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.end(); return;
    }
    const state = u.searchParams.get('state'), flow = state && this.store.get('hubSsoFlows', hash(state)), browser = (req.headers.cookie ?? '').split(';').map(x => x.trim()).find(x => x.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    if (!flow || flow.expiresAt <= this.clock() || !browser || hash(browser) !== flow.browser) fail('联合登录已失效，请重新从星邮登录');
    this.store.transaction(() => this.store.remove('hubSsoFlows', hash(state)));
    if (u.searchParams.has('error')) fail('已取消 FFA hub 授权');
    const tokens = await this.post('/token', { grant_type: 'authorization_code', code: u.searchParams.get('code') ?? '', redirect_uri: c.publicOrigin + '/web/hub/callback', code_verifier: flow.verifier });
    const { payload } = await jwtVerify(tokens.id_token, this.keys, { issuer: c.issuer, audience: c.clientId, algorithms: ['RS256'] }); if (payload.nonce !== flow.nonce) fail('授权随机数不一致', 403);
    const active = await this.post('/token/introspection', { token: tokens.access_token }); if (!active.active || active.sub !== payload.sub) fail('FFA 身份授权已撤销', 403);
    const associations = await this.bridge.request('/v1/links', { subject: payload.sub });
    if (!flow.externalId && associations.links.filter(l => l.kind === 'human').length > 1) { res.writeHead(303, { Location: c.issuer + '/?service=starpost', 'Cache-Control': 'no-store', 'Set-Cookie': cookie('', 0) }); res.end(); return; }
    const result = await this.bridge.signInIdentity({ subject: payload.sub, externalId: flow.externalId });
    res.writeHead(303, { Location: '/app/social', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Set-Cookie': [`starpost_session=${result.accessToken}; Path=/web; HttpOnly; SameSite=Strict; ${c.development ? '' : 'Secure; '}Max-Age=${14 * 86400}`, cookie('', 0)] }); res.end();
  }
}
