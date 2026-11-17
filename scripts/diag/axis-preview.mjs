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
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '6.2.0' });
const positions = store.muPositions({});
const R = Number(positions.parameters?.entranceDepth) || 120;
const knowledge = store.db
  .prepare(
    `SELECT m.id, m.kind, m.title, m.applies FROM memory m
      WHERE m.status = 'verified' AND m.valid_to IS NULL
      ORDER BY m.pinned DESC, COALESCE(m.verified_at, m.updated_at) DESC LIMIT 1`,
  )
  .get();
store.close();

const PULSE_WINDOW = 40;
const VITALITY_WINDOW = 150;

/** Mirrors `vitalityOf` in client.js: one number for how alive an entry is. */
function vitalityOf(entry) {
  const p = Number(entry.p);
  const newness = Number.isFinite(p) ? Math.max(0, Math.min(1, p / R)) : 0;
  const since = entry.sinceRecall;
  const recency = since === null || since === undefined ? 0 : Math.max(0, 1 - Number(since) / VITALITY_WINDOW);
  const sunk = Number.isFinite(p) ? Math.max(0, Math.min(1, -p / (0.6 * R))) : 0;
  return Math.max(0, Math.min(1, Math.max(newness, recency) * (1 - sunk * 0.85)));
}

const placed = positions.entries.filter((entry) => entry.p !== null && Number.isFinite(Number(entry.p)));
const furthestLeft = placed.reduce((low, entry) => Math.min(low, Number(entry.p)), 0);
const left = Math.min(-0.6 * R, furthestLeft * 1.05);
const span = Math.max(1e-6, R - left);
const at = (p, compact) => (compact ? 8 + ((Number(p) - left) / span) * 84 : ((Number(p) - left) / span) * 100);

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
  const laneStep = compact ? 12 : 13;
  const tallest = sorted.reduce((max, entry) => Math.max(max, entry.__depth), 0);
  const baseline = compact ? 16 : (tallest + 1) * laneStep + 12;
  const height = compact ? baseline + 8 : baseline + 28;
  const laneY = (depth) => baseline - Number(depth) * laneStep;

  const stars = sorted
    .map((entry) => {
      const v = vitalityOf(entry);
      const standing = entry.applies === 'always' || entry.pinned === true;
      const importance = Math.min(5, Math.max(1, Number(entry.importance) || 3));
      const size = compact ? 15 : 9 + importance * 1.8;
      const since = entry.sinceRecall;
      const pulse = since !== null && since !== undefined && Number(since) <= PULSE_WINDOW;
      const title = `${entry.title ?? entry.id} — ${Math.round(Number(entry.p))} μ · vitality ${v.toFixed(2)}`;
      return (
        `<span class="loci-sym${pulse ? ' loci-sym-pulse' : ''}" title="${title.replace(/"/g, '&quot;')}" ` +
        `style="left:${at(entry.p, compact).toFixed(2)}%;top:${laneY(entry.__depth)}px;width:${size}px;height:${size}px;` +
        `color:${standing ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-brand-primary)'};` +
        `--vital:${v.toFixed(3)}">` +
        `<i class="loci-halo"></i><i class="loci-glow"></i><i class="loci-star"></i></span>`
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
        .map(([p, label]) => `<span class="loci-axis-tick" style="left:${at(p, compact).toFixed(2)}%">${label}</span>`)
        .join('\n    ');

  return `<div class="loci-axis${compact ? ' loci-axis-compact' : ''}" style="height:${height}px">
    <div class="loci-axis-track" style="top:${baseline}px"></div>
    ${stars}
    ${ticks}
  </div>`;
}

const regions = positions.regions ?? {};
const latestEntry = placed.find((entry) => entry.id === knowledge?.id);
const vitals = placed.map(vitalityOf);

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
  .loci-meta { font-size:11.5px; color:var(--dsw-alias-label-secondary); line-height:1.6; }

  .loci-card-known { display:flex; gap:5px; align-items:center; min-width:0; flex-wrap:wrap; row-gap:3px; }
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
  .loci-card-barline { display:flex; align-items:center; flex:1 1 24px; min-width:16px; margin-left:auto; }
  .loci-card-bar { height:3px; border-radius:2px; background:var(--dsw-alias-bg-layer-2); width:100%; overflow:hidden; }
  .loci-card-bar-fill { height:100%; border-radius:2px; background:var(--dsw-alias-brand-primary); }

.loci-axis { position: relative; margin: 4px 0 0; }
.loci-axis-track { position: absolute; left: 0; right: 0; height: 3px; border-radius: 2px;
  background: linear-gradient(90deg, var(--dsw-alias-state-error-primary) 0%, var(--dsw-alias-state-warn-primary) 24%,
  var(--dsw-alias-state-success-primary) 52%, var(--dsw-alias-brand-primary) 100%); opacity: .3; }
.loci-sym { position: absolute; transform: translate(-50%, -50%);
  transition: left .7s cubic-bezier(.22,.61,.36,1), opacity .7s ease, width .5s ease, height .5s ease; }
.loci-sym > i { position: absolute; display: block; pointer-events: none; }
.loci-halo { inset: -52%; border-radius: 50%;
  background: radial-gradient(circle, currentColor 0%, transparent 66%);
  opacity: clamp(0, calc((var(--vital) - 0.55) * 2.8), .5); }
.loci-glow { inset: 0; background: currentColor;
  clip-path: polygon(50% 0%, 57% 43%, 100% 50%, 57% 57%, 50% 100%, 43% 57%, 0% 50%, 43% 43%);
  filter: blur(2px);
  transform: scale(calc(1.05 + var(--vital) * 0.55));
  opacity: clamp(0, calc(var(--vital) * 1.15), .8); }
.loci-star { inset: 0; background: currentColor;
  clip-path: polygon(50% 0%, 56% 44%, 100% 50%, 56% 56%, 50% 100%, 44% 56%, 0% 50%, 44% 44%);
  transform: scale(calc(0.42 + var(--vital) * 0.58));
  opacity: clamp(.3, calc(0.3 + var(--vital) * 0.7), 1);
  filter: brightness(calc(0.55 + var(--vital) * 0.95)) saturate(calc(0.6 + var(--vital) * 0.7)); }
.loci-sym-pulse .loci-star { animation: loci-recall 1.4s ease-out 2; }
@keyframes loci-recall {
  0%   { filter: brightness(calc(0.55 + var(--vital) * 0.95)); }
  45%  { filter: brightness(2.1) drop-shadow(0 0 5px currentColor); }
  100% { filter: brightness(calc(0.55 + var(--vital) * 0.95)); }
}
.loci-axis-tick { position: absolute; bottom: 0; font-size: 10px; color: var(--dsw-alias-label-secondary);
  transform: translateX(-50%); pointer-events: none; white-space: nowrap; }
.loci-axis-compact { margin: 0; }
.loci-axis-compact .loci-axis-track { height: 3px; opacity: .34; }
</style></head>
<body><div class="wrap">

  <div class="loci-section">Sidebar card</div>
  <div class="loci-card-known">
    <span class="loci-card-known-tag">Latest</span>
    ${knowledge?.applies === 'always' ? '<span class="loci-card-chip is-standing">always</span>' : '<span class="loci-card-chip">topic</span>'}
    ${knowledge?.kind ? `<span class="loci-card-chip is-quiet">${knowledge.kind}</span>` : ''}
    <span class="loci-card-barline"><span class="loci-card-bar"><span class="loci-card-bar-fill" style="width:38%"></span></span></span>
    <span class="loci-card-known-text">${(knowledge?.title ?? '').replace(/</g, '&lt;')}</span>
  </div>
  ${latestEntry === undefined ? '<div class="loci-meta">（latest 条目没有锚点，迷你轴不画）</div>' : renderAxis([latestEntry], true)}

  <div class="loci-section">Position on the axis</div>
  ${renderAxis(placed, false)}

  <div class="loci-grid" style="margin-top:22px">
    <div class="loci-cell"><span class="loci-label">entrance</span><b>${regions.entrance ?? 0}</b></div>
    <div class="loci-cell"><span class="loci-label">digesting</span><b>${regions.digesting ?? 0}</b></div>
    <div class="loci-cell"><span class="loci-label">habitat</span><b>${regions.habitat ?? 0}</b></div>
    <div class="loci-cell"><span class="loci-label">compressing</span><b>${regions.compressing ?? 0}</b></div>
    <div class="loci-cell"><span class="loci-label">forgotten</span><b>${regions.forgotten ?? 0}</b></div>
  </div>

  <div class="loci-meta" style="margin-top:8px">
    ${placed.length} entries · μ ${positions.now.toFixed(1)} · R ${R} ·
    vitality ${Math.min(...vitals).toFixed(2)} – ${Math.max(...vitals).toFixed(2)}<br>
    一个符号，一条梯度：<b>亮核 + 长星芒 + 圆形光晕</b> → 圆形光晕先消失，剩下星形光晕 → 星芒回收、变暗 → 黯淡光点
  </div>

</div></body></html>`;

writeFileSync(out, page, 'utf8');
console.log(`wrote ${out}`);
console.log(`entries ${placed.length} · now ${positions.now.toFixed(2)} · R ${R}`);
console.log(`regions ${JSON.stringify(regions)}`);
console.log(`vitality min ${Math.min(...vitals).toFixed(2)} max ${Math.max(...vitals).toFixed(2)}`);
console.log(`latest: ${knowledge?.kind}/${knowledge?.applies} ${JSON.stringify(String(knowledge?.title ?? '').slice(0, 30))}`);
