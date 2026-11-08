import test from 'node:test';
import assert from 'node:assert/strict';
import { costOf, providerFor, worstCost } from '../scripts/agent-live/providers.mjs';
import { FAMILIES } from '../scripts/agent-live/families.mjs';
import { convertedText } from '../scripts/agent-benchmark-corpus.mjs';
import { docxFile, xlsxFile } from '../scripts/agent-eval/build.mjs';

test('the OpenAI provider sends the request, then each turn\'s tool results, and reads usage as the provider records it', async (t) => {
  // Arrange: a stand-in for the Responses API, answering a tool call and then text.
  const bodies = [];
  const replies = [
    { id: 'r1', status: 'completed', output: [{ type: 'function_call', call_id: 'c1', name: 'lasso', arguments: '{"ask":["q"]}' }],
      usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 0 }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 12 } } },
    { id: 'r2', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ANSWER: 42' }] }],
      usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 } } },
  ];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    bodies.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => replies[bodies.length - 1] };
  };
  t.after(() => { globalThis.fetch = real; });
  const provider = await providerFor('gpt-5.4-mini', { openaiKey: 'test-key', effort: 'low', maxOutput: 100 });
  const tools = [{ name: 'lasso', description: 'd', input_schema: { type: 'object', properties: {} } }];

  // Act
  const conversation = provider.start({ instructions: 'be brief', tools, prompt: 'the question' });
  const first = await conversation.next();
  const second = await conversation.next([{ id: 'c1', output: 'tool output' }]);

  // Assert
  assert.equal(bodies[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(bodies[0].headers.authorization, 'Bearer test-key');
  assert.deepEqual(bodies[0].body.input, [{ role: 'user', content: 'the question' }]);
  assert.deepEqual(bodies[0].body.tools, [{ type: 'function', name: 'lasso', description: 'd', parameters: { type: 'object', properties: {} }, strict: false }]);
  assert.deepEqual([bodies[0].body.reasoning, bodies[0].body.max_output_tokens, bodies[0].body.instructions], [{ effort: 'low' }, 100, 'be brief']);
  assert.deepEqual(first.calls, [{ id: 'c1', name: 'lasso', arguments: '{"ask":["q"]}' }]);
  assert.deepEqual(first.usage, { input: 900, cached: 0, output: 40, reasoning: 12 });
  assert.equal(bodies[1].body.previous_response_id, 'r1', 'later turns continue the stored response');
  assert.deepEqual(bodies[1].body.input, [{ type: 'function_call_output', call_id: 'c1', output: 'tool output' }]);
  assert.deepEqual([second.calls, second.text], [[], 'ANSWER: 42']);
  assert.equal(costOf('gpt-5.4-mini', second.usage), (200 * 0.75 + 800 * 0.075 + 10 * 4.5) / 1e6, 'cached input at its own price');
  assert.ok(worstCost('gpt-5.4-mini', 1000, 6000) > costOf('gpt-5.4-mini', { input: 1000, cached: 0, output: 6000 }), 'the guard allows for growth');
  await assert.rejects(providerFor('gpt-unknown', {}), /No price recorded/, 'a model without a price is refused');
  await assert.rejects(providerFor('gpt-5.4-mini', {}), /OPENAI_API_KEY/);
});

