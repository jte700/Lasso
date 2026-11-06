import test from 'node:test';
import assert from 'node:assert/strict';
import { renderInspectorPanel } from '../src/sharing/share-page.js';

// The CSS body of the first rule whose selector list is exactly `selector`.
function ruleBody(html, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`(?:^|[}\\s])${escaped}\\{([^}]*)\\}`));
  assert.ok(match, `the inspector styles ${selector}`);
  return match[1];
}

test("The inspector's close button and actions are grey like the suggestion card, not the folder colour", () => {
  const html = renderInspectorPanel({ source: { label: 'Total', filename: 'budget.xlsx' } }, 'reference', null);

  const chrome = ['.close-inspector', '.close-inspector:hover', '.inspector-toolbar button',
    '.inspector-toolbar button:hover', '.inspector-toolbar kbd'];

  for (const selector of chrome) {
    assert.doesNotMatch(ruleBody(html, selector), /accent/, `${selector} is not drawn in the source's colour`);
  }
  assert.match(ruleBody(html, '.close-inspector'), /color:var\(--text2\)/, 'the close X is secondary grey');
  assert.match(ruleBody(html, '.inspector-toolbar button'), /color:var\(--text\)/, 'action titles read as plain labels');
});
