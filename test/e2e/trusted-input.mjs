/**
 * Trusted-input CDP helper for the UI e2e.
 *
 * Synthetic `element.click()` reaches React for plain buttons but not for the
 * account-menu popovers, which read real pointer input. These helpers drive the
 * page through `Input.dispatchMouseEvent`, which the browser marks as trusted.
 * @module dsh-loci/test/e2e/trusted-input
 */

/**
 * Connect to the first page target.
 * @param cdpBase - `http://127.0.0.1:<port>`.
 * @returns `{send, evaluate, close}`.
 */
export async function connect(cdpBase) {
  const list = await (await fetch(`${cdpBase}/json/list`)).json();
  const page = list.find((target) => target.type === 'page');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message.result);
      pending.delete(message.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return result.result?.value ?? result.exceptionDetails;
  };
  return { send, evaluate, close: () => socket.close() };
}

/**
 * Click the page element whose aria-label/text matches a regex, using trusted
 * mouse input at its centre.
 * @param api - connection from {@link connect}.
 * @param pattern - regular expression source.
 * @returns whether an element matched and was clicked.
 */
export async function trustedClick(api, pattern) {
  const box = await api.evaluate(`
    (() => {
      const matcher = new RegExp(${JSON.stringify(pattern)}, 'i');
      const nodes = [...document.querySelectorAll('button, [role="button"], a, [role="menuitem"]')];
      const target = nodes.find((node) => matcher.test((node.getAttribute('aria-label') || node.textContent || '').trim()));
      if (target === undefined) return null;
      const rect = target.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()
  `);
  if (box === null || box === undefined) return false;
  const base = { x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 1 };
  await api.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, buttons: 0 });
  await api.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await api.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 });
  return true;
}
