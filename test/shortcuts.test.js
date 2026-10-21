import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { shortcutSections, shortcutListMarkup } from '../public/shortcuts.js';

const catalog = JSON.parse(fs.readFileSync(new URL('../public/shortcuts.json', import.meta.url), 'utf8'));
const entries = catalog.sections.flatMap((section) => section.shortcuts);
const keysFor = (platform) => entries.map((entry) => entry[platform]).filter(Boolean);

test('every shortcut names its action and the keys for at least one platform', () => {
  assert.ok(catalog.sections.length > 0);
  for (const section of catalog.sections) {
    assert.ok(section.title.trim(), 'a section has a title');
    assert.ok(section.shortcuts.length > 0, `${section.title} lists shortcuts`);
    const actions = section.shortcuts.map((entry) => entry.action);
    assert.equal(new Set(actions).size, actions.length, `${section.title} lists each action once`);
    for (const entry of section.shortcuts) {
      assert.ok(entry.action.trim(), `${section.title} entries have an action`);
      assert.ok(entry.macos || entry.windows, `${entry.action} has keys for a platform`);
      assert.deepEqual(Object.keys(entry).filter((key) => !['action', 'macos', 'windows'].includes(key)), [],
        `${entry.action} has no unknown fields`);
    }
  }
});

test('Mac keys use modifier symbols in the order macOS menus show them', () => {
  const order = ['⌃', '⌥', '⇧', '⌘'];
  for (const keys of keysFor('macos')) {
    assert.doesNotMatch(keys, /Ctrl|Cmd|Command|Option|Alt|Shift|\+/, `${keys} uses Mac symbols`);
    const modifiers = [...keys].filter((character) => order.includes(character));
    const sorted = [...modifiers].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    assert.deepEqual(modifiers, sorted, `${keys} lists modifiers as ⌃⌥⇧⌘`);
  }
});

test('Windows keys spell out modifiers in the order Windows shows them', () => {
  for (const keys of keysFor('windows')) {
    assert.doesNotMatch(keys, /[⌃⌥⇧⌘⇥↩]|fn/, `${keys} uses Windows names`);
    const modifiers = keys.split('+').slice(0, -1);
    const order = ['Ctrl', 'Alt', 'Shift'];
    assert.ok(modifiers.every((modifier) => order.includes(modifier)), `${keys} uses known modifiers`);
    assert.deepEqual(modifiers, [...modifiers].sort((a, b) => order.indexOf(a) - order.indexOf(b)),
      `${keys} lists modifiers as Ctrl+Alt+Shift`);
  }
});

test('the suggestion keys each host routes are listed for that host', () => {
  const suggestions = catalog.sections.find((section) => section.title === 'Suggestions while typing').shortcuts;
  const keys = (platform) => suggestions.map((entry) => entry[platform]).filter(Boolean);
  for (const expected of ['⇥', '⌘↩', '⇧⌘↩', '↑↓', 'fn ←', 'fn →', '⌘Z', 'Esc']) assert.ok(keys('macos').includes(expected), expected);
  for (const expected of ['Tab', 'Ctrl+Enter', 'Ctrl+Shift+Enter', '↑↓', 'F4', 'Esc']) assert.ok(keys('windows').includes(expected), expected);
});

test('each platform sees only its own shortcuts, and empty sections are left out', () => {
  const windows = shortcutSections(catalog, 'windows');
  const mac = shortcutSections(catalog, 'macos');
  assert.ok(!windows.some((section) => section.title === 'Lasso'), 'Windows has no Mac app commands');
  assert.ok(mac.some((section) => section.title === 'Lasso'));
  const windowsKeys = windows.flatMap((section) => section.shortcuts.map((shortcut) => shortcut.keys));
  const macKeys = mac.flatMap((section) => section.shortcuts.map((shortcut) => shortcut.keys));
  assert.ok(windowsKeys.includes('F4') && !macKeys.includes('F4'));
  assert.ok(macKeys.includes('⌘L') && !windowsKeys.some((keys) => keys.includes('⌘')));
  const search = (sections) => sections.find((section) => section.title === 'Workspace').shortcuts
    .find((shortcut) => shortcut.action === 'Search').keys;
  assert.equal(search(windows), 'Ctrl+K');
  assert.equal(search(mac), '⌘K');
});

test('malformed entries are skipped instead of shown half-filled', () => {
  const sections = shortcutSections({
    sections: [
      { title: 'Kept', note: '  ', shortcuts: [{ action: 'Save', windows: 'Ctrl+S' }, { action: '', windows: 'Ctrl+X' }, { action: 'Odd', windows: 7 }, null] },
      { title: 'No list', shortcuts: 'Ctrl+K' },
      { title: 'Mac only', shortcuts: [{ action: 'Quit', macos: '⌘Q' }] },
    ],
  }, 'windows');
  assert.deepEqual(sections, [{ title: 'Kept', note: null, shortcuts: [{ action: 'Save', keys: 'Ctrl+S' }] }]);
  assert.deepEqual(shortcutSections(null, 'windows'), []);
  assert.deepEqual(shortcutSections({ sections: 'none' }, 'macos'), []);
});

test('the list escapes text it shows', () => {
  const markup = shortcutListMarkup([{ title: 'A & B', note: '<b>note</b>', shortcuts: [{ action: '"Quote"', keys: '<Ctrl>' }] }]);
  assert.match(markup, /<h4>A &amp; B<\/h4>/);
  assert.match(markup, /&lt;b&gt;note&lt;\/b&gt;/);
  assert.match(markup, /<dt>&quot;Quote&quot;<\/dt><dd><kbd>&lt;Ctrl&gt;<\/kbd><\/dd>/);
  assert.doesNotMatch(shortcutListMarkup([{ title: 'T', note: null, shortcuts: [] }]), /shortcut-note/);
});

test('the server hands the shortcut list to the workspace as JSON', async (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-shortcuts-'));
  const app = createApplication({ dataDir: path.join(sandbox, 'data'), watchProjects: false, port: 0 });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/shortcuts.json`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(await response.json(), catalog);
});
