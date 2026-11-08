import test from 'node:test';
import assert from 'node:assert/strict';
import { compileContext } from '../src/agent/structural/compiler.js';
import { applyContextUpdate, contextDigest, refineContext } from '../src/agent/structural/refinement.js';

function fixture(revision = 'v1', second = false) {
  const source = { id: 'study', revision };
  return {
    expectedRevisions: { study: revision }, budgetBytes: 20000,
    requirements: second ? ['result', 'limitation'] : ['result'],
    records: [
      { id: 'r', text: 'The specified result with essential context. '.repeat(50), requires: ['definition'], validity: 'valid', source },
      { id: 'definition', text: 'Outcome definition.', requires: [], validity: 'valid', source },
      { id: 'limitation', text: 'The result applies only to this population.', requires: ['definition'], validity: 'valid', source },
    ],
    alternatives: [
      { id: 'result', covers: ['result'], evidence: ['r'], audit: [], guarantee: 'declared_dependencies' },
      ...(second ? [{ id: 'limitation', covers: ['limitation'], evidence: ['limitation'], audit: [], guarantee: 'declared_dependencies' }] : []),
    ],
  };
}

test('explicit retained digest permits a smaller patch that reconstructs the full next context', () => {
  const previous = compileContext(fixture());
  const update = refineContext({ previous, request: fixture('v1', true), retainedDigest: contextDigest(previous.payload) });
  assert.equal(update.kind, 'patch');
  assert.deepEqual(update.payload.upsert.map((x) => x.id), ['limitation']);
  assert.ok(update.audit.responseBytes < update.audit.fullResponseBytes);
  assert.equal(contextDigest(applyContextUpdate(previous.payload, update.payload)), contextDigest(update.full.payload));
  assert.equal(Buffer.byteLength(update.text), update.audit.responseBytes);
});

test('missing or stale retention confirmation returns complete evidence after compaction', () => {
  const previous = compileContext(fixture());
  for (const retainedDigest of [undefined, 'wrong']) {
    const update = refineContext({ previous, request: fixture('v1', true), retainedDigest });
    assert.equal(update.kind, 'full');
    assert.deepEqual(applyContextUpdate(null, update.payload), update.full.payload);
  }
});

test('small responses use full replacement when patch framing would cost more', () => {
  const request = fixture(); request.records[0].text = 'A result.';
  const previous = compileContext(request);
  const update = refineContext({ previous, request, retainedDigest: contextDigest(previous.payload) });
  assert.equal(update.kind, 'full');
  assert.equal(update.audit.reason, 'patch_not_smaller');
});

test('revision changes replace all retained facts and never reuse old sources', () => {
  const previous = compileContext(fixture());
  const update = refineContext({ previous, request: fixture('v2', true), retainedDigest: contextDigest(previous.payload) });
  const next = applyContextUpdate(previous.payload, update.payload);
  assert.ok(next.evidence.every((item) => item.source.revision === 'v2'));
  assert.equal(next.status, 'complete_for_declared_requirements');
});

test('stale next inputs remove old facts and preserve unmet requirements', () => {
  const previous = compileContext(fixture());
  const request = fixture('v1', true); request.expectedRevisions.study = 'v2';
  const update = refineContext({ previous, request, retainedDigest: contextDigest(previous.payload) });
  const next = applyContextUpdate(previous.payload, update.payload);
  assert.equal(next.status, 'partial');
  assert.deepEqual(next.evidence, []);
  assert.deepEqual(next.missing, ['limitation', 'result']);
});

test('refinement cannot silently forget a requirement from the earlier request', () => {
  const previous = compileContext(fixture());
  const request = fixture('v1', true);
  request.requirements = ['limitation'];
  const update = refineContext({ previous, request });
  assert.deepEqual(update.full.payload.covered, ['limitation', 'result']);
});

test('tampered patch or wrong retained payload fails reconstruction', () => {
  const previous = compileContext(fixture());
  const update = refineContext({ previous, request: fixture('v1', true), retainedDigest: contextDigest(previous.payload) });
  assert.throws(() => applyContextUpdate(null, update.payload), /base digest mismatch/);
  const changed = structuredClone(previous.payload); changed.evidence[0].text += 'changed';
  assert.throws(() => applyContextUpdate(changed, update.payload), /base digest mismatch/);
  const corrupted = structuredClone(update.payload); corrupted.upsert[0].text = 'fabricated';
  assert.throws(() => applyContextUpdate(previous.payload, corrupted), /patch digest mismatch/);
});

test('refinement respects tokenizer budget even when a byte-smaller patch tokenizes poorly', () => {
  const tokenCounter = (text) => text.includes('structural_context_patch') ? 500 : 20;
  const request = { ...fixture(), tokenCounter, budgetTokens: 30 };
  const previous = compileContext(request);
  const update = refineContext({ previous, request: { ...request, ...fixture('v1', true) }, retainedDigest: contextDigest(previous.payload) });
  assert.equal(update.kind, 'full'); assert.equal(update.audit.responseTokens, 20);
});
