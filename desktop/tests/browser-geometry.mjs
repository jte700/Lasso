// Real Chrome + macOS Accessibility regression. Requires a built, signed Lasso
// app with Accessibility permission. A separate temporary Chrome profile keeps
// the user's tabs, drafts, selection, and profile untouched.
// Build: LASSO_BROWSER_GEOMETRY_TEST=1 npm run desktop
// Run: node desktop/tests/browser-geometry.mjs [path/to/Lasso.app]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.resolve(process.argv[2] ?? path.join(here, '../../dist/Lasso.app'));
const chromePath = process.env.LASSO_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const temporary = await mkdtemp(path.join(tmpdir(), 'lasso-browser-geometry-'));
const requestPath = path.join(temporary, 'request.json');
const resultPath = path.join(temporary, 'result.json');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let chrome, socket, sequence = 0, helperStarted = false;

async function until(read, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let error;
  while (Date.now() < deadline) {
    try { const result = await read(); if (result) return result; } catch (caught) { error = caught; }
    await delay(50);
  }
  throw new Error(`${message}${error ? `: ${error.message}` : ''}`);
}

async function writeRequest(request) {
  await writeFile(`${requestPath}.next`, JSON.stringify(request));
  await rename(`${requestPath}.next`, requestPath);
}

async function helper(command, values = {}) {
  const id = ++sequence;
  await writeRequest({ sequence: id, command, ...values });
  const result = await until(async () => {
    const response = JSON.parse(await readFile(resultPath, 'utf8'));
    return response.sequence === id ? response : null;
  }, `No response from signed Lasso helper (${command})`);
  if (result.error) throw new Error(result.error);
  return result;
}

function lineRects(rects) {
  const lines = [];
  for (const rect of rects.filter(r => r.width > 0 && r.height > 0).sort((a, b) => a.y - b.y || a.x - b.x)) {
    const previous = lines.at(-1);
    if (previous && Math.abs(previous.y - rect.y) < 2) {
      const end = Math.max(previous.x + previous.width, rect.x + rect.width);
      previous.x = Math.min(previous.x, rect.x);
      previous.width = end - previous.x;
      previous.height = Math.max(previous.height, rect.height);
    } else lines.push({ ...rect });
  }
  return lines;
}

function clipped(rect, frame) {
  const x = Math.max(rect.x, frame.x);
  const y = Math.max(rect.y, frame.y);
  return { x, y, width: Math.min(rect.x + rect.width, frame.x + frame.width) - x,
    height: Math.min(rect.y + rect.height, frame.y + frame.height) - y };
}

