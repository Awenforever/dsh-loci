#!/usr/bin/env node
/**
 * Render the sidebar card to a PNG so UI changes can be inspected instead of imagined.
 *
 * Why a harness and not the live app: the DSH page runs in a browser with no CDP endpoint
 * open, so it cannot be attached to. This page pulls the **real stylesheet** out of
 * `client.js` (the same string the components render as `<style>`) and rebuilds the DOM the
 * component produces, so a broken layout, a wrong class name or a missing rule is visible.
 *
 * It cannot catch a mistake in the component's *logic* — only in what it draws. Everything
 * the harness invents is in `TOKENS` below.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = process.argv[2] ?? 'marketplace/screenshots/sidebar-card.png';
const source = readFileSync('client.js', 'utf8').replace(/\r\n/g, '\n');

// Extract the CSS template literal exactly as the components use it.
const cssStart = source.indexOf('const CSS = `');
if (cssStart < 0) throw new Error('CSS block not found');
const cssOpen = source.indexOf('`', cssStart) + 1;
const cssClose = source.indexOf('\n`;', cssOpen);
if (cssClose < 0) throw new Error('CSS terminator not found');
const css = source.slice(cssOpen, cssClose);

// Approximate DSH light-theme tokens; layout is what this harness verifies.
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

const metric = (label, value, tone = '') => `
  <div class="loci-card-metric">
    <span class="loci-card-metric-label">${label}</span>
    <span class="loci-card-metric-value${tone ? ' ' + tone : ''}">${value}</span>
  </div>`;

const card = (title, inner) => `
  <div class="loci-card-root" role="button" tabindex="0">${inner}</div>`;

const head = (version, stamp, dot = '') => `
  <div class="loci-card-head">
    <span class="loci-card-mark" aria-hidden="true">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
        <path d="M20 4c0 9-6.5 15-16 16 0 0 .5-7 4.5-11S20 4 20 4Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
        <path d="M5 20 14 10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
      </svg>
    </span>
    <span class="loci-card-title">Memory</span>
    <button class="loci-card-ver" type="button">v${version}</button>
    <span class="loci-card-dot ${dot}"></span>
    <span class="loci-card-meta">updated ${stamp}</span>
  </div>`;

const populated = card('Memory', [
  head('3.0.0', '2026-11-15 18:55', 'is-warn'),
  `<div class="loci-card-grid">${metric('VERIFIED', 8)}${metric('PENDING', 1, 'is-warn')}${metric('DISPUTED', 0)}</div>`,
  `<div class="loci-card-barline">
     <div class="loci-card-bar"><div class="loci-card-bar-fill" style="width:10%"></div></div>
     <span class="loci-card-bar-label">354 / 3584 B</span>
   </div>`,
  `<div class="loci-card-foot">
     <span>Injected 34</span><span>Opened 12</span><span>Dead 2</span>
     <span class="loci-card-foot-grow"></span>
   </div>`,
  `<div class="loci-card-hint">1 item(s) waiting for you in Review.</div>`,
].join(''));

const nearFull = card('Memory', [
  head('3.0.0', '2026-11-15 19:02', 'is-error'),
  `<div class="loci-card-grid">${metric('VERIFIED', 120)}${metric('PENDING', 0)}${metric('DISPUTED', 3, 'is-error')}</div>`,
  `<div class="loci-card-barline">
     <div class="loci-card-bar"><div class="loci-card-bar-fill is-warn" style="width:92%"></div></div>
     <span class="loci-card-bar-label">3297 / 3584 B</span>
   </div>`,
  `<div class="loci-card-foot">
     <span>Injected 1204</span><span>Opened 87</span><span>Dead 61</span>
     <span class="loci-card-foot-grow"></span>
   </div>`,
].join(''));

const empty = card('Memory', [
  head('3.0.0', '2026-11-15 19:02'),
  `<div class="loci-card-empty">Nothing saved yet</div>`,
  `<div class="loci-card-hint">Ask the agent to remember something, then confirm it here.</div>`,
].join(''));

const reference = `
  <div style="border:1px solid #e5e5ea;border-radius:12px;background:#fff;box-shadow:0 3px 12px rgba(0,0,0,.16);padding:10px 9px 8px;display:flex;flex-direction:column;gap:5px;">
    <div style="display:flex;align-items:center;gap:6px;">
      <span style="font-size:13px;font-weight:700;">USTC</span>
      <span style="font-size:8.5px;color:#6d6d78;">v1.1.17</span>
      <span style="flex:1"></span>
      <span style="font-size:8.5px;color:#6d6d78;">updated 18:57:27</span>
    </div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:3px 8px;">
      <div><div style="font-size:8px;color:#6d6d78;">3H</div><div style="font-size:12px;font-weight:600;">0/30</div></div>
      <div><div style="font-size:8px;color:#6d6d78;">12H</div><div style="font-size:12px;font-weight:600;">16.9/70</div></div>
      <div><div style="font-size:8px;color:#6d6d78;">24H</div><div style="font-size:12px;font-weight:600;">51.3/100</div></div>
    </div>
    <div style="display:flex;gap:6px;align-items:center;">
      <div style="flex:1;height:4px;border-radius:999px;background:#f1f1f4;overflow:hidden;"><div style="width:51%;height:100%;background:#1f9d55;border-radius:999px;"></div></div>
      <span style="font-size:8.5px;color:#6d6d78;">51%</span>
    </div>
  </div>`;

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>loci card harness</title>
<style>
  :root { ${Object.entries(TOKENS).map(([k, v]) => `${k}: ${v};`).join(' ')} }
  body { margin: 0; padding: 16px; background: #f7f7f8; font-family: -apple-system, "Segoe UI", system-ui, sans-serif; color: var(--dsw-alias-label-primary); }
  .col { width: 320px; display: flex; flex-direction: column; gap: 14px; }
  .cap { font-size: 11px; color: #6d6d78; }
${css}
</style></head>
<body><div class="col">
  <div class="cap">populated</div>${populated}
  <div class="cap">near budget / dead weight</div>${nearFull}
  <div class="cap">empty</div>${empty}
  <div class="cap">reference: neighbouring card proportions</div>${reference}
</div></body></html>`;

const dir = mkdtempSync(join(tmpdir(), 'loci-shot-'));
const page = join(dir, 'card.html');
writeFileSync(page, html, 'utf8');

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = join(dir, 'profile');
execFileSync(edge, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--force-device-scale-factor=2',
  `--user-data-dir=${profile}`,
  '--window-size=360,900',
  `--screenshot=${join(process.cwd(), out)}`,
  `file:///${page.replace(/\\/g, '/')}`,
], { stdio: 'ignore' });
console.log(`wrote ${out} from the real stylesheet in client.js`);
