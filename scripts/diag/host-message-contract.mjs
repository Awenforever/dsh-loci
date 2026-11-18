// Confirm the Host's user/message contract by reading the assertion straight out of the shipped bundle.
//
// The defect report says the Host rejects a `user/message` without `data.id`. That is a claim worth checking
// against the code that enforces it rather than against a bug report: the fix depends on exactly which fields
// are required.
import { readFileSync } from 'node:fs';

const asar = 'D:\\Programs\\DeepseekHarness\\resources\\app.asar';
const needle = 'lacks an identified message';
const buffer = readFileSync(asar);
const haystack = buffer.toString('latin1');

let from = 0;
let found = 0;
while (found < 3) {
  const at = haystack.indexOf(needle, from);
  if (at < 0) break;
  found += 1;
  from = at + needle.length;
  // Print a window around the hit so the surrounding assertion is visible.
  const start = Math.max(0, at - 900);
  const window = buffer.subarray(start, at + 300).toString('utf8');
  console.log(`--- hit ${found} at byte ${at} ---`);
  console.log(window.replace(/[^\x09\x0a\x20-\x7e\u4e00-\u9fff]/g, '·'));
  console.log('');
}
if (found === 0) console.log('needle not found in app.asar');
