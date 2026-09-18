/**
 * Render scripts/icon.svg to the PNG sizes a PWA needs.
 *
 *   npm run icons -w @futsal/web
 *
 * Uses headless Chrome over the DevTools Protocol rather than adding an image
 * library to the dependency tree — the PNGs are committed, so this only needs
 * to run when the artwork changes.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'public', 'icons');
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// 192/512 are the PWA manifest minimum; 180 is apple-touch-icon; 32 is the tab.
const SIZES = [32, 180, 192, 256, 512];

mkdirSync(OUT, { recursive: true });
const svg = readFileSync(join(here, 'icon.svg'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'ff-icons-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9350', `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

let nextId = 1;
function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { send, ready };
}

for (let i = 0; i < 60; i++) {
  try { if ((await fetch('http://127.0.0.1:9350/json/version')).ok) break; } catch {}
  await sleep(200);
}

const target = await (await fetch('http://127.0.0.1:9350/json/new?about:blank', { method: 'PUT' })).json();
const { send, ready } = connect(target.webSocketDebuggerUrl);
await ready;
await send('Page.enable');

const html = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>
${svg}`;

for (const size of SIZES) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: size, height: size, deviceScaleFactor: 1, mobile: false,
  });
  await send('Page.navigate', { url: `data:text/html;charset=utf-8,${encodeURIComponent(
    html.replace('width="512" height="512"', `width="${size}" height="${size}"`),
  )}` });
  await sleep(350);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, `icon-${size}.png`), Buffer.from(data, 'base64'));
  console.log(`  wrote icons/icon-${size}.png`);
}

chrome.kill();
console.log('done');
