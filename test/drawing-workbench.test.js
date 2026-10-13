import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceWorkbench } from '../public/source-workbench.js';

test('source library submits natural measurement questions on Enter through grounded ask', async () => {
  const handlers = new Map(), requests = [];
  const input = { value: '', addEventListener: (name, handler) => handlers.set(name, handler) };
  createSourceWorkbench({ input, getProjectId: () => 'project', getActor: () => ({ id: 'user' }),
    api: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return { result: { headline: 'Room area: 120 ft²' } }; } });
  for (const question of ['What is the net square footage of Office 101?', 'ask What is the length of Main Road?']) {
    input.value = question;
    let prevented = false;
    await handlers.get('keydown')({ key: 'Enter', preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(requests.at(-1).url, '/api/projects/project/terminal');
    assert.equal(requests.at(-1).body.input, `ask ${question.replace(/^ask /, '')}`);
  }
  input.value = 'Office 101';
  await handlers.get('keydown')({ key: 'Enter' });
  assert.equal(requests.length, 2, 'ordinary searches do not execute terminal commands');
});
