import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractLandXmlDocument } from '../src/dependencies/landxml-extraction.js';
import { buildInspectorPreview, isTextPreviewPath } from '../src/sharing/share-preview.js';
import { landXmlTable } from '../src/sharing/landxml-table.js';
import { drawingDescriptors } from '../src/dependencies/drawing-objects.js';

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
  assert.equal(facts.length, 8);
  assert.deepEqual(facts.map((fact) => fact.value), ['900.5 m²', '425.25 m', '100.5 m', '300 mm', '101.2 m', '98.1 m', '3.1 m', '98.4 m']);
  assert.ok(facts.filter((fact) => fact.propertyName !== 'depth').every((fact) => fact.measurementBasis === 'model-property'));
  assert.equal(facts.find((fact) => fact.propertyName === 'depth').measurementBasis, 'computed-from-elevations');
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

const CIVIL_SURVEY = Buffer.from([
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">',
  ' <Units><Metric linearUnit="meter" areaUnit="squareMeter" diameterUnit="millimeter"/></Units>',
  ' <Project name="Juniper Hub Site"/>',
  ' <Parcels name="Juniper Site"><Parcel name="Juniper Lot" area="1850.5"/></Parcels>',
  ' <Alignments name="Site Access"><Alignment name="Juniper Access Road" length="125.75"/></Alignments>',
  ' <PipeNetworks><PipeNetwork name="Storm"><Pipes>',
  '  <Pipe name="JH-P1" length="42.5"><CircPipe diameter="300"/></Pipe>',
  ' </Pipes><Structs><Struct name="JH-MH1" elevRim="101.2" elevSump="98.1"/></Structs></PipeNetwork></PipeNetworks>',
  '</LandXML>',
].join('\n'));
const cardFor = (filePath, label) => {
  const fact = annotations(extractLandXmlDocument(CIVIL_SURVEY)).find((entry) => entry.label === label);
  return buildInspectorPreview({ path: filePath, content: CIVIL_SURVEY },
    { kind: 'cad-property', identifier: fact.id, elementId: fact.elementId, propertyName: fact.propertyName },
    { rawText: fact.rawText }, label, 'DRAWING_ANNOTATION');
};
const plain = (blocks) => blocks.map((block) => block.text.replaceAll('**', ''));

const cited = (preview) => preview.rows.flatMap((row) => row.cells.filter((cell) => cell.cited).map((cell) => cell.value));

test('Without coordinates, a LandXML value shows in its property table with the cell marked, not as XML', () => {
  // Arrange
  assert.equal(isTextPreviewPath('Survey.landxml'), true);

  // Act
  const preview = cardFor('Survey.landxml', 'Pipe JH-P1 diameter');

  // Assert
  assert.equal(preview.kind, 'table');
  assert.deepEqual(preview.headers, ['Pipe', 'Length', 'Diameter']);
  assert.deepEqual(preview.rows.map((row) => row.cells.map((cell) => cell.value)), [['JH-P1', '42.5 m', '300 mm']]);
  assert.deepEqual(cited(preview), ['300 mm']);
  assert.equal(preview.location, 'Storm pipes · Pipe JH-P1');
  assert.equal(preview.text, 'Pipe JH-P1 diameter 300 mm');
  assert.deepEqual(preview.openAt, { line: 8 }, 'Open file goes to the line that holds the cited value');
  assert.ok(!JSON.stringify(preview).includes('<'), 'no XML markup reaches the card');
});

test('A LandXML export saved as .xml previews the same way, and a structure lists its worked-out depth', () => {
  // Act
  const parcel = cardFor('Civil-Export.xml', 'Parcel Juniper Lot area');
  const depth = cardFor('Civil-Export.xml', 'Structure JH-MH1 depth');

  // Assert
  assert.deepEqual(parcel.headers, ['Parcel', 'Area']);
  assert.deepEqual(cited(parcel), ['1850.5 m²']);
  assert.equal(parcel.location, 'Parcels · Parcel Juniper Lot');
  assert.deepEqual(parcel.openAt, { line: 5 });
  assert.deepEqual(depth.headers, ['Structure', 'Rim elevation', 'Sump elevation', 'Depth']);
  assert.deepEqual(cited(depth), ['3.1 m']);
});

test('the whole LandXML model previews with nothing cited, and a plain XML file still reads as its lines', () => {
  const whole = buildInspectorPreview({ path: 'Survey.landxml', content: CIVIL_SURVEY }, { kind: 'cad-model' },
    {}, 'Juniper Hub Site', 'DRAWING');
  assert.equal(whole.format, 'markdown');
  assert.equal(whole.location, 'Entire model');
  assert.equal(whole.blocks.some((block) => block.cited), false);
  assert.deepEqual(plain(whole.blocks).slice(0, 5), ['Juniper Hub Site', 'Parcels', 'Parcel Juniper Lot · area 1850.5 m²', 'Alignments', 'Alignment Juniper Access Road · length 125.75 m']);
  const other = buildInspectorPreview({ path: 'feed.xml', content: Buffer.from('<rss><channel><title>News</title></channel></rss>') },
    {}, {}, 'News', 'DOCUMENT');
  assert.equal(other.format, 'plain');
});

const SITE_PLAN = fs.readFileSync(new URL('./fixtures/drawings/juniper-site-plan.landxml', import.meta.url));
const siteFacts = () => annotations(extractLandXmlDocument(SITE_PLAN, { lines: true }));
const siteValue = (label) => siteFacts().find((fact) => fact.label === label);
const siteCard = (label) => {
  const fact = siteValue(label);
  return buildInspectorPreview({ path: 'Site.landxml', content: SITE_PLAN },
    { kind: 'cad-property', identifier: fact.id, elementId: fact.elementId, propertyName: fact.propertyName }, {}, label, 'DRAWING_ANNOTATION');
};

