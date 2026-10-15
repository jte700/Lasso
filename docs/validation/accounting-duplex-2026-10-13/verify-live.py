#!/usr/bin/env python3
"""Compare an already indexed model in a running Lasso app with the independent audit.

No application imports, temporary project, database writes, or seeded index objects.
Usage: python3 verify-live.py http://127.0.0.1:PORT PROJECT_ID
Run audit-ifc-rooms.py on the actual file first and save stdout as source-audit.json.
"""
import datetime
import hashlib
import json
import math
from pathlib import Path
import sys
import urllib.request

HERE = Path(__file__).resolve().parent
audit = json.loads((HERE / 'source-audit.json').read_text())
base = sys.argv[1].rstrip('/')
project_id = sys.argv[2]
project_url = f'/api/projects/{project_id}'
actor = {'id': 'ai:codex-live-drawing-validation', 'displayName': 'Codex drawing validation', 'actorType': 'AI_AGENT'}


def api(route, body=None):
    req = urllib.request.Request(base + route,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)


def equal_number(actual, expected):
    assert isinstance(actual, (int, float)) and math.isfinite(actual)
    assert math.isclose(actual, float(expected), rel_tol=1e-12, abs_tol=1e-10), (actual, expected)


def ask(question):
    return api(project_url + '/terminal', {'input': 'ask ' + question, 'actor': actor})['result']


project = api(project_url)['project']
source = Path(audit['file'])
relative = str(source.relative_to(project['rootPath']))
assert hashlib.sha256(source.read_bytes()).hexdigest() == audit['sha256']
objects = [o for o in api(project_url + '/source-library')['objects'] if o['path'] == relative]
report = {'status': 'running', 'date': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'endpoint': base, 'project': project, 'sourceFile': str(source), 'sha256': audit['sha256'],
          'indexedModelObjects': len(objects), 'rooms': [], 'quantityChecks': [], 'negativeChecks': []}

for expected in audit['propertyAreas']:
    answers = []
    for phrase, value, units in [('area', expected['value'], 'm²'), ('square footage', expected['squareFeet'], 'ft²')]:
        question = f"What is the {phrase} of {expected['number']} in {relative}?"
        answer = ask(question)
        assert answer['ok'] and answer['data']['answered'], (question, answer)
        data = answer['data']
        equal_number(data['numericValue'], value)
        assert data['units'] == units and data['path'] == relative
        assert data['measurementBasis'] == 'model-property'
        assert len(answer['results']) == 1
        reference = answer['results'][0]['ref']
        obj = api('/api/dependency-objects/' + reference['objectId'])['object']
        assert obj['projectId'] == project_id and obj['contentHash'] == audit['sha256']
        metadata = obj['metadata']
        for field, key in [('globalId', 'guid'), ('stepId', 'space'), ('propertyStepId', 'property'),
                           ('propertyName', 'propertyName'), ('propertySet', 'propertySetName'),
                           ('roomNumber', 'number'), ('roomName', 'name')]:
            assert metadata[field] == expected[key], (expected['number'], field)
        assert metadata['units'] == expected['units']
        equal_number(metadata['numericValue'], expected['value'])
        raw_property = expected['evidence'][-1]['record']
        assert raw_property in metadata['rawText']
        preview = api(project_url + '/terminal/preview', {'ref': reference})['preview']
        if preview['kind'] == 'model-plan':
            assert preview['selected']['guid'] == expected['guid']
            assert raw_property in preview['sourceText']
        else:
            assert preview['kind'] == 'text'
            assert any(raw_property in line['text'] for line in preview['lines'])
        answers.append({'question': question, 'response': answer})
    report['rooms'].append({'room': expected['number'], 'name': expected['name'],
                            'expectedProperty': expected['property'], 'answers': answers,
                            'indexedObject': obj, 'sourcePreview': preview})

for expected in audit['areas']:
    matches = [o for o in objects if o['anchor'].get('elementId') == expected['guid']
               and o['anchor'].get('propertyStepId') == expected['property']]
    assert len(matches) == 1, expected
    obj = api('/api/dependency-objects/' + matches[0]['id'])['object']
    equal_number(obj['metadata']['numericValue'], expected['value'])
    assert obj['metadata']['units'] == expected['units']
    assert expected['evidence'][-1]['record'] in obj['metadata']['rawText']
    report['quantityChecks'].append({'room': expected['number'], 'property': expected['property'],
                                    'value': obj['metadata']['numericValue'], 'units': obj['metadata']['units']})

for question, reason in [
    ('What is the area of Living Room?', 'AMBIGUOUS_DRAWING_VALUE'),
    ('What is the area of Imaginary Room?', 'NO_EXPLICIT_DRAWING_VALUE'),
    ('What is the net floor area of A102?', 'NO_EXPLICIT_DRAWING_VALUE'),
]:
    response = ask(question)
    assert response['data']['answered'] is False and response['data']['reason'] == reason
    report['negativeChecks'].append({'question': question, 'response': response})

assert len(report['rooms']) == audit['spaceCount'] == 21
assert len(report['quantityChecks']) == 21
assert api(project_url)['project']['currentSnapshotId'] == project['currentSnapshotId']
report['status'] = 'passed'
(HERE / 'live-results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'status': 'passed', 'rooms': len(report['rooms']), 'roomQueries': len(report['rooms']) * 2,
                  'quantityChecks': len(report['quantityChecks']), 'negativeChecks': len(report['negativeChecks']),
                  'sourceFile': str(source), 'indexedModelObjects': len(objects),
                  'snapshot': project['currentSnapshotId'], 'report': str(HERE / 'live-results.json')}, indent=2))
