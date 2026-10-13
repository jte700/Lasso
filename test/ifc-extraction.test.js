import test from 'node:test';
import assert from 'node:assert/strict';
import { extractIfcDocument, parseStepArguments } from '../src/dependencies/ifc-extraction.js';

export function model({ value = 12, areaUnit = '#2=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);', quantityUnit = '$', extra = '', property = 'NetFloorArea', name = 'Office 101' } = {}) {
  return Buffer.from(`ISO-10303-21;
HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
${areaUnit}
#3=IFCUNITASSIGNMENT((#1,#2));
#4=IFCPROJECT('project',$,'Project',$,$,$,$,$,#3);
#5=IFCSPACE('space-guid',$,'101',$,$,$,$,'${name}',.ELEMENT.,.INTERNAL.,$);
#6=IFCQUANTITYAREA('${property}',$,${quantityUnit},${value},$);
#7=IFCELEMENTQUANTITY('quantity-guid',$,'Qto_SpaceBaseQuantities',$,$,(#6));
#8=IFCRELDEFINESBYPROPERTIES('relation',$,$,$,(#5),#7);
${extra}
ENDSEC;END-ISO-10303-21;`);
}
const facts = (document) => document.pages.flatMap((page) => page.annotations);

test('IFC resolves quantity relationships and explicit area units independently of model length units', () => {
  const result = extractIfcDocument(model());
  assert.equal(result.status, 'ready');
  const [area] = facts(result);
  assert.equal(area.numericValue, 12);
  assert.equal(area.units, 'm²');
  assert.equal(area.kind, 'room_area');
  assert.equal(area.elementId, 'space-guid');
  assert.equal(area.propertyStepId, '#6');
  assert.equal(area.propertyName, 'NetFloorArea');
  assert.equal(area.measurementBasis, 'model-property');
  assert.match(area.rawText, /IFCQUANTITYAREA/);
  assert.equal(area.id, facts(extractIfcDocument(model({ value: 18 })))[0].id);
});

test('IFC quantity unit overrides the project default and square prefixes are squared', () => {
  const [area] = facts(extractIfcDocument(model({ value: 12000000, quantityUnit: '#9', extra: '#9=IFCSIUNIT(*,.AREAUNIT.,.MILLI.,.SQUARE_METRE.);' })));
  assert.equal(area.numericValue, 12);
  assert.equal(area.originalNumericValue, 12000000);
  assert.equal(area.unitFactor, 0.000001);
});

test('IFC conversion-based area units follow the declared conversion factor', () => {
  const [area] = facts(extractIfcDocument(model({ value: 100,
    areaUnit: "#2=IFCCONVERSIONBASEDUNIT(#20,.AREAUNIT.,'SQUARE FOOT',#21);",
    extra: '#20=IFCDIMENSIONALEXPONENTS(2,0,0,0,0,0,0);#21=IFCMEASUREWITHUNIT(IFCAREAMEASURE(0.09290304),#22);#22=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);' })));
  assert.ok(Math.abs(area.numericValue - 9.290304) < 1e-9);
  assert.equal(area.originalUnits, 'SQUARE FOOT');
});

test('IFC refuses missing, mismatched, unsupported and cyclic units rather than guessing from geometry', () => {
  for (const options of [
    { areaUnit: '' }, { quantityUnit: '#1' },
    { areaUnit: "#2=IFCCONTEXTDEPENDENTUNIT(#20,.AREAUNIT.,'unknown');" },
    { areaUnit: "#2=IFCCONVERSIONBASEDUNIT(#20,.AREAUNIT.,'cycle',#21);", extra: '#21=IFCMEASUREWITHUNIT(IFCAREAMEASURE(1),#2);' },
  ]) {
    const result = extractIfcDocument(model(options));
    assert.equal(result.status, 'partial');
    assert.equal(facts(result).length, 0);
    assert.match(result.warnings.join(' '), /No supported AREAUNIT/);
  }
});

test('IFC typed property values and escaped STEP strings retain source identity', () => {
  const result = extractIfcDocument(model({ name: "Manager''s \\X2\\00DC\\X0\\ room ); #123",
    extra: "#30=IFCPROPERTYSET('props',$,'Pset_Test',$,(#31));#31=IFCPROPERTYSINGLEVALUE('GrossFloorArea',$,IFCAREAMEASURE(14),$);#32=IFCRELDEFINESBYPROPERTIES('props-rel',$,$,$,(#5),#30);" }));
  assert.equal(result.status, 'ready');
  assert.equal(facts(result).length, 2);
  assert.equal(facts(result)[0].roomName, "Manager's Ü room ); #123");
  assert.equal(facts(result)[1].value, '14 m²');
  assert.deepEqual(parseStepArguments("'x, y',(#2,IFCREAL(1.5E+2)),$,.AREAUNIT."), ['x, y', [{ ref: 2 }, { type: 'IFCREAL', args: [150] }], null, 'AREAUNIT']);
});

test('IFC distinguishes wall area from floor area and keeps conflicting properties visible', () => {
  assert.equal(facts(extractIfcDocument(model({ property: 'NetWallArea' })))[0].kind, 'area');
  const data = model({ extra: "#10=IFCQUANTITYAREA('NetFloorArea',$,$,15,$);" }).toString().replace('(#6));', '(#6,#10));');
  const result = extractIfcDocument(Buffer.from(data));
  assert.equal(facts(result).length, 2);
  assert.notEqual(facts(result)[0].id, facts(result)[1].id);
  assert.equal(result.status, 'partial');
});

test('malformed IFC and unknown schemas report extraction failures', () => {
  assert.equal(extractIfcDocument(Buffer.from('garbage')).status, 'error');
  assert.equal(extractIfcDocument(Buffer.from(model().toString().replace('IFC4', 'IFC99'))).status, 'unsupported');
  assert.equal(extractIfcDocument(Buffer.from(model().toString().replace("'NetFloorArea'", "'unterminated"))).status, 'error');
  assert.equal(extractIfcDocument(Buffer.from(model().toString().replace('DATA;', ''))).status, 'error');
  assert.equal(extractIfcDocument(Buffer.from(model().toString() + '#123=IFCPROJECT($);')).status, 'error');
  assert.throws(() => parseStepArguments('1,'), /Trailing/);
  const withQuotedRecord = model().toString().replace('HEADER;', "HEADER;FILE_DESCRIPTION(('#999=IFCPROJECT(''fake'',$,$,$,$,$,$,$,$);'),'2;1');");
  assert.equal(extractIfcDocument(Buffer.from(withQuotedRecord)).status, 'ready');
});
