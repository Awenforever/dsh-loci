/**
 * dsh-loci — Host entry.
 *
 * Loci keeps a long-term memory of durable project facts behind a small,
 * stable system-prompt index: the prompt never grows with the store, and every
 * full text is one `loci_get` away.
 *
 * The plugin exports the plain Cordis plugin form (no Service class) so the
 * whole surface stays inside one `apply` and unloads cleanly with its effects.
 * @module dsh-loci
 */
export { apply, inject } from './src/host/index.js';
export { Config } from './src/host/config.js';
