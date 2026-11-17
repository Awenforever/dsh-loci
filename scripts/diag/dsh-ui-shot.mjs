/**
 * Screenshot the running DSH Web UI at a specific place in it.
 *
 * Acceptance for a UI change has to be a picture of the running application. A preview page built by hand is
 * not evidence that anything shipped — it only proves the preview renders.
 *
 * ## Why this is not just `dsh-web-shot.mjs`
 *
 * The kit script captures whatever the app happens to be showing. The Loci panel is behind a click, so this
 * variant drives the page first, then captures. It reuses the kit's authenticated-CDP approach unchanged:
 * a cookie signed from the `client-connection/browser-session` key, a one-shot bootstrap page on loopback, and
 * headless Edge with a throwaway profile.
 *
 * **No secret is printed.** The key is read, used to sign one cookie, and discarded.
 *
 * Usage:
 *   node scripts/diag/dsh-ui-shot.mjs --port 24547 --goto memory  --out shot.png
 *   node scripts/diag/dsh-ui-shot.mjs --port 24547 --goto sidebar --out card.png
 *
 * `--goto memory` opens the Memory panel; `--goto sidebar` scrolls the sidebar footer into view so the Loci
 * card is in frame.
 */
import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';

const HOME = `${process.env.USERPROFILE}\\.dsh`;
const CRED = `${HOME}\\.credentials.yaml`;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

/** Grab an ephemeral loopback port, so a crashed earlier run cannot block this one. */
const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const value = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(value));
    });
  });
const BOOTSTRAP_PORT = await freePort();
const CDP_PORT = await freePort();

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
};
const port = Number(arg('port', '0'));
const target = String(arg('goto', 'memory'));
const out = String(arg('out', 'C:\\tmp\\dsh-ui-shot.png'));
const width = Number(arg('width', '1440'));
const height = Number(arg('height', '900'));
const waitMs = Number(arg('wait', '9000'));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- 1. authority

if (!(Number.isInteger(port) && port > 0 && port < 65536)) {
  throw new Error('pass the port explicitly: --port <n> (auto-detection is in the kit script)');
}
const authority = `127.0.0.1:${port}`;

// ---------------------------------------------------------------- 2. signed cookie

const text = readFileSync(CRED, 'utf8');
const keyAt = text.indexOf('client-connection/browser-session');
if (keyAt < 0) throw new Error('browser-session record not found in credentials');
const secretMatch = text.slice(keyAt).match(/secret:\s*([A-Za-z0-9_-]+)/);
if (secretMatch === null) throw new Error('secret field not found');
const secret = Buffer.from(secretMatch[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const b64u = (buffer) => Buffer.from(buffer).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const cookieName = `dsh-auth-${b64u(createHash('sha256').update(authority).digest())}`;
const issuedAt = Date.now();
const payload = b64u(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt: issuedAt + 30 * 86_400_000 }), 'utf8'));
const cookieValue = `v1.${payload}.${b64u(createHmac('sha256', secret).update(payload).digest())}`;

const probe = await fetch(`http://${authority}/`, { headers: { cookie: `${cookieName}=${cookieValue}` }, redirect: 'manual' });
if (probe.status !== 200) throw new Error(`cookie rejected: HTTP ${probe.status}`);
console.log(`auth ok: HTTP 200 on http://${authority}/`);

// ---------------------------------------------------------------- 3. bootstrap

const bootstrapHtml = `<!doctype html><meta charset="utf-8"><title>dsh bootstrap</title>
<script>document.cookie=${JSON.stringify(`${cookieName}=${cookieValue}; path=/; max-age=2592000; samesite=strict`)};location.replace(${JSON.stringify(`http://${authority}/`)})</script>`;
const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(bootstrapHtml);
});
await new Promise((resolve) => server.listen(BOOTSTRAP_PORT, '127.0.0.1', resolve));

// ---------------------------------------------------------------- 4. headless Edge + CDP

const profile = `C:\\tmp\\edge-dsh-ui-${Date.now()}`;
mkdirSync(profile, { recursive: true });
const edge = spawn(
  EDGE,
  [
    '--headless',
    '--disable-gpu',
    '--no-first-run',
    '--disable-extensions',
    '--disable-crash-reporter',
    '--disable-breakpad',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let wsUrl = null;
for (let i = 0; i < 60; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
    const page = list.find((entry) => entry.type === 'page');
    if (page !== undefined) {
      wsUrl = page.webSocketDebuggerUrl;
      break;
    }
  } catch {
    // The debugger is not up yet; keep waiting.
  }
  await sleep(500);
}
if (wsUrl === null) throw new Error('CDP page target not available');

const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let nextId = 0;
const pending = new Map();
const events = [];
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  } else if (message.method) {
    events.push(message);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
  return result.result?.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
// Surface page errors: a plugin that throws during render unmounts its own panel, and the only trace is a
// console message nobody is watching.
await send('Log.enable').catch(() => {});
const pageErrors = [];
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') {
    const detail = message.params?.exceptionDetails;
    pageErrors.push(`exception: ${detail?.text ?? ''} ${detail?.exception?.description ?? ''}`.slice(0, 400));
  }
  if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params?.type)) {
    const text = (message.params?.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
    if (text.length > 0) pageErrors.push(`console.${message.params.type}: ${text.slice(0, 400)}`);
  }
});
await send('Page.navigate', { url: `http://127.0.0.1:${BOOTSTRAP_PORT}/` });

