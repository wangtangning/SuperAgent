#!/usr/bin/env node
'use strict';
/**
 * lan — SuperAgent 局域网助手。agent 通过它使用已分配的服务器凭据，密码不进模型上下文。
 *   lan list
 *   lan run <id> "<command>"
 *   lan put <id> <local> <remote>
 *   lan get <id> <remote> <local>
 * 凭据文件由宿主维护（SUPERAGENT_LAN_CREDENTIALS）。
 */
const fs = require('fs');
const { Client } = require('ssh2');

const file = process.env.SUPERAGENT_LAN_CREDENTIALS;
function creds() {
  if (!file || !fs.existsSync(file)) { console.error('lan: 没有分配的服务器凭据（在指挥台「服务器」页分配）'); process.exit(2); }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function find(id) {
  const s = creds().find((x) => x.id === id || x.name === id);
  if (!s) { console.error('lan: 未找到服务器 ' + id + '；用 lan list 查看'); process.exit(2); }
  return s;
}
function connect(s) {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on('ready', () => resolve(c));
    c.on('error', reject);
    const cfg = { host: s.host, port: s.port || 22, username: s.username, readyTimeout: 10000, tryKeyboard: true };
    if (s.privateKey) cfg.privateKey = s.privateKey; else cfg.password = s.password;
    c.connect(cfg);
  });
}

const [, , cmd, ...args] = process.argv;

(async () => {
  if (cmd === 'list') {
    for (const s of creds()) console.log(`${s.id}\t${s.name}\t${s.username}@${s.host}:${s.port || 22}`);
    return;
  }
  if (cmd === 'run') {
    const [id, ...rest] = args;
    const command = rest.join(' ');
    if (!id || !command) { console.error('usage: lan run <id> "<command>"'); process.exit(2); }
    const c = await connect(find(id));
    c.exec(command, (err, stream) => {
      if (err) { console.error(err.message); c.end(); process.exit(1); }
      let code = 0;
      stream.on('data', (b) => process.stdout.write(b));
      stream.stderr.on('data', (b) => process.stderr.write(b));
      stream.on('close', (exit) => { code = exit || 0; c.end(); process.exit(code); });
    });
    return;
  }
  if (cmd === 'put' || cmd === 'get') {
    const [id, a, b] = args;
    if (!id || !a || !b) { console.error(`usage: lan ${cmd} <id> <src> <dst>`); process.exit(2); }
    const c = await connect(find(id));
    c.sftp((err, sftp) => {
      if (err) { console.error(err.message); c.end(); process.exit(1); }
      const done = (e) => { if (e) { console.error(e.message); process.exitCode = 1; } else console.log('ok'); c.end(); };
      if (cmd === 'put') sftp.fastPut(a, b, done); else sftp.fastGet(a, b, done);
    });
    return;
  }
  console.error('usage: lan list | run <id> "<cmd>" | put <id> <local> <remote> | get <id> <remote> <local>');
  process.exit(2);
})().catch((e) => { console.error('lan: ' + e.message); process.exit(1); });