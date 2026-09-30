'use strict';
// Node 内置测试框架（无第三方依赖）：
//   node --test
//
// 核心逻辑（index.html 中 id="mde-core" 的 <script>）不接触 DOM，
// 这里从 HTML 提取该段脚本，在 vm 沙箱中运行，并用“可替换的文件句柄”
// 模拟权限丢失、外部改写、迟到读取等场景。

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { TextEncoder, TextDecoder } = require('node:util');

/* ---------- 加载核心脚本 ---------- */

function loadCore() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/<script id="mde-core">([\s\S]*?)<\/script>/);
  assert.ok(m, 'index.html 中应包含 id="mde-core" 的脚本段');

  const win = {
    crypto,
    setTimeout, clearTimeout,
    TextEncoder, TextDecoder,
    console
  };
  const sandbox = {
    window: win,
    TextEncoder, TextDecoder   // 核心脚本以裸标识符引用，需放在 vm 上下文顶层
  };
  vm.createContext(sandbox);
  vm.runInContext(m[1], sandbox, { filename: 'mde-core.js' });
  assert.ok(win.MDE && win.MDE.core, '核心脚本应挂载 window.MDE.core');
  return win.MDE.core;
}

const core = loadCore();

/* ---------- 可替换的假文件句柄 ----------
 *
 * 具备 FileSystemFileHandle 的行为面：
 *   queryPermission / requestPermission（权限可随时被“撤销”）
 *   read（磁盘内容可随时被外部改写）
 *   write（可被注入故障）
 *   gateRead：把读取挂起，直到测试放行，用于模拟“迟到读取”
 */
function createFakeHandle(name, initialText) {
  return {
    name,
    _disk: initialText,
    _perm: 'granted',
    _readGate: null,
    _failWrites: 0,
    writes: 0,

    async queryPermission() { return this._perm; },
    async requestPermission() { return this._perm; }, // 默认不自动授权，测试显式 grant
    grant() { this._perm = 'granted'; },
    revoke() { this._perm = 'denied'; },

    // 模拟外部程序改写磁盘文件（权限状态不变）
    externallyWrite(text) { this._disk = text; },

    failNextWrites(n) { this._failWrites = n; },

    // 之后的 read() 会等待 gate 释放
    gateReads() {
      this._readGate = [];
    },
    releaseReads() {
      const pending = this._readGate;
      this._readGate = null;
      pending.forEach((fn) => fn());
    },

    async read() {
      if (this._readGate) {
        await new Promise((resolve) => this._readGate.push(resolve));
      }
      return { text: this._disk };
    },
    // 原生 FileSystemFileHandle 形状
    async getFile() {
      if (this._readGate) {
        await new Promise((resolve) => this._readGate.push(resolve));
      }
      return { name: this.name, text: async () => this._disk };
    },
    async createWritable() {
      const self = this;
      let buffer = '';
      return {
        async write(data) { buffer += data; },
        async close() {
          if (self._failWrites > 0) {
            self._failWrites--;
            throw new Error('模拟磁盘写入失败（设备忙）');
          }
          self.writes++;
          self._disk = buffer;
        }
      };
    }
  };
}

function makeAdapter(handle) {
  // 生产代码同样通过 createNativeAdapter 包装；这里直接复用同一形状，
  // 为贴近真实，仍使用 createNativeAdapter（假句柄实现了相同接口）。
  return core.createNativeAdapter(handle);
}

// 用可控时钟避免 autosave 定时器干扰断言
function makeTimers() {
  const pending = new Map();
  let id = 0;
  return {
    pending,
    timers: {
      setTimeout(fn) { id += 1; pending.set(id, fn); return id; }, // 忽略 ms：测试手动 flush
      clearTimeout(tid) { pending.delete(tid); }
    },
    flush() {
      const fns = Array.from(pending.values());
      pending.clear();
      return fns;
    }
  };
}

