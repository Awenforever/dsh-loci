/**
 * Reaching a model from the plugin, with the failure made visible.
 *
 * The shared `completeViaHost` helper wraps `llm.stream`, and something about calling it from this
 * context throws: instrumenting the call showed the route resolving and then the callback stopping
 * dead at that line, with no marker after it. Because the extractor it was written for is disabled
 * by default, the fault had never been visible — it simply made every consumer inert.
 *
 * This module replaces it for the curator's purposes and, more importantly, records each step. A
 * helper that throws while building a client is indistinguishable from a helper that returns
 * nothing, and the difference decides whether the fix is "wire a model" or "fix the wiring".
 * @module dsh-loci/record/model-route
 */

/** Pull text out of one stream frame, whichever field the adapter used. */
export function frameText(frame) {
  if (typeof frame === 'string') return frame;
  if (frame === null || typeof frame !== 'object') return '';
  if (typeof frame.text === 'string') return frame.text;
  if (typeof frame.delta?.text === 'string') return frame.delta.text;
  if (typeof frame.delta === 'string') return frame.delta;
  if (Array.isArray(frame.content)) {
    return frame.content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('');
  }
  return '';
}

/**
 * Build a `{system, prompt} → text` function over the Host's `llm` service.
 *
 * @param options - `llm` (the service, either a real object or a traced proxy), `provider`,
 *   `model`, `record` (callback for one diagnostic step), `signal`.
 * @returns `{complete, reason}` — `complete` is `undefined` when the route cannot be used, and
 *   `reason` says why in words that survive a restart.
 */
export function createCompleter({ llm, provider, model, record, signal }) {
  const note = (step, detail) => {
    try {
      record?.(step, detail);
    } catch {
      /* a diagnostic must never be the reason something fails */
    }
  };

  if (llm === undefined || llm === null) {
    note('llm', 'service absent');
    return { complete: undefined, reason: 'llm service absent' };
  }

  // Reading a property off a traced service can itself throw, so the probe is wrapped rather than
  // written as `typeof llm.stream === 'function'` — that expression is where execution stopped.
  let hasStream = false;
  try {
    hasStream = typeof llm.stream === 'function';
  } catch (error) {
    note('llm.stream', `threw: ${String(error?.message ?? error)}`);
    return { complete: undefined, reason: `reading llm.stream threw: ${String(error?.message ?? error)}` };
  }
  if (!hasStream) {
    note('llm.stream', 'not a function');
    return { complete: undefined, reason: 'llm.stream is not a function' };
  }
  note('llm.stream', 'ok');

  // `signal` may be supplied per call as well as at construction.
  //
  // It has to be per call: a tool that fans out a dozen requests needs each one bounded, and the
  // framework's `timeoutMs` on the tool does not cancel an in-flight `await` — it only stops waiting for
  // it, which leaves the request running and the tool looking hung. That was a real 30-minute hang.
  //
  // `onUsage` receives the `usage` chunk when the adapter sends one. The stream type declares it, this
  // loop previously ignored it, and the result was a tool that could only *estimate* token cost while a
  // real number went past unread.
  const complete = async ({ system, prompt, signal: callSignal, onUsage }) => {
    const effectiveSignal = callSignal ?? signal;
    const request = {
      provider,
      model,
      messages: [
        ...(typeof system === 'string' && system.length > 0
          ? [{ role: 'system', content: [{ type: 'text', text: system }] }]
          : []),
        { role: 'user', content: [{ type: 'text', text: prompt }] },
      ],
      ...(effectiveSignal === undefined ? {} : { signal: effectiveSignal }),
    };
    let text = '';
    let frames = 0;
    const shapes = new Set();
    // Two separate facts are needed when a call returns nothing, and they point at different
    // faults: how many frames arrived at all, and what shape they had. An empty reply from a
    // service that streamed nothing is a different problem from one that streamed frames this
    // function failed to read.
    for await (const frame of llm.stream(request)) {
      frames += 1;
      if (frames <= 3) {
        try {
          shapes.add(typeof frame === 'string' ? 'string' : Object.keys(frame ?? {}).join('|').slice(0, 40));
        } catch {
          shapes.add('unreadable');
        }
      }
      // The declared chunk type includes `{type:'usage'}`; this loop used to read only text and drop it,
      // which is why token cost could only ever be estimated.
      if (frame?.type === 'usage' && frame.usage !== undefined) {
        try {
          onUsage?.(frame.usage);
        } catch {
          /* a diagnostic must never be the reason a call fails */
        }
        continue;
      }
      text += frameText(frame);
    }
    note('frames', `${frames} frame(s), shapes: ${[...shapes].join(' ; ') || '(none)'}`);
    return text;
  };
  note('complete', 'built');
  return { complete, reason: 'ok' };
}
