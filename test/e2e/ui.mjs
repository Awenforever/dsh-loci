/**
 * CDP check of the rendered UI in an isolated Web profile.
 *
 * It answers what slot registration alone cannot: does the page show the Memory
 * panel, does the panel read live data from the Host, and does the settings
 * dialog list the Loci section?
 *
 * Popovers in this shell react only to trusted pointer input, so the menu steps
 * go through `Input.dispatchMouseEvent` (see `trusted-input.mjs`).
 *
 * Usage: node test/e2e/ui.mjs --cdp http://127.0.0.1:9336 --url <app url> --out ui-report.json
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
const cdpBase = flagValue('cdp', 'http://127.0.0.1:9336');
const appUrl = flagValue('url');
const out = flagValue('out', 'ui-report.json');
const timeoutMs = Number(flagValue('timeout', '90000'));

if (appUrl === undefined) {
  console.error('usage: node test/e2e/ui.mjs --url <app url> [--cdp http://127.0.0.1:9336]');
  process.exit(2);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fail the run instead of hanging forever. */
const hardStop = setTimeout(() => {
  console.error(`ui check exceeded ${timeoutMs}ms`);
  process.exit(3);
}, timeoutMs + 30_000);
hardStop.unref?.();

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

const bootDeadline = Date.now() + timeoutMs;
for (;;) {
  const ready = await evaluate("document.readyState === 'complete' && document.body.innerText.length > 20");
  if (ready === true) break;
  if (Date.now() > bootDeadline) throw new Error('the page did not become interactive');
  await wait(500);
}
await wait(2500);

// Dismiss the preview notice so it cannot cover the panel.
await trustedClick(api, '^(继续|Continue)$');
await wait(800);

// 1. The Host half mounted: its owner-only API answers from the page origin.
const stats = await evaluate(
  "fetch('/api/loci/stats', { credentials: 'same-origin' }).then(async (r) => ({ status: r.status, body: await r.text() })).catch((e) => ({ status: -1, body: String(e) }))",
);
check('panel API answers from the page', stats.status === 200, `HTTP ${stats.status}`);
if (stats.status === 200) {
  try {
    report.diagnostics.stats = JSON.parse(stats.body);
  } catch {
    report.diagnostics.stats = String(stats.body).slice(0, 200);
  }
}

// 2. The sidebar exposes the Memory entry, and opening it renders the tabs.
const opened = await trustedClick(api, '^(记忆|Memory)$');
await wait(1600);
const panelText = await evaluate('document.body.innerText');
report.diagnostics.panelText = String(panelText).slice(0, 2500);
check('sidebar exposes a Memory entry', opened === true);
check('panel renders the Index tab', /索引|Index/.test(panelText));
check('panel renders the Search tab', /检索|Search/.test(panelText));
check('panel renders the Review tab', /待审|Review/.test(panelText));
check('panel renders the Stats tab', /统计|Stats/.test(panelText));
check('the panel opens on the Feed tab', /动态|Feed/.test(panelText));

// The Index tab is no longer the landing tab, so open it before looking for the
// rendered section. It is the tab whose whole purpose is showing the bytes the
// model actually receives.
await trustedClick(api, '^(索引|Index)$');
await wait(1200);
const indexText = await evaluate('document.body.innerText');
report.diagnostics.indexText = String(indexText).slice(0, 1500);
check(
  'the Index tab shows the exact injected section',
  String(indexText).includes('<loci-context'),
  String(indexText).match(/(\d+)\s*B/)?.[0] ?? 'no byte counter found',
);

// 3. Settings: the account menu, then the settings entry inside it.
const accountOpened = await trustedClick(api, '账号菜单|account menu');
await wait(1200);
const menuItems = await evaluate(
  "[...document.querySelectorAll('[role=\"menuitem\"],button,a,[role=\"button\"]')].map(n=>(n.getAttribute('aria-label')||n.textContent||'').trim()).filter(Boolean).slice(0,80)",
);
report.diagnostics.menuItems = menuItems;
check('account menu opens', accountOpened === true, `${(menuItems ?? []).length} items`);
const settingsClicked = await trustedClick(api, '^设置|^Settings');
await wait(2000);
const probe = await evaluate(`
  (() => {
    const dialogs = [...document.querySelectorAll('[role="dialog"], dialog')];
    const texts = dialogs.map((node) => node.innerText || node.textContent || '');
    return { dialogs: dialogs.length, hit: texts.some((text) => /Loci/.test(text)), head: texts.map((t) => t.slice(0, 300)) };
  })()
`);
report.diagnostics.settingsProbe = probe;
check('settings entry is present in the account menu', settingsClicked === true);
check('settings dialog opens', (probe?.dialogs ?? 0) > 0, `${probe?.dialogs ?? 0} dialog(s)`);
check('settings dialog lists the Loci section', probe?.hit === true, String(probe?.head?.[0] ?? '').replace(/\s+/g, ' ').slice(0, 120));

// 4. Visual artefact.
try {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (typeof shot.data === 'string') {
    const pngPath = out.replace(/\.json$/, '.png');
    writeFileSync(pngPath, Buffer.from(shot.data, 'base64'));
    check('screenshot captured', true, pngPath);
  }
} catch (error) {
  check('screenshot captured', false, String(error?.message ?? error));
}

writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
const failed = report.checks.filter((entry) => !entry.pass);
console.log(`\n${report.checks.length - failed.length}/${report.checks.length} UI checks passed`);
api.close();
if (failed.length > 0) process.exitCode = 1;
