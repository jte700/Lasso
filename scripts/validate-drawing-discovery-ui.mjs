// Validate whole-model discovery through real UI input in the running app.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const [baseUrl, projectId, outputDirectory] = process.argv.slice(2);
if (!baseUrl || !projectId || !outputDirectory) {
  console.error('Usage: node scripts/validate-drawing-discovery-ui.mjs URL PROJECT_ID OUTPUT_DIR'); process.exit(2);
}
const url = new URL('/', baseUrl).href, output = path.resolve(outputDirectory);
await mkdir(output, { recursive: true });
const profile = await mkdtemp('/tmp/lasso-drawing-discovery-');
const transcript = { url, projectId, startedAt: new Date().toISOString(), interactions: [], checks: [], screenshots: [], errors: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  const deadline = Date.now() + 45000; let error;
  while (Date.now() < deadline) {
    try { const result = await fn(); if (result) return result; } catch (caught) { error = caught; }
    await delay(100);
  }
  throw new Error(`${label}${error ? `: ${error.message}` : ''}`);
}
let chrome, socket, call, evaluate;
try {
  const response = await fetch(new URL(`/api/projects/${encodeURIComponent(projectId)}/source-library`, url));
  assert.equal(response.status, 200);
  const { objects } = await response.json();
  const target = objects.find(object => object.objectType === 'DRAWING' && /duplex.*\.ifc$/i.test(object.path));
  assert.ok(target, 'Existing Accounting Duplex drawing must be indexed');
  assert.ok(target.label.toLowerCase().includes('duplex'), 'Whole drawing must have a filename label');
  assert.ok(target.searchAliases?.includes('floor plan'), 'Source library must expose model aliases');
  transcript.target = { objectId: target.id, label: target.label, path: target.path, aliases: target.searchAliases };
  chrome = spawn(process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    `--user-data-dir=${profile}`, '--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--window-size=1480,1100', url,
  ], { stdio: 'ignore' });
  const port = await until(async () => Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]), 'Chrome did not start');
  const page = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(item => item.url.startsWith(url)), 'App tab missing');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0; const pending = new Map(), previews = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') transcript.errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    if (message.method === 'Network.responseReceived' && /\/terminal\/preview$/.test(message.params.response.url)) previews.push(message.params.requestId);
    const entry = pending.get(message.id); if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
  });
  call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'DOM evaluation failed');
    return result.result.value;
  };
  await call('Runtime.enable'); await call('Network.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1480, height: 1100, deviceScaleFactor: 1, mobile: false });
  async function click(selector) {
    const rect = await evaluate(`(() => { const n=document.querySelector(${JSON.stringify(selector)}); if(!n)throw Error('Missing control'); n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height};})()`);
    assert.ok(rect.width > 0 && rect.height > 0 && rect.y > 0 && rect.y < 1100, selector);
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    transcript.interactions.push({ type: 'click', selector });
  }
  async function screenshot(name) {
    const result = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path.join(output, name), Buffer.from(result.data, 'base64')); transcript.screenshots.push(name);
  }
  async function drawing(scope) {
    return evaluate(`(() => {const h=document.querySelector(${JSON.stringify(scope)}),s=h?.querySelector('.model-plan-svg');if(!s)return null;const r=s.getBoundingClientRect();return {width:r.width,height:r.height,selected:s.querySelectorAll('.selected').length,polygons:s.querySelectorAll('path[d]').length,label:document.querySelector('.wb-detail h2')?.textContent,viewBox:s.getAttribute('viewBox')};})()`);
  }
  await until(() => evaluate('Boolean(document.querySelector("#project-pill") && document.querySelector("[data-directory]"))'), 'Project controls unavailable');
  await click('#project-pill'); await click(`[data-directory="${projectId}"]`);
  await until(() => evaluate('document.querySelector(".wb-inspector")?.getAttribute("aria-busy") === "false"'), 'Accounting library did not load');
  transcript.projectName = await evaluate('document.querySelector("#window-project-name").textContent');
  for (const [index, query] of ['floor plan', 'duplex'].entries()) {
    if (index) { await click('#workspace-nav'); await until(() => evaluate('document.querySelector(".wb-inspector")?.getAttribute("aria-busy") === "false"'), 'Library reload incomplete'); }
    await click('#terminal-input');
    await call('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await call('Input.insertText', { text: query }); transcript.interactions.push({ type: 'type', text: query });
    await until(() => evaluate(`document.querySelector('.wb-browser > header > span')?.textContent === 'Matching files' && Boolean(document.querySelector(${JSON.stringify(`[data-object="${target.id}"]`)}))`), `Typing ${query} did not find the whole drawing`);
    await screenshot(`${index + 1}-${query.replaceAll(' ', '-')}-results.png`);
    const count = previews.length;
    await click(`[data-object="${target.id}"]`);
    const rendered = await until(() => drawing('.wb-preview'), 'Whole-model visual preview did not render');
    assert.ok(rendered.width >= 300 && rendered.height >= 200, 'Drawing must occupy a useful viewport');
    assert.ok(rendered.polygons > 10, 'Whole-model preview must contain real context geometry');
    assert.equal(rendered.selected, 0, 'Whole drawing must not select an arbitrary element');
    assert.equal(rendered.label, target.label, 'Preview must identify the selected filename');
    await until(() => previews.length > count, 'Actual preview response missing');
    const payload = await call('Network.getResponseBody', { requestId: previews.at(-1) });
    const { preview } = JSON.parse(payload.base64Encoded ? Buffer.from(payload.body, 'base64').toString() : payload.body);
    assert.equal(preview.kind, 'model-plan'); assert.equal(preview.selected, null); assert.equal(preview.path, target.path);
    transcript.checks.push({ query, ...rendered, responseKind: preview.kind, selected: preview.selected,
      sourceHash: preview.sourceHash, sourcePath: preview.path, storey: preview.storey?.label, passed: true });
    await screenshot(`${index + 1}-${query.replaceAll(' ', '-')}-overview.png`);
  }
  await click('.wb-detail [data-open]');
  const source = await until(() => drawing('.preview-body'), 'Preserved source overview missing');
  assert.equal(source.selected, 0); assert.ok(source.polygons > 10 && source.width >= 300);
  transcript.checks.push({ check: 'preservedSourceOverview', ...source, passed: true });
  await screenshot('3-preserved-model-overview.png'); assert.deepEqual(transcript.errors, []);
  transcript.status = 'passed';
  console.log(JSON.stringify({ status: transcript.status, checks: transcript.checks.length, target: transcript.target, output }, null, 2));
} catch (error) {
  transcript.status = 'failed'; transcript.error = error.stack; process.exitCode = 1;
  if (evaluate) transcript.failure = await evaluate('document.querySelector(".wb-detail, .preview-body")?.innerText').catch(() => null);
  if (call) { const image = await call('Page.captureScreenshot', { format: 'png' }).catch(() => null); if (image) await writeFile(path.join(output, 'failure.png'), Buffer.from(image.data, 'base64')); }
  console.error(error.stack);
} finally {
  transcript.finishedAt = new Date().toISOString(); await writeFile(path.join(output, 'ui-transcript.json'), JSON.stringify(transcript, null, 2));
  socket?.close(); if (chrome) { chrome.kill('SIGTERM'); await new Promise(resolve => { chrome.once('exit', resolve); setTimeout(resolve, 2000); }); }
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
