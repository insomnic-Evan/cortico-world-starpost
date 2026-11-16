import { ownerProject } from './owner-origin.mjs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { jwtVerify, createLocalJWKSet } from 'jose';
const random = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const pkce = value => createHash('sha256').update(value).digest('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export class HubSso {
  constructor(config, { store, bridge, clock = Date.now }) { Object.assign(this, { config, store, bridge, clock }); this.keys = createLocalJWKSet(config.jwks); }
  client(project = 'starpost') {
    ownerProject(project);
    const client = project === 'starpost' ? this.config : this.config.projectClients?.[project];
    if (!client?.clientId || !client?.clientSecret) fail('该项目的 Hub 登录尚未配置', 503);
    return client;
  }
  post(path, data, project = 'starpost') {
    const client = this.client(project);
    return new Promise((resolve, reject) => { const body = new URLSearchParams(data).toString(); const req = http.request(this.config.internalBase + path, { method: 'POST', headers: { Host: this.config.host, 'X-Forwarded-Proto': this.config.development ? 'http' : 'https', 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), Authorization: 'Basic ' + Buffer.from(client.clientId + ':' + client.clientSecret).toString('base64') } }, res => { let raw = ''; res.on('data', p => { raw += p; if (raw.length > 256000) req.destroy(Error('Response too large')); }); res.on('error', reject); res.on('end', () => { try { const out = JSON.parse(raw); if (res.statusCode !== 200) reject(Error('FFA 授权兑换失败')); else resolve(out); } catch { reject(Error('授权响应无效')); } }); }); req.setTimeout(5000, () => req.destroy(Error('授权请求超时'))); req.on('error', reject); req.end(body); });
  }
  page(res, title, content, headers = {}) {
    const nonce = random();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`, ...headers });
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · 星邮</title><style nonce="${nonce}">:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;background:light-dark(#f5f4fc,#17151e);color:light-dark(#262236,#e9e5f5);padding:8vh 20px}main{max-width:560px;margin:auto;background:light-dark(white,#24212e);border-radius:28px;padding:30px}h1{font-size:28px}p{line-height:1.8}button,a{display:block;box-sizing:border-box;width:100%;padding:16px;margin:12px 0;border:0;border-radius:18px;background:light-dark(#e5ddff,#463a64);color:inherit;text-decoration:none;font:inherit;text-align:left}small{display:block;opacity:.7;margin:6px 0;overflow-wrap:anywhere}</style><main><small>STARPOST / FFA HUB</small><h1>${escape(title)}</h1>${content}</main></html>`);
  }
  nativeFlow(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(id)) fail('手机登录请求无效');
    const flow = this.store.get('hubMobileFlows', hash(id));
    if (!flow || flow.expiresAt <= this.clock()) fail('手机登录已过期，请回到 APP 重新发起', 410);
    return flow;
  }
  async mobile(action, input, remote) {
    this.bridge.accounts.throttle.take([[`hub-mobile:${action}:${remote}`, action === 'start' ? 10 : 60, 60000]]);
    if (action === 'start') {
      if (typeof input.challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.challenge)) fail('手机登录校验参数无效');
      const sourceProject = ownerProject(input.project).id;
      if (sourceProject !== 'starpost') this.client(sourceProject);
      const id = random(), expiresAt = this.clock() + 600000;
      this.store.transaction(() => {
        this.store.statement("DELETE FROM documents WHERE collection='hubMobileFlows' AND at<?").run(new Date(this.clock()).toISOString());
        this.store.put('hubMobileFlows', hash(id), { status: 'pending', sourceProject, challenge: input.challenge, expiresAt, at: new Date(expiresAt).toISOString() });
      });
      return { flowId: id, authorizationUrl: this.config.publicOrigin + '/web/hub/start?mobile=' + id, expiresAt, interval: 3 };
    }
    const flow = this.nativeFlow(input.flowId);
    if (typeof input.verifier !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(input.verifier) || !equal(pkce(input.verifier), flow.challenge)) fail('手机登录验证失败', 403);
    if (flow.status === 'pending') return { status: 'pending' };
    if (flow.status !== 'ready') fail('手机登录已处理，请重新发起', 409);
    this.store.transaction(() => this.store.put('hubMobileFlows', hash(input.flowId), { ...flow, status: 'redeeming' }));
    try {
      const result = await this.bridge.signInIdentity({ subject: flow.subject, externalId: flow.externalId, sourceProject: flow.sourceProject, sourceProjectEpoch: flow.sourceProjectEpoch });
      this.store.transaction(() => this.store.remove('hubMobileFlows', hash(input.flowId)));
      return { ...result, status: 'complete' };
    } catch (e) { this.store.transaction(() => this.store.put('hubMobileFlows', hash(input.flowId), { ...flow, status: 'ready' })); throw e; }
  }
  async finish(flow, externalId, res, cookie) {
    if (flow.mobile) {
      const mobile = this.nativeFlow(flow.mobile);
      if (mobile.status !== 'pending') fail('该手机登录请求已处理，请重新发起', 409);
      const allowed = await this.bridge.request('/v1/links', { subject: flow.subject });
      if (externalId && !allowed.links.some(l => l.kind === 'human' && l.external_id === externalId)) fail('此星邮业务号不属于当前 Hub 账号', 403);
      this.store.transaction(() => {
        const current = this.nativeFlow(flow.mobile);
        if (current.status !== 'pending') fail('该手机登录请求已处理，请重新发起', 409);
        this.store.put('hubMobileFlows', hash(flow.mobile), { ...current, status: 'ready', subject: flow.subject, externalId, sourceProjectEpoch: flow.sourceProjectEpoch });
      });
      if (mobile.sourceProject === 'coodock') return this.page(res, 'CooDock 授权完成', '<p>已授权 CooDock 使用星邮的专属 bot 频道。请切回 CooDock，点击“完成登录”。消息、附件及历史由星邮服务器保存，发信来源将标记为 CooDock。</p>', { 'Set-Cookie': cookie('', 0) });
      return this.page(res, '授权完成', '<p>已确认你的 FFA hub 身份。请返回星邮 APP 完成登录，原星邮 ID 和记录会继续保留。</p><a href="io.starpost.mobile://hub/return?flow=' + escape(flow.mobile) + '">返回星邮 APP</a><small>如按钮未唤起 APP，请手动切回星邮，点击“完成登录”。</small>', { 'Set-Cookie': cookie('', 0) });
    }
    const result = await this.bridge.signInIdentity({ subject: flow.subject, externalId });
    res.writeHead(303, { Location: '/app/social', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Set-Cookie': [`starpost_session=${result.accessToken}; Path=/web; HttpOnly; SameSite=Strict; ${this.config.development ? '' : 'Secure; '}Max-Age=${14 * 86400}`, cookie('', 0)] }); res.end();
  }
  async handle(req, res) {
    const c = this.config, u = new URL(req.url, c.publicOrigin), cookieName = c.development ? 'starpost_hub_flow' : '__Secure-starpost_hub_flow', cookie = (value, age) => `${cookieName}=${value}; Path=/web/hub; HttpOnly; SameSite=Lax; ${c.development ? '' : 'Secure; '}Max-Age=${age}`;
    if (u.pathname === '/web/hub/start') {
      if (!c.development && req.headers.host !== new URL(c.publicOrigin).host) {
        res.writeHead(303, { Location: c.publicOrigin + u.pathname + u.search, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.end(); return;
      }
      const mobile = u.searchParams.get('mobile'); if (mobile && this.nativeFlow(mobile).status !== 'pending') fail('请在 APP 重新发起登录', 409);
      const sourceProject = mobile ? this.nativeFlow(mobile).sourceProject ?? 'starpost' : 'starpost';
      const client = this.client(sourceProject);
      const state = random(), nonce = random(), verifier = random(), browser = random();
      this.store.transaction(() => { this.store.statement("DELETE FROM documents WHERE collection IN ('hubSsoFlows','hubSsoChoices') AND at<?").run(new Date(this.clock()).toISOString()); this.store.put('hubSsoFlows', hash(state), { browser: hash(browser), nonce, verifier, mobile, sourceProject, externalId: u.searchParams.get('account'), expiresAt: this.clock() + 600000, at: new Date(this.clock() + 600000).toISOString() }); });
      const auth = new URL(c.issuer + '/auth'); auth.search = new URLSearchParams({ client_id: client.clientId, response_type: 'code', redirect_uri: c.publicOrigin + '/web/hub/callback', scope: 'openid profile email', state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'login consent' }).toString();
      res.writeHead(303, { Location: auth.href, 'Set-Cookie': cookie(browser, 600), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.end(); return;
    }
    const browser = (req.headers.cookie ?? '').split(';').map(x => x.trim()).find(x => x.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    if (u.pathname === '/web/hub/select') {
      if (req.method !== 'POST' || req.headers.origin !== new URL(c.publicOrigin).origin || !req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) fail('账号选择请求来源无效', 403);
      let raw = ''; for await (const part of req) { raw += part.toString(); if (raw.length > 4096) fail('请求过大', 413); }
      const input = new URLSearchParams(raw), choice = browser && this.store.get('hubSsoChoices', hash(browser));
      if (!choice || choice.expiresAt <= this.clock() || !equal(input.get('csrf'), choice.csrf)) fail('账号选择已失效，请重新登录', 403);
      const externalId = input.get('account'); if (!choice.accounts.includes(externalId)) fail('请选择当前 Hub 账号关联的星邮业务号', 403);
      this.store.transaction(() => this.store.remove('hubSsoChoices', hash(browser)));
      return this.finish(choice, externalId, res, cookie);
    }
    const state = u.searchParams.get('state'), flow = state && this.store.get('hubSsoFlows', hash(state));
    if (!flow || flow.expiresAt <= this.clock() || !browser || hash(browser) !== flow.browser) fail('联合登录已失效，请重新从星邮登录');
    this.store.transaction(() => this.store.remove('hubSsoFlows', hash(state)));
    if (u.searchParams.has('error')) fail('已取消 FFA hub 授权');
    const tokens = await this.post('/token', { grant_type: 'authorization_code', code: u.searchParams.get('code') ?? '', redirect_uri: c.publicOrigin + '/web/hub/callback', code_verifier: flow.verifier }, flow.sourceProject);
    const { payload } = await jwtVerify(tokens.id_token, this.keys, { issuer: c.issuer, audience: this.client(flow.sourceProject).clientId, algorithms: ['RS256'] }); if (payload.nonce !== flow.nonce) fail('授权随机数不一致', 403);
    const active = await this.post('/token/introspection', { token: tokens.access_token }, flow.sourceProject); if (!active.active || active.sub !== payload.sub) fail('FFA 身份授权已撤销', 403);
    const projectState = flow.sourceProject === 'coodock' ? await this.bridge.request('/v1/starpost/project-link', { subject: payload.sub, project: flow.sourceProject, token: tokens.access_token }) : null;
    flow.sourceProjectEpoch = projectState?.epoch;
    const associations = await this.bridge.request('/v1/links', { subject: payload.sub });
    const accounts = associations.links.filter(l => l.kind === 'human').map(l => l.external_id);
    const project = ownerProject(flow.mobile ? this.nativeFlow(flow.mobile).sourceProject : undefined);
    if ((!flow.externalId && accounts.length > 1) || project.id === 'coodock') {
      if (flow.externalId && !accounts.includes(flow.externalId)) fail('账号不属于当前 Hub 身份', 403);
      const choices = flow.externalId ? [flow.externalId] : accounts.length ? accounts : [''];
      const choice = { subject: payload.sub, mobile: flow.mobile, sourceProjectEpoch: flow.sourceProjectEpoch, accounts: choices, csrf: random(), expiresAt: this.clock() + 300000, at: new Date(this.clock() + 300000).toISOString() };
      this.store.transaction(() => this.store.put('hubSsoChoices', hash(browser), choice));
      return this.page(res, project.id === 'coodock' ? '授权 CooDock 使用星邮频道' : '选择星邮账号', '<p>选择本次登录使用的星邮账号。聊天、附件与记录保存在星邮；消息来源标记为 ' + escape(project.name) + '。不同业务账号的内容分别保存。</p><form method="post" action="/web/hub/select"><input type="hidden" name="csrf" value="' + choice.csrf + '">' + choices.map(id => '<button name="account" value="' + escape(id) + '">' + escape(this.store.get('people', id)?.nickname || (id ? '星邮账号' : '建立星邮业务账号并授权')) + '<small>' + escape(id) + '</small></button>').join('') + '</form>');
    }
    return this.finish({ ...flow, subject: payload.sub }, flow.externalId || accounts[0], res, cookie);
  }
}
