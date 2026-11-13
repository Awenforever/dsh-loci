import assert from 'node:assert/strict';
import { test } from 'node:test';
import { effectiveConfig } from '../../src/host/config.js';
import { renderIndexBody } from '../../src/host/inject/index-section.js';
import { openTestStore, workspaceFields } from '../helpers.mjs';

/**
 * These tests exist because a wrong call shape here is invisible in unit tests
 * that stub the store: `/api/loci/preview` passed `config` as a function once and
 * the panel showed "请求失败: config is not a function" against a live page,
 * while every other test still passed.
 */
test('renderIndexBody takes a config reader and renders a fenced section', (t) => {
  const { store, scopes } = openTestStore(t);
  store.write({ ...workspaceFields(scopes), kind: 'rule', trustSource: 'user', title: '删除前做路径断言', body: '先校验绝对路径。' });
  const config = effectiveConfig({});
  const seen = [];
  const rendered = renderIndexBody({
    store,
    scopeKeys: [scopes.workspace],
    scopeLabel: scopes.labels.workspace,
    config: (key) => {
      seen.push(key);
      return config[key];
    },
    now: Date.now(),
  });
  assert.ok(rendered.text.includes('<loci-context'), 'the section must be fenced');
  assert.ok(rendered.text.includes('删除前做路径断言'));
  assert.equal(rendered.listed, 1);
  assert.equal(rendered.hidden, 0);
  assert.ok(rendered.bytes > 0);
  assert.ok(seen.length > 0, 'the renderer must actually read config through the reader');
  for (const key of seen) assert.equal(typeof key, 'string', 'the reader is called with a key');
});

test('renderIndexBody honours the byte budget and reports what it hid', (t) => {
  const { store, scopes } = openTestStore(t);
  for (let i = 0; i < 40; i += 1) {
    store.write({
      ...workspaceFields(scopes),
      kind: 'semantic',
      trustSource: 'user',
      title: `事实 ${i}：一条足够长的标题用来占满预算`,
      body: `正文 ${i}`,
    });
  }
  // The floor is 1024 by design (a smaller section cannot carry the fence and one
  // usable line), so the budget under test has to sit at or above it.
  const config = effectiveConfig({ sectionMaxBytes: 1024 });
  const rendered = renderIndexBody({
    store,
    scopeKeys: [scopes.workspace],
    scopeLabel: scopes.labels.workspace,
    config: (key) => config[key],
    now: Date.now(),
  });
  assert.ok(rendered.bytes <= 1024, `section must fit the budget (was ${rendered.bytes})`);
  assert.ok(rendered.hidden > 0, 'a capped section must say how many it hid');
  assert.ok(rendered.text.includes('more'), 'the footer must disclose the hidden count');
});
