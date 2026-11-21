import { ownerProject } from './owner-origin.mjs';
import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
const fail = (message, status = 403) => { throw Object.assign(new Error(message), { status }); };
const same = (a, b) => { const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? '')); return x.length === y.length && timingSafeEqual(x, y); };
export class HubBridge {
  constructor(config, { store, accounts, access, knownIds, profile, reserveBot, clock = Date.now }) {
    Object.assign(this, { config, store, accounts, access, knownIds, profile, reserveBot, clock });
    this.auth = 'Basic ' + Buffer.from('starpost:' + config.serviceSecret).toString('base64');
    const u = new URL(config.internalBase); if (u.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(u.hostname)) throw Error('Hub bridge requires configured loopback endpoint');
  }
  async request(path, body) {
    let response; try { response = await new Promise((resolve, reject) => { const raw = JSON.stringify(body); const request = http.request(this.config.internalBase + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: this.auth, Host: this.config.host, 'Content-Length': Buffer.byteLength(raw) } }, res => { let data = ''; res.on('data', part => { data += part.toString(); if (Buffer.byteLength(data) > 4 * 1024 * 1024) request.destroy(Error('Large response')); }); res.on('error', reject); res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(data) }); } catch { reject(Error('Bad response')); } }); }); request.setTimeout(4000, () => request.destroy(Error('Timeout'))); request.on('error', reject); request.end(raw); }); } catch { fail('FFA hub 暂时不可用，请稍后重试；已有内容和草稿保留', 503); }
    const out = response.data; if (response.status !== 200 || !out.ok) fail(out.message || 'FFA hub 验证失败', response.status); return out.result;
  }
  snapshot(botId) {
    const ids = botId ? [botId] : this.knownIds();
    const bots = ids.filter(id => !this.store.get('accounts', id)?.hubPending).map(id => ({
      id, nickname: this.profile(id).nickname, owner: this.accounts.owner(id),
      teenMode: this.store.get('teenSettings', id)?.enabled, dailyGames: this.store.get('limits', id)?.maxWerewolfGamesPerDay
    }));
    const owner = bots[0]?.owner;
    const records = botId ? (owner ? [[owner, this.store.get('people', owner)]] : []) : this.store.entries('people');
    const people = records.filter(([, p]) => p && !p.hubPending).map(([id, p]) => ({
      id, nickname: p.nickname, email: p.email, password: p.password, aliasOf: p.aliasOf && this.accounts.canonical(id)
    }));
    return { people, bots };
  }
  async sync(botId) {
    const { people, bots } = this.snapshot(botId);
    const peopleById = new Map(people.map(p => [p.id, p]));
    const batchSize = 256;
    for (let offset = 0; offset < Math.max(people.length, bots.length); offset += batchSize) {
      const batchPeople = people.slice(offset, offset + batchSize);
      const batchBots = bots.slice(offset, offset + batchSize);
      // The Hub resolves aliases and owners against the people included in this request.
      const included = new Map(batchPeople.map(p => [p.id, p]));
      for (const id of [...batchPeople.map(p => p.aliasOf), ...batchBots.map(b => b.owner)]) {
        if (peopleById.has(id)) included.set(id, peopleById.get(id));
      }
      const result = await this.request('/v1/starpost/import', {
        people: [...included.values()], bots: batchBots, linkScope: 'submitted'
      });
      this.store.transaction(() => {
        for (const link of result.links) {
          if (!this.store.get('hubOriginalMappings', link.external_id)) this.store.put('hubOriginalMappings', link.external_id, { subject: link.subject, epoch: link.epoch ?? 1 });
          const p = this.store.get('people', link.external_id);
          if (p && p.hubSubject !== link.subject) this.store.put('people', link.external_id, { ...p, hubSubject: link.subject });
        }
      });
    }
  }
  async status(externalId) { let s = await this.request('/v1/legacy/status', { externalId }); if (!s.known || !this.store.get('hubOriginalMappings', externalId)) { await this.sync(); s = await this.request('/v1/legacy/status', { externalId }); } if (!s.known || !s.allowed) fail('该账号在 FFA hub 中受限，请到账号中心处理', 403);
    if (s.kind === 'bot' && s.policy) this.store.transaction(() => {
      const before = this.store.get('hubPolicies', externalId), teen = this.store.get('teenSettings', externalId), limits = this.store.get('limits', externalId) ?? {};
      if (before?.dailyGames !== s.policy.dailyGames || before?.teenMode !== s.policy.teenMode) this.store.put('hubPolicies', externalId, s.policy);
      if (teen?.enabled !== s.policy.teenMode) { this.store.put('teenSettings', externalId, { enabled: s.policy.teenMode }); this.store.emit([externalId], 'teen.mode', { enabled: s.policy.teenMode }); }
      if (limits.maxWerewolfGamesPerDay !== s.policy.dailyGames) this.store.put('limits', externalId, { ...limits, maxWerewolfGamesPerDay: s.policy.dailyGames });
    }); return s; }
  async sessionCheck(session, fresh = false, action, args = {}) {
    const id = session.human ? session.owner : session.humanId;
    const state = await this.status(id), original = this.store.get('hubOriginalMappings', id);
    const expected = session.hubSubject ?? original?.subject;
    if (!expected || expected !== state.subject || !fresh && (session.hubEpoch ?? original?.epoch ?? 1) !== state.epoch) fail('联合账号授权已变更，请通过 FFA hub 重新登录', 401);
    if (!fresh && (session.hubServiceEpoch ?? 0) !== state.serviceEpoch) fail('此服务的登录授权已撤销，请重新登录', 401);
    if (action && !['logout', 'account.info', 'account.bind', 'account.contactRemark', 'chat.preferences', 'owner.notifications', 'square', 'featured', 'featured.read', 'profile'].includes(action) && !/^(human|social|capsule|safety)\./.test(action)) {
      const bot = ['account.botAvatar', 'account.botPokeText', 'account.select'].includes(action) ? args.botId : session.human ? session.selectedBotId : session.owner;
      if (bot) { const membership = state.botAccess?.find(row => row.external_id === bot); if (!membership || (/^teen\./.test(action) || /^account\.bot/.test(action)) && membership.role === 'member') fail('此 bot 的 Hub 管理关系已变更，请先在 FFA hub 确认权限或重新绑定', 403); }
    }
    if (fresh) { const collection = session.human ? 'humanSessions' : 'mobileSessions'; this.store.transaction(() => this.store.put(collection, session.key, { ...this.store.get(collection, session.key), hubSubject: state.subject, hubEpoch: state.epoch, hubServiceEpoch: state.serviceEpoch })); }
    if (session.sourceProject === 'coodock') { const project = await this.request('/v1/starpost/project-state', { subject: state.subject, project: 'coodock' }); if (!project.linked || project.epoch !== session.sourceProjectEpoch) fail('CooDock 的 Hub 授权已撤销，请重新登录', 401); }
    return state;
  }
  filterNotifications(result, state) { return { ...result, items: (result.items ?? []).filter(item => { const bot = item.botId ?? (item.kind === 'owner' ? item.target : null); return !bot || state.botAccess?.some(row => row.external_id === bot); }) }; }
  async syncBinding(session, result) {
    await this.sync();
    const state = await this.status(session.human ? session.owner : session.humanId);
    if (!state.botAccess?.some(row => row.external_id === result.boundBotId)) fail('星邮已记录绑定，但此 bot 的 Hub 管理权限未授权。已有 Hub 管理者的 bot 请由主要管理员邀请；曾释放、冻结或被托管的账号请到 FFA hub 处理。当前人类登录仍有效', 403);
    return { ...result, hubManaged: true };
  }
  accountInfo(result, state) { return { ...result, hubSubject: state.subject, hubIssuer: this.config.issuer, hubUrl: this.config.authorizationOrigin ?? this.config.issuer, loginProvider: 'ffa-hub', identityScope: { service: 'starpost', subject: state.subject, businessId: result.humanId } }; }
  async verifyPassword(id, password) { return this.request('/v1/legacy/password', { externalId: id, password }); }
  async botClaims(token, installationId, deviceId, routeEpoch) {
    if (typeof token !== 'string' || token.length < 24 || token.length > 256 || typeof installationId !== 'string' || !installationId || typeof deviceId !== 'string' || !deviceId) fail('Hub 安装凭据不完整', 401);
    const execute = routeEpoch !== undefined;
    if (execute && (!Number.isSafeInteger(routeEpoch) || routeEpoch < 0)) fail('Hub 主运行端版本无效', 403);
    const c = await this.request(execute ? '/v1/authorize-operation' : '/v1/introspect', { token, ...(execute ? { action: 'bot.execute', routeEpoch } : {}) });
    if (!c.active || execute && !c.allowed || c.issuer !== this.config.issuer || c.audience !== 'starpost' || c.principalType !== 'bot' || c.role !== 'connector' || c.botId !== c.subject || c.installationId !== installationId || c.deviceId !== deviceId || !Array.isArray(c.scope) || !c.scope.includes('bot:connect') || !c.scope.includes('bot:execute')) fail('Hub 授权失效或本安装不是主运行端，请在 FFA hub 检查授权', 403);
    return c;
  }
  async botSession(input, create = false) {
    const c = await this.botClaims(input.token, input.installationId, input.deviceId);
    const links = await this.request('/v1/links', { subject: c.subject });
    const ids = links.links.filter(l => l.kind === 'bot').map(l => l.external_id);
    let botId = input.expectedBotId;
    if (botId && !ids.includes(botId)) fail('选中的 Hub bot 不属于本机星邮账号；原登录保持不变', 409);
    if (!botId && ids.length > 1) fail('此 Hub bot 关联多个星邮号，请先用原凭据恢复需要的星邮账号，再配对', 409);
    botId ||= ids[0];
    if (!botId && create) {
      // Reserve a local number before linking. Pending rows are excluded from legacy import;
      // retries reuse the reservation and cannot accidentally create another Hub identity.
      botId = this.reserveBot(c.subject, links.profile?.nickname);
      const linked = await this.request('/v1/starpost/link-bot', { token: input.token, externalId: botId });
      if (linked.externalId !== botId) fail('Hub 业务编号已在其他部署分配，请联系维护者', 409);
      this.store.transaction(() => { const row = this.store.get('accounts', botId); this.store.put('accounts', botId, { ...row, hubPending: false }); this.store.put('hubOriginalMappings', botId, { subject: c.subject, epoch: links.epoch }); });
    }
    if (!botId || !this.knownIds().includes(botId)) fail('Hub bot 尚未在此星邮服务器建立账号，请先完成配对', 409);
    const reserved = this.store.get('accounts', botId);
    if (reserved?.hubPending && reserved.hubSubject === c.subject && ids.includes(botId)) this.store.transaction(() => {
      this.store.put('accounts', botId, { ...reserved, hubPending: false });
      this.store.put('hubOriginalMappings', botId, { subject: c.subject, epoch: links.epoch });
    });
    const state = await this.status(botId);
    if (state.subject !== c.subject || state.kind !== 'bot') fail('星邮账号归属已变更', 403);
    return { botId, issuer: c.issuer, subject: c.subject, installationId: c.installationId, isPrimary: c.isPrimary, routeEpoch: c.routeEpoch, expiresAt: c.expiresAt };
  }
  async authenticateBot(req) {
    const c = await this.botClaims(req.headers.authorization?.replace(/^Bearer /, ''), req.headers['x-ffa-installation'], req.headers['x-ffa-device'], Number(req.headers['x-ffa-route-epoch']));
    const who = req.headers['x-starpost-id'];
    if (typeof who !== 'string' || !this.knownIds().includes(who)) fail('星邮账号无效', 401);
    const state = await this.status(who);
    if (state.subject !== c.subject || state.kind !== 'bot') fail('Hub 安装不属于此星邮账号', 403);
    return who;
  }
  authenticateInternal(req) { if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || !same(req.headers.authorization, 'Bearer ' + this.config.bridgeSecret)) fail('未授权', 401); }
  async internal(req, res, raw) {
    this.authenticateInternal(req); const input = JSON.parse(raw); let result;
    if (req.url === '/internal/hub/signin') {
      result = await this.signInIdentity(input);
    } else if (req.url === '/internal/hub/export') result = this.snapshot();
    else fail('接口不存在', 404);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ ok: true, result }));
  }
  async signInIdentity(input) {
      const sourceProject = ownerProject(input.sourceProject).id;
      if (sourceProject === 'coodock') { const state = await this.request('/v1/starpost/project-state', { subject: input.subject, project: sourceProject }); if (!state.linked || state.epoch !== input.sourceProjectEpoch) fail('CooDock 的 Hub 授权已变更，请重新登录', 401); }
      const allowed = await this.request('/v1/links', { subject: input.subject });
      if (allowed.kind && allowed.kind !== 'human') fail('需要 FFA 人类账号授权');
      let externalId = input.externalId;
      if (externalId && !allowed.links.some(l => l.external_id === externalId && l.kind === 'human')) fail('业务账号不属于此 FFA 身份');
      if (!externalId) { const choices = allowed.links.filter(l => l.kind === 'human'); if (choices.length > 1) fail('请选择要登录的星邮业务号', 409); externalId = choices[0]?.external_id; }
      if (!externalId) {
        // This creates a new business number; email is not used as an ownership key.
        const existing = this.store.list('people', "json_extract(data,'$.hubSubject')=?", [input.subject], { limit: 1 })[0];
        if (existing) externalId = existing.humanId;
        else externalId = this.store.transaction(() => {
          const next = this.store.get('meta', 'nextHumanId'), humanId = `${next}H`;
          if (!Number.isSafeInteger(next) || next < 10001 || this.store.get('people', humanId)) fail('账号号段异常', 503);
          this.store.put('meta', 'nextHumanId', next + 1);
          this.store.put('people', humanId, { humanId, nickname: allowed.profile.nickname, email: allowed.profile.email, password: null, epoch: 1, hubSubject: input.subject, hubPending: true, createdAt: new Date(this.clock()).toISOString() }); return humanId;
        });
        await this.request('/v1/starpost/link-new', { subject: input.subject, externalId });
      }
      return this.store.transaction(() => {
        const person = this.accounts.person(externalId);
        this.store.put('people', person.humanId, { ...person, hubSubject: input.subject, hubPending: false, email: allowed.profile.email || person.email });
        if (!this.store.get('hubOriginalMappings', externalId)) this.store.put('hubOriginalMappings', externalId, { subject: input.subject, epoch: allowed.epoch });
        const out = this.accounts.issue(externalId), key = createHash('sha256').update(out.accessToken).digest('hex'), row = this.store.get('humanSessions', key);
        this.store.put('humanSessions', key, { ...row, sourceProject, sourceProjectEpoch: sourceProject === 'coodock' ? input.sourceProjectEpoch : undefined, hubSubject: input.subject, hubEpoch: allowed.epoch, hubServiceEpoch: allowed.serviceEpoch }); return { ...out, hubSubject: input.subject, hubIssuer: this.config.issuer, loginProvider: 'ffa-hub' };
      });
  }
}
