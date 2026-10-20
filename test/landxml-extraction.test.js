import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractLandXmlDocument } from '../src/dependencies/landxml-extraction.js';
import { buildInspectorPreview, isTextPreviewPath } from '../src/sharing/share-preview.js';

const metric = '<Metric linearUnit="meter" areaUnit="squareMeter" diameterUnit="millimeter"/>';
const xml = (content, units = metric) => Buffer.from(`<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Units>${units}</Units>${content}</LandXML>`);
const annotations = (result) => result.pages.flatMap((page) => page.annotations);

test('LandXML indexes explicit civil quantities with declared units and stable element/property provenance', () => {
  const input = xml(`<Project name="Civil Site"/><Parcels name="Site"><Parcel name="Lot 1" area="900.5"/></Parcels>
    <Alignments><Alignment name="Main Road" length="425.25"/></Alignments>
    <PipeNetworks><PipeNetwork name="Storm"><Pipes><Pipe name="P1" length="100.5"><CircPipe diameter="300"/></Pipe></Pipes>
    <Structs><Struct name="MH1" elevRim="101.2" elevSump="98.1"><Invert refPipe="P1" elev="98.4"/></Struct></Structs></PipeNetwork></PipeNetworks>`);
  const result = extractLandXmlDocument(input);
  assert.equal(result.status, 'ready');
  const facts = annotations(result);
  assert.equal(facts.length, 7);
  assert.deepEqual(facts.map((fact) => fact.value), ['900.5 m²', '425.25 m', '100.5 m', '300 mm', '101.2 m', '98.1 m', '98.4 m']);
  assert.ok(facts.every((fact) => fact.measurementBasis === 'model-property'));
  assert.equal(facts.at(-1).pipeRef, 'P1');
  assert.match(facts[3].sourcePropertyPath, /CircPipe\/@diameter$/);
  assert.match(facts[3].elementId, /Pipe\[name="P1"\]$/);
  const updated = extractLandXmlDocument(Buffer.from(input.toString().replace('area="900.5"', 'area="901"')));
  assert.equal(annotations(updated)[0].id, facts[0].id, 'a value edit retains property identity');
});

test('LandXML reads namespaced elements and XML escapes without indexing foreign extension elements', () => {
  const source = `<l:LandXML xmlns:l="http://www.landxml.org/schema/LandXML-1.2" xmlns:x="urn:extension" version="1.2">
    <l:Units><l:Metric areaUnit="squareMeter" linearUnit="meter"/></l:Units>
    <l:Parcels><l:Parcel name="A &amp; B" area="12.5"/><x:Parcel name="Fake" area="999"/><!-- <l:Parcel name="Fake2" area="999"/> --></l:Parcels></l:LandXML>`;
  const result = extractLandXmlDocument(Buffer.from(source));
  assert.equal(result.status, 'ready');
  assert.equal(annotations(result).length, 1);
  assert.equal(annotations(result)[0].label, 'Parcel A & B area');
});

test('missing diameter/area units never inherit a different quantity unit or Imperial defaults', () => {
  const result = extractLandXmlDocument(xml('<Parcels><Parcel name="Lot" area="10"/></Parcels><Alignments><Alignment name="Road" length="5"/></Alignments><PipeNetworks><PipeNetwork><Pipes><Pipe name="P1"><CircPipe diameter="12"/></Pipe></Pipes></PipeNetwork></PipeNetworks>', '<Imperial linearUnit="foot"/>'));
  assert.equal(result.status, 'partial');
  assert.deepEqual(annotations(result).map((fact) => fact.value), ['5 ft']);
  assert.ok(result.warnings.some((warning) => warning.includes('diameterUnit')));
  assert.ok(result.warnings.some((warning) => warning.includes('areaUnit')));
  const noUnits = extractLandXmlDocument(xml('<Parcels><Parcel name="Lot" area="10"/></Parcels>', ''));
  assert.equal(noUnits.status, 'error');
});

