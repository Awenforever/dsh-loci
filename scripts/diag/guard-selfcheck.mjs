// Prove the invariant guard would have caught the 7.2.0 defect.
//
// A guard nobody has tested is a guard nobody knows works. This takes the exact snippet that shipped in 7.2.0
// and runs the guard's two patterns over it; both must match, or the guard is decoration.
const historical = [
  'function withRecallMessage(decision, text) {',
  '  return {',
  '    ...decision,',
  '    messages: [',
  '      ...decision.messages,',
  "      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },",
  '    ],',
  '  };',
  '}',
].join('\n');

const spreadPattern = /messages\s*:\s*\[[\s\S]{0,120}?\.\.\.\s*decision\.messages/;
const literalPattern = /\{\s*role:\s*'user'\s*,\s*source:/;

const spreadHit = spreadPattern.test(historical);
const literalHit = literalPattern.test(historical);

console.log('spread pattern matches the 7.2.0 code:', spreadHit);
console.log('literal pattern matches the 7.2.0 code:', literalHit);
console.log(spreadHit && literalHit ? 'PASS — the guard would have caught it' : 'FAIL — the guard is decoration');

// And the fixed code must NOT match, or the guard would forbid the correct implementation.
const fixed = [
  'import { injectedMessage, withMessage } from "./inject/message.js";',
  'function withRecallMessage(decision, text) {',
  '  return withMessage(decision, injectedMessage({ text }));',
  '}',
].join('\n');
const fixedClean = !spreadPattern.test(fixed) && !literalPattern.test(fixed);
console.log('the fixed shape passes the guard:', fixedClean);
process.exit(spreadHit && literalHit && fixedClean ? 0 : 1);
