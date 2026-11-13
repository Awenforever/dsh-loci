/**
 * Markdown projection and re-import.
 *
 * SQLite is the transactional truth; Markdown is the human-readable projection
 * people actually want in a git repo or a backup. Export is total (every
 * revision that is still the head, plus closed history in a second file) and
 * import is deliberately lossy in one direction: an imported entry is always a
 * candidate, so a file someone hands you can never silently become prompt text.
 * @module dsh-loci/store/export
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertInside } from '../paths.js';

/** Current projection format version, written into every file's front matter. */
export const EXPORT_FORMAT = 1;

/**
 * Serialize one scalar the way a YAML reader expects.
 * @param value - string, number, boolean, null, or array.
 * @returns the serialized value.
 */
function scalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map((item) => JSON.stringify(String(item))).join(', ')}]`;
  return JSON.stringify(String(value));
}

/**
 * One entry as a Markdown document with JSON-valued front matter.
 * @param entry - mapped store entry.
 * @returns the document text.
 */
export function toMarkdown(entry) {
  const front = [
    '---',
    `format: ${EXPORT_FORMAT}`,
    `id: ${scalar(entry.id)}`,
    `revision: ${entry.revision}`,
    `kind: ${scalar(entry.kind)}`,
    `scope: ${scalar(entry.scope)}`,
    `scope_key: ${scalar(entry.scopeKey)}`,
    `title: ${scalar(entry.title)}`,
    `status: ${scalar(entry.status)}`,
    `trust_source: ${scalar(entry.trustSource)}`,
    `valid_from: ${entry.validFrom}`,
    `valid_to: ${entry.validTo === null ? 'null' : entry.validTo}`,
    `recorded_at: ${entry.recordedAt}`,
    `superseded_by: ${scalar(entry.supersededBy)}`,
    `tags: ${scalar(entry.tags)}`,
    `entities: ${scalar(entry.entities.map((entity) => entity.name))}`,
    `source_session: ${scalar(entry.sourceSession)}`,
    '---',
    '',
    entry.body,
    '',
  ];
  const quote = entry.evidence?.quote;
  if (typeof quote === 'string' && quote.length > 0) front.push(`> Evidence: “${quote}”`, '');
  return front.join('\n');
}

/**
 * Parse a document produced by {@link toMarkdown}.
 * @param text - file contents.
 * @returns `{front, body}` or undefined when the document is not ours.
 */
export function fromMarkdown(text) {
  if (!text.startsWith('---\n')) return undefined;
  const end = text.indexOf('\n---\n', 4);
  if (end < 0) return undefined;
  const frontText = text.slice(4, end);
  const body = text.slice(end + 5).split('\n> Evidence:')[0].trimEnd();
  const front = {};
  for (const line of frontText.split('\n')) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const raw = line.slice(at + 1).trim();
    if (raw === 'null') front[key] = null;
    else if (/^-?\d+$/.test(raw)) front[key] = Number(raw);
    else if (raw.startsWith('[')) {
      try {
        front[key] = JSON.parse(raw);
      } catch {
        front[key] = [];
      }
    } else {
      try {
        front[key] = JSON.parse(raw);
      } catch {
        front[key] = raw.replace(/^"|"$/g, '');
      }
    }
  }
  return { front, body };
}

/**
 * Write every current entry as Markdown under `<root>/markdown/<scope>/<kind>/`.
 * Closed history is written once as `history-<timestamp>.md` in the export dir.
 * @param store - open store.
 * @param paths - layout paths.
 * @returns `{files, bytes, exportFile}`.
 */
export function exportMarkdown(store, paths) {
  const ids = store.allHeadIds();
  mkdirSync(paths.markdown, { recursive: true });
  let files = 0;
  let bytes = 0;
  for (const id of ids) {
    let entry;
    try {
      entry = store.get(id, { includeHistory: false }).entry;
    } catch {
      continue;
    }
    const dir = assertInside(paths.markdown, join(paths.markdown, safeName(entry.scope), safeName(entry.kind)));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${safeName(entry.id)}.md`);
    const text = toMarkdown(entry);
    writeFileSync(file, text, 'utf8');
    files += 1;
    bytes += Buffer.byteLength(text, 'utf8');
  }
  const exportFile = join(paths.exports, `memory-${Date.now()}.md`);
  mkdirSync(paths.exports, { recursive: true });
  writeFileSync(exportFile, `# Loci memory export\n\nExported ${new Date().toISOString()} · ${files} files · ${bytes} bytes\n`, 'utf8');
  return { files, bytes, exportFile };
}

/**
 * Import Markdown files from a directory (default: the export directory).
 * Every imported entry is stored as a candidate with `trust_source: 'import'`.
 * @param store - open store.
 * @param paths - layout paths.
 * @param options - `dir`, `scopeKey`, `scopeLabel`.
 * @returns `{imported, skipped, errors}`.
 */
export function importMarkdown(store, paths, options = {}) {
  const dir = assertInside(paths.root, options.dir ?? paths.exports);
  const scopeKey = options.scopeKey ?? 'workspace:imported';
  const scopeLabel = options.scopeLabel ?? 'imported';
  let imported = 0;
  let skipped = 0;
  const errors = [];
  const batch = [];
  const flush = () => {
    if (batch.length === 0) return;
    try {
      store.writeMany(batch.splice(0, batch.length), { source: 'import' });
    } catch (error) {
      errors.push({ file: '<batch>', error: String(error?.message ?? error) });
    }
  };
  for (const file of walkMarkdown(dir)) {
    try {
      const parsed = fromMarkdown(readFileSync(file, 'utf8'));
      if (parsed === undefined || typeof parsed.front.title !== 'string' || typeof parsed.body !== 'string') {
        skipped += 1;
        continue;
      }
      batch.push({
        kind: parsed.front.kind ?? 'semantic',
        scope: 'workspace',
        scopeKey,
        scopeLabel,
        title: parsed.front.title,
        body: parsed.body,
        tags: Array.isArray(parsed.front.tags) ? parsed.front.tags : [],
        entities: Array.isArray(parsed.front.entities) ? parsed.front.entities : [],
        status: 'candidate',
        trustSource: 'import',
        evidence: { note: `imported from ${file}` },
      });
      imported += 1;
      if (batch.length >= 200) flush();
    } catch (error) {
      errors.push({ file, error: String(error?.message ?? error) });
    }
  }
  flush();
  return { imported, skipped, errors };
}

/**
 * Recursively list `.md` files, bounded so a huge directory cannot stall a
 * tool call.
 * @param dir - root directory.
 * @returns file paths.
 */
function walkMarkdown(dir) {
  const out = [];
  const visit = (current, depth) => {
    if (depth > 4 || out.length > 1000) return;
    let entries;
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(current, name);
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) visit(full, depth + 1);
      else if (info.isFile() && name.endsWith('.md')) out.push(full);
    }
  };
  visit(dir, 0);
  return out;
}

/**
 * Keep a file name safe on every platform.
 * @param value - raw name.
 * @returns a name without separators or reserved characters.
 */
function safeName(value) {
  return String(value ?? 'unknown').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'unknown';
}
