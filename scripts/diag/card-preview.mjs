/**
 * Render the memory card — old versus new — and screenshot both.
 *
 * The CSS is extracted from the real client.js rather than retyped, so only the DOM is written out
 * here. The DOM is small enough to keep in sync by hand, and the point of the picture is layout
 * density, which is exactly what the CSS decides.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const repo = 'E:/__VIVE__/Documents/deepseek-harness/default-workspace/dsh-loci';
const outDir = join(process.env.TEMP, 'loci-preview');
mkdirSync(outDir, { recursive: true });

const client = readFileSync(join(repo, 'client.js'), 'utf8');
const start = client.indexOf('const CSS = `');
const end = client.indexOf('`;', start);
if (start < 0 || end < 0) throw new Error('CSS block not found');
const css = client.slice(start + 'const CSS = `'.length, end);

// Theme tokens the card reads. Values approximate the default DSH light theme closely enough to
// judge spacing and density, which is what this preview is for.
const tokens = `
:root{
  --dsw-alias-label-primary:#1b1d21; --dsw-alias-label-secondary:#6b7280;
  --dsw-alias-border-l1:#e3e5e9; --dsw-alias-bg-layer-1:#ffffff;
  --dsw-alias-brand-primary:#2f6df6;
  --dsw-alias-state-warn-primary:#b45309; --dsw-alias-state-error-primary:#c0392b;
}
body{margin:0;background:#f4f5f7;padding:14px;font-family:'Segoe UI',system-ui,sans-serif}
.wrap{display:grid;grid-template-columns:279px;gap:14px}
.tag{font-size:10px;color:#6b7280;margin:0 0 4px}
`;

const quill = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 4c0 9-6.5 15-16 16 0 0 .5-7 4.5-11S20 4 20 4Z"/><path d="M5 20 14 10"/></svg>`;

const head = (VersionLabelHtml) => `
  <div class="loci-card-head">
    <span class="loci-card-mark">${quill}</span>
    <span class="loci-card-title">Memory</span>
    ${VersionLabelHtml}
    <span class="loci-card-dot"></span>
    <span class="loci-card-meta">updated 17:29</span>
  </div>`;

const known = `
  <div class="loci-card-known">
    <span class="loci-card-known-tag">Latest</span>
    <span class="loci-card-known-text">DeepSeek-Flash 的推理等级默认设为 max</span>
  </div>`;

const bar = `
  <div class="loci-card-barline">
    <div class="loci-card-bar"><div class="loci-card-bar-fill" style="width:14%"></div></div>
    <span class="loci-card-bar-label">section 518 / 3584 B</span>
  </div>`;

const version = `<span class="loci-card-version">v4.11.0</span>`;

// Before: three big metrics above, and a footer of three more below.
const oldCard = `<div class="loci-card-root">
  ${head(version)}
  <div class="loci-card-grid">
    <div class="loci-card-metric"><span class="loci-card-metric-label">Verified</span><span class="loci-card-metric-value">2</span></div>
    <div class="loci-card-metric"><span class="loci-card-metric-label">Pending</span><span class="loci-card-metric-value is-warn">2</span></div>
    <div class="loci-card-metric"><span class="loci-card-metric-label">Disputed</span><span class="loci-card-metric-value">0</span></div>
  </div>
  ${known}
  ${bar}
  <div class="loci-card-foot">
    <span>Injected 1008</span><span>Opened 0</span><span>Dead 2</span><span class="loci-card-foot-grow"></span>
  </div>
  <button class="loci-card-hint loci-card-hint-action">2 item(s) waiting for you in Review.</button>
</div>`;

// After: one line of counts at the bottom; disputed and the review CTA follow the data.
const newStats = (pending) => `
  <div class="loci-card-stats">
    <span><b>2</b> verified</span>
    <span class="loci-card-sep">·</span>
    <span class="${pending > 0 ? 'is-warn' : ''}"><b>${pending}</b> pending</span>
    <span class="loci-card-sep">·</span>
    <span><b>1008</b> injected</span>
    <span class="loci-card-sep">·</span>
    <span><b>0</b> opened</span>
    <span class="loci-card-foot-grow"></span>
  </div>`;

const newCard = `<div class="loci-card-root">
  ${head(version)}
  ${known}
  ${bar}
  ${newStats(2)}
  <button class="loci-card-hint loci-card-hint-action">Review 2 →</button>
</div>`;

// The state right after the reset: nothing stored, no usage counters.
const emptyCard = `<div class="loci-card-root">
  ${head(version)}
  <div class="loci-card-empty">Nothing saved yet</div>
  <div class="loci-card-hint">Ask the agent to remember something, then confirm it here.</div>
</div>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${tokens}${css}
.loci-card-version{font-size:8.5px;color:var(--dsw-alias-label-secondary)}
.loci-card-dot{width:5px;height:5px;border-radius:999px;background:transparent;flex:0 0 auto}
/* The old layout's rules, dropped from client.js with the layout itself: kept here so the
   before/after picture compares the real thing rather than a broken remnant. */
.loci-card-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:3px 8px;width:100%}
.loci-card-metric{display:flex;flex-direction:column;gap:1px;min-width:0}
.loci-card-metric-label{font-size:8px;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.05em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.loci-card-metric-value{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.loci-card-metric-value.is-warn{color:var(--dsw-alias-state-warn-primary)}
.loci-card-foot{display:flex;align-items:center;gap:6px;width:100%;font-size:8.5px;color:var(--dsw-alias-label-secondary)}
</style></head><body><div class="wrap">
<p class="tag">before</p>${oldCard}
<p class="tag">after</p>${newCard}
<p class="tag">after · empty</p>${emptyCard}
</div></body></html>`;

const file = join(outDir, 'card.html');
writeFileSync(file, html, 'utf8');

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--no-sandbox', '--hide-scrollbars'],
});
const page = await browser.newPage();
await page.setViewport({ width: 320, height: 460, deviceScaleFactor: 2 });
await page.goto(`file:///${file.replace(/\\/g, '/')}`);
const shot = join(outDir, 'card.png');
await page.screenshot({ path: shot, fullPage: true });
const box = await page.evaluate(() => {
  const roots = [...document.querySelectorAll('.loci-card-root')].map((el) => Math.round(el.getBoundingClientRect().height));
  return { heights: roots, width: Math.round(document.querySelector('.loci-card-root').getBoundingClientRect().width) };
});
await browser.close();
console.log(`wrote ${shot}`);
console.log(`card heights (before / after / empty): ${JSON.stringify(box.heights)} · width ${box.width}px`);
