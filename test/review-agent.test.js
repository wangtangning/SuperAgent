'use strict';
/** 评审 agent 离线测试：node --test test/review-agent.test.js */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ReviewAgent, heuristic } = require('../electron/review-agent');

const DIFF_OK = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# Old\n+# SuperAgent 指挥台（Windows 桌面宿主）\n';

test('启发式：小且相关 → approve', () => {
  const v = heuristic({ pr: { files: [{ filename: 'README.md' }], mergeable: true }, diff: DIFF_OK, request: '把 README 标题改成 Windows 桌面宿主' });
  assert.equal(v.verdict, 'approve');
});

test('启发式：敏感路径 / 过大 / 无交集 → 不自动合并', () => {
  assert.equal(heuristic({ pr: { files: [{ filename: '.github/workflows/ci.yml' }] }, diff: 'x', request: 'ci' }).verdict, 'uncertain');
  assert.equal(heuristic({ pr: { files: [{ filename: 'a.js' }] }, diff: 'y'.repeat(70000), request: 'a' }).verdict, 'uncertain');
  assert.equal(heuristic({ pr: { files: [{ filename: 'a.js' }] }, diff: 'console.log(1)', request: 'zzzz qqqq' }).verdict, 'uncertain');
  assert.equal(heuristic({ pr: { files: [] }, diff: '', request: 'x' }).verdict, 'uncertain');
});

test('启发式：冲突 → request_changes', () => {
  const v = heuristic({ pr: { files: [{ filename: 'README.md' }], mergeable: false }, diff: DIFF_OK, request: 'README' });
  assert.equal(v.verdict, 'request_changes');
});

function fakeDeps(t, { mergeable = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const api = {
    async get(p) {
      if (p.startsWith('tickets?')) return { items: [{ id: 't1', action: 'review', title: 'README 标题' }] };
      if (p.startsWith('tickets/')) return { threads: [{ key: 'github:2', url: 'https://github.com/o/r/pull/2' }], mandate: { scope: '把 README 标题改成 Windows 桌面宿主' } };
      throw new Error('unexpected ' + p);
    }
  };
  const gh = {
    async get(p, opts) {
      calls.push(['GET', p]);
      if (opts && opts.accept) return DIFF_OK;
      return { state: 'open', title: 'README 标题', mergeable, files: [{ filename: 'README.md' }] };
    },
    async post(p, b) { calls.push(['POST', p, b]); return {}; },
    async put(p, b) { calls.push(['PUT', p, b]); return { merged: true }; }
  };
  return { dir, calls, api, gh };
}

test('闭环：review 工单 → 自动合并（发单人 REST）', async (t) => {
  const { dir, calls, api, gh } = fakeDeps(t);
  const agent = new ReviewAgent({ api, gh, store: { dir }, log: () => {} });
  const r = await agent.tick();
  assert.equal(r.acted.length, 1);
  assert.equal(r.acted[0].verdict, 'approve');
  assert.ok(calls.some(([m, p]) => m === 'PUT' && p.includes('/pulls/2/merge')));
  // 第二轮不重复评审
  const r2 = await agent.tick();
  assert.equal(r2.acted.length, 0);
});

test('闭环：冲突 → 留 REQUEST_CHANGES 评审，不合并', async (t) => {
  const { dir, calls, api, gh } = fakeDeps(t, { mergeable: false });
  const agent = new ReviewAgent({ api, gh, store: { dir }, log: () => {} });
  const r = await agent.tick();
  assert.equal(r.acted[0].verdict, 'request_changes');
  assert.ok(calls.some(([m, p, b]) => m === 'POST' && p.includes('/reviews') && b.event === 'REQUEST_CHANGES'));
  assert.ok(!calls.some(([m, p]) => m === 'PUT' && p.includes('/merge')));
});

test('开关：disabled 时不评审', async (t) => {
  const { dir, api, gh } = fakeDeps(t);
  const agent = new ReviewAgent({ api, gh, store: { dir }, log: () => {} });
  agent.saveSettings({ enabled: false });
  const r = await agent.tick();
  assert.equal(r.skipped, 'disabled');
});