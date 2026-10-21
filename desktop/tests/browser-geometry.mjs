// Real Chrome + macOS Accessibility regression. Requires a built, signed Lasso
// app with Accessibility permission. A separate temporary Chrome profile keeps
// the user's tabs, drafts, selection, and profile untouched.
// Build: LASSO_BROWSER_GEOMETRY_TEST=1 npm run desktop
// Run: node desktop/tests/browser-geometry.mjs [path/to/Lasso.app] [--close-only]
// Optional LASSO_INSPECTOR_FIXTURE supplies {url, sources:[{objectId, versionId,
// projectId, path, elementId?, capture?}]} from an isolated test workspace.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderInspectorPanel } from '../../src/sharing/share-page.js';
import { createApplication } from '../../src/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const closeOnly = process.argv.includes('--close-only');
const appPath = path.resolve(process.argv.slice(2).find(value => value !== '--close-only') ?? path.join(here, '../../dist/Lasso.app'));
const chromePath = process.env.LASSO_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const temporary = await mkdtemp(path.join(tmpdir(), 'lasso-browser-geometry-'));
const requestPath = path.join(temporary, 'request.json');
const resultPath = path.join(temporary, 'result.json');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let chrome, socket, inspectorServer, predictionApplication, sequence = 0, helperStarted = false;

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
  const notch = await helper('notch-panel', {output:'/tmp/lasso-notch-verified.png'});
  assert.ok(notch.checks >= (notch.supported ? 12 : 2));
  console.log(`  ok ${notch.checks} notch controls, display eligibility and lifecycle checks (notched display: ${notch.supported})`);
  const suggestionNavigation = await helper('suggestion-navigation');
  for (const [label, passed] of Object.entries(suggestionNavigation.checks)) assert.equal(passed, true, label);
  console.log(`  ok ${Object.keys(suggestionNavigation.checks).length} native suggestion navigation checks`);
  const cardSizing = await helper('card-sizing');
  assert.ok(Object.keys(cardSizing.checks ?? {}).length >= 12, 'The card must be measured in every mode it changes size between');
  for (const [label, passed] of Object.entries(cardSizing.checks)) assert.equal(passed, true, label);
  console.log(`  ok ${Object.keys(cardSizing.checks).length} native card sizing checks`);
  const sharePreview = await helper('share-preview-fit');
  assert.ok(sharePreview.checks?.length >= 13, 'Share preview must expose every cell and complete passage with stable redaction coordinates');
  console.log(`  ok ${sharePreview.checks.length} native share preview checks`);
  const pdfComposerInput = path.join(temporary, 'pdf-composer.json');
  await writeFile(pdfComposerInput, JSON.stringify({ document: { kind: 'pdf',
    fileUrl: '/api/dependency-objects/pdf-fixture/source?version=pinned', page: 1,
    blocks: ['A text copy remains available for selective redaction.'] } }));
  const pdfComposer = await helper('share-pdf-preview', { input: pdfComposerInput,
    pdf: path.resolve(here, '../../test/fixtures/drawings/ncsu-office-kit.pdf') });
  assert.ok(pdfComposer.checks?.length >= 20, 'PDF pages must support visible region masks and selected excerpt review');
  console.log(`  ok ${pdfComposer.checks.length} native PDF composer checks`);
  let checks = 0, maximumMeasurementMilliseconds = 0;
  async function check(label) {
    await settle();
    const expected = await evaluate('fixture.snapshot()');
    const actual = await until(() => helper('measure', {
      pid: chrome.pid, editorID: 'lasso-geometry-editor', phrase: expected.phrase,
    }), `${label}: Chrome did not publish the fixture editor in Accessibility`);
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
  if (!closeOnly) {
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
  }

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

  if (!closeOnly) {
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
  }
  await evaluate('fixture.reset()');
  await settle();

  await evaluate("fixture.reset('I need sup'); fixture.selectEnd()");
  await settle();
  await showPopup();
  await helper('popup-key', { keyCode: 48 });
  await expectHidden('Tab accepts the isolated source suggestion');
  await until(async () => await evaluate('editor.textContent') === 'I need supplies',
    'Tab did not complete the intended word');
  await settle();

  if (!closeOnly) {
    // Reproduce contextual suggestions from a real Finance-style index. A
    // fabricated "sup -> supplies" payload cannot catch an unrelated keyword
    // such as "spe" being left behind when Department is suggested.
    console.log('Native Tab acceptance from the real prediction endpoint');
    const financeRoot = path.join(temporary, 'Finance');
    await mkdir(financeRoot);
    await writeFile(path.join(financeRoot, 'Finance-Planning.csv'), [
      'Department,Actual,Budget,Actual - budget,Variance %',
      'People,76000,74000,2000,0.027',
      'Facilities,21100,21000,100,0.0047',
      'Technology,6500,6000,500,0.083',
      'Marketing,14000,16000,-2000,-0.125',
      'Sales,4200,5000,-800,-0.16',
    ].join('\n'));
    predictionApplication = createApplication({
      dataDir: path.join(temporary, 'prediction-state'), watchProjects: false,
    });
    await predictionApplication.workspace.add([financeRoot], {
      id: 'system:browser-regression', displayName: 'Browser regression', actorType: 'SYSTEM',
    });
    let predictionRequests = 0;
    predictionApplication.server.prependListener('request', request => {
      if (request.method === 'POST' && request.url === '/api/workspace/dependencies/predict') predictionRequests++;
    });
    await new Promise((resolve, reject) => {
      predictionApplication.server.once('error', reject);
      predictionApplication.server.listen(0, '127.0.0.1', resolve);
    });
    const predictionURL = `http://127.0.0.1:${predictionApplication.server.address().port}`;
    const predictionWorkspace = predictionApplication.workspace.state();
    const opening = 'the marketing rows for our ';
    for (const scenario of [
      { name: 'contextual keyword replaces spe', text: `${opening}spe`, label: 'Department',
        expected: `${opening}department`, fragment: 'spe', labelStart: opening.length, accepted: 'department' },
      { name: 'matched keyword preserves trailing whitespace', text: `${opening}dep `, label: 'Department',
        expected: `${opening}department `, fragment: 'dep ', labelStart: opening.length, accepted: 'department' },
      { name: 'insertion after a connector preserves the completed words', text: opening, label: 'Department',
        expected: `${opening}Department`, fragment: '', labelStart: opening.length, accepted: 'Department' },
      { name: 'insertion adds a separator after a complete connector', text: opening.trimEnd(), label: 'Department',
        expected: `${opening}Department`, fragment: '', labelStart: opening.length, accepted: 'Department',
        replacementStart: opening.length - 1 },
      { name: 'numeric completion preserves its quantitative predicate', text: 'our department budget is 1', label: 'Marketing · Budget',
        expected: 'our department budget is 16000', fragment: '1', labelStart: 'our department budget is '.length, accepted: '16000' },
    ]) {
      await evaluate(`fixture.reset(${JSON.stringify(scenario.text)}); fixture.selectEnd()`);
      await settle();
      const response = await fetch(`${predictionURL}/api/workspace/dependencies/predict`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: scenario.text, cursor: scenario.text.length, blockIndex: 0 }),
      });
      assert.equal(response.ok, true, `${scenario.name}: prediction endpoint failed`);
      const { prediction } = await response.json();
      const candidates = [...prediction.workspaceCompletions, ...prediction.sourceCompletions]
        .map(suggestion => suggestion.dependencyCandidate)
        .concat(prediction.claims.flatMap(claim => claim.candidates));
      const candidate = candidates.find(value => value.label === scenario.label);
      assert.ok(candidate, `${scenario.name}: real index did not suggest ${scenario.label}`);
      const requestsBeforeNative = predictionRequests;
      await helper('popup-predict', { url: predictionURL,
        projectIds: predictionWorkspace.activeProjectIds, revision: predictionWorkspace.revision });
      let state = await waitForPopup(value => value.visible
        && value.suggestions?.some(suggestion => suggestion.label === scenario.label),
      `${scenario.name}: native prediction did not reach the popup`);
      assert.ok(predictionRequests > requestsBeforeNative, `${scenario.name}: native popup did not call the real endpoint`);
      const index = state.suggestions.findIndex(suggestion => suggestion.label === scenario.label);
      for (let step = 0; step < index; step++) await helper('popup-key', { keyCode: 125 });
      state = await popupState();
      assert.equal(state.selected, index, `${scenario.name}: wrong native suggestion selected`);
      const suggestion = state.suggestions[index];
      assert.equal(suggestion.replacementText, scenario.fragment, `${scenario.name}: wrong captured replacement evidence`);
      assert.equal(suggestion.replacementStart, scenario.replacementStart ?? scenario.labelStart,
        `${scenario.name}: replacement would alter surrounding prose`);
      await helper('popup-key', { keyCode: 48 });
      await until(async () => await evaluate('editor.textContent') === scenario.expected,
        `${scenario.name}: native Tab acceptance did not produce the exact sentence`);
      state = await until(async () => {
        const current = await popupState();
        return current.accepted?.objectId === candidate.id ? current : null;
      }, `${scenario.name}: native insertion did not verify the source range`);
      assert.deepEqual(state.accepted, { text: scenario.accepted,
        start: scenario.labelStart, end: scenario.labelStart + scenario.accepted.length,
        objectId: candidate.id }, `${scenario.name}: source highlight includes unrelated text or whitespace`);
      const selected = await evaluate('fixture.selectionSnapshot()');
      assert.equal(selected.text, '', `${scenario.name}: accepting a suggestion left text selected`);
      await expectHidden(scenario.name);
    }
    await predictionApplication.close();
    predictionApplication = null;
    await evaluate('fixture.reset()');
    await settle();
  }

  // Exercise the actual inspector page bridge with different references. Hold
  // a response until after dismissal so the prior page stays visibly mounted.
  const pendingInspections = new Map();
  inspectorServer = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname !== '/inspect') { response.writeHead(204).end(); return; }
    const objectId = url.searchParams.get('object');
    const send = () => {
      if (response.destroyed) return;
      if (objectId === 'unavailable') {
        response.writeHead(404, { 'content-type': 'text/html' }).end('<h1>Source unavailable</h1>');
      } else {
        const html = renderInspectorPanel({source: {label: objectId, filename: 'Inspector lifecycle fixture.txt',
          absolutePath: '/tmp/fictional-lasso-inspector-fixture.txt', location: 'Fixture text'}},
        url.searchParams.get('reference'), {kind: 'text', lines: [{lineNumber: 1, value: 'Fictional fixture source', cited: true}]});
        response.writeHead(200, { 'content-type': 'text/html' }).end(html);
      }
    };
    const versionId = url.searchParams.get('version');
    if (versionId?.startsWith('delayed-')) pendingInspections.set(`${objectId}|${versionId}`, send);
    else if (objectId.startsWith('delayed-')) pendingInspections.set(objectId, send);
    else send();
  });
  await new Promise((resolve, reject) => {
    inspectorServer.once('error', reject);
    inspectorServer.listen(0, '127.0.0.1', resolve);
  });
  const inspectorURL = `http://127.0.0.1:${inspectorServer.address().port}`;
  const showInspector = async (objectId, referenceId = `reference-${objectId}`, versionId = undefined) =>
    helper('inspector-show', {objectId, referenceId, versionId, url: inspectorURL, path: 'Inspector lifecycle fixture.txt'});
  const readyInspector = async objectId => {
    await showInspector(objectId);
    return until(async () => {
      const state = await helper('inspector-state');
      return state.ready && state.objectId === objectId ? state : null;
    }, `Inspector did not load ${objectId}`);
  };
  const editorFocusedInspector = async () => {
    await helper('popup-activate', {pid: chrome.pid});
    await call('Page.bringToFront');
    return until(async () => {
      const state = await helper('inspector-state');
      return state.frontmostPID === chrome.pid && !state.key ? state : null;
    }, 'Inspector did not preserve the isolated editor focus');
  };
  const closeInspector = async (label, state = null) => {
    state ??= await helper('inspector-state');
    const button = state.closeButtonFrame;
    assert.ok(button && button.width >= 20 && button.height >= 20, 'Inspector must always have a native close control');
    await until(() => helper('native-click', {x: button.x + button.width / 2,
      y: state.primaryTop - button.y - button.height / 2, windowNumber: state.windowNumber}),
    'Native inspector close button is obscured by another window');
    await until(async () => !(await helper('inspector-state')).visible, `${label}: one native click must close the inspector`);
    console.log(`  ok ${label}`);
  };
  await showInspector('delayed-initial');
  await until(() => pendingInspections.has('delayed-initial'), 'Initial delayed navigation did not start');
  let inspectorState = await editorFocusedInspector();
  assert.equal(inspectorState.loading, true);
  await closeInspector('source inspector closes during its initial load', inspectorState);
  pendingInspections.get('delayed-initial')();
  await delay(150);
  assert.equal((await helper('inspector-state')).visible, false, 'A delayed response must not reopen a dismissed inspector');

  inspectorState = await readyInspector('ready-first');
  assert.equal(inspectorState.pageCloseVisible, false, 'Native inspector must not display a duplicate webpage X');
  await showInspector('delayed-replacement', 'reference-new-source');
  await until(() => pendingInspections.has('delayed-replacement'), 'Replacement delayed navigation did not start');
  inspectorState = await editorFocusedInspector();
  assert.equal(inspectorState.objectId, 'ready-first', 'Previous source must remain mounted to exercise the reference race');
  assert.equal(inspectorState.loading, true);
  await closeInspector('source inspector closes while a different reference is loading', inspectorState);
  pendingInspections.get('delayed-replacement')();
  await delay(150);
  assert.equal((await helper('inspector-state')).visible, false, 'An old navigation completion must not reopen the inspector');

  await showInspector('unavailable');
  inspectorState = await until(async () => {
    const state = await helper('inspector-state');
    return !state.loading && state.text?.includes('Source unavailable') ? state : null;
  }, 'Unavailable source fixture did not load');
  assert.equal(inspectorState.ready, false, 'Error page has no inspector webpage controls');
  await closeInspector('source inspector closes after an unavailable source response', await editorFocusedInspector());

  await readyInspector('ready-key-window');
  await helper('inspector-focus');
  inspectorState = await until(async () => {
    const state = await helper('inspector-state');
    return state.key ? state : null;
  }, 'Inspector did not receive keyboard focus');
  await closeInspector('source inspector closes when it is the key window', inspectorState);

  for (let cycle = 0; cycle < 2; cycle++) {
    await readyInspector(`ready-repeat-${cycle}`);
    await helper('inspector-resize', {width: 700 + cycle * 40, height: 560 + cycle * 30});
    await closeInspector(`source inspector closes after reopen and resize ${cycle + 1}`, await editorFocusedInspector());
  }

  for (const changed of ['object', 'version']) {
    const objectId = `ready-stale-${changed}`;
    await showInspector(objectId, 'same-reference', 'v1');
    await until(async () => (await helper('inspector-state')).ready, 'Initial source for stale action did not load');
    const nextObject = changed === 'object' ? 'delayed-new-object' : objectId;
    const nextVersion = changed === 'version' ? 'delayed-v2' : 'v1';
    await showInspector(nextObject, 'same-reference', nextVersion);
    const pendingKey = changed === 'version' ? `${objectId}|${nextVersion}` : nextObject;
    await until(() => pendingInspections.has(pendingKey), `Changed ${changed} response was not delayed`);
    inspectorState = await editorFocusedInspector();
    assert.equal(inspectorState.objectId, objectId, 'Old page must remain mounted during stale action test');
    const share = inspectorState.shareButtonFrame;
    assert.ok(share, 'Old source page must have a real share control');
    await until(() => helper('native-click', {x: share.x + share.width / 2,
      y: inspectorState.primaryTop - share.y - share.height / 2, windowNumber: inspectorState.windowNumber}),
    'Stale page share control is obscured');
    await delay(150);
    assert.deepEqual((await helper('inspector-state')).actions, [], `Stale ${changed} page must not share the new source`);
    pendingInspections.get(pendingKey)();
    inspectorState = await until(async () => {
      const state = await helper('inspector-state');
      return state.ready && state.objectId === nextObject ? state : null;
    }, 'Current source page did not load after delayed response');
    const currentShare = inspectorState.shareButtonFrame;
    await until(() => helper('native-click', {x: currentShare.x + currentShare.width / 2,
      y: inspectorState.primaryTop - currentShare.y - currentShare.height / 2, windowNumber: inspectorState.windowNumber}),
    'Current page share control is obscured');
    await until(async () => (await helper('inspector-state')).actions.includes('share'),
      `Current ${changed} page should allow sharing`);
    await closeInspector(`stale ${changed} actions are rejected while current source actions work`);
  }

  if (process.env.LASSO_INSPECTOR_FIXTURE) {
    const fixture = JSON.parse(await readFile(process.env.LASSO_INSPECTOR_FIXTURE, 'utf8'));
    for (const source of fixture.sources) {
      await helper('popup-activate', { pid: chrome.pid });
      await call('Page.bringToFront');
      await waitForPopup(state => state.frontmostPID === chrome.pid, 'Isolated Chrome did not regain focus');
      await helper('inspector-show', { ...source, url: fixture.url });
      await until(async () => {
        const state = await helper('inspector-state');
        return state.ready && state.objectId === source.objectId && state.closeButtonFrame ? state : null;
      }, 'Source inspector did not finish loading');
      // Focus the isolated editor after page loading/Space transitions settle,
      // proving that the close click reaches an inactive floating inspector.
      await helper('popup-activate', { pid: chrome.pid });
      await call('Page.bringToFront');
      const state = await until(async () => {
        const state = await helper('inspector-state');
        return state.frontmostPID === chrome.pid && !state.key ? state : null;
      }, 'Inspector did not become inactive behind the isolated editor');
      assert.equal(state.frontmostPID, chrome.pid, 'Inspector must preserve the editor focus');
      assert.equal(state.key, false, 'Inspector should initially be inactive');
      if (process.env.LASSO_DXF_PREVIEW_REQUIRED !== '0') {
        assert.ok(state.model && state.paths >= 2, 'DXF inspector must show the real room outlines');
        assert.deepEqual(state.selected, source.elementId ? [source.elementId] : [], 'DXF must highlight the exact cited handle');
        assert.ok(!state.text.includes('cannot be displayed inline'), 'DXF cannot fall back to an unavailable file');
      }
      if (source.capture) await helper('inspector-snapshot', { output: source.capture });
      const button = state.closeButtonFrame;
      const clicked = await until(() => helper('native-click', { x: button.x + button.width / 2,
        y: state.primaryTop - button.y - button.height / 2, windowNumber: state.windowNumber }),
      'Source inspector close button is obscured by another window');
      assert.equal(clicked.clicked, true);
      await delay(350);
      const closed = await helper('inspector-state');
      assert.equal(closed.visible, false, `One native click must close the inactive source inspector: ${JSON.stringify(closed)}`);
      console.log(`  ok ${source.path} ${source.elementId ? 'selected element' : 'overview'} closes on its first click`);
    }
  }

  await showPopup();
  await helper('popup-key', { keyCode: 53 });
  await expectHidden('Escape closes source-scoped suggestions');

  await readyInspector('escape-all');
  await editorFocusedInspector();
  await showPopup();
  const beforeEscape = await evaluate('({html:editor.innerHTML,selection:fixture.selectionSnapshot()})');
  await helper('popup-key', {keyCode:53});
  await expectHidden('Escape closes suggestions alongside another open Lasso panel');
  await until(async()=>!(await helper('inspector-state')).visible,'Escape did not close the source inspector');
  assert.deepEqual(await evaluate('({html:editor.innerHTML,selection:fixture.selectionSnapshot()})'),beforeEscape,'Escape must preserve accepted content, links and caret');
  assert.deepEqual((await helper('inspector-state')).actions,[],'Escape must not invoke source actions');
  console.log('  ok one Escape closes inspector and suggestions without changing the host document');

  await showInspector('delayed-escape');
  await until(()=>pendingInspections.has('delayed-escape'),'Delayed Escape fixture did not start');
  await helper('popup-key',{keyCode:53});
  pendingInspections.get('delayed-escape')();
  await delay(150);
  assert.equal((await helper('inspector-state')).visible,false,'Escape must cancel a pending inspector without reopening');
  console.log('  ok Escape closes a loading inspector without accepting or unlinking');

  const closable = await showPopup();
  const button = closable.closeButtonFrame;
  assert.ok(button && button.width >= 12 && button.height >= 12, 'Popup has no usable native close button');
  assert.ok(button.x >= closable.frame.x - 1 && button.y >= closable.frame.y - 1
    && button.x + button.width <= closable.frame.x + closable.frame.width + 1
    && button.y + button.height <= closable.frame.y + closable.frame.height + 1,
  'Close button lies outside the popup');
  await until(() => helper('native-click', { x: button.x + button.width / 2,
    y: closable.primaryTop - button.y - button.height / 2 }), 'Popup close button is obscured by another window');
  await expectHidden('native close button dismisses the popup');

  await helper('popup-delayed');
  await helper('popup-key', { keyCode: 53 });
  await delay(650);
  await expectHidden('dismissed pending response cannot reopen the popup');

  if (!closeOnly) {
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
  }
  console.log(`${popupChecks} real-browser popup lifecycle checks passed.`);
} finally {
  if (helperStarted) { try { await helper('stop'); } catch {} }
  inspectorServer?.closeAllConnections();
  inspectorServer?.close();
  await predictionApplication?.close();
  socket?.close();
  if (chrome && chrome.exitCode === null) {
    chrome.kill('SIGTERM');
    await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), delay(2500)]);
    if (chrome.exitCode === null) chrome.kill('SIGKILL');
  }
  await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
