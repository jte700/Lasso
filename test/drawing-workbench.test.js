import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceWorkbench } from '../public/source-workbench.js';

test('source library submits natural measurement questions on Enter through grounded ask', async () => {
  const handlers = new Map(), requests = [];
  const input = { value: '', addEventListener: (name, handler) => handlers.set(name, handler) };
  createSourceWorkbench({ input, getProjectId: () => 'project', getActor: () => ({ id: 'user' }),
    api: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return { result: { headline: 'Room area: 120 ft²' } }; } });
  for (const question of ['What is the net square footage of Office 101?', 'ask What is the length of Main Road?']) {
    input.value = question;
    let prevented = false;
    await handlers.get('keydown')({ key: 'Enter', preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(requests.at(-1).url, '/api/projects/project/terminal');
    assert.equal(requests.at(-1).body.input, `ask ${question.replace(/^ask /, '')}`);
  }
  input.value = 'Office 101';
  await handlers.get('keydown')({ key: 'Enter' });
  assert.equal(requests.length, 2, 'ordinary searches do not execute terminal commands');
});

test('an explicit source selection survives a pending debounced search', async () => {
  const previousDocument = globalThis.document;
  const handlers = new Map();
  const input = { value: '', addEventListener: (name, handler) => handlers.set(name, handler) };
  const object = { id: 'wall-area', path: 'building.ifc', label: 'Exterior wall Area', valueText: '13 m²',
    anchor: { kind: 'cad-property', elementId: 'wall-guid', propertyName: 'Area' } };
  const button = { dataset: { object: object.id } };
  const host = { isConnected: true, innerHTML: '',
    querySelector: () => null,
    querySelectorAll: selector => selector === '[data-object]' ? [button] : [] };
  globalThis.document = { activeElement: null, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
  try {
    const workbench = createSourceWorkbench({ input, getProjectId: () => 'project', getActor: () => ({ id: 'user' }),
      api: async url => new URL(url, 'http://localhost').pathname.endsWith('/source-library') ? { objects: [object] }
        : url.endsWith('/terminal/session') ? { session: {} }
          : url.endsWith('/terminal/preview') ? { preview: { kind: 'text', lines: [{ text: 'Cited wall property', lineNumber: 1 }] } }
            : { plan: { edits: [] } } });
    workbench.setHost(host); await workbench.refresh();
    input.value = 'Exterior wall'; handlers.get('input')();
    await button.onclick();
    await new Promise(resolve => setTimeout(resolve, 160));
    assert.match(host.innerHTML, /Cited wall property/);
    assert.match(host.innerHTML, /data-open/);
    assert.doesNotMatch(host.innerHTML, /Select one to inspect its evidence/);
  } finally { globalThis.document = previousDocument; }
});
