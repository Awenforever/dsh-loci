/**
 * Import bridges for the memory plugins a user is likely leaving.
 *
 * Loci's own export format is round-trippable (see `export.js`); this module is
 * about the other direction — a user who already has memories in another DSH
 * plugin should not start from zero. Two formats are supported, each one verified
 * against the producer's own source rather than guessed:
 *
 * - **auto-memory** (`dsh-auto-memory`): one Markdown file per memory under
 *   `$DSH_HOME/memory/_user/` and `--<project>--/`, with YAML front matter written
 *   by its `serializeMemory()` (`name`, `title`, `description`, `type`, `pinned`,
 *   `disabled`, `status`, `evidence{quote}`, `supersedes`, `created`).
 * - **Claude Code memory**: `MEMORY.md` holding one line per memory, each linking
 *   a topic file whose body is the memory.
 *
 * Everything imported lands as a `candidate`: another plugin's trust level is not
 * evidence for this store — only a verbatim quote from the current session, or a
 * person, can promote an entry.
 *
 * @module dsh-loci/store/importers
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

/** How many files a single import will read; a runaway directory must not hang. */
const MAX_FILES = 5000;

/** How long one imported body may be, matching the store's own cap. */
const MAX_BODY = 20_000;

/**
 * Parse the restricted YAML that auto-memory writes.
 *
 * Deliberately not a general YAML parser: the producer emits flat scalars plus one
 * level of nesting (`evidence: { quote, sessionId }`), and a dependency-free
 * reader for exactly that is both smaller and easier to reason about than a full
 * parser. Anything deeper is ignored rather than mis-read.
 *
 * @param text - the text between the `---` fences.
 * @returns a plain object; nested one-level maps become nested objects.
 */
export function parseRestrictedYaml(text) {
  const result = {};
  let currentKey;
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue;
    const indented = /^\s+\S/.test(line);
    const match = /^(\s*)([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (match === null) continue;
    const [, indent, key, valueText] = match;
    const value = valueText.trim();
    if (indented && currentKey !== undefined) {
      if (typeof result[currentKey] !== 'object' || result[currentKey] === null) result[currentKey] = {};
      result[currentKey][key] = unquote(value);
      continue;
    }
    currentKey = key;
    result[key] = value.length === 0 ? {} : unquote(value);
  }
  return result;
}

/** Strip the quotes YAML writers add, and coerce the obvious scalars. */
function unquote(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

/** Split a document into front matter and body. */
function splitFrontmatter(raw) {
  // Strip a BOM first: PowerShell's  -Encoding utf8 writes one, and so do many
  // editors. Without this the file has no front matter at all and silently
  // imports as one blob of body text.
  const text = String(raw ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!text.startsWith('---\n')) return { front: {}, body: text.trim() };
  const end = text.indexOf('\n---', 4);
  if (end < 0) return { front: {}, body: text.trim() };
  const front = parseRestrictedYaml(text.slice(4, end));
  const after = text.slice(end + 4).replace(/^\n+/, '');
  return { front, body: after.trim() };
}

/** Every `.md` file under a directory, bounded. */
function walkMarkdown(dir, out = []) {
  if (out.length >= MAX_FILES) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) break;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(path, out);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(path);
  }
  return out;
}

/**
 * Map an auto-memory `type` onto a Loci kind.
 * @param type - the foreign type.
 * @returns one of the Loci kinds.
 */
function kindFromAutoMemory(type) {
  switch (type) {
    case 'user':
      return 'semantic';
    case 'feedback':
      return 'procedural';
    case 'reference':
      return 'semantic';
    default:
      return 'semantic';
  }
}

/**
 * Read an auto-memory store directory.
 *
 * Directory layout (from the producer): `_user/` for user-level entries and
 * `--<projectKey>--/` per project. A project directory's memories keep that
 * project's scope key so a merge does not collapse two projects into one.
 *
 * @param dir - the foreign `memory` directory.
 * @param options - `scopeKey`, `scopeLabel` (used for the `_user` folder).
 * @returns entries ready for `store.writeMany`.
 */
