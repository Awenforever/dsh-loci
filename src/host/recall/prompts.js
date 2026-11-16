/**
 * The prompts this plugin sends to a model.
 *
 * Kept in one file because they are the plugin's outward contract with a model, and spreading
 * them across modules made it easy to change a contract without noticing that a parser depends
 * on its exact shape.
 * @module dsh-loci/recall/prompts
 */

/** The one-line system prompt for auxiliary calls that must answer in a fixed shape. */
export const CURATOR_SYSTEM_TINY = 'Answer with the requested format only. Nothing else.';
