import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { StarpostWorld } from '../src/world.ts';
import { STARPOST_DEFAULTS } from '../src/config.ts';
import { HubBridge } from '../server/hub-bridge.mjs';
import { createStarpostServer } from '../server/server.mjs';

const hubRoot = resolve(process.env.FFA_HUB_SOURCE || '../ffa-hub');
const available = existsSync(join(hubRoot, 'src/server.mjs'));
async function fixture(t: any) {
  const { createApp } = await import(pathToFileURL(join(hubRoot, 'src/server.mjs')).href);
  const { Store } = await import(pathToFileURL(join(hubRoot, 'src/store.mjs')).href);
  const probe = net.createServer(); await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as net.AddressInfo).port; await new Promise<void>(r => probe.close(() => r()));
  const issuer = `http://127.0.0.1:${port}`;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const serviceSecret = randomBytes(32).toString('hex');
  const app = await createApp({ issuer, development: true, secret: randomBytes(32).toString('base64url'), cookieKeys: [randomBytes(32).toString('hex')],
    jwks: { keys: [{ ...privateKey.export({ format: 'jwk' }), kid: 'isolated', alg: 'RS256', use: 'sig' }] },
    services: [{ id: 'starpost', name: '星邮隔离测试', secret: serviceSecret }], clients: [] }, { store: new Store(), sendMail: async () => {} });
  await new Promise<void>(r => app.server.listen(port, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'starpost-hub-'));
  const key = 'k'.repeat(32);
  const relay = createStarpostServer({ file: join(dir, 'data.json'), keys: { 10001: key }, port: 0,
    hubConfig: { issuer, internalBase: issuer, host: new URL(issuer).host, serviceSecret, bridgeSecret: 'isolated-only' } });
  await relay.listen();
  const server = `http://127.0.0.1:${(relay.server.address() as net.AddressInfo).port}`;
  t.after(async () => { await relay.close(); await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const existing = app.store.link('starpost', '10001').subject;
  const owner = app.accounts.person(app.hub.members(existing).find((m: any) => m.role === 'primary').human);
  const cfg = { ...structuredClone(STARPOST_DEFAULTS), serverUrl: server, hubUrl: issuer, enabled: true };
  const world = (name: string, legacy = false) => new StarpostWorld({ ...cfg, botId: legacy ? '10001' : '' }, join(dir, name), dir, join(dir, name), 'Asia/Shanghai', () => key);
  const call = async (path: string, body: unknown, headers = {}) => { const r = await fetch(server + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }); return { status: r.status, ...await r.json() }; };
  const approve = (name: string, bot = existing) => {
    const p = JSON.parse(readFileSync(join(dir, name, 'starpost-hub-pairing.json'), 'utf8'));
    assert.equal(app.authz.pairing(p.pairingId).proved, true);
    app.authz.approvePairing(owner.id, { pairingId: p.pairingId, shortCode: p.shortCode, bot }); return p;
  };
  const primary = (bot: string, installation: string) => app.authz.setPrimary(owner.id, bot, 'starpost:' + installation, app.accounts.person(bot).routeEpoch ?? 0);
  return { app, relay, dir, key, issuer, server, cfg, owner, existing, world, call, approve, primary };
}
const panel = (world: StarpostWorld, method: string, args: unknown[] = []) => world.webUi().invoke!('viewer', method, args) as Promise<any>;

test('Hub upgrade preserves legacy credentials; failed or cancelled pairing never replaces identity', { skip: !available }, async t => {
  const f = await fixture(t), w = f.world('legacy', true);
  assert.deepEqual(await panel(w, 'status'), { registered: true, botId: '10001' });
  const credential = readFileSync(join(f.dir, 'legacy/starpost-credential.json'), 'utf8');
  await panel(w, 'snapshot');
  assert.deepEqual(await panel(f.world('legacy'), 'status'), { registered: true, botId: '10001' });
  await panel(w, 'hubBegin'); assert.equal((await panel(w, 'hubFinish')).status, 'pending');
  await panel(w, 'hubCancel'); assert.equal((await panel(w, 'hubStatus')).mode, 'legacy');
  await panel(w, 'hubBegin'); const other = f.app.hub.createBot('另一个 bot', f.owner.id).bot.id;
  f.approve('legacy', other); await assert.rejects(panel(w, 'hubFinish'), /不属于本机/);
  assert.equal(readFileSync(join(f.dir, 'legacy/starpost-credential.json'), 'utf8'), credential);
  assert.equal(existsSync(join(f.dir, 'legacy/starpost-hub-session.json')), false);
  await panel(w, 'snapshot'); await panel(w, 'hubCancel');
});

