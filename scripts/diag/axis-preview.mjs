/**
 * Build a static preview of the memory axis from real store data.
 *
 * The rendered panel cannot be screenshotted from this session — the sidebar browser is bound to another
 * conversation — so this writes a standalone page using the **same CSS rules and the same lane-stacking
 * algorithm** as `client.js`, filled with the live store. It is a preview for a human to look at, not a
 * second implementation: if it disagrees with the panel, this file is the thing that is wrong.
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
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '6.0.1' });
const positions = store.muPositions({});
const R = Number(positions.parameters?.entranceDepth) || 2000;
store.close();

const placed = positions.entries.filter((entry) => entry.p !== null && Number.isFinite(Number(entry.p)));
const furthestLeft = placed.reduce((low, entry) => Math.min(low, Number(entry.p)), 0);
const left = Math.min(-R * 1.1, furthestLeft * 1.05);
const span = Math.max(1e-6, R - left);
const at = (p) => ((Number(p) - left) / span) * 100;

/** Mirrors the lane algorithm in `client.js`: separate dots that would land on top of each other. */
function layoutLanes(list, compact) {
  const minGap = compact ? 3.5 : 2.4;
  const lanes = [];
  const sorted = [...list].sort((a, b) => Number(a.p) - Number(b.p));
  for (const entry of sorted) {
    const x = at(entry.p);
    let lane = 0;
    while (lane < lanes.length && lanes[lane].some((taken) => Math.abs(taken - x) < minGap)) lane += 1;
    if (lane === lanes.length) lanes.push([]);
    lanes[lane].push(x);
    entry.__lane = lane;
  }
  const laneCount = Math.max(1, lanes.length);
  const laneStep = compact ? 6 : 9;
  // The track is the baseline and the dots rise from it, like a histogram — same rule as `client.js`.
  const baseline = compact ? 12 : laneCount * laneStep + 8;
  const height = compact ? baseline + 4 : baseline + 22;
  return { sorted, laneCount, laneStep, baseline, height, laneY: (lane) => baseline - lane * laneStep };
}

function renderAxis(list, compact) {
  const { sorted, baseline, height, laneY } = layoutLanes(list, compact);
  const dots = sorted
    .map((entry) => {
      const p = Number(entry.p);
      const standing = entry.applies === 'always' || entry.pinned === true;
      const importance = Math.min(5, Math.max(1, Number(entry.importance) || 3));
      const size = compact ? 4 : 5 + importance;
      const away = Math.min(1, Math.abs(p) / R);
      const awake = entry.sinceRecall !== null && entry.sinceRecall <= 40;
      const cls = ['loci-axis-dot'];
      if (standing) cls.push('loci-axis-dot-standing');
      if (awake) cls.push('loci-axis-dot-awake');
      if (p < -0.6 * R) cls.push('loci-axis-dot-fading');
      const title = `${entry.title ?? entry.id} — ${Math.round(p)} μ${entry.injections > 0 ? ` · shown ${entry.injections}×` : ' · never shown'}`;
      return (
        `<span class="${cls.join(' ')}" title="${title.replace(/"/g, '&quot;')}" ` +
        `style="left:${at(p).toFixed(2)}%;top:${laneY(entry.__lane ?? 0)}px;width:${size}px;height:${size}px;` +
        `opacity:${(1 - away * 0.65).toFixed(3)};z-index:${entry.injections > 0 ? 3 : 2}"></span>`
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
        .map(
          ([p, label]) =>
            `<span class="loci-axis-tick" style="left:${at(p).toFixed(2)}%">${label}</span>`,
        )
        .join('\n    ');
  return `<div class="loci-axis${compact ? ' loci-axis-compact' : ''}" style="height:${height}px">
    <div class="loci-axis-track" style="top:${baseline}px"></div>
    ${dots}
    ${ticks}
  </div>`;
}

const regions = positions.regions ?? {};
const page = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>Loci — 记忆空间</title>
<style>
  :root {
    --dsw-alias-bg-base:#12141a; --dsw-alias-bg-layer-1:#181b23;
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
  .loci-card-known-text { min-width:0; font-size:11.5px; line-height:1.45;
    font-family:"Segoe UI","Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif;
    color:var(--dsw-alias-label-primary); overflow:hidden; display:-webkit-box; -webkit-line-clamp:2;
    -webkit-box-orient:vertical; }
  .loci-card-known-tag { font-size:8px; letter-spacing:.05em; text-transform:uppercase;
    color:var(--dsw-alias-label-secondary); margin-right:6px; }

  .loci-axis { position:relative; margin:4px 0 2px; }
  .loci-axis-track { position:absolute; left:0; right:0; height:3px; border-radius:2px;
    background:linear-gradient(90deg,var(--dsw-alias-state-error-primary) 0%,var(--dsw-alias-state-warn-primary) 22%,
    var(--dsw-alias-state-success-primary) 50%,var(--dsw-alias-brand-primary) 100%); opacity:.22; }
  .loci-axis-dot { position:absolute; border-radius:50%; background:var(--dsw-alias-brand-primary);
    transform:translate(-50%,-50%); transition:left .6s cubic-bezier(.22,.61,.36,1),opacity .6s ease; }
  .loci-axis-dot-standing { border-radius:1.5px; background:var(--dsw-alias-state-success-primary); }
  .loci-axis-dot-fading { background:var(--dsw-alias-state-idle-primary); }
  .loci-axis-dot-awake { animation:loci-awake 1.6s ease-out 3; }
  @keyframes loci-awake { 0%{box-shadow:0 0 0 0 var(--dsw-alias-brand-primary);}
    70%{box-shadow:0 0 0 5px rgba(0,0,0,0);} 100%{box-shadow:0 0 0 0 rgba(0,0,0,0);} }
  .loci-axis-tick { position:absolute; top:calc(100% - 12px); font-size:8.5px;
    color:var(--dsw-alias-label-secondary); transform:translateX(-50%); pointer-events:none; white-space:nowrap; }
  .loci-axis-compact { margin:0; }
  .loci-axis-compact .loci-axis-track { height:2px; }
</style></head>
<body><div class="wrap">

  <div class="loci-card-known-text" style="margin-bottom:4px">
    <span class="loci-card-known-tag">Latest</span>位置切换图标不要用简单的左右箭头，需另选更美观的图标（这张卡片验证 11.5px 中文字号）
  </div>

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
    ${placed.length} entries · μ ${positions.now.toFixed(0)} · R ${R} ·
    圆点 = 话题性，方块 = 常驻 · 透明度 = 离栖息地的距离 · 脉冲 = 最近 40 μ 内被召回 · 悬停看标题
  </div>

  <div class="loci-section">Card miniature</div>
  ${renderAxis(placed, true)}

</div></body></html>`;

writeFileSync(out, page, 'utf8');
console.log(`wrote ${out}`);
console.log(`entries ${placed.length} · now ${positions.now.toFixed(0)} · R ${R} · lanes ${layoutLanes([...placed], false).laneCount}`);
console.log(`regions ${JSON.stringify(regions)}`);
