import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDevTools } from './devtools-socket.js';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const artifacts = resolve(root, '.artifacts');
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function findBrowser() {
  const configured = process.argv.find(arg => arg.startsWith('--browser-path='))?.slice('--browser-path='.length) || process.env.BROWSER_PATH;
  if (configured) {
    await access(configured);
    return configured;
  }
  for (const candidate of [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome'
  ]) {
    try { await access(candidate); return candidate; } catch {}
  }
  throw new Error('Set BROWSER_PATH to an installed Chromium browser');
}

export async function startServer(site = '.') {
  const child = spawn(process.execPath, ['scripts/serve.js', site], {
    cwd: root, env: { ...process.env, PORT: '0' }, windowsHide: true, stdio: 'pipe'
  });
  try {
    const url = await new Promise((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('HTTP server startup timed out')), 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`HTTP server exited: ${code}`)); });
      child.stdout.on('data', chunk => {
        const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); accept(match[0]); }
      });
    });
    return { url, close: () => child.kill() };
  } catch (error) { child.kill(); throw error; }
}

export async function startBrowser({ label = 'browser', timeoutMs = 15000 } = {}) {
  await mkdir(artifacts, { recursive: true });
  const runId = `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const tracePath = resolve(artifacts, `${runId}.jsonl`);
  let writes = Promise.resolve();
  const trace = (event, details = {}) => {
    writes = writes.then(() => appendFile(tracePath, JSON.stringify({ at: new Date().toISOString(), event, ...details }) + '\n'));
  };
  const executable = await findBrowser();
  const profile = await mkdtemp(resolve(artifacts, 'browser-'));
  const browserNoSandbox = process.argv.includes('--browser-no-sandbox');
  const args = ['--headless=new', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--log-file=${resolve(profile, 'chrome.log')}`,
    ...(browserNoSandbox ? ['--no-sandbox'] : []),
    ...(process.argv.includes('--browser-disable-gpu') ? ['--disable-gpu'] : []),
    `--user-data-dir=${profile}`, 'about:blank'];
  const browser = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  trace('launch', { executable, args, pid: browser.pid, node: process.version, platform: process.platform });
  let socket, session, sequence = 0, closing = false, failure, diagnostics = '', lastCommand;
  const pending = new Map(), errors = [], events = [];
  const fail = error => {
    failure ??= error;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  browser.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-30000); trace('stderr', { text: chunk.toString() }); });
  browser.on('error', error => { trace('process-error', { error: error.message }); fail(error); });
  browser.on('exit', (code, signal) => {
    trace('process-exit', { code, hex: code === null ? null : `0x${(code >>> 0).toString(16)}`, signal, closing, lastCommand });
    if (!closing) fail(new Error(`Browser exited (${code === null ? signal : `0x${(code >>> 0).toString(16)}`}) during ${lastCommand?.method}. See ${tracePath}`));
  });
  function receive(message) {
    if (message.id) {
      const request = pending.get(message.id);
      trace('response', { id: message.id, method: request?.method, error: message.error });
      if (request) {
        pending.delete(message.id); clearTimeout(request.timer);
        message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
      }
    }
    if (message.method && !['Network.dataReceived', 'Network.requestWillBeSentExtraInfo', 'Network.responseReceivedExtraInfo'].includes(message.method)) {
      trace('protocol-event', { method: message.method, params: message.params });
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') events.push(message.params.entry);
    if (message.method === 'Inspector.targetCrashed' || message.method === 'Target.targetCrashed') {
      errors.push(message); fail(new Error(`Renderer crashed: ${JSON.stringify(message.params)}`));
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params);
    if (message.method === 'Network.responseReceived' && message.params.response.status >= 400 && !message.params.response.url.endsWith('/favicon.ico')) errors.push(message.params.response);
  }
  function command(method, params = {}, browserScope = method.startsWith('Browser.') || method.startsWith('Target.')) {
    return new Promise((accept, reject) => {
      if (failure) { reject(failure); return; }
      const id = ++sequence;
      lastCommand = { id, method, params };
      trace('command', lastCommand);
      const timer = setTimeout(() => {
        pending.delete(id);
        const error = new Error(`CDP timeout (${timeoutMs}ms): ${method} ${JSON.stringify(params).slice(0, 500)}; browser exit=${browser.exitCode}; trace=${tracePath}`);
        trace('timeout', { id, method, params, error: error.message });
        reject(error);
      }, timeoutMs);
      pending.set(id, { resolve: accept, reject, timer, method });
      try { socket.send(JSON.stringify({ id, method, params, ...(!browserScope && session ? { sessionId: session } : {}) })); }
      catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  const close = async () => {
    if (closing) return;
    closing = true; fail(new Error('Browser session closed'));
    socket?.close();
    const exited = new Promise(resolve => browser.once('exit', resolve));
    if (browser.exitCode === null && browser.signalCode === null) { browser.kill(); await Promise.race([exited, pause(1000)]); }
    trace('closed'); await writes;
    await writeFile(resolve(artifacts, `${runId}.log`), diagnostics);
    try { await rm(profile, { recursive: true, force: true }); } catch {}
  };
  try {
    socket = await connectDevTools(browser, profile, receive);
    socket.addEventListener('error', event => {
      trace('socket-error', { message: event.message, error: String(event.error), cause: String(event.error?.cause) });
      if (!closing) fail(new Error(`DevTools socket error: ${event.message}; trace=${tracePath}`));
    });
    socket.addEventListener('close', event => {
      trace('socket-close', { code: event.code, reason: event.reason, wasClean: event.wasClean, closing });
      if (!closing) fail(new Error(`DevTools disconnected (${event.code} ${event.reason}); trace=${tracePath}`));
    });
    const version = await command('Browser.getVersion');
    const target = await command('Target.createTarget', { url: 'about:blank' });
    session = (await command('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
    await command('Target.setDiscoverTargets', { discover: true });
    for (const domain of ['Runtime', 'Page', 'Network', 'Inspector', 'Log']) await command(`${domain}.enable`);
    const evaluate = async expression => {
      const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const screenshot = async name => {
      const result = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      await writeFile(resolve(artifacts, `${name}.png`), Buffer.from(result.data, 'base64'));
    };
    const metrics = (width, height) => command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 640 });
    return { command, evaluate, screenshot, metrics, errors, events, close, version, browserNoSandbox, runId, tracePath };
  } catch (error) { error.tracePath = tracePath; error.runId = runId; await close(); throw error; }
}