let appLoaded = false;
for (let i = 0; i < 80; i += 1) {
  if (events.some((entry) => entry.method === 'Page.frameNavigated' && entry.params?.frame?.url?.startsWith(`http://${authority}/`))) {
    appLoaded = true;
    break;
  }
  await sleep(250);
}
console.log('app navigation observed:', appLoaded);
await sleep(waitMs);

// ---------------------------------------------------------------- 5. navigate

/**
 * Click the navigation item whose trimmed text equals `label`.
 *
 * **"Memory" is ambiguous.** The left nav has an item by that name, and the Loci sidebar card carries the same
 * title, so four elements match. Picking by "fewest descendants" or "first in DOM" both picked the card on some
 * renders, and the script then reported that the panel would not open.
 *
 * The card is distinguishable: it is the only one of the two that contains the status words. Candidates nested
 * inside an element carrying those words are the card, and are skipped.
 */
const clickByText = async (label) => {
  const expression = `(() => {
    const want = ${JSON.stringify(label)};
    const cardMarkers = ['verified', 'pending', 'disputed', 'injected'];
    const matches = [...document.querySelectorAll('a,button,li,div,span')]
      .filter((node) => node.textContent !== null && node.textContent.trim() === want);
    if (matches.length === 0) return 'not found';
    const inCard = (node) => {
      let current = node;
      while (current !== null && current !== document.body) {
        const text = current.textContent || '';
        if (cardMarkers.every((marker) => text.includes(marker))) return true;
        current = current.parentElement;
      }
      return false;
    };
    const candidates = matches.filter((node) => !inCard(node));
    // Among the nav candidates, the label lives on the deepest node. Clicking a wrapping <div> was measured to
    // do nothing at all, while clicking the <span> that owns the text opens the panel.
    const nav = (candidates.length > 0 ? candidates : matches).sort(
      (a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length,
    )[0];
    nav.click();
    return 'clicked ' + nav.tagName + ' (' + matches.length + ' matches, ' + (inCard(nav) ? 'CARD!' : 'nav') + ')';
  })()`;
  return evaluate(expression);
};

/** Wait until `predicate` is true in the page, up to `timeoutMs`. */
const waitFor = async (expression, timeoutMs = 12_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true;
    await sleep(400);
  }
  return false;
};

/** Text of the whole page, for verifying what actually rendered. */
const pageText = () => evaluate('(document.body.innerText || "").replace(/\\s+/g, " ").trim()');

