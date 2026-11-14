'use strict';
/**
 * SSH 密钥库：存储 → 分配给 agent。
 *
 * - 私钥用 Electron safeStorage（Windows DPAPI）加密后落在 userData/ssh/keys.json；
 *   公钥/指纹/备注明文，方便展示。
 * - 「分配给 agent」= 把私钥解密写到 userData/ssh/agent_key（仅当前用户 ACL），
 *   宿主给 dsh 子进程注入 GIT_SSH_COMMAND，执行器的 git/ssh 自动使用它。
 * - 不碰用户自己的 ~/.ssh；取消分配即删除明文副本。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

function findBin(name) {
  const candidates = [
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', name + '.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', name + '.exe')
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return name; // 交给 PATH
}

function run(cmd, args, { timeoutMs = 30000, input } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '', err = '';
    const t = setTimeout(() => { try { p.kill(); } catch {} resolve({ code: -1, out, err: 'timeout' }); }, timeoutMs);
    p.stdout.on('data', (b) => { out += b.toString(); });
    p.stderr.on('data', (b) => { err += b.toString(); });
    if (input !== undefined) { p.stdin.write(input); p.stdin.end(); }
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: e.message }); });
  });
}

class SshVault {
  /** deps: { dir, encrypt(text)->string, decrypt(payload)->string, log?, onChange? } */
  constructor(deps) {
    this.dir = deps.dir;
    this.encrypt = deps.encrypt;
    this.decrypt = deps.decrypt;
    this.log = deps.log || (() => {});
    this.onChange = deps.onChange || (() => {});
    fs.mkdirSync(this.dir, { recursive: true });
    this.file = path.join(this.dir, 'keys.json');
    this.agentKeyFile = path.join(this.dir, 'agent_key');
    this.knownHostsFile = path.join(this.dir, 'known_hosts');
  }

  _load() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return { keys: [], assignedId: '' }; }
  }
  _save(data) {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  list() {
    const d = this._load();
    return {
      assignedId: d.assignedId || '',
      keys: (d.keys || []).map((k) => ({ id: k.id, name: k.name, publicKey: k.publicKey, fingerprint: k.fingerprint, createdAt: k.createdAt, comment: k.comment || '' }))
    };
  }

  async _fingerprint(publicKey) {
    const tmp = path.join(os.tmpdir(), `sa-ssh-pub-${Date.now()}.pub`);
    fs.writeFileSync(tmp, publicKey.trim() + '\n', 'utf8');
    const r = await run(findBin('ssh-keygen'), ['-lf', tmp]);
    fs.rmSync(tmp, { force: true });
    return r.code === 0 ? r.out.trim().split(/\s+/).slice(0, 2).join(' ') : '';
  }

  /** 生成 ed25519 密钥对并入库。 */
  async generate(name) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-ssh-gen-'));
    const keyPath = path.join(tmpDir, 'key');
    const r = await run(findBin('ssh-keygen'), ['-t', 'ed25519', '-N', '', '-C', String(name || 'superagent'), '-f', keyPath]);
    if (r.code !== 0) { fs.rmSync(tmpDir, { recursive: true, force: true }); throw new Error('ssh-keygen 失败：' + (r.err || r.out).slice(0, 200)); }
    const privateKey = fs.readFileSync(keyPath, 'utf8');
    const publicKey = fs.readFileSync(keyPath + '.pub', 'utf8').trim();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return this._store(name, privateKey, publicKey);
  }

  /** 导入已有私钥（粘贴内容）。 */
  async importKey(name, privateKey) {
    const text = String(privateKey || '').trim();
    if (!/-----BEGIN (OPENSSH|RSA|EC|DSA) PRIVATE KEY-----/.test(text)) throw new Error('不像私钥：需要 -----BEGIN … PRIVATE KEY----- 开头');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-ssh-imp-'));
    const keyPath = path.join(tmpDir, 'key');
    fs.writeFileSync(keyPath, text + '\n', { mode: 0o600 });
    await this._restrictAclSync(keyPath);
    const r = await run(findBin('ssh-keygen'), ['-y', '-f', keyPath]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (r.code !== 0) throw new Error('无法从私钥导出公钥（可能带口令，暂不支持）：' + (r.err || '').slice(0, 200));
    return this._store(name, text, r.out.trim());
  }

  async _store(name, privateKey, publicKey) {
    const d = this._load();
    const key = {
      id: 'k-' + crypto.randomBytes(5).toString('hex'),
      name: String(name || '未命名').slice(0, 60),
      publicKey,
      fingerprint: await this._fingerprint(publicKey),
      createdAt: new Date().toISOString(),
      secret: this.encrypt(privateKey)
    };
    d.keys.push(key);
    this._save(d);
    this.log(`SSH 密钥已入库：${key.name}（${key.fingerprint}）`);
    this.onChange();
    return key;
  }

  remove(id) {
    const d = this._load();
    const key = d.keys.find((k) => k.id === id);
    if (!key) throw new Error('密钥不存在');
    if (d.assignedId === id) this.unassign();
    d.keys = d.keys.filter((k) => k.id !== id);
    this._save(d);
    this.log(`SSH 密钥已删除：${key.name}`);
    this.onChange();
    return { ok: true };
  }

  /** 分配给 agent：解密私钥写到 agent_key，返回注入 dsh 环境用的 GIT_SSH_COMMAND。 */
  async assign(id) {
    const d = this._load();
    const key = d.keys.find((k) => k.id === id);
    if (!key) throw new Error('密钥不存在');
    const privateKey = this.decrypt(key.secret);
    fs.writeFileSync(this.agentKeyFile, privateKey.endsWith('\n') ? privateKey : privateKey + '\n', { mode: 0o600 });
    await this._restrictAclSync(this.agentKeyFile);
    d.assignedId = id;
    this._save(d);
    this.log(`SSH 密钥已分配给 agent：${key.name}`);
    this.onChange();
    return { ok: true, env: this.env() };
  }

  unassign() {
    const d = this._load();
    d.assignedId = '';
    this._save(d);
    try { fs.rmSync(this.agentKeyFile, { force: true }); } catch {}
    this.log('已取消 agent 的 SSH 密钥分配');
    this.onChange();
    return { ok: true };
  }

  /** 同步收紧 ACL，返回 Promise（ssh-keygen/ssh 读私钥前必须完成）。 */
  _restrictAclSync(file) {
    return new Promise((resolve) => {
      try {
        const user = process.env.USERNAME || os.userInfo().username;
        const p = spawn('icacls', [file, '/inheritance:r', '/grant:r', `${user}:R`], { windowsHide: true });
        p.on('close', () => resolve());
        p.on('error', () => resolve());
      } catch { resolve(); }
    });
  }

  /** 注入 dsh 子进程的环境；未分配返回 {}。 */
  env() {
    const d = this._load();
    if (!d.assignedId || !fs.existsSync(this.agentKeyFile)) return {};
    const ssh = findBin('ssh');
    const q = (p) => `"${p.replace(/"/g, '\\"')}"`;
    return {
      GIT_SSH_COMMAND: `${q(ssh)} -i ${q(this.agentKeyFile)} -o IdentitiesOnly=yes -o UserKnownHostsFile=${q(this.knownHostsFile)} -o StrictHostKeyChecking=accept-new`
    };
  }

  /** 用分配的密钥试连（默认 git@github.com；GitHub 成功时 exit 1 且带 successfully authenticated）。 */
  async test(target) {
    const env = this.env();
    if (!env.GIT_SSH_COMMAND) throw new Error('先分配一把密钥给 agent');
    const dest = String(target || 'git@github.com').trim();
    if (!/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$/.test(dest)) throw new Error('目标格式：user@host');
    const ssh = findBin('ssh');
    const r = await run(ssh, [
      '-i', this.agentKeyFile, '-o', 'IdentitiesOnly=yes',
      '-o', `UserKnownHostsFile=${this.knownHostsFile}`, '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
      '-T', dest
    ], { timeoutMs: 20000 });
    const text = (r.out + r.err).trim();
    const ok = /successfully authenticated|welcome|authenticated/i.test(text) || r.code === 0;
    return { ok, code: r.code, output: text.slice(0, 400) };
  }
}

module.exports = { SshVault, findBin };