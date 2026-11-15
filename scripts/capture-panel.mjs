/**
 * Capture the panel screenshot for the marketplace listing.
 *
 * Dismisses the preview notice, opens the Memory panel, and saves a PNG. Kept
 * separate from the assertion script so a screenshot never decides a pass/fail.
 *
 * Usage: node scripts/capture-panel.mjs --cdp http://127.0.0.1:9336 --url <app url> --out <png>
 */
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? fallback : value;
};
const cdpBase = flagValue('cdp', 'http://127.0.0.1:9336');
const appUrl = flagValue('url');
const out = flagValue('out', 'marketplace/screenshots/panel-index.png');

const list = await (await fetch(`${cdpBase}/json/list`)).json();
const page = list.find((target) => target.type === 'page');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));

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
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: appUrl });
await wait(6000);

// Dismiss the preview notice so it does not cover the panel.
await evaluate(`
  (() => {
    const nodes = [...document.querySelectorAll('button, [role="button"], a')];
    const target = nodes.find((node) => /^(继续|Continue)$/i.test((node.textContent || '').trim()));
    if (target !== undefined) target.click();
    return target !== undefined;
  })()
`);
await wait(1200);

// Open the Memory panel.
const opened = await evaluate(`
  (() => {
    const nodes = [...document.querySelectorAll('button, [role="button"], a')];
    const target = nodes.find((node) => /^(Memory)$/i.test((node.getAttribute('aria-label') || node.textContent || '').trim()));
    if (target === undefined) return false;
    target.click();
    return true;
  })()
`);
await wait(1800);

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log(`panel opened=${opened} · wrote ${out}`);
socket.close();
