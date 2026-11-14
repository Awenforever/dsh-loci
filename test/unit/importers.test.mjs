import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { importPeer, parseRestrictedYaml, readAutoMemory, readClaudeMemory, splitFrontmatter } from '../../src/host/store/importers.js';
import { openTestStore } from '../helpers.mjs';

/** The exact front-matter shape auto-memory's serializeMemory() writes. */
const AUTO_MEMORY_FILE = `---
name: rollback-window
title: 回滚窗口 30 分钟
description: 超过 30 分钟必须人工决策
type: feedback
pinned: true
status: verified
evidence:
  sessionId: session-abc
  quote: 回滚窗口是 30 分钟
created: 1794573893000
updated: 1794573893000
reads: 4
---

超过 30 分钟必须走人工评审，不能由模型自己决定。
`;

test('the restricted YAML reader handles the shape auto-memory writes', () => {
  const front = parseRestrictedYaml(`name: x\npinned: true\nreads: 4\nevidence:\n  quote: "hi: there"\n  sessionId: s1`);
  assert.equal(front.name, 'x');
  assert.equal(front.pinned, true);
  assert.equal(front.reads, 4);
  assert.deepEqual(front.evidence, { quote: 'hi: there', sessionId: 's1' });
});

test('front matter and body split without eating the body', () => {
  const { front, body } = splitFrontmatter(AUTO_MEMORY_FILE);
  assert.equal(front.type, 'feedback');
  assert.equal(front.evidence.quote, '回滚窗口是 30 分钟');
  assert.match(body, /^超过 30 分钟/);
  assert.equal(body.includes('---'), false);
});

test('a byte-order mark does not hide the front matter', () => {
  // PowerShell's `Set-Content -Encoding utf8` writes a BOM; without tolerance the
  // file imports as one blob of body text with a filename-derived title.
  const { front, body } = splitFrontmatter(`${String.fromCharCode(0xfeff)}---\ntype: feedback\ntitle: 带 BOM 的\n---\n\n正文内容。`);
  assert.equal(front.type, 'feedback');
  assert.equal(front.title, '带 BOM 的');
  assert.equal(body, '正文内容。');
});
test('a document without front matter is all body', () => {
  const { front, body } = splitFrontmatter('# 只是一个标题\n\n正文');
  assert.deepEqual(front, {});
  assert.match(body, /只是一个标题/);
});

test('auto-memory folders map to scopes, and disabled entries are skipped', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'loci-am-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '_user'), { recursive: true });
  mkdirSync(join(dir, '--proj-a--'), { recursive: true });
  writeFileSync(join(dir, '_user', 'rollback-window.md'), AUTO_MEMORY_FILE, 'utf8');
  writeFileSync(
    join(dir, '--proj-a--', 'deploy-order.md'),
    `---\nname: deploy-order\ntitle: 发布顺序\ndescription: staging 先行\ntype: project\n---\n\nstaging → canary → 全量。\n`,
    'utf8',
  );
  writeFileSync(
    join(dir, '_user', 'old-and-wrong.md'),
    `---\nname: old-and-wrong\ntitle: 已经过时的\ndescription: x\ntype: user\ndisabled: true\n---\n\n不要导入。\n`,
    'utf8',
  );

  const entries = readAutoMemory(dir, {});
  assert.equal(entries.length, 2, 'the disabled entry is not imported');
  const user = entries.find((entry) => entry.title === '回滚窗口 30 分钟');
  assert.equal(user.scope, 'global', 'the _user folder becomes a global-scope entry');
  assert.equal(user.kind, 'procedural', 'feedback maps to procedural');
  assert.match(user.sourceRef, /^auto-memory:_user\//);
  const project = entries.find((entry) => entry.title === '发布顺序');
  assert.equal(project.scope, 'workspace');
  assert.match(project.scopeKey, /^workspace:--proj-a--$/);
});

test('claude memory reads the index and the topic files', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'loci-claude-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'MEMORY.md'), '- [回滚窗口](rollback.md) — 30 分钟\n- [发布顺序](deploy.md)\n', 'utf8');
  writeFileSync(join(dir, 'rollback.md'), '# 回滚窗口\n\n超过 30 分钟必须人工决策。\n', 'utf8');
  writeFileSync(join(dir, 'deploy.md'), 'staging → canary → 全量。\n', 'utf8');
  writeFileSync(join(dir, 'unlisted.md'), '# 手工加的一条\n\n索引里没有，但不该丢。\n', 'utf8');

  const entries = readClaudeMemory(dir, {});
  const titles = entries.map((entry) => entry.title).sort();
  assert.deepEqual(titles, ['回滚窗口', '手工加的一条', '发布顺序'].sort());
  assert.ok(entries.every((entry) => entry.status === 'candidate'));
});

test('importPeer lands everything as candidates in one scope', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'loci-peer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '_user'), { recursive: true });
  writeFileSync(join(dir, '_user', 'rollback-window.md'), AUTO_MEMORY_FILE, 'utf8');

  const { store, scopes } = openTestStore(t);
  const result = importPeer(store, { from: 'auto-memory', dir });
  assert.equal(result.imported, 1);

  const rows = store.db.prepare("SELECT status, trust_source, scope_key, title FROM memory").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'candidate', 'another plugin trust level is not our evidence');
  assert.equal(rows[0].trust_source, 'import');
  assert.equal(rows[0].scope_key, 'global:');
  assert.equal(store.indexEntries({ scopeKeys: [scopes.workspace, 'global:'] }).length, 0, 'nothing is injected');
});

test('importPeer refuses an unknown format and a missing directory', (t) => {
  const { store } = openTestStore(t);
  assert.throws(() => importPeer(store, { from: 'nope', dir: tmpdir() }), /unknown import format/);
  assert.throws(() => importPeer(store, { from: 'claude', dir: join(tmpdir(), 'does-not-exist-' + Date.now()) }), /not a directory/);
});

test('a dry run reads without writing', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'loci-dry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '_user'), { recursive: true });
  writeFileSync(join(dir, '_user', 'rollback-window.md'), AUTO_MEMORY_FILE, 'utf8');

  const { store } = openTestStore(t);
  const result = importPeer(store, { from: 'auto-memory', dir, dryRun: true });
  assert.equal(result.read, 1);
  assert.equal(result.imported, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM memory').get().n, 0);
});
