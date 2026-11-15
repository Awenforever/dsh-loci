#!/usr/bin/env node
/**
 * Render the panel — feed with legend, and the detail view — from the real stylesheet.
 *
 * The card harness (`shot-card.mjs`) proves the sidebar; this one proves the panel, which is
 * where the complaints were: "I don't understand anything in here", an arrow that led to a
 * blank page, and type that was a notch smaller than the native Plugins panel.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = process.argv[2] ?? 'marketplace/screenshots/panel.png';
const source = readFileSync('client.js', 'utf8').replace(/\r\n/g, '\n');
const open = source.indexOf('const CSS = `') + 'const CSS = `'.length;
const css = source.slice(open, source.indexOf('\n`;', open));

const TOKENS = {
  '--dsw-alias-bg-base': '#ffffff',
  '--dsw-alias-bg-layer-1': '#ffffff',
  '--dsw-alias-bg-layer-2': '#f5f5f7',
  '--dsw-alias-bg-layer-3': '#ececf0',
  '--dsw-alias-border-l1': '#ebebef',
  '--dsw-alias-border-l2': '#e0e0e6',
  '--dsw-alias-border-l3': '#d6d6dd',
  '--dsw-alias-border-l4': '#c6c6cf',
  '--dsw-alias-label-primary': '#16161c',
  '--dsw-alias-label-secondary': '#6d6d78',
  '--dsw-alias-label-tertiary': '#9a9aa5',
  '--dsw-alias-brand-primary': '#3b6ef5',
  '--dsw-alias-state-success-primary': '#1f9d55',
  '--dsw-alias-state-warn-primary': '#c97b00',
  '--dsw-alias-state-error-primary': '#d32f2f',
  '--dsw-alias-state-idle-primary': '#9a9aa5',
  '--dsw-alias-interactive-bg-hover': '#f2f2f5',
  '--dsw-radius-xl': '12px',
};

const row = (tag, tagClass, title, meta, snippet) => `
  <button class="loci-row" type="button">
    <div class="loci-main">
      <div class="loci-name">${title}</div>
      <div class="loci-meta">
        <span class="loci-tag ${tagClass}">${tag}</span>
        ${meta.map((m) => `<span>${m}</span>`).join('')}
      </div>
      ${snippet === undefined ? '' : `<div class="loci-snippet">${snippet}</div>`}
    </div>
    <div class="loci-actions"><span class="loci-chevron">→</span></div>
  </button>`;

const feed = `
  <div class="loci-root" style="height:470px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-base);overflow:hidden">
    <div class="loci-bar">
      <span class="loci-title">Memory</span>
      <span class="loci-scope"><select class="loci-select" title="auto: no project found, so this stays in this conversation">
        <option>Automatic — session</option>
        <option>This project</option>
        <option>This conversation only</option>
        <option>Whole workspace</option>
        <option>Everywhere (global)</option>
      </select></span>
      <span class="loci-grow"></span>
      <div class="loci-tabs">
        <button class="loci-tab is-active">Feed</button><button class="loci-tab">Index</button>
        <button class="loci-tab">Search</button><button class="loci-tab">Review</button><button class="loci-tab">Stats</button>
      </div>
    </div>
    <div class="loci-body">
      <div class="loci-meta" style="margin-bottom:8px;align-items:center">
        <span class="loci-muted">What was remembered, revised, verified or removed. Newest first.</span>
        <span class="loci-grow"></span>
        <button class="loci-btn" type="button">Refresh</button>
      </div>
      <div class="loci-legend">
        <span class="loci-legend-item"><span class="loci-tag is-added">added</span><span>saved, but the model cannot see it yet</span></span>
        <span class="loci-legend-item"><span class="loci-tag is-verified">verified</span><span>approved by a person, so it is in the model's prompt</span></span>
        <span class="loci-legend-item"><span class="loci-tag is-deleted">disputed</span><span>marked wrong, kept in history, never injected</span></span>
      </div>
      ${row('added → verified', 'is-verified', 'Rollback window is 30 minutes', ['2h ago', 'procedural', 'default-workspace'])}
      ${row('added', 'is-added', 'Deploy order is staging to canary to full', ['5h ago', 'procedural', 'default-workspace'])}
      ${row('added → verified → revised', 'is-revised', 'Never run migrations directly on production', ['yesterday', 'rule', 'default-workspace'], 'The rule changed after the incident: migrations now require a paired operator.')}
    </div>
  </div>`;

const detail = `
  <div class="loci-root" style="height:470px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-base);overflow:hidden">
    <div class="loci-bar"><span class="loci-title">Memory</span></div>
    <div class="loci-body">
      <div class="loci-detail-head">
        <button class="loci-btn" type="button">← Back</button>
        <span class="loci-grow"></span>
        <div class="loci-actions">
          <button class="loci-btn is-primary" type="button">Verify</button>
          <button class="loci-btn" type="button">Dispute</button>
          <button class="loci-btn" type="button">Pin</button>
        </div>
      </div>
      <div class="loci-name" style="font-size:15px;font-weight:600;white-space:normal">Rollback window is 30 minutes</div>
      <div class="loci-meta">
        <span class="loci-id">m_01M7FM2X3RBMYQRNH251@1</span>
        <span class="loci-pill is-verified">verified</span>
        <span>procedural</span>
        <span>workspace:default-workspace</span>
        <span>2026-11-15 → now</span>
      </div>
      <div class="loci-section">Body</div>
      <pre class="loci-pre">After a production incident you must decide within thirty minutes whether to roll back or continue. Past that window, escalate to the on-call lead.</pre>
      <div class="loci-section">Evidence</div>
      <div class="loci-evidence">回滚窗口是三十分钟，超时升级给值班负责人。</div>
    </div>
  </div>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><title>loci panel</title>
<style>
  :root { ${Object.entries(TOKENS).map(([k, v]) => `${k}: ${v};`).join(' ')} }
  body { margin:0; padding:18px; background:#f7f7f8; font-family:-apple-system,"Segoe UI",system-ui,sans-serif; color:var(--dsw-alias-label-primary); }
  .wrap { width:1000px; display:flex; flex-direction:column; gap:16px; }
  .cap { font-size:12px; color:#6d6d78; margin-bottom:-8px; }
${css}
</style></head><body><div class="wrap">
  <div class="cap">feed — legend says what the tags mean; the whole row is clickable</div>${feed}
  <div class="cap">detail — the arrow used to land here and show nothing</div>${detail}
</div></body></html>`;

const dir = mkdtempSync(join(tmpdir(), 'loci-panel-'));
const page = join(dir, 'panel.html');
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
    '--window-size=1040,1060',
    `--screenshot=${join(process.cwd(), out)}`,
    `file:///${page.replace(/\\/g, '/')}`,
  ],
  { stdio: 'ignore' },
);
console.log(`wrote ${out}`);