export function readAutoMemory(dir, options = {}) {
  const entries = [];
  const wanted = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()) : [];
  for (const folder of wanted) {
    const folderPath = join(dir, folder.name);
    const isUser = folder.name === '_user';
    const scopeKey = isUser ? (options.scopeKey ?? 'global:') : `workspace:${folder.name}`;
    const scopeLabel = isUser ? (options.scopeLabel ?? 'imported (auto-memory user)') : folder.name;
    for (const file of walkMarkdown(folderPath)) {
      const { front, body } = splitFrontmatter(readFileSync(file, 'utf8'));
      // A disabled or superseded foreign entry is history, not knowledge.
      if (front.disabled === true || front.supersededBy !== undefined) continue;
      const title = String(front.title ?? front.name ?? basename(file, '.md')).trim();
      if (title.length === 0 || body.length === 0) continue;
      entries.push({
        kind: kindFromAutoMemory(front.type),
        scope: isUser ? 'global' : 'workspace',
        scopeKey,
        scopeLabel,
        title: title.slice(0, 200),
        body: body.slice(0, MAX_BODY),
        tags: [],
        entities: [],
        status: 'candidate',
        trustSource: 'import',
        sourceRef: `auto-memory:${folder.name}/${basename(file)}`,
        evidence: { note: `imported from auto-memory at ${file}` },
      });
      if (entries.length >= MAX_FILES) break;
    }
  }
  return entries;
}

/**
 * Read a Claude Code memory directory.
 *
 * `MEMORY.md` lists one memory per line, usually `- [Title](file.md) — hook`. The
 * link target is relative to the index. Files not listed in the index are still
 * read (the index is a convenience, not the truth), so a hand-added topic file is
 * not silently lost.
 *
 * @param dir - directory containing `MEMORY.md`.
 * @param options - `scopeKey`, `scopeLabel`.
 * @returns entries ready for `store.writeMany`.
 */
export function readClaudeMemory(dir, options = {}) {
  const index = join(dir, 'MEMORY.md');
  const entries = [];
  const scopeKey = options.scopeKey ?? 'workspace:claude-import';
  const scopeLabel = options.scopeLabel ?? 'imported (claude)';
  const seen = new Set();

  const push = (file, fallbackTitle) => {
    const path = join(dir, file);
    if (seen.has(path) || !existsSync(path)) return;
    seen.add(path);
    const { front, body } = splitFrontmatter(readFileSync(path, 'utf8'));
    const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
    const title = String(front.title ?? front.name ?? heading ?? fallbackTitle ?? basename(file, '.md')).trim();
    const text = body.replace(/^#\s+.+$/m, '').trim();
    if (title.length === 0 || text.length === 0) return;
    entries.push({
      kind: front.type === 'feedback' ? 'procedural' : 'semantic',
      scope: 'workspace',
      scopeKey,
      scopeLabel,
      title: title.slice(0, 200),
      body: text.slice(0, MAX_BODY),
      tags: [],
      entities: [],
      status: 'candidate',
      trustSource: 'import',
      sourceRef: `claude-memory:${file}`,
      evidence: { note: `imported from Claude memory at ${path}` },
    });
  };

  if (existsSync(index)) {
    for (const line of readFileSync(index, 'utf8').split('\n')) {
      const link = /\[([^\]]+)\]\(([^)]+\.md)\)/.exec(line);
      if (link !== null) push(link[2], link[1]);
    }
  }
  for (const file of walkMarkdown(dir)) {
    if (basename(file).toLowerCase() === 'memory.md') continue;
    push(relative(dir, file), basename(file, '.md'));
  }
  return entries;
}

/** A small relative-path helper (avoids importing `node:path` twice). */
function relative(from, to) {
  const base = from.endsWith('\\') || from.endsWith('/') ? from : `${from}${from.includes('\\') ? '\\' : '/'}`;
  return to.startsWith(base) ? to.slice(base.length) : basename(to);
}

/**
 * Import from a named peer format.
 *
 * @param store - open store.
 * @param request - `from` (`auto-memory`|`claude`), `dir`, `scopeKey`, `scopeLabel`, `dryRun`.
 * @returns `{from, read, imported, skipped, errors}`.
 */
export function importPeer(store, request) {
  const from = request?.from;
  if (from !== 'auto-memory' && from !== 'claude') {
    throw new Error(`unknown import format: ${from}; expected auto-memory or claude`);
  }
  const dir = request?.dir;
  if (typeof dir !== 'string' || dir.length === 0) throw new Error('import requires --dir');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`not a directory: ${dir}`);

  const entries = from === 'auto-memory' ? readAutoMemory(dir, request) : readClaudeMemory(dir, request);
  if (request?.dryRun === true) return { from, read: entries.length, imported: 0, skipped: entries.length, errors: [] };
  if (entries.length === 0) return { from, read: 0, imported: 0, skipped: 0, errors: [] };
  const ids = store.writeMany(entries, { source: `import:${from}` });
  return { from, read: entries.length, imported: ids.length, skipped: 0, errors: [] };
}

/** Re-exported for tests: the fence splitter is the one piece with edge cases. */
export { splitFrontmatter };

