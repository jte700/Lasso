import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const script = fs.readFileSync(new URL('../public/platform.js', import.meta.url), 'utf8');
function boot({ search = '', platform = 'Win32', windows = false, mac = false } = {}) {
  const sent = [], events = [], listeners = {}, classes = [];
  const window = { location: { search }, dispatchEvent: event => events.push(event) };
  if (windows) window.chrome = { webview: { postMessage: data => sent.push(data), addEventListener: (type, callback) => { listeners[type] = callback; } } };
  if (mac) window.webkit = { messageHandlers: { lasso: { postMessage: data => sent.push(data) } } };
  const document = { documentElement: { dataset: {}, classList: { add: name => classes.push(name) } } };
  vm.runInNewContext(script, { window, document, navigator: { platform }, URLSearchParams, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } });
  return { api: window.lassoPlatform, document, sent, events, listeners, classes };
}
test('Windows browser uses Ctrl labels without gaining native capabilities', () => {
  const app = boot();
  assert.equal(app.api.name, 'windows');
  assert.equal(app.api.shortcut('L', true), 'Ctrl+Shift+L');
  assert.equal(app.api.isNative, false);
  assert.equal(app.api.canChooseFolder, false);
  assert.equal(app.api.postMessage({ action: 'chooseFolder' }), false);
});
test('Windows host sends project and folder commands and validates native response shapes', () => {
  const app = boot({ search: '?app=1&platform=windows', windows: true });
  assert.equal(app.api.isNative, true);
  app.api.postMessage({ activeProjectId: 'project-a' });
  assert.equal(app.sent[0].activeProjectId, 'project-a');
  app.listeners.message({ data: { type: 'assist-state', enabled: 'yes' } });
  app.listeners.message({ data: { type: 'folder-selected', path: 7 } });
  assert.equal(app.events.length, 0);
  app.listeners.message({ data: { type: 'assist-state', enabled: true } });
  app.listeners.message({ data: { type: 'folder-selected', path: null } });
  app.listeners.message({ data: { type: 'open-source', sourceId: 'source-a', versionId: 'v1' } });
  assert.deepEqual(app.events.map(e => e.type), ['lasso-assist-state', 'lasso-folder-selected', 'lasso-open-source']);
  assert.equal(app.events[2].detail.versionId, 'v1');
});
test('Mac companion retains its bridge and command shortcuts', () => {
  const app = boot({ search: '?app=1', platform: 'MacIntel', mac: true });
  assert.equal(app.api.shortcut('K'), '⌘K');
  assert.equal(app.api.isNative, true);
  assert.equal(app.api.canChooseFolder, false);
  app.api.postMessage({ action: 'suggestionState' });
  assert.equal(app.sent[0].action, 'suggestionState');
});
test('visual Windows preview never enables an absent bridge', () => {
  const app = boot({ search: '?app=1&platform=windows', platform: 'MacIntel' });
  assert.equal(app.api.isWindows, true);
  assert.equal(app.api.isNative, false);
});
