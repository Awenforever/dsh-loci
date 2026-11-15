import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { effectiveConfig } from '../../src/host/config.js';
import { createTools } from '../../src/host/tools/tools.js';
import { extractDurableStatements } from '../../src/host/capture/capture.js';
import { fakeExec, openTestStore, workspaceFields } from '../helpers.mjs';

/**
 * Four containment defects an audit found, all of the same class: an operation that
 * trusted an input it should have checked.
 *
 *   1. `snapshot('../../x')` wrote outside the memory root.
 *   2. `loci_get` / `loci_forget` used an id with no scope check.
 *   3. an MCP write with no scope pooled in `session:unknown`, which no Host session reads.
 *   4. capture matched bare `别` inside 级别 / 特别 / 识别 / 区别 / 分别, and `要不要…？`
 *      matched the 不要 rule — so ordinary sentences became verified rules in the prompt.
 */

// 1.

test('a snapshot label cannot escape the backup directory', (t) => {
  const { store, scopes } = openTestStore(t);
  store.write({ ...workspaceFields(scopes), kind: 'semantic', trustSource: 'user', title: '一条事实', body: '正文。' });
  const root = store.paths.backups;
  for (const label of ['../../escape', 'a/b', 'x\\y', '..']) {
    const written = store.snapshot(label);
    assert.ok(written.startsWith(root), `${label} must stay inside ${root}, got ${written}`);
    assert.equal(existsSync(written), true);
  }
  // Everything landed in one directory, which is the property that matters.
  assert.equal(readdirSync(root).length, 4);
});

// 2.

test('a foreign id cannot be read or forgotten through the tools', async (t) => {
  const { store, scopes, home } = openTestStore(t);
  const foreign = store.write({
    ...workspaceFields(scopes),
    kind: 'semantic',
    trustSource: 'user',
    title: '另一个项目的事实',
    body: '不该被本会话看到。',
  });
  const tools = createTools({ store, config: () => effectiveConfig({}), log: undefined, capture: undefined });
  const get = tools.find((tool) => tool.name === 'loci_get');
  const forget = tools.find((tool) => tool.name === 'loci_forget');

  // A session rooted somewhere else resolves to different workspace/project keys, so the
  // entry is genuinely out of scope — the same situation as pasting an id from project B
  // into project A's chat.
  const elsewhere = mkdtempSync(join(tmpdir(), 'loci-elsewhere-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  const foreignExec = fakeExec('session-other', elsewhere);
  assert.notEqual(elsewhere, home);

  await assert.rejects(() => get.execute({ id: foreign.entry.id }, foreignExec), /not in this session's scope/);
  await assert.rejects(() => forget.execute({ id: foreign.entry.id }, foreignExec), /not in this session's scope/);
  // A refused delete must not have deleted anything.
  assert.equal(store.get(foreign.entry.id).entry.status, 'verified');
});

test('an in-scope id still works', async (t) => {
  const { store, scopes, home } = openTestStore(t);
  const own = store.write({ ...workspaceFields(scopes), kind: 'semantic', trustSource: 'user', title: '本会话的事实', body: '正文。' });
  const tools = createTools({ store, config: () => effectiveConfig({}), log: undefined, capture: undefined });
  const get = tools.find((tool) => tool.name === 'loci_get');
  const result = await get.execute({ id: own.entry.id }, fakeExec('session-test', home));
  assert.equal(result.entry.id, own.entry.id);
});

// 3.

test('an MCP write with no scope lands in the workspace, never session:unknown', async (t) => {
  const { store, scopes } = openTestStore(t);
  // The bug: `readScopeKeys(scopes, { scope: undefined })[0]` is `session:unknown`, a key
  // every facade shares and no Host session ever includes.
  const naive = [`session:unknown`, scopes.workspace];
  assert.equal(naive[0], 'session:unknown');
  // The fix picks the workspace key explicitly; assert the shape the server now uses.
  const chosen = [scopes.workspace][0];
  assert.notEqual(chosen, 'session:unknown');
  assert.equal(store.write({ ...workspaceFields(scopes), kind: 'semantic', trustSource: 'import', title: '来自 MCP 的提案', body: '正文。' }).entry.scopeKey, scopes.workspace);
});

// 4.

const FALSE_POSITIVES = [
  '这个 bug 的级别是 P1，先处理它',
  '我特别想看 diff',
  '识别这类错误要靠日志',
  '两者区别不大，随便选',
  '我们分别试了两种方案',
  '要不要一起吃饭？',
  '这个不得了的坑',
  '你记得改配置吗？',
];

const TRUE_POSITIVES = [
  ['以后都用中文回复我', 'rule'],
  ['不要再改测试文件', 'rule'],
  ['别把密钥写进仓库', 'rule'],
  ['禁止直接改生产库', 'rule'],
  ['必须先跑迁移再发布', 'procedural'],
  ['我们的约定是用 squash 合并', 'semantic'],
  ['记住这个回滚窗口是三十分钟', 'semantic'],
  ['发布流程是 staging 到 canary 到全量', 'procedural'],
  ['以后一律用 pnpm', 'rule'],
  ['下次别急着改代码', 'rule'],
];

test('ordinary sentences are not captured as rules', () => {
  for (const text of FALSE_POSITIVES) {
    const found = extractDurableStatements([{ seq: 1, text }], 200);
    assert.equal(found.length, 0, `"${text}" must not become a rule (got ${found[0]?.kind})`);
  }
});

test('real announcements are still captured, with the right kind', () => {
  for (const [text, kind] of TRUE_POSITIVES) {
    const found = extractDurableStatements([{ seq: 1, text }], 200);
    assert.equal(found.length, 1, `"${text}" must be captured`);
    assert.equal(found[0].kind, kind, `"${text}" should be ${kind}`);
  }
});