test('signed Hub pairing preserves Starpost ID, requires primary, survives restart and fails closed on revocation', { skip: !available }, async t => {
  const f = await fixture(t), w = f.world('old', true);
  await panel(w, 'status'); const original = readFileSync(join(f.dir, 'old/starpost-credential.json'), 'utf8');
  await panel(w, 'hubBegin'); const p = f.approve('old');
  assert.equal((await panel(w, 'hubFinish')).status, 'awaiting_primary');
  assert.equal((await panel(w, 'hubStatus')).mode, 'legacy');
  f.primary(f.existing, p.installationId);
  assert.equal((await panel(w, 'hubFinish')).botId, '10001');
  assert.equal(readFileSync(join(f.dir, 'old/starpost-credential.json'), 'utf8'), original);
  const reboot = f.world('old'); await panel(reboot, 'snapshot');
  const session = JSON.parse(readFileSync(join(f.dir, 'old/starpost-hub-session.json'), 'utf8'));
  const info = await panel(reboot, 'mobileLoginInfo'); assert.equal(info.credential, '');
  assert(!JSON.stringify([info, await panel(reboot, 'hubStatus'), reboot.webUi().config]).includes(session.accessToken));
  const headers = { authorization: 'Bearer ' + session.accessToken, 'x-starpost-auth': 'ffa-hub', 'x-starpost-id': '10001', 'x-ffa-installation': p.installationId, 'x-ffa-device': p.deviceId, 'x-ffa-route-epoch': '1' };
  assert.equal((await f.call('/credential/claim', {}, headers)).status, 401);
  assert.equal((await f.call('/owner/control', { operation: 'enable' }, headers)).status, 401);
  assert.equal((await f.call('/rpc', { action: 'snapshot' }, { ...headers, 'x-ffa-device': 'wrong' })).status, 403);
  assert.equal((await f.call('/rpc', { action: 'snapshot' }, { ...headers, 'x-ffa-route-epoch': '0' })).status, 403);
  const latest = f.relay.store.events('10001', 0).at(-1)?.seq ?? 0;
  const waiting = f.call('/rpc', { action: 'events', args: { since: latest, waitMs: 500 } }, headers);
  await new Promise(r => setTimeout(r, 100));
  f.app.authz.revokeInstallation(f.owner.id, 'starpost:' + p.installationId);
  assert.equal((await waiting).status, 403, 'long poll must recheck authorization after waiting');
  await assert.rejects(panel(reboot, 'snapshot'), /授权/);
  assert.equal((await panel(reboot, 'hubStatus')).mode, 'hub');
  // Compatibility path remains available to already logged-in old clients.
  assert.equal((await f.call('/rpc', { action: 'snapshot' }, { authorization: 'Bearer ' + f.key, 'x-starpost-id': '10001' })).status, 200);
});

test('整库超过一万条时分批同步，每批都带上归属人和别名主账号', async () => {
  const humans = Array.from({ length: 10001 }, (_, i) => ({ id: (10001 + i) + 'H', aliasOf: undefined as string | undefined }));
  humans[0].aliasOf = humans.at(-1)!.id;
  const bots = Array.from({ length: 10001 }, (_, i) => ({ id: String(10001 + i), owner: humans.at(-1)!.id }));
  const importedBots = new Set<string>(), importedPeople = new Set<string>();
  const bridge = Object.create(HubBridge.prototype);
  bridge.snapshot = () => ({ people: humans, bots });
  bridge.store = { transaction: (work: () => void) => work() };
  bridge.request = async (_path: string, batch: { linkScope: string, people: typeof humans, bots: typeof bots }) => {
    assert.equal(batch.linkScope, 'submitted');
    assert(batch.people.length <= 10000 && batch.bots.length <= 10000);
    const ids = new Set(batch.people.map(p => p.id));
    for (const p of batch.people) { importedPeople.add(p.id); if (p.aliasOf) assert(ids.has(p.aliasOf)); }
    for (const bot of batch.bots) { assert(ids.has(bot.owner)); assert(!importedBots.has(bot.id)); importedBots.add(bot.id); }
    return { links: [] };
  };
  await bridge.sync();
  assert.equal(importedBots.size, bots.length);
  assert.equal(importedPeople.size, humans.length);
});

test('本地与 Hub bot 超过原注册上限后仍可交替接入，共用顺延编号', { skip: !available }, async t => {
  const f = await fixture(t);
  f.relay.store.transaction(() => {
    for (let id = 10002; id < 20001; id++) {
      f.relay.store.put('accounts', String(id), { installationId: String(id), tokenHash: 'unused' });
    }
    f.relay.store.put('meta', 'nextBotId', 20001);
  });
  async function pairNew(name: string) {
    const bot = f.app.hub.createBot(name, f.owner.id).bot.id;
    const world = f.world(name);
    await panel(world, 'hubBegin');
    const pairing = f.approve(name, bot);
    f.primary(bot, pairing.installationId);
    return panel(world, 'hubFinish');
  }
  assert.equal((await pairNew('hub-first')).botId, '20001');
  const local = { installationId: '00000000-0000-4000-8000-000000000001', token: 'a'.repeat(64) };
  assert.equal((await f.call('/register', local)).result.botId, '20002');
  const extra = { installationId: '00000000-0000-4000-8000-000000000002', token: 'b'.repeat(64) };
  assert.equal((await f.call('/register', extra)).result.botId, '20003');
  assert.equal((await pairNew('hub-next')).botId, '20004');
  assert.equal((await f.call('/register', local)).result.botId, '20002');
  assert.equal(f.relay.store.get('meta', 'nextBotId'), 20005);
});

