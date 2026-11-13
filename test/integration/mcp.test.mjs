import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { effectiveConfig } from '../../src/host/config.js';
import { ensureMemoryRoot, layout } from '../../src/host/paths.js';
import { resolveScopes } from '../../src/host/scope.js';
import { Store } from '../../src/host/store/store.js';

const SERVER = fileURLToPath(new URL('../../src/mcp/server.js', import.meta.url));

/** Send one JSON-RPC line and collect the first response. */
function withServer(home, lines, options = {}) {
  const { timeoutMs = 15_000, args = [] } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, '--home', home, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, DSH_HOME: home },
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`mcp timeout; stderr: ${err.slice(0, 500)}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      err += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', () => {
      clearTimeout(timer);
      const messages = out
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return undefined;
          }
        })
        .filter(Boolean);
      resolve({ messages, err });
    });
    for (const line of lines) child.stdin.write(`${JSON.stringify(line)}\n`);
    child.stdin.end();
  });
}

test('the MCP facade answers initialize and lists read-only tools', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'loci-mcp-'));
  const root = ensureMemoryRoot(join(home, 'memory', 'loci'));
  const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '1.0.0' });
  const scopes = resolveScopes({ sessionId: 'mcp-test', cwd: home });
  store.write({
    scope: 'workspace',
    scopeKey: scopes.workspace,
    scopeLabel: scopes.labels.workspace,
    kind: 'procedural',
    status: 'verified',
    trustSource: 'user',
    title: '发布顺序',
    body: 'staging → canary 10% → 全量，任一步失败立即停止。',
  });
  store.close();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const { messages } = await withServer(
    home,
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'loci_search', arguments: { query: '发布顺序' } } },
    ],
    // The facade reads the scope of the directory it is pointed at, so the test
    // has to name it. That is the point: an MCP client cannot see memory that
    // belongs to a project it was not started for.
    { args: ['--cwd', home] },
  );

  const init = messages.find((message) => message.id === 1);
  assert.equal(init.result.protocolVersion, '2024-11-05');
  assert.equal(init.result.serverInfo.name, 'loci');

  const list = messages.find((message) => message.id === 2);
  const names = list.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ['loci_get', 'loci_search', 'loci_stats'], 'read-only by default: no write tool');
  for (const tool of list.result.tools) assert.ok(tool.description.length > 20);

  const call = messages.find((message) => message.id === 3);
  assert.equal(call.result.isError, false);
  assert.match(call.result.content[0].text, /canary|发布顺序/);
});

test('the facade does not read another workspace\'s memory', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'loci-mcp-scope-'));
  const root = ensureMemoryRoot(join(home, 'memory', 'loci'));
  const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '1.1.0' });
  // Seeded for one directory, read from another.
  const other = resolveScopes({ sessionId: 'a', cwd: join(home, 'project-a') });
  store.write({
    scope: 'workspace',
    scopeKey: other.workspace,
    scopeLabel: other.labels.workspace,
    kind: 'semantic',
    status: 'verified',
    trustSource: 'user',
    title: '项目 A 的私有约定',
    body: '只属于项目 A。',
  });
  store.close();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const { messages } = await withServer(
    home,
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'loci_search', arguments: { query: '私有约定' } } },
    ],
    { args: ['--cwd', join(home, 'project-b')] },
  );
  const call = messages.find((message) => message.id === 2);
  assert.equal(call.result.isError, false);
  const text = call.result.content[0].text;
  assert.match(text, /total=0/, 'project B must not see project A');
  assert.equal(text.includes('私有约定'), false, 'the title must not leak across workspaces');
});
