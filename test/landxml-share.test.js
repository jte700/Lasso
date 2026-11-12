import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { buildFullShareDocument } from '../src/sharing/share-preview.js';
import { normalizeRedactions } from '../src/sharing/object-share.js';

const SURVEY = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">',
  ' <Units><Metric linearUnit="meter" areaUnit="squareMeter" diameterUnit="millimeter"/></Units>',
  ' <Project name="Juniper Hub Site"/>',
  ' <Parcels name="Juniper Site"><Parcel name="Juniper Lot" area="1850.5"/></Parcels>',
  '',
  ' <Alignments name="Site Access"><Alignment name="PRIVATE_ROAD" length="125.75"/></Alignments>',
  '</LandXML>',
  '',
].join('\r\n');

test('a LandXML document reads as its source lines, indentation kept and blank lines dropped', () => {
  const document = buildFullShareDocument({ path: 'Survey.landxml', content: Buffer.from(SURVEY) });
  assert.equal(document.kind, 'text');
  assert.equal(document.format, 'lines');
  assert.equal(document.layout, 'lines');
  assert.equal(document.blocks.length, 7);
  assert.equal(document.blocks[0], '<?xml version="1.0" encoding="UTF-8"?>');
  assert.equal(document.blocks[4], ' <Parcels name="Juniper Site"><Parcel name="Juniper Lot" area="1850.5"/></Parcels>');
  assert.equal(document.blocks.at(-1), '</LandXML>');

  // A LandXML export saved as .xml reads the same way.
  assert.deepEqual(buildFullShareDocument({ path: 'Survey.xml', content: Buffer.from(SURVEY) }).blocks, document.blocks);
});

test('a share made before the line layout keeps the paragraph sections it was made with', () => {
  const legacy = buildFullShareDocument({ path: 'Survey.xml', content: Buffer.from(SURVEY) }, { structuredLayout: false });
  assert.equal(legacy.kind, 'text');
  assert.equal(legacy.format, undefined);
  assert.equal(legacy.blocks.length, 2);
});

test('text redactions can address sections past line 10,000 of a long XML export', () => {
  const [entry] = normalizeRedactions([{ kind: 'BLOCK', block: 25000, effect: 'BLANK' }], 'REDACTED');
  assert.equal(entry.block, 25000);
  assert.throws(() => normalizeRedactions([{ kind: 'BLOCK', block: 1_000_000 }], 'REDACTED'), /Invalid text redaction/);
});

test('LandXML sources show the complete document and share and redact it line by line', async t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-landxml-'));
  const root = path.join(sandbox, 'Sources');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'Juniper-Site-Survey.landxml'), SURVEY);
  fs.writeFileSync(path.join(root, 'Civil-Export.xml'), SURVEY);
  const app = createApplication({ shareBaseUrl: 'http://localhost:4317', dataDir: path.join(sandbox, 'data'), watchProjects: false, port: 0 });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const actor = { id: 'human:qa', displayName: 'QA', actorType: 'HUMAN_SELF' };
  const { project } = app.timeline.importProject(root, actor, { watch: false });
  app.dependencies.ensureIndex(project.id);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const objectFor = (filePath, label) => app.db.prepare(`SELECT v.id AS versionId, v.object_id AS objectId
    FROM scientific_object_versions v JOIN scientific_objects o ON o.id=v.object_id
    WHERE o.project_id=? AND v.path=? AND v.label=?`).get(project.id, filePath, label);

  const parcel = objectFor('Juniper-Site-Survey.landxml', 'Parcel Juniper Lot area');
  assert.ok(parcel, 'the parcel area is indexed');
  const local = (await (await fetch(`${base}/api/dependency-objects/${parcel.objectId}/document?version=${parcel.versionId}`)).json()).document;
  assert.equal(local.format, 'lines');
  assert.equal(local.blocks.length, 7);
  const cited = (await (await fetch(`${base}/api/dependency-objects/${parcel.objectId}/preview?version=${parcel.versionId}`)).json()).preview;
  assert.deepEqual(cited.lines.filter(line => line.cited).map(line => line.lineNumber), [5]);

  const share = async (object, accessScope, redactions = []) => {
    const response = await fetch(`${base}/api/projects/${project.id}/object-shares`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objectId: object.objectId, versionId: object.versionId, actor, accessScope, redactions }),
    });
    assert.equal(response.status, 201);
    return (await response.json()).share;
  };

  const privateLine = local.blocks.findIndex(block => block.includes('PRIVATE_ROAD'));
  const redacted = await share(parcel, 'REDACTED', [{ kind: 'BLOCK', block: privateLine, effect: 'BLANK' }]);
  assert.equal(redacted.redactions[0].layout, 'lines');
  const page = await (await fetch(`${base}/d/${redacted.token}`)).text();
  assert.match(page, /class="full-document document-text document-lines"/);
  assert.doesNotMatch(page, /PRIVATE_ROAD/);
  // XML reaches the recipient as escaped text, never as markup.
  assert.match(page, /&lt;Parcel name=/);
  assert.doesNotMatch(page, /<Parcel /);
  const download = await fetch(`${base}/d/${redacted.token}/excerpt`);
  assert.match(download.headers.get('content-disposition'), /Juniper-Site-Survey-redacted-v1\.txt/);
  const downloaded = await download.text();
  assert.doesNotMatch(downloaded, /PRIVATE_ROAD/);
  assert.match(downloaded, /area="1850\.5"\/><\/Parcels>\n\[Redacted\]\n<\/LandXML>\n$/);

  // An .xml text redaction stored before the line layout still hides the
  // paragraph section it was made against, never a different one.
  const exported = objectFor('Civil-Export.xml', 'Parcel Juniper Lot area');
  assert.ok(exported, 'LandXML saved as .xml is indexed');
  const legacy = await share(exported, 'REDACTED', [{ kind: 'BLOCK', block: 0, effect: 'BLANK' }]);
  app.db.prepare('UPDATE object_share_grants SET redactions_json=? WHERE token=?')
    .run(JSON.stringify([{ kind: 'BLOCK', block: 0, effect: 'BLANK' }]), legacy.token);
  const legacyPage = await (await fetch(`${base}/d/${legacy.token}`)).text();
  assert.match(legacyPage, /class="full-document document-text">/);
  assert.doesNotMatch(legacyPage, /Juniper Hub Site/);
});