function makeSession(handle, initialText, opts = {}) {
  const tm = makeTimers();
  const session = core.createSession({
    draftStore: core.createMemoryDraftStore(),
    autosaveDelay: 100000,   // 测试中永不自动触发
    timers: tm.timers,
    ...opts
  });
  const h = handle || createFakeHandle('note.md', initialText);
  return { session, handle: h, tm, adapter: makeAdapter(h) };
}

async function openSession(initialText = '# 标题\n\n打开时的内容 v1') {
  const ctx = makeSession(null, initialText);
  await ctx.session.open(ctx.adapter);
  return ctx;
}

async function flushAutosave(ctx) {
  for (const fn of ctx.tm.flush()) await fn();
}

// 等待条件成立（冲突出现/写入完成等），避免依赖固定的宏任务数量
async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor 超时：条件未达成');
}

/* ============================ 测试 ============================ */

test('能力检测：showOpenFilePicker/showSaveFilePicker 均存在才视为支持', () => {
  assert.equal(core.supportsFileSystemAccess({}), false);
  assert.equal(core.supportsFileSystemAccess({ showOpenFilePicker() {} }), false);
  assert.equal(
    core.supportsFileSystemAccess({ showOpenFilePicker() {}, showSaveFilePicker() {} }),
    true
  );
});

test('正常路径：打开 → 编辑 → 保存，写回原文件并清理草稿', async () => {
  const { session, handle, tm } = await openSession();
  assert.equal(session.getState().permission, 'granted');

  session.setText('# 标题\n\n草稿 v2');
  assert.equal(session.getState().status, 'dirty');

  // 未保存草稿存在于草稿库，并标出所属文件版本
  for (const fn of tm.flush()) await fn();
  let drafts = await session.listDrafts();
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].name, 'note.md');
  assert.ok(drafts[0].baseDigest, '草稿必须记录所属版本摘要');
  assert.equal(drafts[0].text, '# 标题\n\n草稿 v2');

  const res = await session.save();
  assert.equal(res.ok, true);
  assert.equal(session.getState().status, 'saved');
  assert.equal(session.getState().message, core.MESSAGES.saved);
  assert.equal(handle._disk, '# 标题\n\n草稿 v2');

  // 保存后摘要基线更新，草稿被移除
  const expectedHash = await core.digest('# 标题\n\n草稿 v2');
  assert.equal(session.getState().baseDigest, expectedHash);
  drafts = await session.listDrafts();
  assert.equal(drafts.length, 0);
});

test('未修改时保存直接跳过，不产生写入', async () => {
  const { session, handle } = await openSession();
  const res = await session.save();
  assert.equal(res.skipped, true);
  assert.equal(handle.writes, 0);
});

test('外部改写：保存前重读发现摘要不同 → 暂停写入并展示磁盘版/草稿版', async () => {
  const { session, handle } = await openSession('原始内容 v1');
  session.setText('我的草稿 v2');

  // 外部程序在磁盘上改写
  handle.externallyWrite('别人写入的 v3');

  let conflictSeen = null;
  session.subscribe((s) => { if (s.status === 'conflict') conflictSeen = s; });

  const saveP = session.save();
  await waitFor(() => session.pendingConflict());
  const pc = session.pendingConflict();
  assert.ok(pc, '应存在待决冲突');
  assert.equal(pc.diskText, '别人写入的 v3');
  assert.equal(conflictSeen.message, core.MESSAGES.conflict);
  assert.equal(handle.writes, 0, '冲突期间不得写入');

  // 选择“用草稿覆盖”
  session.resolveConflict('draft');
  const res = await saveP;
  assert.equal(res.ok, true);
  assert.equal(handle._disk, '我的草稿 v2');
  assert.equal(session.getState().status, 'saved');
});

