/**
 * Build a static preview of the memory axis from real store data.
 *
 * The rendered panel cannot be screenshotted from this session when the sidebar browser is bound to another
 * conversation, so this writes a standalone page using the **same CSS and the same layout algorithm** as
 * `client.js`, filled with the live store. It is a preview for a human to look at, not a second
 * implementation: if it disagrees with the panel, this file is the thing that is wrong.
 *
 * Usage: node scripts/diag/axis-preview.mjs [outfile]
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const out = process.argv[2] ?? join(process.env.TEMP ?? '.', 'loci-axis-preview.html');
const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '6.1.1' });
const positions = store.muPositions({});
const R = Number(positions.parameters?.entranceDepth) || 2000;
const knowledge = store.db
  .prepare(
    `SELECT id, kind, title, applies FROM memory
      WHERE status = 'verified' AND valid_to IS NULL ORDER BY pinned DESC, COALESCE(verified_at, updated_at) DESC LIMIT 1`,
  )
  .get();
store.close();

const PULSE_WINDOW = 40;
const VITALITY_WINDOW = 150;
const axisState = (entry) => {
  const p = Number(entry.p);
  if (Number.isFinite(p) && p >= 0.6 * R) return 'new';
  const since = entry.sinceRecall;
  if (since !== null && since !== undefined && Number(since) <= VITALITY_WINDOW) return 'awake';
  return 'idle';
};

const placed = positions.entries.filter((entry) => entry.p !== null && Number.isFinite(Number(entry.p)));
const furthestLeft = placed.reduce((low, entry) => Math.min(low, Number(entry.p)), 0);
const left = Math.min(-0.6 * R, furthestLeft * 1.05);
const span = Math.max(1e-6, R - left);
const at = (p, compact) => (compact ? 6 + ((Number(p) - left) / span) * 88 : ((Number(p) - left) / span) * 100);

function renderAxis(list, compact) {
  const columnWidth = compact ? 20 : 2.6;
  const sorted = [...list].sort((a, b) => Number(a.p) - Number(b.p));
  const seen = new Map();
  for (const entry of sorted) {
    const bin = Math.floor(at(entry.p, compact) / columnWidth);
    const depth = seen.get(bin) ?? 0;
    seen.set(bin, depth + 1);
    entry.__depth = depth;
  }
  const laneStep = compact ? 8 : 12;
  const tallest = sorted.reduce((max, entry) => Math.max(max, entry.__depth), 0);
  const baseline = compact ? 14 : (tallest + 1) * laneStep + 8;
  const height = compact ? baseline + 6 : baseline + 26;
  const laneY = (depth) => baseline - Number(depth) * laneStep;

  const syms = sorted
    .map((entry) => {
      const p = Number(entry.p);
      const state = axisState(entry);
      const standing = entry.applies === 'always' || entry.pinned === true;
      const importance = Math.min(5, Math.max(1, Number(entry.importance) || 3));
      const size = compact ? 10 : 8 + importance * 1.7;
      const since = entry.sinceRecall;
      const age = since === null || since === undefined ? VITALITY_WINDOW * 1.5 : Number(since);
      const halo = Math.max(0, Math.min(1, 1 - age / (VITALITY_WINDOW * 1.5)));
      const pulse = since !== null && since !== undefined && Number(since) <= PULSE_WINDOW;
      const cls = ['loci-sym', `loci-sym-${state}`];
      if (standing) cls.push('loci-sym-standing');
      if (pulse) cls.push('loci-sym-pulse');
      const title = `${entry.title ?? entry.id} — ${Math.round(p)} μ${standing ? ' · always' : ' · topical'}`;
      return (
        `<span class="${cls.join(' ')}" title="${title.replace(/"/g, '&quot;')}" style="` +
        `left:${at(p).toFixed(2)}%;top:${laneY(entry.__depth)}px;width:${size}px;height:${size}px;` +
        `color:${standing ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-brand-primary)'};` +
        `--halo:${halo.toFixed(3)};--vital:${halo.toFixed(3)};opacity:${(0.4 + halo * 0.6).toFixed(3)};` +
        `z-index:${entry.injections > 0 ? 3 : 2}"></span>`
      );
    })
    .join('\n    ');

  const ticks = compact
    ? ''
    : [
        [-0.6 * R, 'forgotten'],
        [0, 'habitat'],
        [0.6 * R, 'entrance'],
      ]
        .map(([p, label]) => `<span class="loci-axis-tick" style="left:${at(p).toFixed(2)}%">${label}</span>`)
        .join('\n    ');

  return `<div class="loci-axis${compact ? ' loci-axis-compact' : ''}" style="height:${height}px">
    <div class="loci-axis-track" style="top:${baseline}px"></div>
    ${syms}
    ${ticks}
  </div>`;
}

const regions = positions.regions ?? {};
const latestEntry = placed.find((entry) => entry.id === knowledge?.id);

const page = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>Loci — 记忆空间</title>
<style>
  :root {
    --dsw-alias-bg-base:#12141a; --dsw-alias-bg-layer-1:#181b23; --dsw-alias-bg-layer-2:#1e222b;
    --dsw-alias-border-l1:#2a2f3a; --dsw-alias-label-primary:#e6e9ef; --dsw-alias-label-secondary:#9aa3b2;
    --dsw-alias-brand-primary:#5b8cff; --dsw-alias-state-success-primary:#3fb950;
    --dsw-alias-state-warn-primary:#d29922; --dsw-alias-state-error-primary:#f85149;
    --dsw-alias-state-idle-primary:#6e7681;
  }
  body { margin:0; padding:24px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary);
    font-family:"Segoe UI","Microsoft YaHei UI","Microsoft YaHei",sans-serif; }
  .wrap { max-width:760px; margin:0 auto; }
  .loci-section { font-size:11px; color:var(--dsw-alias-label-secondary); margin:16px 0 6px;
    text-transform:uppercase; letter-spacing:.04em; }
  .loci-grid { display:grid; grid-template-columns:repeat(5,1fr); gap:8px; }
  .loci-cell { background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1);
    border-radius:8px; padding:8px 10px; }
  .loci-label { display:block; font-size:11px; color:var(--dsw-alias-label-secondary); }
  .loci-cell b { font-size:17px; }
  .loci-meta { font-size:11.5px; color:var(--dsw-alias-label-secondary); line-height:1.5; }

  .loci-card-known { display:flex; gap:5px; align-items:baseline; min-width:0; flex-wrap:wrap; }
  .loci-card-known-tag { flex:0 0 auto; font-size:8px; letter-spacing:.05em; text-transform:uppercase;
    color:var(--dsw-alias-label-secondary); }
  .loci-card-known-text { min-width:0; flex:1 1 100%; font-size:11.5px; line-height:1.5;
    font-family:"Segoe UI","Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif;
    color:var(--dsw-alias-label-primary); white-space:normal; word-break:break-word; }
  .loci-card-chip { flex:0 0 auto; font-size:8.5px; line-height:1.4; padding:0 4px; border-radius:3px;
    border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); text-transform:lowercase; }
  .loci-card-chip.is-standing { border-color:var(--dsw-alias-state-success-primary);
    color:var(--dsw-alias-state-success-primary); }
  .loci-card-chip.is-quiet { border-color:transparent; padding:0 2px; }

.loci-axis { position: relative; margin: 2px 0 0; }
.loci-axis-track { position: absolute; left: 0; right: 0; height: 2px; border-radius: 1px;
  background: linear-gradient(90deg, var(--dsw-alias-state-error-primary) 0%, var(--dsw-alias-state-warn-primary) 22%,
  var(--dsw-alias-state-success-primary) 50%, var(--dsw-alias-brand-primary) 100%); opacity: .18; }
.loci-sym { position: absolute; transform: translate(-50%, -50%);
  transition: left .7s cubic-bezier(.22,.61,.36,1), opacity .7s ease, width .4s ease, height .4s ease; }
.loci-sym::before, .loci-sym::after { content: ''; position: absolute; }
.loci-sym-new::before { inset: 0; background: currentColor;
  clip-path: polygon(50% 0%, 58% 31%, 85% 15%, 69% 42%, 100% 50%, 69% 58%, 85% 85%, 58% 69%, 50% 100%, 42% 69%, 15% 85%, 31% 58%, 0% 50%, 31% 42%, 15% 15%, 42% 31%);
  animation: loci-arrive 2.4s ease-in-out infinite; }
.loci-sym-new::after { inset: -55%; border-radius: 50%;
  background: radial-gradient(circle, currentColor 0%, transparent 62%); opacity: calc(var(--halo) * .45); }
.loci-sym-awake::before { inset: 0; background: currentColor;
  clip-path: polygon(50% 0%, 56% 44%, 100% 50%, 56% 56%, 50% 100%, 44% 56%, 0% 50%, 44% 44%);
  transform: scale(calc(.55 + var(--vital) * .55));
  animation: loci-breathe 2.8s ease-in-out infinite; }
.loci-sym-awake::after { inset: -45%; border-radius: 50%;
  background: radial-gradient(circle, currentColor 0%, transparent 66%); opacity: calc(var(--halo) * .34); }
.loci-sym-idle::before { inset: 32%; border-radius: 50%; background: currentColor; opacity: .92; }
.loci-sym-idle::after { inset: -60%; border-radius: 50%;
  background: radial-gradient(circle, currentColor 0%, transparent 68%);
  opacity: calc(var(--halo) * .3); animation: loci-breathe 4.2s ease-in-out infinite; }
@keyframes loci-breathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.16); } }
@keyframes loci-arrive { 0%, 100% { transform: scale(1) rotate(0deg); } 50% { transform: scale(1.1) rotate(22.5deg); } }
.loci-axis-tick { position: absolute; bottom: 2px; font-size: 8.5px; color: var(--dsw-alias-label-secondary);
  transform: translateX(-50%); pointer-events: none; white-space: nowrap; }
.loci-axis-compact { margin: 0; }
.loci-axis-compact .loci-axis-track { height: 1px; opacity: .12; }
</style></head>
<body><div class="wrap">

  <div class="loci-section">Sidebar card — latest</div>
  <div class="loci-card-known">
    <span class="loci-card-known-tag">Latest</span>
    ${knowledge?.applies === 'always' ? '<span class="loci-card-chip is-standing">always</span>' : '<span class="loci-card-chip">topic</span>'}
    ${knowledge?.kind ? `<span class="loci-card-chip is-quiet">${knowledge.kind}</span>` : ''}
    <span class="loci-card-known-text">${(knowledge?.title ?? '').replace(/</g, '&lt;')}</span>
  </div>
  ${latestEntry === undefined ? '<div class="loci-meta">（latest 条目没有锚点，迷你轴不画）</div>' : renderAxis([latestEntry], true)}

  <div class="loci-section">Position on the axis</div>
  ${renderAxis(placed, false)}

  <div class="loci-grid" style="margin-top:26px">
    <div class="loci-cell"><span class="loci-label">entrance</span><b>${regions.entrance ?? 0}</b></div>
    <div class="loci-cell"><span class="loci-label">digesting</span><b>${regions.digesting ?? 0}</b></div>
    <div class="loci-cell"><span class="loci-label">habitat</span><b>${regions.habitat ?? 0}</b></div>
    <div class="loci-cell"><span class="loci-label">compressing</span><b>${regions.compressing ?? 0}</b></div>
    <div class="loci-cell"><span class="loci-label">forgotten</span><b>${regions.forgotten ?? 0}</b></div>
  </div>

  <div class="loci-meta" style="margin-top:8px">
    ${placed.length} entries · μ ${positions.now.toFixed(0)} · R ${R}<br>
    <b>八芒星</b> = 新进入（还没消化完） · <b>四芒星</b> = 近期被唤醒 · <b>暗核+呼吸光晕</b> = 已沉静、正在老化<br>
    <b style="color:#3fb950">绿</b> = 常驻 · <b style="color:#5b8cff">蓝</b> = 话题性 · 大小 = importance · 亮度与光晕 = 年龄
  </div>

</div></body></html>`;

writeFileSync(out, page, 'utf8');
console.log(`wrote ${out}`);
console.log(`entries ${placed.length} · now ${positions.now.toFixed(0)} · R ${R}`);
console.log(`regions ${JSON.stringify(regions)}`);
console.log(`latest: ${knowledge?.kind}/${knowledge?.applies} ${JSON.stringify(String(knowledge?.title ?? '').slice(0, 30))}`);
const states = placed.reduce((acc, entry) => {
  const s = axisState(entry);
  acc[s] = (acc[s] ?? 0) + 1;
  return acc;
}, {});
console.log(`symbols ${JSON.stringify(states)}`);
