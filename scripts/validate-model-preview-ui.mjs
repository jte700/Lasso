// Exercise the running application through visible controls in isolated Chrome.
// Metadata is read only to choose indexed targets and independently check GUIDs;
// preview navigation uses mouse and keyboard events, never app state or mocks.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const [baseUrl, projectId, outputDir, targetsPath] = process.argv.slice(2);
if (!baseUrl || !projectId || !outputDir) {
  console.error('Usage: node scripts/validate-model-preview-ui.mjs URL PROJECT_ID OUTPUT_DIR [TARGETS_JSON]');
  process.exit(2);
}
const url = new URL('/', baseUrl).href;
const output = path.resolve(outputDir);
await mkdir(output, { recursive: true });
const profile = await mkdtemp('/tmp/lasso-model-preview-chrome-');
const transcript = { url, projectId, startedAt: new Date().toISOString(), interactions: [], checks: [], screens: [], browserErrors: [], previewRequests: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  let error;
  while (Date.now() < deadline) {
    try { const result = await fn(); if (result) return result; } catch (caught) { error = caught; }
    await delay(100);
  }
  throw new Error(`${label}${error ? `: ${error.message}` : ''}`);
}
async function get(endpoint) {
  const response = await fetch(new URL(endpoint, url));
  assert.equal(response.status, 200, `GET ${endpoint}`);
  return response.json();
}
let chrome, socket, call, evaluate;
try {
  const { objects } = await get(`/api/projects/${encodeURIComponent(projectId)}/source-library`);
  const specifications = targetsPath ? JSON.parse(await readFile(targetsPath, 'utf8')) : await Promise.all([
    { role: 'room', entityType: 'IFCSPACE', propertyName: 'Area' },
    { role: 'door', entityType: 'IFCDOOR', propertyName: 'Width' },
    { role: 'wall', entityType: 'IFCWALL', propertyName: 'Area' },
  ].map(async specification => {
    const { objects: candidates } = await get(`/api/projects/${encodeURIComponent(projectId)}/dependency-objects?query=${specification.entityType}`);
    const matches = candidates.filter(object => /\.ifc$/i.test(object.path)
      && (object.metadata?.entityType === specification.entityType
        || specification.entityType === 'IFCWALL' && object.metadata?.entityType === 'IFCWALLSTANDARDCASE')
      && object.anchor?.propertyName === specification.propertyName);
    const object = matches.find(item => specification.role === 'room' && item.metadata.roomNumber === 'A102') ?? matches[0];
    assert.ok(object, `No indexed ${specification.entityType} ${specification.propertyName} found`);
    return { role: specification.role, objectId: object.id, entityType: object.metadata.entityType };
  }));
  const targets = specifications.map(specification => {
    const object = objects.find(item => /\.ifc$/i.test(item.path)
      && (specification.objectId ? item.id === specification.objectId
        : specification.guid ? item.anchor?.elementId === specification.guid && (!specification.propertyName || item.anchor?.propertyName === specification.propertyName)
          : specification.label ? item.label === specification.label : specification.match.test(item.label)));
    assert.ok(object, `Missing indexed ${specification.role ?? specification.label ?? specification.guid} target`);
    assert.ok(object.anchor?.elementId, 'Target must have an indexed element GUID');
    return { role: specification.role ?? 'element', objectId: object.id, label: object.label,
      path: object.path, guid: object.anchor.elementId, propertyName: object.anchor.propertyName,
      expectedEntityType: specification.entityType ?? null };
  });
  assert.ok(targets.length >= 2, 'Provide multiple indexed elements to verify selection switching');
  assert.equal(new Set(targets.map(target => target.guid)).size, targets.length, 'Every target must identify a different element');
  transcript.targets = targets;
  chrome = spawn(process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    `--user-data-dir=${profile}`, '--headless=new', '--remote-debugging-port=0', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking', '--disable-component-update',
    '--disable-sync', '--window-size=1480,1100', url,
  ], { stdio: 'ignore' });
  const port = await until(async () => Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]), 'Chrome did not start');
  const page = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(item => item.url.startsWith(url)), 'Application tab did not open');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') transcript.browserErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    if (message.method === 'Network.responseReceived' && /\/preview(?:\?|$)/.test(message.params.response.url)) {
      const { url: requestUrl, status } = message.params.response;
      transcript.previewRequests.push({ url: requestUrl, status });
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
  });
  call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'DOM evaluation failed');
    return result.result.value;
  };
  await call('Runtime.enable'); await call('Network.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1480, height: 1100, deviceScaleFactor: 1, mobile: false });
  async function screenshot(name) {
    const result = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path.join(output, name), Buffer.from(result.data, 'base64')); transcript.screens.push(name);
  }
  async function click(selector) {
    const point = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw Error('Control missing');
      element.scrollIntoView({block:'nearest',inline:'nearest'});
      const rect = element.getBoundingClientRect();
      return {x:rect.x + rect.width / 2, y:rect.y + rect.height / 2, width:rect.width, height:rect.height};
    })()`);
    assert.ok(point.width > 0 && point.height > 0 && point.y > 0 && point.y < 1100, `${selector} must be visible`);
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    transcript.interactions.push({ type: 'click', selector });
  }
  async function search(text, waitForResults = true) {
    await click('#terminal-input');
    await call('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await call('Input.insertText', { text });
    assert.equal(await evaluate('document.querySelector("#terminal-input").value'), text, 'Keyboard search must replace the prior query');
    transcript.interactions.push({ type: 'type', text });
    // The unfiltered library may already contain the next target. Wait for the
    // visible debounced search result before clicking it; otherwise its pending
    // input handler legitimately clears the prematurely chosen selection.
    if (waitForResults) await until(() => evaluate('document.querySelector(".wb-browser > header > span")?.textContent === "Matching files" && document.querySelector(".wb-inspector")?.getAttribute("aria-busy") === "false"'), 'Search results did not finish updating');
  }
  async function drawing(scope = '.wb-preview') {
    return evaluate(`(() => {
      const root = document.querySelector(${JSON.stringify(scope)}), plan = root?.querySelector('[data-model-plan]'), svg = plan?.querySelector('svg');
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      return { label: plan.querySelector('strong')?.textContent, details: plan.querySelector('header')?.innerText,
        selected: [...svg.querySelectorAll('.selected')].map(path => path.dataset.modelElement),
        selectedPaths: [...svg.querySelectorAll('.selected')].map(path => path.getAttribute('d')),
        elements: svg.querySelectorAll('[data-model-element]').length, viewBox: svg.getAttribute('viewBox'),
        focus: plan.dataset.modelFocus, context: plan.dataset.modelContext,
        width: rect.width, height: rect.height, visible: rect.width > 0 && rect.height > 0 };
    })()`);
  }
  async function verifySelected(target, scope = '.wb-preview') {
    const result = await until(async () => {
      const current = await drawing(scope);
      return current?.selected.includes(target.guid) ? current : null;
    }, `The ${target.role} preview did not highlight ${target.guid}`);
    assert.ok(result.visible && result.width >= 300 && result.height >= 200, 'Drawing must be visibly sized');
    assert.deepEqual(result.selected, [target.guid], 'Only the target element should be selected');
    assert.ok(result.selectedPaths.every(value => /^M/.test(value) && value.includes('L')), 'Highlight must contain actual polygon paths');
    assert.ok(result.elements > 1, 'Drawing must include surrounding model context');
    assert.equal(result.viewBox, result.focus, 'New selection must start focused on the indexed element');
    if (target.expectedEntityType) assert.ok(result.details.includes(target.expectedEntityType));
    transcript.checks.push({ check: 'selectedGeometry', scope, target: target.role, ...result });
    return result;
  }
  await until(() => evaluate('Boolean(document.querySelector("#project-pill") && document.querySelector("[data-directory]"))'), 'Project controls did not load');
  await click('#project-pill');
  await click(`[data-directory="${projectId}"]`);
  await until(() => evaluate('Boolean(document.querySelector(".wb") && document.querySelector(".wb-inspector")?.getAttribute("aria-busy") === "false")'), 'Source library did not load');
  transcript.projectName = await evaluate('document.querySelector("#window-project-name").textContent');

  for (const [index, target] of targets.entries()) {
    if (index) {
      await click('#workspace-nav');
      await until(() => evaluate('document.querySelector(".wb-inspector")?.getAttribute("aria-busy") === "false"'), 'Library did not finish loading');
    }
    // The wall is already visible in this model's first library rows. Exercise
    // immediate selection as well as the ordinary debounced search workflow.
    await search(target.label, target.role !== 'wall');
    await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(`[data-object="${target.objectId}"]`)}))`), `Search did not display ${target.label}`);
    await click(`[data-object="${target.objectId}"]`);
    const focused = await verifySelected(target);
    await delay(160);
    assert.deepEqual((await drawing())?.selected, [target.guid], 'A pending search update must not clear an explicit source selection');
    await click('.wb-preview [data-model-action="zoom-in"]');
    const zoomed = await drawing();
    assert.ok(Number(zoomed.viewBox.split(' ')[2]) < Number(focused.viewBox.split(' ')[2]), 'Zoom in must reduce the visible extent');
    await click('.wb-preview [data-model-action="context"]');
    const context = await drawing();
    assert.equal(context.viewBox, context.context, 'Show context must fit the surrounding model');
    assert.deepEqual(context.selected, [target.guid], 'Changing view must preserve the selected element');
    await click('.wb-preview [data-model-action="selection"]');
    assert.equal((await drawing()).viewBox, focused.viewBox, 'Fit selection must restore the indexed extent');
    transcript.checks.push({ check: 'viewControls', target: target.role, passed: true });
    await screenshot(`${String(index + 1).padStart(2, '0')}-${target.role}-focused.png`);
    await click('.wb-detail [data-open]');
    await verifySelected(target, '.preview-body');
    assert.ok(transcript.previewRequests.some(request => request.status === 200
      && new URL(request.url).searchParams.get('elementId') === target.guid), 'Open source must carry the indexed GUID to the preserved snapshot preview');
    await screenshot(`${String(index + 1).padStart(2, '0')}-${target.role}-source.png`);
  }
  // Return to the first element after inspecting other types to catch stale
  // selection state crossing between property previews and source documents.
  const first = targets[0];
  await click('#workspace-nav');
  await until(() => evaluate('document.querySelector(".wb-inspector")?.getAttribute("aria-busy") === "false"'), 'Library did not finish loading on revisit');
  await search(first.label);
  await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(`[data-object="${first.objectId}"]`)}))`), 'First target missing on revisit');
  await click(`[data-object="${first.objectId}"]`); await verifySelected(first);
  transcript.checks.push({ check: 'selectionRevisit', target: first.role, passed: true });
  assert.deepEqual(transcript.browserErrors, [], 'No uncaught browser exceptions');
  transcript.status = 'passed';
  console.log(JSON.stringify({ status: transcript.status, targets: targets.map(target => ({ role: target.role, label: target.label, guid: target.guid })), checks: transcript.checks.length, output }, null, 2));
} catch (error) {
  transcript.status = 'failed'; transcript.error = error.stack; process.exitCode = 1;
  if (evaluate) transcript.failurePreview = await evaluate('document.querySelector(".wb-detail, .preview-body")?.innerText ?? null').catch(() => null);
  if (call) {
    const result = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }).catch(() => null);
    if (result) await writeFile(path.join(output, 'failure.png'), Buffer.from(result.data, 'base64'));
  }
  console.error(error.stack);
} finally {
  transcript.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'ui-transcript.json'), JSON.stringify(transcript, null, 2));
  socket?.close();
  if (chrome) {
    chrome.kill('SIGTERM');
    await new Promise(resolve => { chrome.once('exit', resolve); setTimeout(resolve, 2000); });
  }
  await rm(profile, { recursive: true, force: true });
}