test('外部改写后选择“使用磁盘版”：草稿不写入，编辑器载入磁盘内容', async () => {
  const { session, handle } = await openSession('原始 v1');
  session.setText('我的草稿 v2');
  handle.externallyWrite('磁盘 v3');

  const saveP = session.save();
  await waitFor(() => session.pendingConflict());
  assert.ok(session.pendingConflict());

  session.resolveConflict('disk');
  const res = await saveP;
  assert.equal(res.reason, 'kept-disk');
  assert.equal(handle.writes, 0);
  assert.equal(session.getState().text, '磁盘 v3');
  assert.equal(session.getState().dirty, false);
  assert.equal(session.getState().message, core.MESSAGES.external);
  const drafts = await session.listDrafts();
  assert.equal(drafts.length, 0, '已与磁盘一致，草稿删除');
});

test('取消冲突：磁盘不动，草稿与未保存状态保留', async () => {
  const { session, handle, tm } = await openSession('原始 v1');
  session.setText('草稿 v2');
  handle.externallyWrite('磁盘 v3');

  const saveP = session.save();
  await waitFor(() => session.pendingConflict());
  session.resolveConflict('cancel');
  const res = await saveP;
  assert.equal(res.reason, 'cancelled');
  assert.equal(handle.writes, 0);
  assert.equal(session.getState().dirty, true);
  for (const fn of tm.flush()) await fn();
  const drafts = await session.listDrafts();
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].text, '草稿 v2');
});

test('权限丢失：保存被拒绝，不写入，草稿保留并标记所属版本', async () => {
  const { session, handle, tm } = await openSession('原始 v1');
  session.setText('草稿 v2');
  handle.revoke(); // 模拟用户在站点设置中撤销授权

  const res = await session.save();
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'denied');
  assert.equal(handle.writes, 0);
  const s = session.getState();
  assert.equal(s.status, 'denied');
  assert.match(s.message, /重新授权/);

  for (const fn of tm.flush()) await fn();
  const drafts = await session.listDrafts();
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].adapterKind, 'native');
  assert.ok(drafts[0].handle === handle, '草稿保留句柄，重新授权时可复用');
  assert.equal(
    drafts[0].baseDigest,
    await core.digest('原始 v1'),
    '草稿明确标出它所属的文件版本（打开时 v1）'
  );
  assert.equal(drafts[0].text, '草稿 v2');
});

test('重新授权后再次保存：重新读取比对，磁盘未变才写入（绝不自动覆盖）', async () => {
  const { session, handle } = await openSession('原始 v1');
  session.setText('草稿 v2');
  handle.revoke();
  const denied = await session.save();
  assert.equal(denied.reason, 'denied');

  // 用户在浏览器授权弹窗中显式点击“允许”；只恢复授权，不触发任何写入
  handle.grant();
  const perm = await session.requestPermission();
  assert.equal(perm, 'granted');
  assert.equal(handle.writes, 0, '重新授权不得自动保存');

  const res = await session.save();
  assert.equal(res.ok, true);
  assert.equal(handle._disk, '草稿 v2');
});

test('重新授权时磁盘已被外部改写：再次保存仍会检出冲突，不能自动覆盖较新磁盘文件', async () => {
  const { session, handle } = await openSession('原始 v1');
  session.setText('草稿 v2');
  handle.revoke();
  await session.save(); // denied，草稿保留

  // 撤销期间外部改写
  handle.externallyWrite('磁盘更新 v3');
  handle.grant();
  await session.requestPermission();

  const saveP = session.save();
  await waitFor(() => session.pendingConflict());
  const pc = session.pendingConflict();
  assert.ok(pc, '即便重新授权，较新的磁盘版本也必须触发冲突选择');
  assert.equal(pc.diskText, '磁盘更新 v3');
  assert.equal(handle.writes, 0);

  // 用户知情后明确选择覆盖
  session.resolveConflict('draft');
  const res = await saveP;
  assert.equal(res.ok, true);
  assert.equal(handle._disk, '草稿 v2');
});

