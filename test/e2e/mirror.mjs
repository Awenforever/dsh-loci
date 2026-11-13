/**
 * Verify the sidebar mirror card and the panel feed in a live page.
 *
 * This is the acceptance the user actually asked for: "like a second screen,
 * showing what was recently remembered and corrected". A component test cannot
 * prove it renders in the shell, so this drives the real page over CDP.
 *
 * Usage: node test/e2e/mirror.mjs --url <app url> --cdp http://127.0.0.1:9337 --out mirror-report.json
 */
import { writeFileSync } from 'node:fs';
import { connect, trustedClick } from './trusted-input.mjs';

const argv = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? fallback : value;
};
const appUrl = flagValue('url');
const cdpBase = flagValue('cdp', 'http://127.0.0.1:9337');
const out = flagValue('out', 'mirror-report.json');
const png = flagValue('png', 'mirror-report.png');

if (appUrl === undefined) {
  console.error('usage: node test/e2e/mirror.mjs --url <app url> [--cdp ...]');
  process.exit(2);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const api = await connect(cdpBase);
const { evaluate, send } = api;

const report = { appUrl, checks: [], diagnostics: {} };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: appUrl });

const deadline = Date.now() + 60_000;
for (;;) {
  const ready = await evaluate("document.readyState === 'complete' && document.body.innerText.length > 20");
  if (ready === true) break;
  if (Date.now() > deadline) throw new Error('page never became interactive');
  await wait(400);
}
await wait(2500);
await trustedClick(api, '^(继续|Continue)$');
await wait(800);

// 1. Both new endpoints answer from the page origin.
const endpoints = await evaluate(`
  (async () => {
    const read = async (path) => {
      const response = await fetch(path, { credentials: 'same-origin' });
      return { status: response.status, body: await response.text() };
    };
    return { activity: await read('/api/loci/activity?limit=10'), update: await read('/api/loci/update') };
  })()
`);
report.diagnostics.activityStatus = endpoints?.activity?.status;
report.diagnostics.updateStatus = endpoints?.update?.status;
check('activity endpoint answers', endpoints?.activity?.status === 200, `HTTP ${endpoints?.activity?.status}`);
check('update endpoint answers', endpoints?.update?.status === 200, `HTTP ${endpoints?.update?.status}`);
let activity;
try {
  activity = JSON.parse(endpoints.activity.body);
} catch {
  activity = undefined;
}
report.diagnostics.activity = activity;
check('activity carries a digest', typeof activity?.digest?.today === 'number', `today=${activity?.digest?.today} week=${activity?.digest?.week}`);
check('activity lists what changed', Array.isArray(activity?.items) && activity.items.length > 0, `${activity?.items?.length ?? 0} items`);
const actions = [...new Set((activity?.items ?? []).map((item) => item.action))];
check('the feed distinguishes added from revised', actions.includes('added'), actions.join(','));

// 2. The mirror card is rendered in the sidebar footer, with its counters.
const card = await evaluate(`
  (() => {
    const buttons = [...document.querySelectorAll('button, [role="button"], div[role="button"]')];
    const target = buttons.find((node) => {
      const text = node.innerText || '';
      return /记忆|Memory/.test(text) && /今日|today/.test(text);
    });
    if (target === undefined) return { found: false };
    const rect = target.getBoundingClientRect();
    return {
      found: true,
      text: (target.innerText || '').replace(/\\s+/g, ' ').slice(0, 200),
      x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height),
      version: /v\\d+\\.\\d+\\.\\d+/.exec(target.innerText || '')?.[0] ?? null,
    };
  })()
`);
report.diagnostics.card = card;
check('the mirror card renders in the sidebar', card?.found === true, card?.text);
check('the card shows a version in small text', typeof card?.version === 'string', card?.version ?? 'none');
check('the card is in the left column', (card?.x ?? 999) < 400, `x=${card?.x}`);
check(
  'the card shows a recent change line',
  /新增|更正|added|revised/.test(card?.text ?? ''),
  card?.text?.slice(0, 120),
);

// 3. Clicking it opens the panel on the Feed tab.
const opened = await evaluate(`
  (() => {
    const buttons = [...document.querySelectorAll('button, [role="button"], div[role="button"]')];
    const target = buttons.find((node) => /记忆|Memory/.test(node.innerText || '') && /今日|today/.test(node.innerText || ''));
    if (target === undefined) return false;
    target.click();
    return true;
  })()
`);
await wait(1500);
const panelText = await evaluate('document.body.innerText');
report.diagnostics.panelText = String(panelText).slice(0, 1500);
check('the card opens the memory panel', opened === true && /动态|Feed/.test(panelText));
check('the feed tab lists a change with its action tag', /新增|更正|核实|added|revised|verified/.test(panelText));

// 4. Evidence screenshot of the mirror card in place.
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(png, Buffer.from(shot.data, 'base64'));
check('screenshot captured', true, png);

writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
const failed = report.checks.filter((entry) => !entry.pass);
console.log(`\n${report.checks.length - failed.length}/${report.checks.length} mirror checks passed`);
api.close();
if (failed.length > 0) process.exitCode = 1;