test('LandXML refuses malformed numbers and does not guess pipe slope units', () => {
  const result = extractLandXmlDocument(xml('<Parcels><Parcel name="Lot" area="NaN"/><Parcel name="Lot2" area="-2"/></Parcels><PipeNetworks><PipeNetwork><Pipes><Pipe name="P1" length="Infinity" slope="0.02"/></Pipes></PipeNetwork></PipeNetworks>'));
  assert.equal(result.status, 'partial');
  assert.equal(annotations(result).length, 0);
  assert.ok(result.warnings.some((warning) => warning.includes('unit convention')));
});

test('LandXML rejects DTD/entity declarations, malformed XML, foreign documents, and ambiguous units', () => {
  for (const input of [
    '<!DOCTYPE LandXML [<!ENTITY secret SYSTEM "file:///etc/passwd">]>' + xml('<Project name="&secret;"/>').toString(),
    xml('<Parcels><Parcel name="bad" area="1"></Parcels>'),
    xml('<Parcels><Parcel name="bad" name="duplicate" area="1"/></Parcels>'),
    xml('<Parcels><Parcel name="&unknown;" area="1"/></Parcels>'),
    xml('', metric + metric),
  ]) {
    const result = extractLandXmlDocument(Buffer.from(input));
    assert.equal(result.status, 'error');
    assert.equal(annotations(result).length, 0);
  }
  assert.equal(extractLandXmlDocument(Buffer.from('<Other/>')).status, 'unsupported');
  assert.equal(extractLandXmlDocument(Buffer.from('<LandXML xmlns="urn:not-landxml"/>')).status, 'unsupported');
});

test('public Civil 3D Main Road sample retains its explicit source length and foot unit', () => {
  const buffer = fs.readFileSync(new URL('./fixtures/drawings/civil3d-main-road.xml', import.meta.url));
  const result = extractLandXmlDocument(buffer);
  assert.equal(result.status, 'ready');
  const mainRoad = annotations(result).find((fact) => fact.label === 'Alignment Main Road length');
  assert.equal(mainRoad.numericValue, 2455.497573251083);
  assert.equal(mainRoad.units, 'ft');
  assert.equal(mainRoad.measurementBasis, 'model-property');
  assert.match(mainRoad.rawText, /length="2455.497573251083"/);
  assert.equal(mainRoad.propertyName, 'length');
});


test('LandXML refuses declared units with the wrong dimension or unknown dictionary keys', () => {
  for (const areaUnit of ['meter', '__proto__', 'constructor', 'unknown']) {
    const result = extractLandXmlDocument(xml('<Parcels><Parcel name="Lot" area="10"/></Parcels>', `<Metric areaUnit="${areaUnit}"/>`));
    assert.equal(result.status, 'partial');
    assert.equal(annotations(result).length, 0);
  }
  const result = extractLandXmlDocument(xml('<Alignments><Alignment name="Road" length="10"/></Alignments>', '<Metric linearUnit="squareMeter"/>'));
  assert.equal(annotations(result).length, 0);
});

test('a LandXML quantity previews as its source XML with the cited element highlighted', () => {
  const content = Buffer.from([
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">',
    ' <Parcels name="Juniper Site"><Parcel name="Juniper Lot" area="1850.5"/></Parcels>',
    ' <Alignments name="Site Access"><Alignment name="Juniper Access Road" length="125.75"/></Alignments>',
    '</LandXML>',
  ].join('\n'));
  assert.equal(isTextPreviewPath('Survey.landxml'), true);
  const preview = buildInspectorPreview({ path: 'Survey.landxml', content },
    { kind: 'cad-property', propertyName: 'area' },
    { rawText: '<Parcel name="Juniper Lot" area="1850.5"/>' }, 'Parcel Juniper Lot area', 'DRAWING_ANNOTATION');
  assert.equal(preview.kind, 'text');
  assert.deepEqual(preview.lines.filter((line) => line.cited).map((line) => line.lineNumber), [3]);
  assert.match(preview.lines.find((line) => line.cited).value, /area="1850\.5"/);
});
