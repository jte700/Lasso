import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the production handlers with deliberately reordered network results.
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
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
