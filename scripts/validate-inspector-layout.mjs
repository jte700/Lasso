// Render the actual inspector in an isolated browser, including a cited cell
// beyond the initial viewport. No workspace, clipboard or user profile is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderInspectorPanel } from '../src/sharing/share-page.js';

const temporary = await mkdtemp(path.join(tmpdir(), 'lasso-inspector-layout-'));
const source = { label: 'Clinic appointment capacity', filename: 'Harbour-Appointment-Capacity.xlsx',
  absolutePath: '/Users/Example/Desktop/Software Tests/Healthcare/Harbour-Appointment-Capacity.xlsx',
  location: 'S58' };
const table = { kind: 'table', sheet: 'Clinic capacity', columns: Array.from({ length: 20 }, (_, index) => String.fromCharCode(65 + index)),
  rows: Array.from({ length: 60 }, (_, row) => ({ rowNumber: row + 1,
    cells: Array.from({ length: 20 }, (_, column) => ({ value: row === 0 ? `Heading ${column + 1}` : `Row ${row + 1}, field ${column + 1}`,
      cited: row === 57 && column === 18 })) })) };
const cases = [
  { name: 'table-default', width: 560, height: 540, preview: table },
  { name: 'table-resized', width: 940, height: 700, preview: table },
  { name: 'table-short', width: 560, height: 440, preview: table },
  { name: 'table-narrow', width: 320, height: 420, preview: table },
  { name: 'long-metadata', width: 560, height: 440, preview: table,
    source: { ...source, label: 'A long descriptive source label '.repeat(30), filename: `${'VeryLongWorkbookName'.repeat(20)}.xlsx`,
      absolutePath: `/Users/Example/${'VeryLongDirectoryName/'.repeat(60)}source.xlsx` } },
  { name: 'source-lines', width: 560, height: 440, preview: { kind: 'text',
    lines: Array.from({ length: 70 }, (_, index) => ({ lineNumber: index + 1, value: `${index}: ${'long source line '.repeat(30)}`, cited: index === 62 })) } },
  { name: 'document-text', width: 560, height: 440, preview: { kind: 'text', extracted: true,
    lines: [{ value: 'Medical administration policy '.repeat(600) }] } },
  { name: 'image', width: 560, height: 440, preview: { kind: 'image',
    fileUrl: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="400" height="1600"%3E%3Crect width="400" height="1600" fill="%239cc9ff"/%3E%3C/svg%3E' } },
  { name: 'pdf', width: 560, height: 440, preview: { kind: 'pdf', page: 1, fileUrl: 'about:blank' } },
  { name: 'drawing', width: 560, height: 440, preview: { kind: 'model-plan', format: 'dxf',
    fileName: 'Floor plan', units: 'm', bounds: { minX: 0, minY: 0, maxX: 10, maxY: 6 }, elements: [],
    drawing: [{ type: 'path', id: 'walls', points: [[0, 0], [10, 0], [10, 6], [0, 6]], closed: true }] } },
];
let chrome, socket;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(read, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { try { const value = await read(); if (value) return value; } catch {} await delay(50); }
  throw new Error(label);
}
try {
  const profile = path.join(temporary, 'chrome-profile');
  chrome = spawn(process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    `--user-data-dir=${profile}`, '--headless=new', '--remote-debugging-port=0', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', 'about:blank',
  ], { stdio: 'ignore' });
  const port = await until(async () => Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]), 'Chrome did not start');
  const page = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(item => item.type === 'page'), 'Browser tab missing');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const pending = new Map(), browserErrors = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') browserErrors.push(message.params.exceptionDetails.text);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'Page evaluation failed');
    return result.result.value;
  };
  await call('Runtime.enable');
  await call('Page.enable');
  for (const scenario of cases) {
    const filename = path.join(temporary, `${scenario.name}.html`);
    await writeFile(filename, renderInspectorPanel({ source: scenario.source ?? source }, 'reference-1', scenario.preview));
    await call('Emulation.setDeviceMetricsOverride', { width: scenario.width, height: scenario.height, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: pathToFileURL(filename).href });
    await until(() => evaluate(`document.readyState === 'complete' && document.title.includes('source') && Boolean(document.querySelector('.inspector-toolbar'))`), `${scenario.name}: page did not load`);
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const state = await evaluate(`(() => {
      const rect = element => { const r = element.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom }; };
      const scroll = document.querySelector('.preview-scroll'), selected = document.querySelector('.cited');
      return { width: innerWidth, height: innerHeight, rootWidth:document.documentElement.scrollWidth,
        rootHeight:document.documentElement.scrollHeight, scrollX, scrollY,
        header:rect(document.querySelector('.source-summary')), details:rect(document.querySelector('.inspector-details')),
        preview:rect(document.querySelector('.inspector-preview')), toolbar:rect(document.querySelector('.inspector-toolbar')),
        controls:[...document.querySelectorAll('[data-action]')].map(rect),
        selected:selected ? rect(selected) : null, viewport:scroll ? rect(scroll) : null,
        rowHeader:selected?.closest('tr')?.querySelector('.row-number') ? rect(selected.closest('tr').querySelector('.row-number')) : null,
        columnHeader:selected?.closest('td') ? rect(document.querySelectorAll('thead th')[19]) : null,
        fitted:document.querySelector('.preview-model .model-plan-svg, .preview-image .source-image, .source-pdf')
          ? rect(document.querySelector('.preview-model .model-plan-svg, .preview-image .source-image, .source-pdf')) : null,
        scroll:scroll ? {left:scroll.scrollLeft, top:scroll.scrollTop, width:scroll.clientWidth, height:scroll.clientHeight,
          fullWidth:scroll.scrollWidth, fullHeight:scroll.scrollHeight,
          verticalGutter:scroll.offsetWidth - scroll.clientWidth, horizontalGutter:scroll.offsetHeight - scroll.clientHeight} : null };
    })()`);
    assert.equal(state.scrollX, 0, `${scenario.name}: root must not move horizontally`);
    assert.equal(state.scrollY, 0, `${scenario.name}: root must not move vertically`);
    assert.ok(state.rootWidth <= state.width && state.rootHeight <= state.height, `${scenario.name}: document escaped its viewport: ${JSON.stringify(state)}`);
    for (const rectangle of [state.header, state.details, state.preview, state.toolbar, ...state.controls]) {
      assert.ok(rectangle.x >= -1 && rectangle.right <= state.width + 1 && rectangle.y >= -1 && rectangle.bottom <= state.height + 1,
        `${scenario.name}: inspector control clipped: ${JSON.stringify(rectangle)}`);
    }
    assert.ok(state.preview.height >= 80, `${scenario.name}: metadata consumed the source viewport`);
    if (state.fitted) {
      assert.ok(state.fitted.width > 0 && state.fitted.height > 0 && state.fitted.x >= state.preview.x
        && state.fitted.right <= state.preview.right && state.fitted.y >= state.preview.y
        && state.fitted.bottom <= state.preview.bottom, `${scenario.name}: visual source should fit its preview: ${JSON.stringify(state)}`);
    }
    if (state.selected && scenario.preview.kind === 'table') {
      assert.ok(state.scroll.verticalGutter >= 10 && state.scroll.horizontalGutter >= 10,
        `${scenario.name}: overflowing worksheet should show persistent scrollbars`);
      assert.ok(state.scroll.left > 0 && state.scroll.top > 0, `${scenario.name}: selected far-away cell must move source viewport`);
      assert.ok(state.selected.x >= state.viewport.x + 30 && state.selected.right <= state.viewport.right + 1
        && state.selected.y >= state.viewport.y + 26 && state.selected.bottom <= state.viewport.bottom + 1,
      `${scenario.name}: selected cell must remain visible beside sticky row/column headings: ${JSON.stringify(state)}`);
      assert.ok(state.rowHeader.x >= state.viewport.x && state.rowHeader.right <= state.viewport.right,
        `${scenario.name}: worksheet row numbers should stay visible while scrolling horizontally`);
      assert.ok(state.columnHeader.y >= state.viewport.y && state.columnHeader.bottom <= state.viewport.bottom,
        `${scenario.name}: worksheet column headings should stay visible while scrolling vertically`);
    }
    // Every far edge remains reachable without moving fixed source details or controls.
    const end = await evaluate(`(() => { const scroll = document.querySelector('.preview-scroll'); if (!scroll) return null;
      scroll.scrollLeft = scroll.scrollWidth; scroll.scrollTop = scroll.scrollHeight;
      return {left:scroll.scrollLeft,top:scroll.scrollTop,width:scroll.clientWidth,height:scroll.clientHeight,
        fullWidth:scroll.scrollWidth,fullHeight:scroll.scrollHeight,x:scrollX,y:scrollY}; })()`);
    if (end) {
      assert.equal(end.left + end.width, end.fullWidth, `${scenario.name}: right edge unreachable`);
      assert.equal(end.top + end.height, end.fullHeight, `${scenario.name}: bottom edge unreachable`);
      assert.equal(end.x, 0); assert.equal(end.y, 0);
    }
    if (process.env.LASSO_LAYOUT_SCREENSHOT && scenario.name === 'table-default') {
      await call('Page.reload');
      await delay(150);
      const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(process.env.LASSO_LAYOUT_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
    }
    console.log(`PASS ${scenario.name}: contained source, visible controls, reachable content`);
  }
  assert.deepEqual(browserErrors, [], 'Inspector must not throw browser errors');
  console.log(`PASS ${cases.length} inspector layouts`);
} finally {
  socket?.close();
  if (chrome && chrome.exitCode === null) {
    chrome.kill('SIGTERM');
    await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), delay(3000)]);
  }
  await rm(temporary, { recursive: true, force: true });
}
