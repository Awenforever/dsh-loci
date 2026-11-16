/**
 * Store construction shared by the MCP facade and tests.
 *
 * The facade must not import the Host plugin: it needs paths, defaults, and a
 * read-only store, nothing that touches Cordis.
 * @module dsh-loci/mcp/store-facade
 */
import { effectiveConfig } from '../host/config.js';
import { ensureMemoryRoot, layout, resolveDshHome, resolveMemoryRoot } from '../host/paths.js';
import { Store } from '../host/store/store.js';

/**
 * Resolve the effective config for a standalone process.
 * @param home - explicit `--home` override.
 * @returns the effective config object.
 */
export function loadStoreConfig(home) {
  return effectiveConfig({ home: home ?? '' });
}

/**
 * Open the store for a standalone process.
 * @param options - `home`, `readOnly`.
 * @returns `{store, paths}`.
 */
export function openFacadeStore(options = {}) {
  const config = loadStoreConfig(options.home);
  const root = resolveMemoryRoot(resolveDshHome(config.home));
  const paths = layout(root);
  // A user who configures the MCP server before ever opening the plugin has no
  // store yet. Creating the directory keeps the facade from dying before the
  // JSON-RPC handshake; a read-only facade then opens an empty database instead
  // of crashing with ENOENT.
  ensureMemoryRoot(root);
  const store = new Store({
    memoryRoot: root,
    paths,
    config,
    pluginVersion: '4.7.0',
    readOnly: options.readOnly === true,
  });
  return { store, paths };
}
