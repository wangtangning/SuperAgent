'use strict';
/** 服务器凭据库离线测试：node --test test/server-vault.test.js */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('child_process');
const { ServerVault } = require('../electron/server-vault');

function tmpVault(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-vault-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new ServerVault({
    dir,
    encrypt: (s) => 'b64:' + Buffer.from(s, 'utf8').toString('base64'),
    decrypt: (p) => Buffer.from(String(p).replace(/^b64:/, ''), 'base64').toString('utf8')
  });
}

test('入库：密码加密落盘，list 不泄露密码', async (t) => {
  const v = tmpVault(t);
  const s = v.add({ name: 'nas', host: '192.168.1.10', username: 'root', password: 'hunter2', note: '群晖' });
  const raw = fs.readFileSync(path.join(v.dir, 'servers.json'), 'utf8');
  assert.ok(!raw.includes('hunter2'), '密码明文不得落盘');
  const list = v.list('proj-a');
  assert.equal(list.servers.length, 1);
  assert.equal(list.servers[0].host, '192.168.1.10');
  assert.ok(!JSON.stringify(list).includes('hunter2'));
  assert.equal(s.auth, 'password');
});

test('分配 → 凭据文件生成 + env 注入 + 技能含清单不含密码', async (t) => {
  const v = tmpVault(t);
  const s = v.add({ name: 'nas', host: '192.168.1.10', username: 'root', password: 'hunter2' });
  assert.deepEqual(v.env('C:\\bin', 'proj-a'), {});
  assert.equal(v.skillText('proj-a'), '');
  v.assign(s.id, 'proj-a');
  const env = v.env('C:\\lan\\bin', 'proj-a');
  assert.ok(env.SUPERAGENT_LAN_CREDENTIALS.endsWith('credentials-proj-a.json'));
  assert.ok(env.PATH.startsWith('C:\\lan\\bin'));
  const cred = JSON.parse(fs.readFileSync(require('path').join(v.dir, 'credentials-proj-a.json'), 'utf8'));
  assert.equal(cred[0].password, 'hunter2');
  const skill = v.skillText('proj-a');
  assert.ok(skill.includes('192.168.1.10'));
  assert.ok(skill.includes('lan run'));
  assert.ok(!skill.includes('hunter2'), '技能里不得有密码');
  v.unassign(s.id, 'proj-a');
  assert.ok(!fs.existsSync(require('path').join(v.dir, 'credentials-proj-a.json')));
  assert.equal(v.skillText('proj-a'), '');
});

test('删除分配中的服务器 → 凭据文件清除', async (t) => {
  const v = tmpVault(t);
  const s = v.add({ name: 'x', host: '10.0.0.1', username: 'u', password: 'p' });
  v.assign(s.id, 'proj-a');
  v.remove(s.id);
  assert.equal(v.list('proj-a').servers.length, 0);
  assert.ok(!fs.existsSync(require('path').join(v.dir, 'credentials-proj-a.json')));
});

test('必填校验', async (t) => {
  const v = tmpVault(t);
  assert.throws(() => v.add({ host: '', username: 'u', password: 'p' }), /必填/);
  assert.throws(() => v.add({ host: 'h', username: 'u' }), /至少填一个/);
});

test('lan 助手：list 输出清单；run 对不可达主机报错退出', async (t) => {
  const v = tmpVault(t);
  const s = v.add({ name: 'loop', host: '127.0.0.1', port: 59999, username: 'u', password: 'p' });
  v.assign(s.id, 'proj-a');
  const helper = path.join(__dirname, '..', 'scripts', 'lan-helper.js');
  const env = Object.assign({}, process.env, { SUPERAGENT_LAN_CREDENTIALS: require('path').join(v.dir, 'credentials-proj-a.json') });
  const list = spawnSync(process.execPath, [helper, 'list'], { env, encoding: 'utf8' });
  assert.equal(list.status, 0);
  assert.ok(list.stdout.includes('127.0.0.1'));
  assert.ok(!list.stdout.includes('"p"') && !list.stdout.includes('password'));
  const run = spawnSync(process.execPath, [helper, 'run', s.id, 'echo hi'], { env, encoding: 'utf8', timeout: 15000 });
  assert.notEqual(run.status, 0);
  assert.ok(/ECONNREFUSED|connect|timed/i.test(run.stderr));
});

test('连接测试：不可达主机返回 ok=false 与原因', async (t) => {
  const v = tmpVault(t);
  const s = v.add({ name: 'loop', host: '127.0.0.1', port: 59999, username: 'u', password: 'p' });
  const r = await v.test(s.id);
  assert.equal(r.ok, false);
  assert.ok(r.output.length > 0);
});