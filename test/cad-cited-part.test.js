import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { buildStepView } from '../src/dependencies/step-geometry.js';
import { ASSEMBLY_ELEMENT } from '../src/dependencies/step-extraction.js';
import { citedPartModel } from '../src/sharing/cited-part.js';
import { bracketPart, fixtureAssembly } from './fixtures/step-models.js';

const actor = { id: 'human:cad-reviewer', displayName: 'CAD reviewer', actorType: 'HUMAN_SELF' };
const assembly = Buffer.from(fixtureAssembly());

test('a cited part shows one instance of that part with its cited feature still marked', async () => {
  const view = await buildStepView(assembly, { elementId: 'Pin', featureId: null });
  const part = citedPartModel(view);
  assert.ok(part, 'a cited part can be shared on its own');
  assert.equal(part.citedPart, true);
  assert.ok(part.elements.length > 0 && part.elements.every(element => element.guid === 'Pin'),
    'no other component of the assembly is published');
  assert.equal(new Set(part.elements.map(element => element.id)).size, 1, 'a part placed twice is shown once');
  assert.ok(part.elements.some(element => element.selected));
  assert.deepEqual(part.warnings, [], 'warnings about the rest of the assembly are not published');
  const xs = part.elements.flatMap(element => element.lines.flat().map(point => point[0]));
  assert.equal(part.bounds.minX, Math.min(...xs));
  assert.equal(part.bounds.maxX, Math.max(...xs));
  assert.deepEqual(part.focusBounds, part.bounds, 'the view opens on the whole part');

  const hole = citedPartModel(await buildStepView(assembly, { elementId: 'Bracket', featureId: 'hole:8:10' }));
  assert.ok(hole.elements.some(element => element.selected) && hole.elements.some(element => !element.selected),
    'the cited hole is marked against the rest of its part');
  assert.equal(hole.selected.label, 'Bracket · Ø8 hole');
});

test('a model overview or an assembly size has no single part to share', async () => {
  assert.equal(citedPartModel(await buildStepView(assembly, {})), null);
  assert.equal(citedPartModel(await buildStepView(assembly, { elementId: ASSEMBLY_ELEMENT, featureId: 'extent:X' })), null);
  assert.equal(citedPartModel({ kind: 'model-unavailable' }), null);
  assert.equal(citedPartModel(null), null);
});

test('the share composer and a cited-part link show the same part, and never the STEP file', async t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-cad-cited-part-'));
  const root = path.join(sandbox, 'Project');
  fs.mkdirSync(path.join(root, 'CAD'), { recursive: true });
  fs.writeFileSync(path.join(root, 'CAD', 'bracket.step'), bracketPart());
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false, port: 0 });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const { project } = app.timeline.importProject(root, actor, { watch: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = async route => { const response = await fetch(base + route); assert.equal(response.status, 200); return response.json(); };

  const hole = app.dependencies.search(project.id, 'Bracket Ø8 hole diameter').find(object => object.label === 'Bracket Ø8 hole diameter');
  const local = await get(`/api/dependency-objects/${hole.id}/preview?version=${hole.versionId}`);
  assert.equal(local.citedPart?.citedPart, true, 'the composer is told which part a cited-part link shares');
  assert.equal(local.citedPart.selected.label, 'Bracket · Ø8 hole');

  const overview = app.dependencies.search(project.id, 'bracket.step').find(object => object.anchor?.kind === 'cad-model');
  assert.ok(overview, 'the model file itself is indexed');
  assert.equal((await get(`/api/dependency-objects/${overview.id}/preview?version=${overview.versionId}`)).citedPart, null,
    'a whole-model citation offers no cited part');

  const created = await fetch(`${base}/api/projects/${project.id}/object-shares`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ objectId: hole.id, versionId: hole.versionId, actor, accessScope: 'INDEXED' }),
  });
  assert.equal(created.status, 201);
  const { share } = await created.json();
  const page = await (await fetch(`${base}/d/${share.token}`)).text();
  assert.match(page, /model-plan-svg/, 'the recipient sees the part');
  assert.match(page, /Cited part only/);
  assert.doesNotMatch(page, /Download original/);
  assert.match(page, /\/excerpt" download>.*SVG/s, 'the part drawing is what downloads');
  assert.equal((await fetch(`${base}/d/${share.token}/download`)).status, 403, 'the STEP file stays private');
  const excerpt = await fetch(`${base}/d/${share.token}/excerpt`);
  assert.equal(excerpt.status, 200);
  assert.match(await excerpt.text(), /<svg /);
});