test('new Hub bot provisions one business account; re-pair and migration do not duplicate it', { skip: !available }, async t => {
  const f = await fixture(t), bot = f.app.hub.createBot('全新 bot', f.owner.id).bot.id, w = f.world('new');
  await panel(w, 'hubBegin'); const p = f.approve('new', bot); f.primary(bot, p.installationId);
  const connected = await panel(w, 'hubFinish'); assert.equal(connected.botId, '10002');
  assert.equal(f.app.store.link('starpost', '10002').subject, bot);
  assert.equal(existsSync(join(f.dir, 'new/starpost-credential.json')), false);
  await panel(w, 'snapshot');
  const second = f.world('second'); await panel(second, 'hubBegin'); const p2 = f.approve('second', bot);
  assert.equal((await panel(second, 'hubFinish')).status, 'awaiting_primary');
  f.primary(bot, p2.installationId); assert.equal((await panel(second, 'hubFinish')).botId, '10002');
  await assert.rejects(panel(w, 'snapshot'), /授权|主运行端/);
  await panel(second, 'snapshot'); assert.equal(f.relay.store.count('accounts'), 1);
  const ss = JSON.parse(readFileSync(join(f.dir, 'second/starpost-hub-session.json'), 'utf8'));
  const wrongUrl = new StarpostWorld({ ...f.cfg, serverUrl: 'https://other.invalid' }, f.dir, f.dir, join(f.dir, 'second'), 'Asia/Shanghai', () => '');
  assert.throws(() => wrongUrl.webUi(), /其他服务地址/);
  writeFileSync(join(f.dir, 'second/starpost-hub-session.json'), JSON.stringify({ ...ss, expiresAt: Date.now() - 1000 }));
  await assert.rejects(panel(f.world('second'), 'snapshot'), /到期/);
});

const dshRoot = resolve(process.env.STARPOST_DSH_SOURCE || '../dsh-plugin-starpost');
test('DSH CLI pairs through Hub without leaking credentials and reloads the same bot/session', { skip: !available || !existsSync(join(dshRoot, 'src/account.mjs')), timeout: 30000 }, async t => {
  const f = await fixture(t), home = join(f.dir, 'dsh'), session = 'isolated-dsh-session';
  const cli = async (args: string[]) => JSON.parse((await promisify(execFile)(process.execPath, [join(dshRoot, 'src/account.mjs'), ...args], { env: { ...process.env, STARPOST_DSH_HOME: home } })).stdout);
  await cli(['login', '--session', session, '--server', f.server, '--file', (() => { const file = join(f.dir, 'old.json'); writeFileSync(file, JSON.stringify({ version: 1, botId: '10001', token: f.key })); return file; })()]);
  const first = await cli(['hub-login', '--hub', f.issuer]); assert.equal(first.registered, true); assert.equal(first.hub.mode, 'legacy');
  const p = f.approve('dsh'); f.primary(f.existing, p.installationId);
  const done = await cli(['hub-complete']); assert.equal(done.hub.mode, 'hub'); assert.equal(done.botId, '10001');
  const status = await cli(['status']); assert.equal(status.sessionId, session); assert.equal(status.hub.mode, 'hub');
  const credential = JSON.parse(readFileSync(join(home, 'starpost-hub-session.json'), 'utf8'));
  assert(!JSON.stringify([first, done, status]).includes(credential.accessToken));
  const { makeWorld, loadSettings } = await import(pathToFileURL(join(dshRoot, 'src/local.mjs')).href);
  const running = makeWorld(home, loadSettings(home)), delivered: any[] = [];
  await panel(running, 'snapshot');
  try {
    await running.start({ pushEvent: async (event: any) => { delivered.push(event); return { cursor: delivered.length }; }, promotePending: async () => true });
    const human = await f.call('/mobile/login', { botId: '10001', credential: f.key }); assert.equal(human.status, 200);
    const headers = { authorization: 'Bearer ' + human.result.accessToken };
    assert.equal((await f.call('/mobile/rpc', { action: 'owner.address', args: { address: '测试主人' } }, headers)).status, 200);
    assert.equal((await f.call('/mobile/rpc', { action: 'owner.send', args: { text: 'Hub 专属频道唤醒验证' } }, headers)).status, 200);
    const deadline = Date.now() + 8000;
    while (!delivered.some(e => e.text.includes('Hub 专属频道唤醒验证')) && Date.now() < deadline) await new Promise(r => setTimeout(r, 80));
    assert(delivered.some(e => e.type === 'starpost.owner_message' && e.text.includes('Hub 专属频道唤醒验证')));
    const reply = await running.tools()[0].handler({ family: 'mobile', action: 'send', argsJson: JSON.stringify({ text: 'Hub 回复已送达' }) });
    assert(!reply?.failed, JSON.stringify(reply));
    assert(f.relay.store.list('ownerMessages', 'owner=?', ['10001']).some((m: any) => m.text === 'Hub 回复已送达'));
    assert(!JSON.stringify(delivered).includes(credential.accessToken));
  } finally { await running.stop(); }
});
