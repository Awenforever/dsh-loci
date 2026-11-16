#!/usr/bin/env node
/** What does store.write() actually return? */
import { openTestStore, workspaceFields } from '../../test/helpers.mjs';

const { store, scopes } = openTestStore({ after: () => {} });
const written = store.write({
  ...workspaceFields(scopes),
  status: 'verified',
  trustSource: 'user',
  kind: 'semantic',
  title: 'probe',
  body: 'probe body',
});
console.log('typeof:', typeof written);
console.log('value:', JSON.stringify(written));
console.log('keys:', written === null || written === undefined ? '(none)' : Object.keys(written));
if (written && typeof written === 'object') {
  for (const [key, value] of Object.entries(written)) console.log(`  ${key}: ${typeof value} = ${JSON.stringify(value)}`);
}
store.close();
