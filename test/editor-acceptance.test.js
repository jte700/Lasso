import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { caretPointForTextLengths, contextualCompletionCase } from '../public/editor-acceptance.js';

test('accepted labels inherit sentence casing without damaging scientific identifiers', () => {
  assert.equal(contextualCompletionCase('Supplies', 'sup', 'The statement lists ', 'label'), 'supplies');
  assert.equal(contextualCompletionCase('Current Period', '', 'supplies for the ', 'label'), 'current period');
  assert.equal(contextualCompletionCase('Vitamin B1', 'vit', 'Our study found ', 'label'), 'vitamin B1');
  assert.equal(contextualCompletionCase('CON4', 'co', 'in row ', 'label'), 'CON4');
  assert.equal(contextualCompletionCase('Mohammad et al. (2021)', 'moh', 'The paper by ', 'proper-name'), 'Mohammad et al. (2021)');
  assert.equal(contextualCompletionCase('Supplies', 'Sup', '', 'label'), 'Supplies');
});

test('caret boundaries resolve after accepted linked text, not inside its final word', () => {
  assert.deepEqual(caretPointForTextLengths([8], 8), { atEnd: true });
  assert.deepEqual(caretPointForTextLengths([8, 4], 8), { atEnd: false, nodeIndex: 1, offset: 0 });
  assert.deepEqual(caretPointForTextLengths([8, 4], 3), { atEnd: false, nodeIndex: 0, offset: 3 });
});