if (target === 'memory') {
  // **Open a conversation first.**
  //
  // The panel's default scope is "Automatic — session", and a fresh headless browser has no session, so it
  // resolves to nothing and the axis comes up empty. Selecting a conversation that has workspace-scoped
  // memories makes the automatic scope land on real data — which is also the state a person actually looks at,
  // so the screenshot shows the panel as it is used rather than a contrived configuration.
  const conversation = String(arg('conversation', 'DSH-Loci'));
  const opened = await evaluate(`(() => {
    const want = ${JSON.stringify(conversation)};
    const nodes = [...document.querySelectorAll('a,button,li,div,span')];
    const hit = nodes
      .filter((node) => node.textContent !== null && node.textContent.trim() === want)
      .sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0];
    if (!hit) return 'conversation not found';
    (hit.closest('button,a,[role="button"]') ?? hit).click();
    return 'clicked';
  })()`);
  console.log(`opening conversation "${conversation}":`, opened);
  await sleep(5000);

  // **Make the panel read every scope.**
  //
  // The Stats route describes `activeScopeKeys()` — the scope of the last prompt the Host assembled — and falls
  // back to the read set around that one workspace key. Every verified entry in this store lives in a *session*
  // scope, so that view is empty and the axis renders nothing. `?all=1` is the route's own admin view and
  // returns all 48.
  //
  // The scope dropdown in the panel does not affect Stats at all — it sets the *write* scope — so there is no
  // click that produces this view. Shimming fetch is the only way to photograph the axis with the real store
  // behind it, and the screenshot is labelled "everywhere" to say so.
  // The axis is no longer filtered by scope — `muPositions` was changed to describe the whole store, because a
  // map of one room is not a map. The shim below is kept opt-in (`--all 1`) for the case where that regression
  // comes back and the admin view is needed to tell an empty axis from a broken one.
  if (arg('all', '0') === '1') {
    await evaluate(`(() => {
      if (window.__lociAllScopes) return 'already shimmed';
      const original = window.fetch;
      window.__lociAllScopes = true;
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : input && input.url ? input.url : '';
        if (url.includes('/api/loci/stats') && !url.includes('all=1')) {
          const joined = url.includes('?') ? url + '&all=1' : url + '?all=1';
          return original.call(this, joined, init);
        }
        return original.call(this, input, init);
      };
      return 'shimmed';
    })()`);
    console.log('fetch shim: /api/loci/stats -> ?all=1');
  }

  // The panel is identified by its own tab strip. The detector must be specific: clicking Memory a second time
  // *closes* it, so a retry loop that blindly re-clicks toggles the panel shut and then reports success on a
  // blank page.
  const panelOpenExpr = `(() => {
    const labels = [...document.querySelectorAll('button')].map((b) => b.textContent.trim());
    return labels.includes('Feed') && labels.includes('Stats');
  })()`;

  if (await evaluate(panelOpenExpr)) {
    console.log('panel already open');
  } else {
    console.log('opening Memory:', await clickByText('Memory'));
    const opened = await waitFor(panelOpenExpr, 20_000);
    console.log('panel open:', opened);
    if (!opened) {
      // Capture anyway, and say so. A blank picture with an explanation is a diagnostic; a thrown error after
      // twenty minutes of sequencing is not.
      console.log('warning: panel did not open; capturing whatever is on screen');
    }
  }

  // **Click the tab inside the panel, not the first "Stats" in the document.**
  //
  // A global text match picked a button somewhere else on the page, and clicking it removed the panel — the
  // capture then showed a highlighted nav item with an empty content area. The tab strip lives in the same
  // container as the panel's own copy, so that container is the search scope.
  const tabResult = await evaluate(`(() => {
    // The tab strip is the only place where Stats sits beside Feed, Index, Search and Review. Matching on that
    // company is what distinguishes the panel's tab from any other button that happens to say "Stats".
    const strips = [...document.querySelectorAll('div,nav,header')].filter((node) => {
      const texts = [...node.querySelectorAll('button,[role="tab"],a,span')].map((child) => child.textContent.trim());
      return texts.includes('Feed') && texts.includes('Index') && texts.includes('Review') && texts.includes('Stats');
    });
    if (strips.length === 0) return 'no tab strip found';
    const strip = strips.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0];
    const tab = [...strip.querySelectorAll('button,[role="tab"],a,span')].find((node) => node.textContent.trim() === 'Stats');
    if (tab === undefined) return 'strip found but no Stats tab';
    tab.click();
    return 'clicked Stats inside the strip';
  })()`);
  console.log('tab:', tabResult);
  // The axis only exists after the statistics payload arrives.
  const statsShown = await waitFor('(document.body.innerText || "").includes("Position on the axis")', 20_000);
  console.log('stats rendered:', statsShown);
  if (!statsShown) console.log('body has:', (await pageText()).slice(0, 300));

  // The axis describes the whole store now, so there is no scope to widen here. Give it a beat to lay out
  // and any recall pulse to run.
  await sleep(2500);
} else if (target === 'sidebar') {
  // Scroll the sidebar footer to its bottom so the card is visible.
  const scrolled = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll('div,aside,section')];
    const filler = nodes.filter((node) => node.scrollHeight > node.clientHeight + 20)
      .sort((a, b) => b.scrollHeight - a.scrollHeight);
    if (filler.length === 0) return 'no scrollable container';
    const last = filler[0];
    last.scrollTop = last.scrollHeight;
    return 'scrolled ' + last.className.slice(0, 40) + ' to ' + last.scrollTop;
  })()`);
  console.log('sidebar:', scrolled);
  await sleep(2500);
} else if (target === 'none') {
  // Capture as-is.
} else {
  throw new Error(`unknown --goto ${target} (memory | sidebar | none)`);
}

// A panel that throws during render unmounts itself, and the only trace is a console message nobody is
// watching. Printing them here is what turns "the panel is blank" into "the panel threw".
if (pageErrors.length > 0) {
  console.log(`page errors (${pageErrors.length}):`);
  for (const line of pageErrors.slice(-10)) console.log(`  ${line}`);
}

const title = await evaluate('document.title + " | " + location.href');
console.log('page:', title);

// ---------------------------------------------------------------- 6. capture

const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
if (!shot.result?.data) throw new Error(`captureScreenshot failed: ${JSON.stringify(shot.error ?? shot)}`);
const png = Buffer.from(shot.result.data, 'base64');
writeFileSync(out, png);
console.log(`screenshot: ${out} (${png.readUInt32BE(16)}x${png.readUInt32BE(20)}, ${png.length} bytes)`);

// ---------------------------------------------------------------- 7. teardown

await send('Browser.close').catch(() => {});
ws.close();
server.close();
for (let i = 0; i < 40; i += 1) {
  try {
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
  } catch {
    break;
  }
  await sleep(250);
}
try {
  edge.kill();
} catch {
  // Already gone.
}
const psKill = `Get-CimInstance Win32_Process -Filter "name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${profile}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
try {
  execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-Command', psKill], { stdio: 'ignore' });
} catch {
  // Best effort.
}
await sleep(800);
try {
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  console.log('temp profile removed');
} catch (error) {
  console.log('temp profile left at', profile, String(error));
}
process.exit(0);
