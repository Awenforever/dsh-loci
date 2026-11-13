/**
 * Decode a DSH session transcript.
 *
 * The `.zstd` file is not one stream: the store appends one frame per batch, and
 * the frames are not always adjacent (there can be padding or a length prefix
 * between them). Node's streaming decoder stops at the first "unknown frame
 * descriptor", so this walks the file, finds every zstd magic number and decodes
 * the frames with the single-shot API.
 *
 * Usage: node scripts/read-session.mjs <file.zstd> [needle]
 */
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const file = process.argv[2];
const needle = process.argv[3];
if (file === undefined) {
  console.error('usage: node scripts/read-session.mjs <file.zstd> [needle]');
  process.exit(2);
}

const raw = readFileSync(file);
const starts = [];
for (let i = 0; i + 4 <= raw.length; i += 1) {
  if (raw[i] === MAGIC[0] && raw[i + 1] === MAGIC[1] && raw[i + 2] === MAGIC[2] && raw[i + 3] === MAGIC[3]) starts.push(i);
}

const parts = [];
let decoded = 0;
for (let index = 0; index < starts.length; index += 1) {
  const from = starts[index];
  const to = index + 1 < starts.length ? starts[index + 1] : raw.length;
  try {
    parts.push(zstdDecompressSync(raw.subarray(from, to)));
    decoded += 1;
  } catch {
    // A frame boundary inside compressed data is not a frame start; try the next.
  }
}

const text = Buffer.concat(parts).toString('utf8');
console.log(`frames found ${starts.length}, decoded ${decoded}, bytes ${text.length}`);
if (needle === undefined) {
  process.stdout.write(text);
} else {
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.includes(needle)) console.log(line.slice(0, 4000));
  }
}
