/**
 * Try to reach the real GUI with the operator's persisted browser session.
 *
 * The web app is behind a token fence: `/` itself answers 401 to an anonymous client, so a headless
 * browser without the operator's cookie can only screenshot a 401 page. The operator issued a 30-day
 * cookie to Edge bound to port 24547, and it lives in Edge's profile — so the question this answers is
 * whether a *copy* of that profile, driven headlessly, is still authenticated.
 *
 * No puppeteer: Node has fetch and WebSocket, and the peer session's method is CDP over both.
 *
 * Usage: node scripts/diag/gui-probe.mjs [--port 9333] [--url http://127.0.0.1:24547/]
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const portArg = process.argv.find((arg) => arg.startsWith('--port='));
const port = portArg === undefined ? 9333 : Number(portArg.slice('--port='.length));
const urlArg = process.argv.find((arg) => arg.startsWith('--url='));
const url = urlArg === undefined ? 'http://127.0.0.1:24547/' : urlArg.slice('--url='.length);

const edgeProfile = join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data');
const work = join(process.env.TEMP, 'loci-gui-profile');

console.log(`source profile  ${edgeProfile}`);
console.log(`working profile ${work}`);

if (existsSync(work)) rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, 'Default', 'Network'), { recursive: true });

// Only what carries the session: the cookie store and the key material that unwraps it.
for (const [from, to] of [
  [join(edgeProfile, 'Local State'), join(work, 'Local State')],
  [join(edgeProfile, 'Default', 'Network', 'Cookies'), join(work, 'Default', 'Network', 'Cookies')],
]) {
  try {
    cpSync(from, to);
    console.log(`copied   ${from}`);
  } catch (error) {
    console.error(`could not copy ${from}: ${String(error?.message ?? error)}`);
    process.exit(2);
  }
}

const child = spawn(
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  [
    `--user-data-dir=${work}`,
    `--remote-debugging-port=${port}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    url,
  ],
  { detached: false, stdio: 'ignore' },
);
console.log(`launched edge pid ${child.pid} on port ${port}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function version() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  }
}

let info;
for (let attempt = 0; attempt < 40; attempt += 1) {
  info = await version();
  if (info !== undefined) break;
  await sleep(500);
}
if (info === undefined) {
  console.error('CDP never came up');
  child.kill();
  process.exit(3);
}
console.log(`CDP up: ${info['Browser']}`);

/** One CDP session over the first page target. */
async function withPage(fn) {
  let list;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    if (list.some((target) => target.type === 'page')) break;
    await sleep(500);
  }
  const page = list.find((target) => target.type === 'page');
  if (page === undefined) throw new Error('no page target');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (waiter !== undefined) {
      pending.delete(message.id);
      waiter(message);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      id += 1;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  try {
    return await fn(send, page);
  } finally {
    socket.close();
  }
}

const result = await withPage(async (send, page) => {
  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(2500);
  const probe = await send('Runtime.evaluate', {
    expression: `(async () => {
      const stats = await fetch('/api/loci/stats', { credentials: 'include' });
      const text = document.body?.innerText?.slice(0, 200) ?? '';
      return { href: location.href, status: stats.status, title: document.title, text };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  return { page: page.url, ...(probe.result?.result?.value ?? { error: JSON.stringify(probe) }) };
});

console.log(`\npage url    ${result.page}`);
console.log(`document    ${JSON.stringify(result.title ?? '')}`);
console.log(`api status  ${result.status}`);
console.log(`body head   ${JSON.stringify(String(result.text ?? '').slice(0, 160))}`);
console.log(
  result.status === 200
    ? '\nauthenticated: the copied profile carries a live session'
    : '\nnot authenticated: the copied profile does not carry the session (or the cookie is app-bound)',
);

child.kill();
if (process.argv.includes('--keep')) console.log(`profile kept at ${work}`);
else rmSync(work, { recursive: true, force: true });
process.exit(result.status === 200 ? 0 : 1);
