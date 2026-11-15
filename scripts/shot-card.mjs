#!/usr/bin/env node
/**
 * Render the sidebar card and the panel column so a UI change can be looked at.
 *
 * The DSH page runs in a browser with no CDP endpoint open, so this cannot attach to it.
 * Instead it pulls the **real stylesheet** out of `client.js` (the same string every
 * component renders as `<style>`) and rebuilds the DOM the components produce. It cannot
 * catch a mistake in the component's logic — only in what it draws, which is the mistake
 * that shipped twice.
 *
 * Everything invented here is in TOKENS (approximate light-theme values) and MOCK content.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = process.argv[2] ?? 'marketplace/screenshots/sidebar-card.png';
const source = readFileSync('client.js', 'utf8').replace(/\r\n/g, '\n');
const cssOpen = source.indexOf('const CSS = `') + 'const CSS = `'.length;
const css = source.slice(cssOpen, source.indexOf('\n`;', cssOpen));

const TOKENS = {
  '--dsw-alias-bg-base': '#ffffff',
  '--dsw-alias-bg-layer-1': '#ffffff',
  '--dsw-alias-bg-layer-2': '#f1f1f4',
  '--dsw-alias-border-l1': '#e5e5ea',
  '--dsw-alias-border-l2': '#d4d4dc',
  '--dsw-alias-label-primary': '#16161c',
  '--dsw-alias-label-secondary': '#6d6d78',
  '--dsw-alias-brand-primary': '#3b6ef5',
  '--dsw-alias-state-success-primary': '#1f9d55',
  '--dsw-alias-state-warn-primary': '#c97b00',
  '--dsw-alias-state-error-primary': '#d32f2f',
  '--dsw-alias-state-idle-primary': '#9a9aa5',
};

const LOGO = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none">
  <path d="M12 3 21 7.5 12 12 3 7.5 12 3Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
  <path d="M3.6 12.2 12 16.4l8.4-4.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M3.6 16.8 12 21l8.4-4.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const metric = (label, value, tone = '') =>
  `<div class="loci-card-metric"><span class="loci-card-metric-label">${label}</span><span class="loci-card-metric-value${tone ? ' ' + tone : ''}">${value}</span></div>`;

const head = (stamp, dot = '') => `
  <div class="loci-card-head">
    <span class="loci-card-mark">${LOGO}</span>
    <span class="loci-card-title">Memory</span>
    <button class="loci-card-ver" type="button">v3.1.0</button>
    <span class="loci-card-dot ${dot}"></span>
    <span class="loci-card-meta">updated ${stamp}</span>
  </div>`;

const card = (inner) => `<div class="loci-card-root" role="button" tabindex="0">${inner}</div>`;

const populated = card(
  [
    head('2026-11-15 19:40', 'is-warn'),
    `<div class="loci-card-grid">${metric('VERIFIED', 8)}${metric('PENDING', 2, 'is-warn')}${metric('DISPUTED', 0)}</div>`,
    `<div class="loci-card-known"><span class="loci-card-known-tag">Latest</span><span class="loci-card-known-text">Rollback window is 30 minutes; decide within that or escalate</span></div>`,
    `<div class="loci-card-barline"><div class="loci-card-bar"><div class="loci-card-bar-fill" style="width:12%"></div></div><span class="loci-card-bar-label">412 / 3584 B</span></div>`,
    `<div class="loci-card-foot"><span>Injected 34</span><span>Opened 12</span><span>Dead 2</span><span class="loci-card-foot-grow"></span></div>`,
    `<button class="loci-card-hint loci-card-hint-action" type="button">2 item(s) waiting for you in Review.</button>`,
  ].join(''),
);

const empty = card(
  [head('2026-11-15 19:40'), `<div class="loci-card-empty">Nothing saved yet</div>`, `<div class="loci-card-hint">Ask the agent to remember something, then confirm it here.</div>`].join(''),
);

// A mock of the panel body so the readable-column change is visible, not asserted.
const panelRow = (title, meta) => `
  <div class="loci-row">
    <span class="loci-id">m_01J9F2…</span>
    <div class="loci-main"><div class="loci-name">${title}</div><div class="loci-meta">${meta}</div></div>
    <div class="loci-actions"><span class="loci-pill is-verified">verified</span><button class="loci-btn">Verify</button></div>
  </div>`;

const panel = `
  <div class="loci-root" style="height:520px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base)">
    <div class="loci-bar">
      <span class="loci-title">Memory</span><span class="loci-grow"></span>
      <div class="loci-tabs">
        <button class="loci-tab is-active">Feed</button><button class="loci-tab">Index</button>
        <button class="loci-tab">Search</button><button class="loci-tab">Review</button><button class="loci-tab">Stats</button>
      </div>
    </div>
    <div class="loci-body">
      <div class="loci-muted" style="margin-bottom:8px">What was remembered, revised, verified or removed. Newest first.</div>
      <div class="loci-muted" style="margin-bottom:10px;padding:8px 10px;border-left:2px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);border-radius:0 6px 6px 0">Review tab: proposals waiting for a person. Verified entries enter the prompt; disputed ones are kept but excluded.</div>
      ${panelRow('Rollback window is 30 minutes', 'procedural · 2026-11-15 19:12 · workspace')}
      ${panelRow('Deploy order is staging to canary to full', 'procedural · 2026-11-15 18:40 · workspace')}
      ${panelRow('Never run migrations directly on production', 'rule · 2026-11-15 17:02 · project')}
    </div>
  </div>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><title>loci ui</title>
<style>
  :root { ${Object.entries(TOKENS).map(([k, v]) => `${k}: ${v};`).join(' ')} }
  body { margin: 0; padding: 16px; background: #f7f7f8; font-family: -apple-system, "Segoe UI", system-ui, sans-serif; color: var(--dsw-alias-label-primary); }
  .side { width: 300px; display: flex; flex-direction: column; gap: 14px; }
  .cap { font-size: 11px; color: #6d6d78; margin: 4px 0 -6px; }
  .wide { width: 1040px; margin-top: 18px; }
${css}
</style></head><body>
  <div class="side">
    <div class="cap">sidebar card — populated</div>${populated}
    <div class="cap">sidebar card — empty</div>${empty}
  </div>
  <div class="wide"><div class="cap">panel — readable column, not edge to edge</div>${panel}</div>
</body></html>`;

const dir = mkdtempSync(join(tmpdir(), 'loci-shot-'));
const page = join(dir, 'ui.html');
writeFileSync(page, html, 'utf8');
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
execFileSync(
  edge,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=2',
    `--user-data-dir=${join(dir, 'profile')}`,
    '--window-size=1100,780',
    `--screenshot=${join(process.cwd(), out)}`,
    `file:///${page.replace(/\\/g, '/')}`,
  ],
  { stdio: 'ignore' },
);
console.log(`wrote ${out}`);
