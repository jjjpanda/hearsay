import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function connectDevTools(browser, profile, onMessage) {
  let address;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (browser.exitCode !== null || browser.signalCode !== null) throw new Error('Browser exited before opening DevTools.');
    try {
      const [portText, path] = (await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
      const port = Number(portText);
      if (Number.isInteger(port) && port > 0 && port <= 65535 && /^\/devtools\/browser\/[\w-]+$/.test(path)) {
        address = `ws://127.0.0.1:${port}${path}`; break;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!address) throw new Error('Browser did not open DevTools within 10 seconds.');
  const socket = new WebSocket(address);
  socket.addEventListener('message', event => onMessage(JSON.parse(event.data)));
  await new Promise((accept, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('DevTools WebSocket connection timed out.')); }, 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); accept(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('DevTools WebSocket connection failed.')); }, { once: true });
  });
  return socket;
}
