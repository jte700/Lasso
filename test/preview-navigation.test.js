import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the production handlers with deliberately reordered network results.
// A Windows checkout may use CRLF line endings; handlers are found by LF.
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function handler(name) {
  const start = app.indexOf(`async function ${name}(`);
  const end = app.indexOf('\n}\n', start) + 2;
  assert.ok(start >= 0 && end > start);
  return app.slice(start, end);
}
function harness() {
  const requests = [], rendered = [], errors = [], usage = [];
  const target = { innerHTML: '' };
  const dialog = { open: false, querySelector: () => target, showModal() { this.open = true; } };
  const state = { project: { id: 'accounting' }, editor: { navigationRevision: 0, viewerRequest: 0 } };
  const context = vm.createContext({ state, URLSearchParams, encodeURIComponent,
    api: url => new Promise((resolve, reject) => requests.push({ url, resolve, reject })),
    renderPreview: preview => rendered.push(preview),
    renderDependencySourceViewer: (_, viewer) => rendered.push(viewer),
    recordRecommendationUsage: source => usage.push(source),
    toast: message => errors.push(message),
    ensureDependencySourceViewer: () => dialog,
    escapeHtml: String,
    document: { getElementById: () => ({ addEventListener() {} }) },
  });
  vm.runInContext(`${handler('showPreview')}\n${handler('openDependencySourceViewer')}`, context);
  return { context, state, requests, rendered, errors, usage, dialog, target };
}

test('a slow model source cannot overwrite a newer element or a departed workspace', async () => {
  const h = harness();
  const first = h.context.showPreview('v34', 'building.ifc', { elementId: 'room' });
  const second = h.context.showPreview('v34', 'building.ifc', { elementId: 'wall' });
  assert.match(h.requests[1].url, /elementId=wall/);
  h.requests[1].resolve({ preview: { selected: 'wall' } }); await second;
  h.requests[0].resolve({ preview: { selected: 'room' } }); await first;
  assert.deepEqual(h.rendered, [{ selected: 'wall' }]);
  assert.equal(h.usage.length, 1);

  const abandoned = h.context.showPreview('v34', 'building.ifc');
  h.state.editor.navigationRevision += 1; // Workspace navigation invalidates the active load.
  h.requests[2].reject(new Error('stale geometry error')); await abandoned;
  assert.deepEqual(h.errors, []);
  const switched = h.context.showPreview('v34', 'building.ifc');
  h.state.project = { id: 'another-project' };
  h.requests[3].resolve({ preview: { selected: 'room' } }); await switched;
  assert.equal(h.rendered.length, 1);
});

test('closing and reopening the source viewer discards its previous geometry and errors', async () => {
  const h = harness();
  const first = h.context.openDependencySourceViewer('room');
  h.dialog.open = false;
  const second = h.context.openDependencySourceViewer('door');
  h.requests[1].resolve({ viewer: { selected: 'door' } }); await second;
  const content = h.target.innerHTML;
  h.requests[0].reject(new Error('stale room failure')); await first;
  assert.deepEqual(h.rendered, [{ selected: 'door' }]);
  assert.equal(h.target.innerHTML, content);

  const third = h.context.openDependencySourceViewer('wall');
  h.dialog.open = false;
  h.requests[2].resolve({ viewer: { selected: 'wall' } }); await third;
  assert.equal(h.rendered.length, 1);
  assert.equal(h.usage.length, 1);
});

test('opening a PDF source renders its preserved page and selectable text safely', () => {
  const start = app.indexOf('function previewContent(');
  const end = app.indexOf('\n}\n', start) + 2;
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({
    escapeHtml: value => String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[character])),
  });
  vm.runInContext(app.slice(start, end), context);
  const preview = {
    kind: 'pdf', path: 'Plans & notes.pdf', pageNumber: 1,
    fileUrl: '/api/snapshots/old-version/source?path=Plans%20%26%20notes.pdf',
    pages: [
      { pageNumber: 1, text: 'The original source text.', anchor: { kind: 'pdf-page', pageNumber: 1 } },
      { pageNumber: 3, text: 'The room is < 40 m2. <script>text only</script>', anchor: { kind: 'pdf-page', pageNumber: 3 } },
    ],
    warnings: ['Only the first 80 pages were extracted.'],
  };
  const html = context.previewContent(preview, { kind: 'drawing-sheet', pageNumber: 3 });
  assert.match(html, /class="source-viewer-pdf snapshot-pdf"/);
  assert.match(html, /old-version\/source\?path=Plans%20%26%20notes\.pdf#page=3&amp;zoom=page-width/);
  assert.match(html, /title="Plans &amp; notes\.pdf"/);
  assert.match(html, /Selectable PDF text/);
  assert.match(html, /&quot;kind&quot;:&quot;pdf-page&quot;,&quot;pageNumber&quot;:3/);
  assert.match(html, /The room is &lt; 40 m2\. &lt;script&gt;text only&lt;\/script&gt;/);
  assert.match(html, /Only the first 80 pages were extracted/);
  assert.doesNotMatch(html, /<script>|binary-preview|Preview unavailable/);
  assert.match(context.previewContent(preview), /#page=1&amp;zoom=page-width/);
});
