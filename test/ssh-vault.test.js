'use strict';
/** SSH 密钥库离线测试：node --test test/ssh-vault.test.js */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SshVault } = require('../electron/ssh-vault');

function tmpVault(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-vault-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // 测试用 base64 代替 DPAPI
  return new SshVault({
    dir,
    encrypt: (s) => 'b64:' + Buffer.from(s, 'utf8').toString('base64'),
    decrypt: (p) => Buffer.from(String(p).replace(/^b64:/, ''), 'base64').toString('utf8')
  });
}

test('生成 → 入库 → 公钥/指纹可读，私钥加密落盘', async (t) => {
  const v = tmpVault(t);
  const k = await v.generate('test-key');
  assert.ok(k.publicKey.startsWith('ssh-ed25519 '));
  assert.ok(/SHA256:/.test(k.fingerprint));
  const raw = fs.readFileSync(path.join(v.dir, 'keys.json'), 'utf8');
  assert.ok(!raw.includes('PRIVATE KEY'), '私钥明文不得落盘');
  assert.ok(raw.includes('b64:'));
  const list = v.list();
  assert.equal(list.keys.length, 1);
  assert.equal(list.assignedId, '');
});

test('分配 → env 注入 GIT_SSH_COMMAND；取消 → 清空', async (t) => {
  const v = tmpVault(t);
  const k = await v.generate('assign-me');
  assert.deepEqual(v.env(), {});
  await v.assign(k.id);
  const env = v.env();
  assert.ok(env.GIT_SSH_COMMAND.includes('agent_key'));
  assert.ok(env.GIT_SSH_COMMAND.includes('IdentitiesOnly=yes'));
  assert.ok(fs.existsSync(v.agentKeyFile));
  assert.equal(v.list().assignedId, k.id);
  v.unassign();
  assert.deepEqual(v.env(), {});
  assert.ok(!fs.existsSync(v.agentKeyFile));
});

test('导入私钥 → 导出公钥一致；坏输入拒绝', async (t) => {
  const v = tmpVault(t);
  const k = await v.generate('src');
  const priv = v.decrypt(JSON.parse(fs.readFileSync(path.join(v.dir, 'keys.json'), 'utf8')).keys[0].secret);
  const imp = await v.importKey('imported', priv);
  assert.equal(imp.publicKey, k.publicKey);
  await assert.rejects(() => v.importKey('bad', 'not a key'), /不像私钥/);
});

test('删除使用中的密钥 → 自动取消分配', async (t) => {
  const v = tmpVault(t);
  const k = await v.generate('del');
  await v.assign(k.id);
  v.remove(k.id);
  assert.equal(v.list().keys.length, 0);
  assert.deepEqual(v.env(), {});
});

test('连接测试：未分配时拒绝；github 试连返回结果', async (t) => {
  const v = tmpVault(t);
  await assert.rejects(() => v.test(), /先分配/);
  const k = await v.generate('net');
  await v.assign(k.id);
  const r = await v.test('git@github.com');
  // 新密钥未登记到 GitHub：应返回未通过但带 GitHub 的响应文本（证明 ssh 链路工作）
  assert.equal(typeof r.ok, 'boolean');
  assert.ok(r.output.length > 0);
});