/**
 * The append-only audit trail (`audit.jsonl`).
 *
 * Every injected section, recall, write, trust change, deletion, and
 * maintenance pass lands here with its byte count, so "what did this request
 * cost" and "who removed that fact" are answerable from one file. Bodies and
 * queries are never written: ids, lengths, and counts are enough to audit and
 * cannot leak the content they describe.
 * @module dsh-loci/store/audit
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { scanSecrets } from '../inject/sanitize.js';

/** Events that must survive a crash immediately; everything else is buffered. */
const SYNC_EVENTS = new Set(['write', 'delete', 'verify', 'import', 'migrate', 'error', 'maintenance']);

/** How many recent events the in-memory ring keeps for the panel. */
const RING_SIZE = 500;

/**
 * Derive the rotated file name for one generation.
 * @param file - live audit path.
 * @param generation - 1-based generation.
 * @returns the rotated path.
 */
function rotatedPath(file, generation) {
  return `${file}.${generation}`;
}

/**
 * JSONL audit writer with size rotation and a small in-memory tail.
 */
export class AuditLog {
  /** @type {string} */
  file;
  /** @type {number} */
  maxBytes;
  /** @type {number} */
  keep;
  /** @type {object[]} */
  ring = [];
  /** @type {object[]} */
  buffer = [];
  /** @type {NodeJS.Timeout | undefined} */
  timer;
  closed = false;

  /**
   * @param options - `file`, `maxBytes`, `keep`, `log`.
   */
  constructor(options) {
    this.file = options.file;
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    this.keep = options.keep ?? 5;
    this.log = options.log;
  }

  /**
   * Record one event.
   * @param event - event name (`inject`, `recall`, `write`, ...).
   * @param detail - small JSON-safe payload; never include body text.
   * @param options - `sync` forces an immediate flush.
   */
  append(event, detail = {}, options = {}) {
    if (this.closed) return;
    const line = { ts: Date.now(), event, ...sanitizeDetail(detail) };
    this.buffer.push(line);
    this.ring.push(line);
    if (this.ring.length > RING_SIZE) this.ring.splice(0, this.ring.length - RING_SIZE);
    if (options.sync === true || SYNC_EVENTS.has(event)) this.flush();
    else this.scheduleFlush();
  }

  /** Schedule a flush soon, keeping the timer unref'd so it never holds the process open. */
  scheduleFlush() {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, 300);
    this.timer.unref?.();
  }

  /** Write buffered lines and rotate when the file grew past the limit. */
  flush() {
    if (this.buffer.length === 0) return;
    const text = `${this.buffer.map((line) => JSON.stringify(line)).join('\n')}\n`;
    this.buffer = [];
    try {
      appendFileSync(this.file, text, 'utf8');
      this.rotateIfNeeded();
    } catch (error) {
      this.log?.warn?.(`loci: audit write failed: ${String(error?.message ?? error)}`);
    }
  }

  /** Rotate `audit.jsonl` to `.1`, shifting older generations. */
  rotateIfNeeded() {
    let size = 0;
    try {
      size = statSync(this.file).size;
    } catch {
      return;
    }
    if (size < this.maxBytes) return;
    try {
      const oldest = rotatedPath(this.file, this.keep);
      if (existsSync(oldest)) rmSync(oldest, { force: true });
      for (let generation = this.keep - 1; generation >= 1; generation -= 1) {
        const from = rotatedPath(this.file, generation);
        if (existsSync(from)) renameSync(from, rotatedPath(this.file, generation + 1));
      }
      renameSync(this.file, rotatedPath(this.file, 1));
    } catch (error) {
      this.log?.warn?.(`loci: audit rotation failed: ${String(error?.message ?? error)}`);
    }
  }

  /**
   * The newest events, from the ring when it is warm and from the file tail
   * otherwise.
   * @param limit - how many events to return, newest last.
   * @returns parsed events, oldest first.
   */
  tail(limit = 100) {
    if (this.ring.length >= limit) return this.ring.slice(-limit);
    return readAuditTail(this.file, limit);
  }

  /** Flush and stop the timer. */
  close() {
    this.flush();
    this.closed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

/**
 * Read the last `limit` JSON lines of a file without loading all of it.
 * Malformed lines (a process killed mid-append) are skipped and counted.
 * @param file - audit path.
 * @param limit - maximum lines to return.
 * @returns parsed events, oldest first.
 */
export function readAuditTail(file, limit = 100) {
  if (!existsSync(file)) return [];
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const window = Math.min(size, Math.max(64 * 1024, limit * 512));
    const start = size - window;
    const buffer = Buffer.alloc(window);
    readSync(fd, buffer, 0, window, start);
    const text = buffer.toString('utf8');
    const lines = text.split('\n');
    if (start > 0) lines.shift();
    const events = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch {
        /* a torn final line from a killed process is expected; skip it */
      }
    }
    return events.slice(-limit);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Keep free text out of the audit log unless it is short and harmless.
 *
 * The audit is a factual record of ids, modes and counts. A caller-supplied
 * `reason` is the one field that can carry arbitrary prose, and prose is where a
 * credential ends up after a copy-paste. It is therefore capped and scanned with
 * the same detector the memory body uses; a hit replaces the text with a marker
 * instead of dropping the event.
 *
 * @param detail - the fields the caller wants recorded.
 * @returns the fields that are safe to write.
 */
function sanitizeDetail(detail) {
  if (typeof detail.reason !== 'string') return detail;
  const cleaned = detail.reason.replace(/\s+/g, ' ').trim();
  const { hits } = scanSecrets(cleaned, 'redact');
  return {
    ...detail,
    reason: hits.length > 0 ? '[redacted]' : cleaned.slice(0, 160),
  };
}