test('写入失败：不丢失草稿，状态为 error，可在恢复后重试成功', async () => {
  const { session, handle, tm } = await openSession('原始 v1');
  session.setText('草稿 v2');
  handle.failNextWrites(1);

  const res = await session.save();
  assert.equal(res.reason, 'write-error');
  assert.equal(session.getState().status, 'error');
  assert.match(session.getState().message, /写入失败/);

  for (const fn of tm.flush()) await fn();
  const drafts = await session.listDrafts();
  assert.equal(drafts.length, 1, '写入失败后草稿必须保留');

  const retry = await session.save();
  assert.equal(retry.ok, true);
  assert.equal(handle._disk, '草稿 v2');
  assert.equal((await session.listDrafts()).length, 0);
});

test('迟到读取①：读取挂起期间发起新保存，迟到的旧读取结果作废，不产生误冲突', async () => {
  const { session, handle } = await openSession('原始 v1');
  session.setText('草稿 v2');
  handle.gateReads();

  const p1 = session.save();           // 读取挂起（旧保存）
  await Promise.resolve();
  await Promise.resolve();             // 让流程进入被 gate 挂起的 getFile()
  assert.equal(handle.writes, 0);

  session.setText('草稿 v2-修订');
  const p2 = session.save();           // 新保存使旧保存作废
  handle.releaseReads();

  const r1 = await p1;
  assert.equal(r1.reason, 'superseded', '迟到的旧保存应返回 superseded');
  const r2 = await p2;
  assert.equal(r2.ok, true, '磁盘未被外部改写，新保存直接写入');
  assert.equal(handle._disk, '草稿 v2-修订');
  assert.equal(handle.writes, 1, '只发生一次有效写入');
  assert.equal(session.pendingConflict(), null);
});

test('迟到读取②：旧保存已检出冲突时发起新保存，旧冲突作废；新流程按最新磁盘状态决策', async () => {
  const { session, handle } = await openSession('原始 v1');
  session.setText('草稿 v2');
  handle.externallyWrite('磁盘 v3');

  const p1 = session.save();
  await waitFor(() => session.pendingConflict());
  assert.ok(session.pendingConflict(), '第一次保存应看到冲突并暂停');

  // 用户尚未选择，磁盘又被改回，且编辑者更新草稿后发起第二次保存
  handle.externallyWrite('磁盘 v4');
  session.setText('草稿 v2b');
  const p2 = session.save();
  await waitFor(() => session.pendingConflict() && session.pendingConflict().diskText === '磁盘 v4');

  const r1 = await p1;
  assert.equal(r1.reason, 'superseded', '旧冲突 promise 必须被作废，不会悬挂');

  // 新冲突展示最新磁盘版
  const pc = session.pendingConflict();
  assert.ok(pc);
  assert.equal(pc.diskText, '磁盘 v4', '冲突面板必须是最新磁盘内容');

  session.resolveConflict('draft');
  const r2 = await p2;
  assert.equal(r2.ok, true);
  assert.equal(handle._disk, '草稿 v2b');
});

test('打开新文件会作废旧保存：迟到写入结果不污染新会话', async () => {
  const ctx1 = await openSession('文件A v1');
  ctx1.session.setText('A 的草稿');
  ctx1.handle.gateReads();
  const oldSave = ctx1.session.save();
  await Promise.resolve();
  await Promise.resolve();             // 进入被 gate 挂起的读取

  const h2 = createFakeHandle('B.md', '文件B v1');
  const opened = await ctx1.session.open(makeAdapter(h2));
  assert.equal(opened.ok, true);
  ctx1.handle.releaseReads();

  const oldRes = await oldSave;
  assert.equal(oldRes.reason, 'superseded');

  const s = ctx1.session.getState();
  assert.equal(s.name, 'B.md');
  assert.equal(s.text, '文件B v1');
  assert.equal(s.dirty, false);
  assert.equal(ctx1.handle.writes, 0, '迟到的旧保存不得写回文件A');
});