test('the Claude provider runs a turn as a host does: adaptive thinking, caching, a turn\'s tool results together, each reply sent back whole', async () => {
  // Arrange: a stand-in for the Messages API, through the SDK's own request path.
  const bodies = [];
  const reply = (id, stop_reason, content, usage) => ({ id, type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason, stop_sequence: null, content, usage });
  const replies = [
    reply('msg_1', 'tool_use', [{ type: 'thinking', thinking: '', signature: 'sig-1' }, { type: 'tool_use', id: 'tu_1', name: 'lasso', input: { ask: ['q'] } },
      { type: 'tool_use', id: 'tu_2', name: 'Read', input: { file_path: 'a.md' } }],
    { input_tokens: 50, cache_creation_input_tokens: 900, cache_read_input_tokens: 0, output_tokens: 60, output_tokens_details: { thinking_tokens: 20 } }),
    reply('msg_2', 'end_turn', [{ type: 'text', text: 'ANSWER: 42' }],
      { input_tokens: 30, cache_creation_input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 10, output_tokens_details: { thinking_tokens: 0 } }),
    reply('msg_3', 'refusal', [], { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }),
  ];
  const fetch = async (url, init) => {
    bodies.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
    return new Response(JSON.stringify(replies[bodies.length - 1]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const provider = await providerFor('claude-sonnet-5-5', { anthropicKey: 'test-key', effort: 'low', fetch });
  const tools = [{ name: 'lasso', description: 'd', input_schema: { type: 'object', properties: {} } }];

  // Act
  const conversation = provider.start({ instructions: 'be brief', tools, prompt: 'the question' });
  const first = await conversation.next();
  const second = await conversation.next([{ id: 'tu_1', output: 'evidence' }, { id: 'tu_2', output: 'File does not exist: a.md', error: true }]);
  const refused = await provider.start({ instructions: 'be brief', tools, prompt: 'another' }).next();

  // Assert
  assert.match(bodies[0].url, /\/v1\/messages$/);
  assert.equal(bodies[0].headers.get('authorization'), 'Bearer test-key', 'the key given, not one found elsewhere');
  const sent = bodies[0].body;
  assert.deepEqual([sent.model, sent.max_tokens, sent.system], ['claude-sonnet-5-5', 16_000, 'be brief']);
  assert.deepEqual([sent.thinking, sent.output_config, sent.cache_control], [{ type: 'adaptive' }, { effort: 'low' }, { type: 'ephemeral' }]);
  assert.deepEqual(sent.tools, [{ name: 'lasso', description: 'd', input_schema: { type: 'object', properties: {} } }]);
  assert.deepEqual(sent.messages, [{ role: 'user', content: 'the question' }]);
  assert.deepEqual(first.calls, [{ id: 'tu_1', name: 'lasso', arguments: '{"ask":["q"]}' }, { id: 'tu_2', name: 'Read', arguments: '{"file_path":"a.md"}' }]);
  assert.deepEqual(first.usage, { input: 950, cached: 0, written: 900, output: 60, reasoning: 20 }, 'input counts the whole prompt, cache writes apart');
  assert.deepEqual(bodies[1].body.messages.slice(1), [
    { role: 'assistant', content: replies[0].content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'evidence' },
      { type: 'tool_result', tool_use_id: 'tu_2', content: 'File does not exist: a.md', is_error: true }] },
  ], 'the reply goes back whole, thinking block included, and both results in one message');
  assert.deepEqual([second.calls, second.text, second.incomplete, second.refused], [[], 'ANSWER: 42', false, false]);
  assert.equal(costOf('claude-sonnet-5-5', second.usage), (30 * 2 + 900 * 0.2 + 100 * 2.5 + 10 * 10) / 1e6, 'cache reads and writes at their own prices');
  assert.equal(refused.refused, true, 'a refusal is recorded as one');
  assert.equal(costOf('claude-haiku-5-5', { input: 150_000, cached: 0, written: 0, output: 1000 }), (150_000 * 0.5 + 1000 * 2.5) / 1e6,
    'Haiku 5.5 is dearer once a prompt passes 100K tokens');
});

test('the mock model calls the tools it is given and spends nothing', async () => {
  // Arrange
  const provider = await providerFor('mock', {});
  const tools = [{ name: 'Read' }, { name: 'Glob' }, { name: 'lasso' }];

  // Act
  const conversation = provider.start({ instructions: 'i', tools, prompt: 'Q4 revenue' });
  const first = await conversation.next();
  const second = await conversation.next([{ id: first.calls[0].id, output: 'Q4 revenue was $1.69 million.' }]);

  // Assert
  assert.deepEqual(first.calls.map((call) => [call.name, JSON.parse(call.arguments)]), [['lasso', { ask: ['Q4 revenue'] }]]);
  assert.match(second.text, /ANSWER: .*1\.69 million/);
  assert.equal(costOf('mock', second.usage), 0);
  assert.ok(provider.estimated, 'its token counts are marked as estimates');
});

test('a converter gives the file tools a workbook\'s rows and a Word file\'s paragraphs', () => {
  const workbook = xlsxFile([{ name: 'Sites', header: ['Site', 'Note'], rows: [['Ashford', 'open, staffed'], ['Bexley', '2']] }]);
  assert.equal(convertedText(workbook, 'data/sites.xlsx'), 'Sheet: Sites\nSite,Note\nAshford,"open, staffed"\nBexley,2');
  assert.equal(convertedText(docxFile('Memo', [{ heading: 'Purpose' }, { paragraph: 'Roll out in April.' }]), 'memo.docx'), 'Purpose\n\nRoll out in April.');
  assert.equal(convertedText(Buffer.from('plain'), 'notes.md'), null, 'other files are read as they are');
});

test('assembly questions are graded against the placements the files were written with', async () => {
  // Arrange
  const [workspace] = await FAMILIES.geometry();
  try {
    const task = (id) => workspace.tasks.find((item) => item.id === `geometry/${id}`);

    // Act and assert
    assert.equal(task('fixture-pin-distance').grade('They are 58.31 mm apart.\nANSWER: 58.31 mm').correct, true);
    assert.equal(task('fixture-pin-distance').grade('ANSWER: 50 mm').correct, false);
    assert.equal(task('flange-bolt-pose').grade('ANSWER: offset (−25, 25, 0) mm, turned 90° about z').correct, true, 'an offset in either sign');
    assert.deepEqual(task('flange-sensor-position').grade('Bolts Bolt:1 to Bolt:8; Sensor:1 at (90, 30, 20).').detail.missing, ['8 bolts'],
      'a count is a phrase, not any 8 in the answer');
    assert.match(task('flange-sensor-tilt').upload, /^=== Engineering\/Flange assembly\.step ===\nISO-10303-21;/, 'the upload attaches the STEP file');
  } finally {
    await workspace.close();
  }
});
