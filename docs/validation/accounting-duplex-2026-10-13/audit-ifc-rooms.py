#!/usr/bin/env python3
"""Independent reader for this Duplex sample's room-area STEP records.

No Lasso dependencies or expected-value fixture. This is a validation reader,
not a general IFC implementation: it requires explicit square-metre project
units and rejects per-property unit overrides rather than guessing their units.
"""
import bisect, hashlib, json, re, sys
from decimal import Decimal
from pathlib import Path

source = Path(sys.argv[1])
raw = source.read_bytes()
text = raw.decode('utf-8-sig')

def split_args(value):
    result, start, depth, quoted, i = [], 0, 0, False, 0
    while i < len(value):
        c = value[i]
        if c == "'":
            if quoted and i + 1 < len(value) and value[i + 1] == "'":
                i += 2
                continue
            quoted = not quoted
        elif not quoted:
            if c == '(':
                depth += 1
            elif c == ')':
                depth -= 1
            elif c == ',' and depth == 0:
                result.append(value[start:i].strip())
                start = i + 1
        i += 1
    result.append(value[start:].strip())
    return result

def string(value):
    return value[1:-1].replace("''", "'") if value.startswith("'") else value

entities = {}
line_starts = [match.start() for match in re.finditer('\\n', text)]
for match in re.finditer(r'(?m)^#(\d+)\s*=\s*(\w+)\s*\((.*?)\)\s*;', text, re.S):
    identity, kind, body = match.groups()
    entities['#' + identity] = (kind, split_args(body), match.group(0), bisect.bisect_right(line_starts, match.start()) + 1)

# Establish the explicit project area unit, not a presumed default.
project = next((key, ent) for key, ent in entities.items() if ent[0] == 'IFCPROJECT')
unit_assignment = entities[project[1][1][8]]
area_ref = next(ref for ref in re.findall(r'#\d+', unit_assignment[1][0])
                if entities[ref][0] == 'IFCSIUNIT' and entities[ref][1][1] == '.AREAUNIT.')
area_unit = entities[area_ref]
assert area_unit[1][2] == '$' and area_unit[1][3] == '.SQUARE_METRE.', area_unit

rooms = []
for relation_ref, relation in entities.items():
    if relation[0] != 'IFCRELDEFINESBYPROPERTIES':
        continue
    qset_ref = relation[1][5]
    qset = entities[qset_ref]
    if qset[0] != 'IFCELEMENTQUANTITY':
        continue
    for space_ref in re.findall(r'#\d+', relation[1][4]):
        space = entities[space_ref]
        if space[0] != 'IFCSPACE':
            continue
        for area_ref in re.findall(r'#\d+', qset[1][5]):
            area = entities[area_ref]
            if area[0] != 'IFCQUANTITYAREA':
                continue
            assert area[1][2] == '$', 'Explicit quantity unit needs separate resolution'
            value = Decimal(area[1][3])
            rooms.append({
                'number': string(space[1][2]), 'name': string(space[1][7]), 'guid': string(space[1][0]),
                'quantity': string(area[1][0]), 'value': str(value), 'units': 'm²',
                'squareFeet': str(value / Decimal('0.09290304')),
                'space': space_ref, 'relation': relation_ref, 'quantitySet': qset_ref, 'property': area_ref,
                'evidence': [{'line': ent[3], 'record': ent[2]} for ent in [space, relation, qset, area]],
            })

property_areas = []
for relation_ref, relation in entities.items():
    if relation[0] != 'IFCRELDEFINESBYPROPERTIES':
        continue
    pset_ref = relation[1][5]
    pset = entities[pset_ref]
    if pset[0] != 'IFCPROPERTYSET':
        continue
    for space_ref in re.findall(r'#\d+', relation[1][4]):
        space = entities[space_ref]
        if space[0] != 'IFCSPACE':
            continue
        for property_ref in re.findall(r'#\d+', pset[1][4]):
            prop = entities[property_ref]
            if prop[0] != 'IFCPROPERTYSINGLEVALUE':
                continue
            measure = re.fullmatch(r'IFCAREAMEASURE\(([^()]+)\)', prop[1][2])
            if not measure:
                continue
            assert prop[1][3] == '$', 'Explicit property unit needs separate resolution'
            value = Decimal(measure.group(1))
            property_areas.append({
                'number': string(space[1][2]), 'name': string(space[1][7]), 'guid': string(space[1][0]),
                'propertyName': string(prop[1][0]), 'propertySetName': string(pset[1][2]),
                'value': str(value), 'units': 'm²', 'measureType': 'IFCAREAMEASURE',
                'squareFeet': str(value / Decimal('0.09290304')),
                'space': space_ref, 'relation': relation_ref, 'propertySet': pset_ref, 'property': property_ref,
                'evidence': [{'line': ent[3], 'record': ent[2]} for ent in [space, relation, pset, prop]],
            })

print(json.dumps({'file': str(source.resolve()), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
                  'schema': re.search(r'FILE_SCHEMA\(\((.*?)\)\)', text).group(1),
                  'spaceCount': sum(ent[0] == 'IFCSPACE' for ent in entities.values()),
                  'unitEvidence': [project[1][2], unit_assignment[2], area_unit[2]],
                  'areas': rooms, 'propertyAreas': property_areas}, indent=2, ensure_ascii=False))