test('恢复草稿：版本信息完整；恢复后保存仍重新检查磁盘，较新版本触发冲突', async () => {
  const store = core.createMemoryDraftStore();
  const handle = createFakeHandle('note.md', '原始 v1');
  const tm = makeTimers();
  const s1 = core.createSession({ draftStore: store, autosaveDelay: 100000, timers: tm.timers });
  await s1.open(makeAdapter(handle));
  s1.setText('未保存草稿 v2');
  for (const fn of tm.flush()) await fn();
  const rec = (await store.list())[0];
  assert.equal(rec.adapterKind, 'native');
  assert.equal(rec.baseDigest, await core.digest('原始 v1'));
  assert.equal(rec.openedAt !== null, true);

  // 模拟“页面意外关闭后重新打开”：全新会话 + 全新（未授权）假句柄，
  // 从 IndexedDB 记录恢复，记录里携带原句柄
  handle.revoke();
  const s2 = core.createSession({ draftStore: store, autosaveDelay: 100000, timers: makeTimers().timers });
  const restored = await s2.restoreDraft(rec);
  assert.equal(restored.text, '未保存草稿 v2');
  assert.equal(restored.baseText, '原始 v1');
  assert.equal(restored.status, 'restored');
  assert.equal(restored.dirty, true);

  // 磁盘在期间被外部改写，授权后保存必须再次拦下
  handle.externallyWrite('磁盘新版 v3');
  handle.grant();
  const saveP = s2.save();
  await waitFor(() => s2.pendingConflict());
  const pc = s2.pendingConflict();
  assert.ok(pc);
  assert.equal(pc.diskText, '磁盘新版 v3');
  assert.equal(handle.writes, 0, '恢复草稿不得自动覆盖较新磁盘文件');
  s2.resolveConflict('draft');
  assert.equal((await saveP).ok, true);
  assert.equal(handle._disk, '未保存草稿 v2');
});

test('导入模式：无适配器，不能“保存到原文件”，状态文案只承诺下载', async () => {
  const tm = makeTimers();
  const session = core.createSession({
    draftStore: core.createMemoryDraftStore(),
    autosaveDelay: 100000, timers: tm.timers
  });
  await session.loadImported('readme.md', '导入内容', 'import');
  const s0 = session.getState();
  assert.equal(s0.canSaveToFile, false);
  assert.equal(s0.message, core.MESSAGES.imported);

  const noop = await session.save();
  assert.equal(noop.reason, 'no-adapter');

  session.setText('导入后修改');
  session.markDownloaded();
  const s = session.getState();
  assert.equal(s.status, 'downloaded');
  assert.equal(s.message, core.MESSAGES.downloaded);
  assert.ok(!/已保存到原文件/.test(s.message), '下载不得宣称写回原文件');

  // 导入文件的脏草稿也保留，但标记为 import（无句柄）
  for (const fn of tm.flush()) await fn();
  const drafts = await session.listDrafts();
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].adapterKind, 'import');
  assert.equal(drafts[0].handle, null);
});

test('另存为：成功后新句柄成为保存目标，旧草稿清理', async () => {
  const { session } = await openSession('原始 v1');
  session.setText('草稿 v2');
  const h2 = createFakeHandle('copy.md', '');
  const res = await session.saveAs(makeAdapter(h2));
  assert.equal(res.ok, true);
  assert.equal(h2._disk, '草稿 v2');
  assert.equal(session.getState().name, 'copy.md');
  assert.equal(session.getState().status, 'saved');
  assert.equal(session.getState().message, core.MESSAGES.saved);
  assert.equal((await session.listDrafts()).length, 0);
});

test('摘要工具稳定：相同内容同摘要，改动后摘要变化', async () => {
  const a = await core.digest('abc');
  const b = await core.digest('abc');
  const c = await core.digest('abd');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{64}$/);
});