// Execute the browser's actual async handlers with controlled network ordering.
// The DOM surface here only supplies the elements touched by each regression.
// Each handler is found in whichever workbench module declares it.
const appSources = ['editor-document.js', 'editor-predictions.js', 'dependency-picker.js', 'source-viewer.js',
  'dependency-sharing.js', 'snapshot-preview.js', 'workspace-shell.js']
  .map(file => fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'));
function appHandlers(names, globals) {
  const context = vm.createContext({ URLSearchParams, AbortController, clearTimeout, ...globals });
  for (const name of names) {
    const declaration = new RegExp(`^(?:export )?((?:async )?function ${name}\\()`, 'm');
    const appSource = appSources.find(text => declaration.test(text));
    assert.ok(appSource, `${name} is declared in a workbench module`);
    const match = declaration.exec(appSource);
    const start = match.index + match[0].length - match[1].length;
    const next = appSource.slice(start + 1).search(/\n(?:export )?(?:async )?function /);
    vm.runInContext(appSource.slice(start, next < 0 ? undefined : start + 1 + next), context);
  }
  return context;
}
const flush = () => new Promise(resolve => setImmediate(resolve));

function drawingCompletionHarness(text, fragment, candidate, claimDetails = {}) {
  const block = { isConnected: true, textContent: text,
    dataset: { blockIndex: '0', blockType: 'paragraph' } };
  const claim = { start: text.lastIndexOf(fragment), end: text.length, text: fragment,
    type: 'ENTITY', partial: true, candidates: [candidate], ...claimDetails };
  const state = { workspace: { revision: 1 }, editor: {
    document: { path: 'Draft.md', projectId: 'one' }, activeBlock: block,
  } };
  const links = [], history = [], caret = [], errors = [];
  const context = appHandlers(['predictForBlock', 'predictionEdit', 'acceptPrediction', 'namesWholeFile'], {
    state, AUTOMATIC_SUGGESTION_LIMIT: 40,
    document: { querySelectorAll() { return [block]; } },
    api: async () => ({ prediction: { claims: [claim] } }),
    caretOffsetWithin: () => block.textContent.length,
    pendingDependenciesForPrediction: () => [],
    showPredictionCompletion() {}, editorAssistStatus() {}, contextualCompletionCase,
    clearPrediction() { state.editor.prediction = null; },
    recordEditorHistory(...args) { history.push(args); },
    focusEditorBlock(_, offset) { caret.push(offset); },
    markEditorDirty() { state.editor.dirty = true; },
    async linkCandidate(...args) { links.push(args); },
    toast(message) { errors.push(message); },
  });
  return { context, state, block, links, history, caret, errors, candidate };
}

test('Tab replaces a partial drawing keyword even when it matches inside the source label', async () => {
  const label = 'AC20 FZK haus · Projekt-FZK-Haus';
  const h = drawingCompletionHarness('I was looking at the pro', 'pro', {
    id: 'drawing', objectType: 'DRAWING', label, path: 'AC20-FZK-haus.ifc',
  });
  await h.context.predictForBlock(h.block);
  assert.equal(h.state.editor.prediction.mode, 'COMPLETE_AND_LINK');
  assert.equal(h.state.editor.prediction.completion.kind, 'DRAWING_REFERENCE');
  await h.context.acceptPrediction();
  assert.equal(h.block.textContent, `I was looking at the ${label}`);
  assert.equal(h.links.length, 1);
  assert.equal(h.links[0][0].text, label);
  assert.equal(h.links[0][0].start, 'I was looking at the '.length);
  assert.equal(h.links[0][0].end, h.block.textContent.length);
  assert.equal(h.links[0][1].id, 'drawing');
  assert.deepEqual(h.history, [['prediction', true]]);
  assert.deepEqual(h.caret, [h.block.textContent.length]);
  assert.deepEqual(h.errors, []);
});

test('Tab completes any named file, not only drawings, to the name the server offers', async () => {
  const h = drawingCompletionHarness('I checked the General-Ledger.cs', 'General-Ledger.cs', {
    id: 'ledger', objectType: 'DATASET', label: 'General-Ledger.csv', path: 'Finance/General-Ledger.csv', fileReference: true,
  });
  await h.context.predictForBlock(h.block);
  assert.equal(h.state.editor.prediction.mode, 'COMPLETE_AND_LINK');
  await h.context.acceptPrediction();
  assert.equal(h.block.textContent, 'I checked the General-Ledger.csv');
  assert.equal(h.links[0][0].start, 'I checked the '.length);
  assert.equal(h.links[0][1].id, 'ledger');
  assert.deepEqual(h.errors, []);
});

test('drawing completion replaces only the matched alias and preserves Unicode sentence text', async () => {
  const h = drawingCompletionHarness('🏠 Please check the architectural drawing', 'architectural drawing', {
    id: 'home', objectType: 'DRAWING', label: 'Home', path: 'Home.ifc',
  });
  await h.context.predictForBlock(h.block);
  await h.context.acceptPrediction();
  assert.equal(h.block.textContent, '🏠 Please check the Home');
  assert.equal(h.links[0][0].start, '🏠 Please check the '.length);
  assert.equal(h.links[0][0].text, 'Home');
});

test('ordinary entity linking keeps the original typed text', async () => {
  for (const [objectType, partial] of [['MODEL', true], ['DRAWING', false]]) {
    const h = drawingCompletionHarness('I reviewed AC20', 'AC20', {
      id: 'source', objectType, label: 'AC20 model', path: 'Building.ifc',
    }, { partial });
    await h.context.predictForBlock(h.block);
    assert.equal(h.state.editor.prediction.mode, 'LINK');
    await h.context.acceptPrediction();
    assert.equal(h.block.textContent, 'I reviewed AC20');
    assert.equal(h.links[0][0].text, 'AC20');
    assert.equal(h.history.length, 0);
  }
});

test('drawing completion refuses to replace text after the user keeps typing', async () => {
  const h = drawingCompletionHarness('I was looking at the pro', 'pro', {
    id: 'drawing', objectType: 'DRAWING', label: 'AC20 FZK haus · Projekt-FZK-Haus',
  });
  await h.context.predictForBlock(h.block);
  h.block.textContent += 'gress';
  await h.context.acceptPrediction();
  assert.equal(h.block.textContent, 'I was looking at the progress');
  assert.equal(h.links.length, 0);
  assert.equal(h.history.length, 0);
  assert.equal(h.state.editor.prediction, null);
});

function editorHarness() {
  const requests = [], rendered = [], errors = [];
  const detail = { innerHTML: '' };
  const state = { project: { id: 'one' }, projectSwitchRevision: 0, editor: {
    document: null, documents: [], pendingLinks: [], navigationRevision: 0,
  } };
  const context = appHandlers(['openDocument', 'showSession'], {
    state, shell: {}, elements: { 'detail-column': detail }, document: { getElementById() { return {}; } },
    api: url => new Promise((resolve, reject) => requests.push({ url, resolve, reject })),
    setWorkspaceView(view) { state.view = view; if (view !== 'editor') state.editor.navigationRevision += 1; },
    refreshShell() {}, clearPrediction() {}, hideDependencyPicker() {},
    prepareDocumentForEditor: value => value, renderManuscriptBrowser() {},
    renderDocumentEditor() { rendered.push(state.editor.document.path); },
    toast(message) { errors.push(message); },
    dependencyShell: { setHost() {}, mount() {}, refresh() {} },
  });
  const doc = path => ({ document: { path, audit: { summary: {} } } });
  return { context, state, requests, rendered, errors, detail, doc };
}

test('opening documents keeps the latest selection when earlier project metadata arrives late', async () => {
  const h = editorHarness();
  const first = h.context.openDocument('First.md');
  h.requests[0].resolve(h.doc('First.md')); await flush();
  assert.equal(h.state.editor.document, null, 'document and project metadata commit together');
  const second = h.context.openDocument('Second.md');
  h.requests[2].resolve(h.doc('Second.md')); await flush();
  h.requests[3].resolve({ project: { id: 'one', currentVersion: 2 } }); await second;
  h.requests[1].resolve({ project: { id: 'one', currentVersion: 1 } }); await first;
  assert.deepEqual(h.rendered, ['Second.md']);
  assert.equal(h.state.editor.document.path, 'Second.md');
  assert.equal(h.state.project.currentVersion, 2);
  assert.equal(h.state.view, 'editor');
});

test('returning to sources cancels an unfinished document opening and its errors', async () => {
  for (const fail of [false, true]) {
    const h = editorHarness();
    const opening = h.context.openDocument('Previous.md');
    await h.context.showSession();
    const html = h.detail.innerHTML;
    if (fail) h.requests[0].reject(new Error('Previous document failure'));
    else h.requests[0].resolve(h.doc('Previous.md'));
    await opening;
    assert.equal(h.state.editor.document, null);
    assert.equal(h.state.view, 'session');
    assert.equal(h.detail.innerHTML, html);
    assert.deepEqual(h.rendered, []);
    assert.deepEqual(h.errors, []);
  }
});

test('manual source search ignores older queries and errors after the picker closes', async () => {
  const requests = [];
  const target = { isConnected: true, innerHTML: '', querySelectorAll() { return []; } };
  const picker = { hidden: false, replaceChildren() { target.isConnected = false; } };
  const state = { editor: { document: { path: 'Draft.md', projectId: 'one' }, manualClaim: { text: 'value' } } };
  const context = appHandlers(['loadPickerResults', 'hideDependencyPicker'], {
    state, document: { getElementById: id => id === 'picker-results' ? target : picker },
    api: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
    escapeHtml: String,
  });
  const first = context.loadPickerResults('first');
  const second = context.loadPickerResults('second');
  assert.equal(requests[0].options.signal.aborted, true);
  requests[1].resolve({ objects: [{ id: 'two', label: 'Current source' }] }); await second;
  const current = target.innerHTML;
  requests[0].resolve({ objects: [{ id: 'one', label: 'Old source' }] }); await first;
  assert.equal(target.innerHTML, current);
  assert.match(current, /Current source/);
  const third = context.loadPickerResults('third');
  context.hideDependencyPicker();
  requests[2].reject(new Error('Cancelled request')); await third;
  assert.equal(requests[2].options.signal.aborted, true);
  assert.equal(target.innerHTML, current);
});

test('a source viewer cannot be overwritten by an older source response or failure', async () => {
  for (const fail of [false, true]) {
    const requests = [], rendered = [], usage = [];
    const target = { innerHTML: '' };
    const dialog = { open: false, querySelector() { return target; }, showModal() { this.open = true; } };
    const context = appHandlers(['openDependencySourceViewer'], {
      state: { project: { id: 'one' }, editor: { viewerRequest: 0 } },
      api: url => new Promise((resolve, reject) => requests.push({ url, resolve, reject })),
      ensureDependencySourceViewer: () => dialog,
      renderDependencySourceViewer(_, viewer) { rendered.push(viewer.id); target.innerHTML = viewer.id; },
      recordRecommendationUsage(source) { usage.push(source.dependencyId); },
    });
    const first = context.openDependencySourceViewer('first');
    const second = context.openDependencySourceViewer('second');
    requests[1].resolve({ viewer: { id: 'second' } }); await second;
    if (fail) requests[0].reject(new Error('Obsolete failure'));
    else requests[0].resolve({ viewer: { id: 'first' } });
    await first;
    assert.deepEqual(rendered, ['second']);
    assert.deepEqual(usage, ['second']);
    assert.equal(target.innerHTML, 'second');
  }
});

test('source-sharing responses stay attached to the inspected source', async () => {
  const requests = [], rendered = [];
  const target = { isConnected: true, innerHTML: '' };
  const context = appHandlers(['openDependencySharing'], {
    state: { editor: { sharingRequest: 0 } },
    document: { getElementById() { return target; } },
    api: url => new Promise(resolve => requests.push({ url, resolve })),
    renderDependencySharing(dependency) { rendered.push(dependency.id); },
  });
  const first = context.openDependencySharing({ id: 'first' });
  const second = context.openDependencySharing({ id: 'second' });
  requests[1].resolve({ sharing: {} }); await second;
  requests[0].resolve({ sharing: {} }); await first;
  assert.deepEqual(rendered, ['second']);
  const third = context.openDependencySharing({ id: 'third' });
  target.isConnected = false;
  requests[2].resolve({ sharing: {} }); await third;
  assert.deepEqual(rendered, ['second']);
});


test('drawing/file previews ignore late results after another source or document is opened', async () => {
  const requests = [], rendered = [], errors = [];
  const state = { project: { id: 'one' }, editor: { navigationRevision: 0 } };
  const context = appHandlers(['showPreview'], {
    state, api: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    renderPreview: preview => rendered.push(preview.path), recordRecommendationUsage() {},
    toast: message => errors.push(message),
  });
  const first = context.showPreview('snapshot', 'old.ifc');
  const second = context.showPreview('snapshot', 'current.ifc');
  requests[1].resolve({ preview: { path: 'current.ifc' } }); await second;
  requests[0].resolve({ preview: { path: 'old.ifc' } }); await first;
  assert.deepEqual(rendered, ['current.ifc']);
  const third = context.showPreview('snapshot', 'abandoned.ifc');
  state.editor.navigationRevision += 1;
  requests[2].reject(new Error('Old source error')); await third;
  assert.deepEqual(errors, []);
});
