'use strict';
/**
 * 服务器凭据库：局域网运维场景。
 *
 * 存 IP/端口/用户名/密码（或密钥），DPAPI 加密；「分配给 agent」后：
 *   - 凭据明文写到 userData/lan/credentials.json（仅当前用户 ACL），供 LAN 助手命令读取；
 *   - 宿主把助手目录注入 dsh 的 PATH，agent 用 `lan list / lan run <id> "cmd"` 免问登录；
 *   - 宿主把「可用服务器清单」（只有名字/IP/用户名，没有密码）写进 agent 技能。
 * 密码永远不进模型上下文：模型只调助手，助手在本机用凭据认证。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Client } = require('ssh2');

class ServerVault {
  /** deps: { dir, encrypt, decrypt, log?, onChange? } */
  constructor(deps) {
    this.dir = deps.dir;
    this.encrypt = deps.encrypt;
    this.decrypt = deps.decrypt;
    this.log = deps.log || (() => {});
    this.onChange = deps.onChange || (() => {});
    fs.mkdirSync(this.dir, { recursive: true });
    this.file = path.join(this.dir, 'servers.json');
    this.credentialsFile = path.join(this.dir, 'credentials.json');
  }

  _load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!d.assignedByProject) {
        d.assignedByProject = {};
        if ((d.assignedIds || []).length) d.assignedByProject['p-default'] = d.assignedIds;
        delete d.assignedIds;
      }
      return d;
    } catch { return { servers: [], assignedByProject: {} }; }
  }
  _save(d) {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  list(projectId) {
    const d = this._load();
    const assigned = projectId ? (d.assignedByProject || {})[projectId] || [] : [...new Set(Object.values(d.assignedByProject || {}).flat())];
    return {
      assignedIds: assigned,
      assignedByProject: d.assignedByProject || {},
      servers: (d.servers || []).map((s) => ({
        id: s.id, name: s.name, host: s.host, port: s.port, username: s.username,
        auth: s.auth, note: s.note || '', createdAt: s.createdAt
      }))
    };
  }

  add({ name, host, port, username, password, privateKey, note }) {
    const h = String(host || '').trim();
    const u = String(username || '').trim();
    if (!h || !u) throw new Error('IP/主机名和用户名必填');
    if (!password && !privateKey) throw new Error('密码或私钥至少填一个');
    const d = this._load();
    const server = {
      id: 's-' + crypto.randomBytes(4).toString('hex'),
      name: String(name || h).slice(0, 60),
      host: h,
      port: Number(port) || 22,
      username: u,
      auth: password ? 'password' : 'key',
      note: String(note || '').slice(0, 200),
      createdAt: new Date().toISOString(),
      secret: this.encrypt(JSON.stringify({ password: password || '', privateKey: privateKey || '' }))
    };
    d.servers.push(server);
    this._save(d);
    this.log(`服务器已入库：${server.name}（${u}@${h}:${server.port}）`);
    this.onChange();
    return server;
  }

  remove(id) {
    const d = this._load();
    const s = d.servers.find((x) => x.id === id);
    if (!s) throw new Error('服务器不存在');
    d.servers = d.servers.filter((x) => x.id !== id);
    for (const k of Object.keys(d.assignedByProject || {})) d.assignedByProject[k] = (d.assignedByProject[k] || []).filter((x) => x !== id);
    this._save(d);
    this.syncAssigned();
    this.log(`服务器已删除：${s.name}`);
    this.onChange();
    return { ok: true };
  }

  assign(id, projectId) {
    const d = this._load();
    if (!d.servers.some((x) => x.id === id)) throw new Error('服务器不存在');
    d.assignedByProject = d.assignedByProject || {};
    const cur = d.assignedByProject[projectId] || [];
    d.assignedByProject[projectId] = [...new Set([...cur, id])];
    this._save(d);
    this.syncAssigned();
    this.log(`服务器已分配给项目 ${projectId}：${d.servers.find((x) => x.id === id).name}`);
    this.onChange();
    return { ok: true };
  }

  unassign(id, projectId) {
    const d = this._load();
    d.assignedByProject = d.assignedByProject || {};
    d.assignedByProject[projectId] = (d.assignedByProject[projectId] || []).filter((x) => x !== id);
    this._save(d);
    this.syncAssigned();
    this.onChange();
    return { ok: true };
  }

  /** 所有项目分配到的服务器凭据 → 各自助手可读文件（仅当前用户 ACL）。 */
  syncAssigned() {
    const d = this._load();
    const byProject = d.assignedByProject || {};
    for (const [proj, ids] of Object.entries(byProject)) {
      const file = path.join(this.dir, `credentials-${proj}.json`);
      if (!ids.length) { try { fs.rmSync(file, { force: true }); } catch {} continue; }
      const servers = ids.map((id) => d.servers.find((s) => s.id === id)).filter(Boolean).map((s) => {
        const secret = JSON.parse(this.decrypt(s.secret));
        return { id: s.id, name: s.name, host: s.host, port: s.port, username: s.username, password: secret.password, privateKey: secret.privateKey };
      });
      fs.writeFileSync(file, JSON.stringify(servers, null, 2), { mode: 0o600 });
      this._restrictAclSync(file);
    }
    const all = [...new Set(Object.values(byProject).flat())];
    if (!all.length) { try { fs.rmSync(this.credentialsFile, { force: true }); } catch {} }
  }

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

  /** 注入 dsh 子进程：助手上 PATH + 该项目凭据文件位置。 */
  env(helperDir, projectId) {
    const d = this._load();
    const ids = ((d.assignedByProject || {})[projectId] || []);
    if (!ids.length) return {};
    const credFile = path.join(this.dir, `credentials-${projectId}.json`);
    if (!fs.existsSync(credFile)) this.syncAssigned();
    return {
      SUPERAGENT_LAN_CREDENTIALS: credFile,
      PATH: helperDir + path.delimiter + (process.env.PATH || '')
    };
  }

  /** agent 技能文本：只有该项目分配到的清单，没有密码。 */
  skillText(projectId) {
    const d = this._load();
    const ids = ((d.assignedByProject || {})[projectId] || []);
    const assigned = ids.map((id) => d.servers.find((s) => s.id === id)).filter(Boolean);
    if (!assigned.length) return '';
    const lines = assigned.map((s) => `- ${s.name} (id ${s.id}): ${s.username}@${s.host}:${s.port}${s.note ? ' — ' + s.note : ''}`);
    return [
      '# LAN servers',
      '',
      'The operator has stored credentials for these LAN servers and assigned them to you. Use the `lan` helper; never ask the operator for passwords, and never print credentials.',
      '',
      ...lines,
      '',
      'Commands:',
      '- `lan list` — show assigned servers',
      '- `lan run <id> "<command>"` — run a shell command over SSH (password or key handled locally)',
      '- `lan put <id> <localPath> <remotePath>` / `lan get <id> <remotePath> <localPath>` — transfer files',
      '',
      'Prefer read-only inspection first (uptime, df, systemctl status, logs). For destructive or service-affecting commands, state what you will do in the ticket report; the operator authorized server maintenance via policy.'
    ].join('\n');
  }

  /** 连接测试：密码/密钥认证 + 执行 echo。 */
  async test(id) {
    const d = this._load();
    const s = d.servers.find((x) => x.id === id);
    if (!s) throw new Error('服务器不存在');
    const secret = JSON.parse(this.decrypt(s.secret));
    return new Promise((resolve) => {
      const conn = new Client();
      const timer = setTimeout(() => { try { conn.end(); } catch {} resolve({ ok: false, output: '连接超时（10s）' }); }, 10000);
      conn.on('ready', () => {
        conn.exec('echo superagent-ok && hostname', (err, stream) => {
          if (err) { clearTimeout(timer); conn.end(); return resolve({ ok: false, output: err.message }); }
          let out = '';
          stream.on('data', (b) => { out += b.toString(); });
          stream.stderr.on('data', (b) => { out += b.toString(); });
          stream.on('close', () => { clearTimeout(timer); conn.end(); resolve({ ok: out.includes('superagent-ok'), output: out.trim().slice(0, 300) }); });
        });
      });
      conn.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, output: e.message.slice(0, 200) }); });
      const cfg = { host: s.host, port: s.port, username: s.username, readyTimeout: 8000, tryKeyboard: true };
      if (secret.privateKey) cfg.privateKey = secret.privateKey;
      else cfg.password = secret.password;
      conn.connect(cfg);
    });
  }
}

module.exports = { ServerVault };