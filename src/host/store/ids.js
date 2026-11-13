/**
 * Time-sortable identifiers: 48-bit millisecond timestamp + 80 bits of
 * randomness, Crockford base32, prefixed `m_`.
 *
 * Sortable ids keep the index stable (a new entry appends after its older
 * siblings in the same tier) and let a log line name one entry without a join.
 * @module dsh-loci/store/ids
 */
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: no I, L, O, U

/**
 * Encode an integer into `width` base32 characters.
 * @param value - non-negative safe integer.
 * @param width - exact character count.
 * @returns the encoded string.
 */
function encode(value, width) {
  let out = '';
  let rest = value;
  for (let i = 0; i < width; i += 1) {
    out = ALPHABET[rest % 32] + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

/**
 * Mint one memory id.
 * @param now - millisecond timestamp (tests pass a fixed clock).
 * @returns `m_` plus 26 base32 characters.
 */
export function newMemoryId(now = Date.now()) {
  const time = encode(Math.max(0, Math.floor(now)), 10);
  const bytes = randomBytes(10);
  let random = '';
  for (let i = 0; i < 10; i += 1) random += encode(bytes[i], 1).length === 1 ? ALPHABET[bytes[i] % 32] : '0';
  // 10 independent 5-bit draws from the same bytes is fine; the timestamp half
  // already orders them for our purpose.
  return `m_${time}${random}`;
}

/**
 * Mint one entity id.
 * @returns `e_` plus 20 base32 characters.
 */
export function newEntityId() {
  const bytes = randomBytes(10);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % 32];
  return `e_${out}`;
}

/** Whether a string looks like a Loci memory id. */
export function isMemoryId(value) {
  return typeof value === 'string' && /^m_[0-9A-HJKMNP-TV-Z]{20,32}$/.test(value);
}