test('LandXML offers what civil designers write about: stations, curves, PVIs, pipe routes, materials, slopes, depths, points and surfaces', () => {
  // Act
  const values = Object.fromEntries(siteFacts().map((fact) => [fact.label, fact.value]));

  // Assert
  assert.equal(values['Alignment Juniper Access Road start station'], '0+000.00');
  assert.equal(values['Alignment Juniper Access Road end station'], '0+125.75');
  assert.equal(values['Alignment Juniper Access Road curve 1 radius'], '30 m');
  assert.equal(values['Profile Juniper Access Road FG PVI 0+062.50 elevation'], '98.95 m');
  assert.equal(values['Profile Juniper Access Road FG vertical curve at 0+062.50 length'], '30 m');
  assert.equal(values['Pipe JH-P1 route'], 'JH-MH1 to JH-MH2');
  assert.equal(values['Pipe JH-P1 material'], 'PVC');
  assert.equal(values['Structure JH-MH2 depth'], '3.4 m');
  assert.equal(values['Structure JH-MH1 diameter'], '1200 mm');
  assert.equal(values['Point 102 elevation'], '101.6 m');
  assert.equal(siteValue('Point 101 elevation').searchTerms, 'TOP OF CURB');
  assert.equal(values['Surface Existing Ground maximum elevation'], '102.8 m');
  // The fall between the stated inverts over the pipe's length, and it says so.
  assert.equal(values['Pipe JH-P1 slope'], '1.2%');
  assert.equal(siteValue('Pipe JH-P1 slope').measurementBasis, 'computed-from-inverts');
});

test('An indexed LandXML value says its property once, in words, without its attribute name', () => {
  // Act
  const { descriptors } = drawingDescriptors({ path: 'Site.landxml', projectFileId: 'file', contentHash: 'hash', fileType: 'drawing' }, SITE_PLAN);
  const labels = descriptors.map((descriptor) => descriptor.label);

  // Assert
  assert.ok(labels.includes('Structure JH-MH1 rim elevation'));
  assert.ok(labels.includes('Alignment Juniper Access Road start station'));
  assert.ok(!labels.some((label) => /elev Rim|sta Start|area2 D/.test(label)));
});

test('A pipe row carries the inverts at both its ends, and a structure invert is shown in that row', () => {
  // Arrange
  const facts = siteFacts();
  const invert = facts.find((fact) => fact.label === 'Structure JH-MH2 pipe JH-P1 invert elevation');

  // Act
  const table = landXmlTable(facts, invert);

  // Assert
  assert.deepEqual(table.headers, ['Pipe', 'From', 'To', 'Length', 'Diameter', 'Material', 'Slope', 'Start invert', 'End invert']);
  assert.deepEqual(table.rows[0].cells.map((cell) => cell.value), ['JH-P1', 'JH-MH1', 'JH-MH2', '42.5 m', '300 mm', 'PVC', '1.2%', '98.4 m', '97.89 m']);
  assert.deepEqual(cited(table), ['97.89 m']);
});

test('With coordinates, a LandXML value shows on the plan with its element highlighted', () => {
  // Act
  const pipe = siteCard('Pipe JH-P1 slope');
  const parcel = siteCard('Parcel Juniper Lot area');
  const curve = siteCard('Alignment Juniper Access Road curve 1 radius');

  // Assert
  assert.equal(pipe.kind, 'model-plan');
  assert.deepEqual(pipe.elements.filter((element) => element.selected).map((element) => element.label), ['Pipe JH-P1']);
  assert.equal(pipe.selected.label, 'Pipe JH-P1 slope 1.2%');
  assert.equal(pipe.location, 'Storm pipes · Pipe JH-P1');
  assert.deepEqual(pipe.drawing.map((label) => label.text), ['JH-MH1', 'JH-MH2']);
  // A point is written northing first; the plan's x is its easting.
  assert.deepEqual(pipe.elements.find((element) => element.label === 'Pipe JH-P1').lines, [[[1010, 5010], [1052.5, 5010]]]);
  assert.equal(parcel.elements.find((element) => element.selected).polygons[0].length, 4);
  assert.equal(curve.elements.find((element) => element.selected).entityType, 'Curve');
  assert.equal(curve.location, 'Juniper Access Road curves · Curve 1');
});

test('Civil 3D values read as its plans print them: stations in feet, floating-point noise rounded', () => {
  // Arrange
  const buffer = fs.readFileSync(new URL('./fixtures/drawings/civil3d-main-road.xml', import.meta.url));

  // Act
  const facts = annotations(extractLandXmlDocument(buffer));
  const value = (label) => facts.find((fact) => fact.label === label);

  // Assert
  assert.equal(value('Alignment Main Road end station').value, '24+55.50');
  assert.equal(value('Alignment Main Road curve 2 radius').value, '800 ft');
  assert.equal(value('Alignment Main Road curve 2 radius').numericValue, 799.999999999896);
  assert.equal(value('Profile Main Road Layout PVI 4+58.28 elevation').value, '347.204 ft');
});

test('a LandXML file with nothing Lasso can read previews as its source lines', () => {
  const broken = Buffer.from('<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Units></Units></LandXML>');
  const preview = buildInspectorPreview({ path: 'Broken.landxml', content: broken }, { kind: 'cad-model' }, {}, 'Broken', 'DRAWING');
  assert.equal(preview.format, 'plain');
});
