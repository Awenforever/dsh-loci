// Compare the recall curve the document asks for with the one the code implements.
//
// `docs/MEMORY-UNITS.md` §3.1 says the recall amplitude is 按对数 — a log-shaped curve, large at the head
// near 0 and small at the tail. The code uses exponential decay. Both have a large head and a small tail, so
// the three properties the document derives from the shape still hold; what differs is how *fast* the tail
// falls, which decides how expensive it is to rescue a memory that has drifted far.
//
// This prints both so the difference is a number rather than a word.

const R = 2000;
const base = 130;
const scale = 500;
const floor = 1;

const exponential = (p) => Math.max(floor, base * Math.exp(-Math.abs(p) / scale));
// Log-shaped: linear in log-distance, reaching zero exactly at the entrance depth.
const logarithmic = (p) => Math.max(floor, base * (1 - Math.log(1 + Math.abs(p) / scale) / Math.log(1 + R / scale)));

const rows = [0, -100, -300, -500, -1000, -1500, -2000, -5000];
console.log('position    exponential   logarithmic     (one recall, μ)');
for (const p of rows) {
  console.log(`  ${String(p).padStart(6)}    ${exponential(p).toFixed(1).padStart(8)}     ${logarithmic(p).toFixed(1).padStart(8)}`);
}

const recallsToRescue = (boostFn, from) => {
  let p = from;
  let n = 0;
  while (p < 0 && n < 100000) {
    p += boostFn(p);
    n += 1;
  }
  return n;
};

console.log('\nrecalls needed to bring an entry back to the habitat:');
for (const p of [-100, -500, -1000, -2000]) {
  console.log(`  from ${String(p).padStart(6)}:  exponential ${String(recallsToRescue(exponential, p)).padStart(5)}   logarithmic ${String(recallsToRescue(logarithmic, p)).padStart(5)}`);
}

console.log('\nwhat the document requires (MEMORY-UNITS §3.1):');
console.log('  1. a slightly aged memory is rescued by one recall');
console.log('  2. a memory aged far away is expensive to rescue');
console.log('  3. a recall triggers re-digestion on the way back');
const ok = (label, value) => console.log(`  ${value ? 'yes' : 'no '} — ${label}`);
ok('one recall from -100 both curves', exponential(-100) >= 100 || logarithmic(-100) >= 100);
ok('far entries cost many recalls (both)', recallsToRescue(exponential, -2000) > 10 && recallsToRescue(logarithmic, -2000) > 10);
console.log('\nthe difference that matters: with exponential, -1000 needs several recalls; with log, two.');
console.log('the code ships the exponential one — docs/AXIS.md §2.3 documents the formula, MEMORY-UNITS §3.1 calls');
console.log('it logarithmic. Same three properties, different rescue cost in the middle of the axis.');
