#!/usr/bin/env node
/** Print the exact section the model receives — the end of the R14 chain. */
import { effectiveConfig } from '../../src/host/config.js';
import { layout, resolveDshHome, resolveMemoryRoot } from '../../src/host/paths.js';
import { renderIndexBody } from '../../src/host/inject/index-section.js';
import { Store } from '../../src/host/store/store.js';

const root = resolveMemoryRoot(resolveDshHome());
const store = new Store({ memoryRoot: root, paths: layout(root), config: effectiveConfig({}), pluginVersion: '3.4.0' });
const keys = store.activeScopeKeys();
const rendered = renderIndexBody({
  store,
  scopeKeys: keys,
  scopeLabel: 'default-workspace',
  config: (key) => effectiveConfig({})[key],
});
console.log(`bytes ${rendered.bytes} · listed ${rendered.listed} · total ${rendered.total} · ids ${JSON.stringify(rendered.ids)}`);
console.log('--- the section as the model sees it ---');
console.log(rendered.text);
store.close();
