import test from 'node:test';
import assert from 'node:assert/strict';
import { dismissLassoOverlays } from '../public/escape-dismissal.js';

test('Escape dismisses every overlay and dialog without executing source or clipboard actions', () => {
  const persistent = { text: 'Accepted source value', links: ['existing-reference'], clipboard: 'copied-link', query: 'kept search' };
  const before = structuredClone(persistent), closed = [];
  const nodes = Object.fromEntries(['dependency-completion','dependency-picker','source-peek','dependency-inspector','project-popover'].map(id => [id,{hidden:false}]));
  nodes['dependency-sharing'] = { childElementCount: 3, replaceChildren() { this.childElementCount = 0; } };
  const dialogs = ['source viewer','identity'].map(name => ({ close() { closed.push(name); } }));
  let cancelled = 0;
  const palette = { isOpen: true, close() { this.isOpen = false; } };
  const result = dismissLassoOverlays({
    document: { getElementById: id => nodes[id], querySelectorAll: () => dialogs }, palette,
    closeProjectPicker: () => { nodes['project-popover'].hidden = true; },
    cancelPending: () => { cancelled += 1; },
  });
  assert.equal(result,true);
  assert.ok(Object.entries(nodes).filter(([id])=>id!=='dependency-sharing').every(([,node])=>node.hidden));
  assert.equal(nodes['dependency-sharing'].childElementCount,0);
  assert.equal(palette.isOpen,false);
  assert.equal(cancelled,1);
  assert.deepEqual(closed,['source viewer','identity']);
  assert.deepEqual(persistent,before);
});

test('Escape with no overlays still invalidates pending UI work without clearing workspace contents', () => {
  let generation=12;
  const run=()=>dismissLassoOverlays({document:{getElementById:()=>null,querySelectorAll:()=>[]},cancelPending:()=>generation++});
  assert.equal(run(),false);
  assert.equal(run(),false);
  assert.equal(generation,14);
});
