// Record the detected host version in meta, expose it in stats and doctor.
import { readFileSync, writeFileSync } from 'node:fs';

function patch(file, pairs) {
  let text = readFileSync(file, 'utf8');
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const norm = (value) => value.split('\n').join(nl);
  let applied = 0;
  for (const [from, to] of pairs) {
    const anchor = norm(from);
    if (!text.includes(anchor)) {
      console.log(`MISS ${file}: ${from.slice(0, 70).replace(/\n/g, '\\n')}`);
      continue;
    }
    text = text.replace(anchor, norm(to));
    applied += 1;
  }
  if (applied > 0) writeFileSync(file, text, 'utf8');
  console.log(`${file}: ${applied}/${pairs.length}`);
}

// 1. A meta key for it.
patch('src/host/store/schema.js', [
  [
    `  lastMaintenance: 'last_maintenance',`,
    `  lastMaintenance: 'last_maintenance',
  /** The Harness version this store has been used with, recorded at activation. */
  hostVersion: 'host_version',`,
  ],
]);

// 2. Store: write it once at open, and report it.
patch('src/host/store/store.js', [
  [
    `    this.pluginVersion = options.pluginVersion ?? '0.0.0';`,
    `    this.pluginVersion = options.pluginVersion ?? '0.0.0';
    /** Recorded host version, so support can see which point release met this store. */
    this.hostVersion = options.hostVersion ?? undefined;`,
  ],
  [
    `    pluginVersion: this.pluginVersion,`,
    `    pluginVersion: this.pluginVersion,
      hostVersion: this.hostVersion ?? readMeta(this.db, META_KEYS.hostVersion) ?? null,`,
  ],
]);

console.log('done');
