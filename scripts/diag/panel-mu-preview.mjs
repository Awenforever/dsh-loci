/**
 * Render the panel's memory-unit block and screenshot it.
 *
 * The objective named the panel as one of three observability surfaces. The data reaching it was
 * verified, but "the payload is correct" is not "the block renders" — that gap is exactly what hid a
 * blank detail view for several releases. CSS is extracted from the real client.js.
 *
 * Run from a directory that has puppeteer-core, like `scripts/diag/card-preview.mjs`.
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
const css = client.slice(start + 'const CSS = `'.length, end);

const tokens = `
:root{
  --dsw-alias-label-primary:#1b1d21; --dsw-alias-label-secondary:#6b7280;
  --dsw-alias-border-l1:#e3e5e9; --dsw-alias-label-tertiary:#9aa1ab;
  --dsw-alias-bg-layer-1:#ffffff; --dsw-alias-bg-layer-2:#f4f5f7;
  --dsw-alias-brand-primary:#2f6df6;
  --dsw-alias-state-warn-primary:#b45309; --dsw-alias-state-error-primary:#c0392b;
}
body{margin:0;background:#eceef1;padding:14px;font-family:'Segoe UI',system-ui,sans-serif}
.panel{width:420px;background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:16px}
`;

// Mirrors the real helper exactly: .loci-cell > .loci-label + <b>. Getting this wrong the first time
// produced four full-width stacked cards, because `.loci-cells` has no CSS rule at all — the real
// container is `.loci-grid`. That is precisely what a screenshot catches and a data check cannot.
const cell = (label, value) =>
  `<div class="loci-cell"><span class="loci-label">${label}</span><b>${value}</b></div>`;

const trail = [
  { mu: 3.0, reason: 'inject', add: 0, use: 4 },
  { mu: 8.76, reason: 'inject', add: 0, use: 3 },
  { mu: 21.74, reason: 'write', add: 1, use: 0 },
];

const block = `
<div class="loci-section">Distance from the working set</div>
<div class="loci-grid">
  ${cell('fresh', 7)}${cell('active', 6)}${cell('cool', 0)}${cell('cold', 0)}
</div>
<div class="loci-meta" style="margin-top:6px">Measured in memory units — units of work, not dates. Retirement is off until a threshold is calibrated, so this is where growth shows up first.</div>
<div style="margin-top:10px">
  ${trail
    .slice()
    .reverse()
    .map(
      (row) =>
        `<div class="loci-row"><span class="loci-id">${row.mu.toFixed(1)}</span><div class="loci-main"><div class="loci-meta">${row.reason} · +${row.add} new · +${row.use} use</div></div></div>`,
    )
    .join('')}
</div>
<div class="loci-section">Store</div>
<dl class="loci-kv">
  <dt>path</dt><dd>~/.dsh/memory/loci/memory.db</dd>
  <dt>schema</dt><dd>v7</dd>
  <dt>host</dt><dd>0.2.2-rc.3</dd>
  <dt>memory unit</dt><dd>21.7 MU</dd>
  <dt>retirement</dt><dd>off (threshold not calibrated)</dd>
</dl>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${tokens}${css}
.loci-cell-value{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.loci-cell-label{font-size:9px;color:var(--dsw-alias-label-secondary)}
</style></head><body><div class="panel">${block}</div></body></html>`;

const file = join(outDir, 'panel-mu.html');
writeFileSync(file, html, 'utf8');

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--no-sandbox', '--hide-scrollbars'],
});
const page = await browser.newPage();
await page.setViewport({ width: 450, height: 620, deviceScaleFactor: 2 });
await page.goto(`file:///${file.replace(/\\/g, '/')}`);
const shot = join(outDir, 'panel-mu.png');
await page.screenshot({ path: shot, fullPage: true });
const box = await page.evaluate(() => {
  const panel = document.querySelector('.panel');
  const missing = [...panel.querySelectorAll('.loci-section, .loci-cell, .loci-row, .loci-kv dt')].length;
  return { height: Math.round(panel.getBoundingClientRect().height), blocks: missing };
});
await browser.close();
console.log(`wrote ${shot}`);
console.log(`panel height ${box.height}px · rendered blocks ${box.blocks}`);
