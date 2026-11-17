#!/usr/bin/env node
/**
 * Apply the verdicts a person confirmed, entry by entry.
 *
 * This is deliberately *not* the heuristic in `applies-classify.mjs`. That script proposed verdicts; a
 * person reviewed them and disagreed with one of them — the "VM is reachable" entry is not standing, it is
 * *conditional*, and marking it `always` would have the model reason from a premise it cannot see. So the
 * list below is the human verdict, and the heuristics stay where they belong: in the proposal.
 *
 * Two other things happen here because the review surfaced them:
 *
 * - The AGENTS.md rule exists as **three separate entries** — same rule, three phrasings, written by the
 *   rule extractor and the curator independently. They are folded into the most complete one.
 * - The VM entry gets its premise recorded in `whenCondition`, which until this release was stored but
 *   never shown to a model.
 *
 * Every change is a normal revision, so `loci_get` still shows the earlier shapes and the audit keeps them.
 *
 * Usage: node scripts/diag/applies-apply-verdicts.mjs [--apply]
 */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { Store } from '../../src/host/store/store.js';

const apply = process.argv.includes('--apply');
const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '5.1.6' });

/** Confirmed by the operator on 2026-11-17. */
const ALWAYS = [
  { id: 'm_01M7JSC6MTW9C7MG3R17', why: 'acceptance: look at the result before declaring it done' },
  { id: 'm_01M7JM0DFRJXDWE5V15S', why: 'technique: find the listening port by PID, applies to any service' },
  { id: 'm_01M7JSC6N4XHZX71HRPE', why: 'handing work to another session: separate general from session-specific' },
];

/** The AGENTS.md rule, three copies. The target is the one whose body is most complete. */
const MERGE = {
  targetId: 'm_01M7KSXM2RHVYJV34HXY',
  sources: ['m_01M7KSYMNBQS5H45W0NV', 'm_01M7KSXM30MPXSNAP4YG'],
  why: 'one rule, three phrasings, written independently by the extractor and the curator',
};

/** Conditional, not standing. The premise is the point of the entry. */
const CONDITIONAL = {
  id: 'm_01M7JM7TXWF34BND8E6A',
  whenCondition: 'invictus 可达时（VM 运行在 invictus 上）',
  why: 'the entry is a conditional fact; as an unconditional title the model would reason from a false premise',
};

const look = (id) => {
  const row = store.db
    .prepare(
      `SELECT m.id, m.applies, m.kind, m.title, m.body, m.when_condition, m.scope_key, h.status
         FROM memory m JOIN memory_head h ON h.ord = m.ord
        WHERE m.id = ? AND m.valid_to IS NULL`,
    )
    .get(id);
  return row;
};

console.log('=== to be marked always ===');
for (const item of ALWAYS) {
  const row = look(item.id);
  if (row === undefined) {
    console.log(`  MISSING ${item.id}`);
    continue;
  }
  console.log(`  ${row.applies === 'always' ? 'already' : 'change '} ${row.id}  ${JSON.stringify(String(row.title).slice(0, 76))}`);
  console.log(`           why: ${item.why}`);
}

console.log('\n=== merge ===');
const mergeTarget = look(MERGE.targetId);
if (mergeTarget === undefined) {
  console.log(`  MISSING target ${MERGE.targetId}`);
} else {
  console.log(`  keep   ${mergeTarget.id}  ${JSON.stringify(String(mergeTarget.title).slice(0, 76))}`);
  for (const id of MERGE.sources) {
    const row = look(id);
    console.log(`  fold   ${id}  ${row === undefined ? '(missing)' : JSON.stringify(String(row.title).slice(0, 72))}`);
  }
  console.log(`         why: ${MERGE.why}`);
}

console.log('\n=== conditional, not standing ===');
const conditional = look(CONDITIONAL.id);
if (conditional === undefined) {
  console.log(`  MISSING ${CONDITIONAL.id}`);
} else {
  console.log(`  ${conditional.id}  applies=${conditional.applies}`);
  console.log(`    ${JSON.stringify(String(conditional.title).slice(0, 80))}`);
  console.log(`    whenCondition -> ${JSON.stringify(CONDITIONAL.whenCondition)}`);
  console.log(`    why: ${CONDITIONAL.why}`);
}

if (!apply) {
  console.log('\ndry run — nothing written. Re-run with --apply.');
  store.close();
  process.exit(0);
}

let changed = 0;
for (const item of ALWAYS) {
  const row = look(item.id);
  if (row === undefined) continue;
  store.update(item.id, {
    scope: 'workspace',
    scopeKey: row.scope_key,
    title: row.title,
    body: row.body,
    applies: 'always',
  });
  changed += 1;
}

if (mergeTarget !== undefined) {
  const sources = MERGE.sources.filter((id) => look(id) !== undefined);
  if (sources.length > 0) {
    store.merge({ targetId: MERGE.targetId, sourceIds: sources });
    changed += 1;
  }
  // The merged rule is standing regardless of whether there was anything to fold.
  const afterMerge = look(MERGE.targetId);
  if (afterMerge !== undefined) {
    store.update(MERGE.targetId, {
      scope: 'workspace',
      scopeKey: afterMerge.scope_key,
      title: afterMerge.title,
      body: afterMerge.body,
      applies: 'always',
    });
    changed += 1;
  }
}

if (conditional !== undefined) {
  store.update(CONDITIONAL.id, {
    scope: 'workspace',
    scopeKey: conditional.scope_key,
    title: conditional.title,
    body: conditional.body,
    applies: 'topic',
    whenCondition: CONDITIONAL.whenCondition,
  });
  changed += 1;
}

console.log(`\napplied ${changed} changes`);
store.close();