try {
  const profile = path.join(temporary, 'chrome-profile');
  const fixtureURL = pathToFileURL(path.join(here, 'browser-geometry.html')).href;
  chrome = spawn(chromePath, [`--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--force-renderer-accessibility', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--window-size=1100,850', fixtureURL], { stdio: 'ignore' });
  chrome.on('error', error => { console.error(error.message); });
  const port = await until(async () => Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]),
    'Isolated Chrome did not start');
  const page = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json())
    .find(target => target.url === fixtureURL), 'Chrome fixture tab did not load');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let commandID = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const result = JSON.parse(event.data);
    const entry = pending.get(result.id);
    if (!entry) return;
    pending.delete(result.id);
    clearTimeout(entry.timeout);
    result.error ? entry.reject(new Error(result.error.message)) : entry.resolve(result.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++commandID;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'Fixture script failed');
    return result.result.value;
  };
  const settle = async () => {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await delay(180); // Blink publishes its native AX tree asynchronously.
  };
  await until(() => evaluate('Boolean(window.fixture)'), 'Fixture did not initialize');
  await writeRequest({ sequence: 0, command: 'ping' });
  await new Promise((resolve, reject) => {
    const launch = spawn('/usr/bin/open', ['-g', '-n', appPath, '--args', '--browser-geometry-test', requestPath, resultPath], { stdio: 'inherit' });
    launch.once('error', reject);
    launch.once('exit', code => code === 0 ? resolve() : reject(new Error(`Lasso helper launch exited ${code}`)));
  });
  helperStarted = true;
  await helper('ping');
  let checks = 0, maximumMeasurementMilliseconds = 0;
  async function check(label) {
    await settle();
    const expected = await evaluate('fixture.snapshot()');
    const actual = await helper('measure', { pid: chrome.pid, editorID: 'lasso-geometry-editor', phrase: expected.phrase });
    assert.deepEqual(actual.selectionAfter, actual.selectionBefore, `${label}: measurement changed the selection`);
    assert.deepEqual(await evaluate('fixture.selectionSnapshot()'), expected.selection,
      `${label}: measurement changed the DOM selection`);
    maximumMeasurementMilliseconds = Math.max(maximumMeasurementMilliseconds, actual.durationMilliseconds);
    const measured = lineRects(actual.rects);
    const oracle = lineRects(expected.rects.map(rect => clipped(rect, expected.editorFrame))
      .map(rect => ({ ...rect, x: rect.x + actual.viewport.x, y: rect.y + actual.viewport.y })));
    assert.equal(measured.length, oracle.length, `${label}: missing or extra highlight line; ${JSON.stringify({ measured, oracle, text: actual.text })}`);
    for (let i = 0; i < oracle.length; i++) {
      for (const key of ['x', 'y', 'width', 'height']) {
        assert.ok(Math.abs(measured[i][key] - oracle[i][key]) <= 2,
          `${label}: ${key} differs from Chrome DOM range; ${JSON.stringify({ measured, oracle, text: actual.text })}`);
      }
    }
    checks++;
    console.log(`  ok ${label}`);
  }
  async function enter() {
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  }
  console.log('Native Chrome highlight geometry versus DOM Range.getClientRects()');
  await check('initial phrase');
  for (let n = 1; n <= 5; n++) { await enter(); await check(`after Enter ${n}`); }
  await call('Input.insertText', { text: 'More content on another line that has different metrics. '.repeat(3) });
  await check('typing long wrapped content after blank lines');
  await evaluate('fixture.selectStart()');
  await check('caret moved before the phrase');
  await evaluate("fixture.reset();");
  await call('Input.insertText', { text: ' and more narrow iii and wide WWW letters' });
  await check('same-line typing with different glyph widths');
  await evaluate("fixture.reset('<p>Earlier paragraph</p><p>I was looking at supplies</p><p>Later paragraph</p>')");
  await check('paragraph margins with caret on a different paragraph');
  await evaluate('fixture.reset()');
  await enter();
  await call('Input.insertText', { text: 'Other words to select' });
  await evaluate('fixture.selectLastText(5)');
  assert.equal(await evaluate('getSelection().toString()'), 'Other');
  await check('noncollapsed selection on another line stays unchanged');
  await evaluate("fixture.reset('<div>Earlier line</div>'.repeat(8) + '<div>I was looking at supplies</div>' + '<div>Later line</div>'.repeat(8)); editor.scrollTop = 140;");
  await check('scrolled editor with the phrase visible');
  await evaluate("fixture.reset('<div>I was looking at supplies</div>' + '<div>Later line</div>'.repeat(30)); editor.scrollTop = editor.scrollHeight;");
  await check('fully scrolled-out phrase has no ghost highlight');
  await evaluate("fixture.reset('I need office supplies', 'office supplies'); editor.style.width = '90px'");
  await check('phrase wraps into multiple rectangles after resize');
  await evaluate("fixture.reset('I need office<br>supplies<div>Later text</div>', 'office\\nsupplies')");
  await check('phrase spans an explicit line break');
  await evaluate("fixture.reset('😀 Planning for <b>sup</b><i>plies</i><div>Later text</div>')");
  await check('UTF-16 prefix and phrase split across formatting nodes');
  console.log(`${checks} real-browser geometry checks passed.`);
  console.log(`Maximum native range measurement: ${maximumMeasurementMilliseconds.toFixed(1)} ms.`);

  // Exercise the actual popup coordinator and native close button in the signed
  // test app. Only our isolated Chrome instance is brought to the foreground.
  console.log('Native popup dismissal and host tracking in isolated Chrome');
  let popupChecks = 0;
  const popupState = () => helper('popup-state');
  async function waitForPopup(predicate, label) {
    return until(async () => {
      const state = await popupState();
      return predicate(state) ? state : null;
    }, label, 5000);
  }
  async function expectHidden(label) {
    await waitForPopup(state => !state.visible && !state.tracking, `${label}: popup or tracking timer remained active`);
    popupChecks++;
    console.log(`  ok ${label}`);
  }
  async function showPopup() {
    const shown = await helper('popup-show');
    assert.equal(shown.shown, true, `Could not capture isolated Chrome editor: ${JSON.stringify(shown)}`);
    return waitForPopup(state => state.visible && state.tracking, 'Popup did not become visible with host tracking');
  }
  function near(actual, expected, label, tolerance = 2) {
    assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
      `${label}: expected ${expected}, received ${actual}`);
  }
  async function expectAnchored(label, state) {
    assert.equal(state.visible, true, `${label}: popup disappeared`);
    assert.equal(state.tracking, true, `${label}: tracking timer stopped`);
    const dom = await evaluate('fixture.caretSnapshot()');
    const measured = await helper('measure', { pid: chrome.pid, editorID: 'lasso-geometry-editor', phrase: 'supplies' });
    const caret = { ...dom, x: dom.x + measured.viewport.x, y: dom.y + measured.viewport.y };
    assert.ok(caret.height > 0 && state.caret && state.frame, `${label}: missing caret or popup geometry`);
    for (const key of ['x', 'y', 'height']) near(state.caret[key], caret[key], `${label}: current caret ${key}`);
    const caretX = caret.x + caret.width / 2;
    const caretBottom = state.primaryTop - caret.y - caret.height;
    const caretTop = state.primaryTop - caret.y;
    const screen = state.screens.find(({ frame }) => caretX >= frame.x && caretX <= frame.x + frame.width
      && caretBottom >= frame.y && caretBottom <= frame.y + frame.height) ?? state.screens[0];
    assert.ok(screen, 'Test display geometry is unavailable');
    const visible = screen.visibleFrame;
    let x = caretX - 84;
    let y = caretBottom - state.frame.height - 2;
    if (y < visible.y) y = caretTop + 2;
    x = Math.min(Math.max(visible.x, x), visible.x + visible.width - state.frame.width);
    y = Math.min(Math.max(visible.y, y), visible.y + visible.height - state.frame.height);
    near(state.frame.x, x, `${label}: popup x follows the actual DOM caret`);
    near(state.frame.y, y, `${label}: popup y follows the actual DOM caret`);
  }

  const activated = await helper('popup-activate', { pid: chrome.pid });
  assert.equal(activated.activated, true, 'Could not activate the isolated Chrome process');
  await call('Page.bringToFront');
  await waitForPopup(state => state.frontmostPID === chrome.pid, 'Isolated Chrome did not receive focus');
  const { windowId } = await call('Browser.getWindowForTarget', { targetId: page.id });
  const primaryScreen = activated.screens.find(({ frame }) => frame.x === 0 && frame.y === 0) ?? activated.screens[0];
  const windowWidth = Math.min(1000, primaryScreen.frame.width - 160);
  const windowHeight = Math.min(720, primaryScreen.frame.height - 160);
  await call('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  await call('Browser.setWindowBounds', { windowId,
    bounds: { left: 60, top: 80, width: windowWidth, height: windowHeight } });
  await evaluate('fixture.reset()');
  await settle();

  console.log('Native source hyperlink insertion in isolated Chrome');
  for (const keyboardFallback of [false, true]) {
    await evaluate("fixture.reset('The total is off'); fixture.selectEnd()");
    await settle();
    const destination = 'https://example.test/d/source-regression';
    const result = await helper('link-insert', {
      label: 'office supplies', url: destination, keyboardFallback,
    });
    const actual = await evaluate(`({text: editor.textContent, links: [...editor.querySelectorAll('a')].map(a => ({label:a.textContent, url:a.href}))})`);
    assert.equal(result.inserted, true, `Native hyperlink was not verified: ${JSON.stringify({ ...result, actual })}`);
    assert.equal(result.prefix, 'off', 'Insertion did not replace the intended partial word');
    assert.equal(actual.text, 'The total is office supplies', 'Hyperlink paste changed surrounding text');
    assert.deepEqual(actual.links, [{ label: 'office supplies', url: destination }], 'Pasted source is not a real hyperlink');
    console.log(`  ok ${keyboardFallback ? 'read-only AX selection keyboard fallback' : 'native AX selection'} preserves text and inserts a clickable source`);
  }
  const destination = 'https://example.test/d/source-regression';
  for (const [label, html, expected] of [
    ['styled text is not a hyperlink', 'The total is <u>office supplies</u>', false],
    ['a different destination is rejected', '<a href="https://example.test/wrong">office supplies</a>', false],
    ['an earlier matching link is rejected', `<a href="${destination}">office supplies</a> and office supplies`, false],
    ['a partially linked label is rejected', `<a href="${destination}">office</a> supplies`, false],
    ['formatting inside the correct link is accepted', `The total is <a href="${destination}"><b>office</b> supplies</a>`, true],
  ]) {
    await evaluate(`fixture.reset(${JSON.stringify(html)}); fixture.selectEnd()`);
    await settle();
    const selection = await evaluate('fixture.selectionSnapshot()');
    const result = await helper('link-verify', { label: 'office supplies', url: destination });
    assert.equal(result.linked, expected, label);
    assert.deepEqual(await evaluate('fixture.selectionSnapshot()'), selection, 'Verification changed the selection');
    console.log(`  ok ${label}`);
  }
  await evaluate('fixture.reset()');
  await settle();

  await showPopup();
  await helper('popup-key', { keyCode: 53 });
  await expectHidden('Escape closes source-scoped suggestions');

  const closable = await showPopup();
  const button = closable.closeButtonFrame;
  assert.ok(button && button.width >= 12 && button.height >= 12, 'Popup has no usable native close button');
  assert.ok(button.x >= closable.frame.x - 1 && button.y >= closable.frame.y - 1
    && button.x + button.width <= closable.frame.x + closable.frame.width + 1
    && button.y + button.height <= closable.frame.y + closable.frame.height + 1,
  'Close button lies outside the popup');
  await helper('popup-close');
  await expectHidden('native close button dismisses the popup');

  await helper('popup-delayed');
  await helper('popup-key', { keyCode: 53 });
  await delay(650);
  await expectHidden('dismissed pending response cannot reopen the popup');

  await evaluate("fixture.reset('I was looking at supplies and reviewing the latest planning details. '.repeat(5)); editor.style.width = 'calc(100vw - 96px)'; fixture.selectEnd()");
  await settle();
  const beforeMove = await showPopup();
  await expectAnchored('initial popup', beforeMove);
  await call('Browser.setWindowBounds', { windowId, bounds: { left: 140, top: 125 } });
  await settle();
  const moved = await waitForPopup(state => state.visible && state.frame
    && (Math.abs(state.frame.x - beforeMove.frame.x) > 10 || Math.abs(state.frame.y - beforeMove.frame.y) > 10),
  'Popup did not move with the Chrome window');
  await expectAnchored('moved Chrome window', moved);
  popupChecks++;
  console.log('  ok popup tracks a window move without keyboard input');

  await call('Browser.setWindowBounds', { windowId, bounds: { width: Math.max(600, windowWidth - 280) } });
  await settle();
  const resized = await waitForPopup(state => state.visible && state.frame
    && (Math.abs(state.frame.x - moved.frame.x) > 2 || Math.abs(state.frame.y - moved.frame.y) > 2),
  'Popup did not follow the caret after window resizing reflowed the editor');
  await expectAnchored('resized Chrome window', resized);
  popupChecks++;
  console.log('  ok popup tracks the reflowed caret after window resizing');

  await evaluate("const other = document.createElement('input'); other.id = 'lasso-popup-other-field'; document.body.append(other); other.focus()");
  await expectHidden('changing the focused field dismisses the popup');
  await evaluate("document.getElementById('lasso-popup-other-field').remove(); fixture.reset()");
  await settle();
  await showPopup();
  await evaluate('editor.remove()');
  await expectHidden('removing the original editor dismisses the popup');
  await evaluate('document.body.insertBefore(editor, document.body.children[1]); fixture.reset()');
  await settle();
  await showPopup();
  const closed = await fetch(`http://127.0.0.1:${port}/json/close/${page.id}`);
  assert.equal(closed.ok, true, 'Could not close the isolated Chrome fixture window');
  await expectHidden('closing the Chrome window dismisses the popup');
  console.log(`${popupChecks} real-browser popup lifecycle checks passed.`);
} finally {
  if (helperStarted) { try { await helper('stop'); } catch {} }
  socket?.close();
  if (chrome && chrome.exitCode === null) {
    chrome.kill('SIGTERM');
    await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), delay(2500)]);
    if (chrome.exitCode === null) chrome.kill('SIGKILL');
  }
  await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
