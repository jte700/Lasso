// Lasso keeps which characters of a file an AI wrote, from what the tools
// said they wrote when they wrote it: Claude Code's hooks (the file before
// and after each edit, the time each command ran), Lasso's writer and pastes
// from AI apps reported by the Mac app. Nothing is guessed from the words.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { appendToSpool, spoolLine } from '../src/cli/ai-hook.js';
import { hookStatus, runHooksCommand, withLasso, withoutLasso } from '../src/cli/ai-hooks-install.js';
import { FRESH, NOBODY, carryForward, claimText, settle, spansOf } from '../src/provenance/text-runs.js';
import { writeZip } from '../src/dependencies/zip-archive.js';
import { openBackend } from '../src/cli/backend.js';
import { renderAnywhereBlame } from '../src/cli/anywhere-views.js';
import { createPainter } from '../src/cli/style.js';

const writer = { id: 'human:writer', displayName: 'Writer', actorType: 'HUMAN_SELF' };

function folder(t, files) {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-ai-authorship-')));
  const root = path.join(sandbox, 'Notes');
  fs.mkdirSync(root);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
  const application = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false, port: 0 });
  t.after(async () => {
    await application.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  const project = application.timeline.importProject(root, writer, { watch: false }).project;
  const library = application.config.dataDir;
  const file = (name) => path.join(root, name);
  const hook = async (input) => {
    const line = await spoolLine({ session_id: 'session-1', cwd: root, ...input }, { library });
    if (line) appendToSpool(library, line);
    return line;
  };
  /** Claude Code's Edit tool writing `content` to `name`, as its hooks report it. */
  const claudeWrites = async (name, content, { tool = 'Edit', finish = true } = {}) => {
    const call = { tool_name: tool, tool_use_id: crypto.randomUUID(), tool_input: { file_path: file(name) } };
    await hook({ hook_event_name: 'PreToolUse', ...call });
    fs.writeFileSync(file(name), content);
    if (finish) await hook({ hook_event_name: 'PostToolUse', ...call });
    return () => hook({ hook_event_name: 'PostToolUse', ...call });
  };
  const save = async () => {
    const capture = application.timeline.capture(project.id, writer);
    await application.authorship.settled();
    return capture;
  };
  const authorship = (name) => application.authorship.forPath(file(name));
  const latestEvent = () => application.timeline.listEvents(project.id)[0];
  return { application, project, root, file, hook, claudeWrites, save, authorship, latestEvent };
}

test('What Claude Code writes with its edit tool is marked as Claude\'s, with the prompt that asked for it', async (t) => {
  const notes = folder(t, { 'notes.md': '# Pump trial\n\nThe pump ran for six hours.\n' });
  await notes.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Add a line on the flow rate' });

  await notes.claudeWrites('notes.md', '# Pump trial\n\nThe pump ran for six hours.\nThe flow rate held at 4.2 L/min throughout.\n');
  await notes.save();

  const found = notes.authorship('notes.md');
  assert.deepEqual(found.spans.map((span) => span.text), ['The flow rate held at 4.2 L/min throughout.']);
  assert.equal(found.spans[0].lineStart, 4);
  const [mark] = found.marks;
  assert.equal(mark.agent.name, 'Claude');
  assert.equal(mark.kind, 'edit');
  assert.equal(mark.tool, 'Claude Code');
  assert.equal(mark.prompt, 'Add a line on the flow rate');
  assert.equal(mark.editedInside, 0);
  assert.equal(notes.latestEvent().actor.displayName, 'Claude');
  assert.equal(notes.latestEvent().initiatedBy.displayName, 'Writer');
});

test('lasso blame lists the parts of a file an AI wrote, with what asked for them', async (t) => {
  const notes = folder(t, { 'notes.md': 'Intro.\n' });
  await notes.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Add the result' });
  await notes.claudeWrites('notes.md', 'Intro.\nAll six runs passed.\n');
  await notes.save();
  const backend = openBackend({ dataDir: notes.application.config.dataDir, cwd: notes.root, readHistory: false });
  t.after(() => backend.close());

  const data = await backend.call('blame', notes.file('notes.md'));
  const shown = renderAnywhereBlame(data, createPainter('none'), 100).join('\n');

  assert.equal(data.ai.spans[0].text, 'All six runs passed.');
  assert.match(shown, /Written by AI: \[Claude\] 1 part/);
  assert.match(shown, /\[line 2 +Claude with its edit tool/);
  assert.match(shown, /asked: "Add the result"/);
});

test('A person\'s edit saved together with Claude\'s stays the person\'s', async (t) => {
  const notes = folder(t, { 'notes.md': 'Line one.\nLine two.\n' });
  fs.writeFileSync(notes.file('notes.md'), 'Line one, edited by hand.\nLine two.\n');

  await notes.claudeWrites('notes.md', 'Line one, edited by hand.\nLine two.\nClaude added this closing line.\n');
  await notes.save();

  assert.deepEqual(notes.authorship('notes.md').spans.map((span) => span.text), ['Claude added this closing line.']);
  assert.equal(notes.latestEvent().actor.displayName, 'Writer');
});

test('Words a person rewrites inside Claude\'s text become theirs, and the rest stays Claude\'s', async (t) => {
  const notes = folder(t, { 'notes.md': 'Intro.\n' });
  await notes.claudeWrites('notes.md', 'Intro.\nThe flow rate held at 4.2 L/min throughout.\n');
  await notes.save();

  fs.writeFileSync(notes.file('notes.md'), 'A new opening line.\nIntro.\nThe flow rate held at 4.3 L/min throughout.\n');
  await notes.save();

  const found = notes.authorship('notes.md');
  assert.deepEqual(found.spans.map((span) => span.text), ['The flow rate held at 4.', 'L/min throughout.']);
  assert.equal(found.spans[0].lineStart, 3);
  assert.equal(found.marks[0].editedInside, 1);
  assert.equal(notes.latestEvent().actor.displayName, 'Writer');
});

test('Text pasted from ChatGPT is marked once the file is saved with it, and words already there are not', async (t) => {
  const notes = folder(t, { 'methods.md': 'The method is described below.\n' });
  const pasted = 'Samples were centrifuged at 3,000 g for ten minutes before analysis. The method is described below.';
  notes.application.authorship.record({ kind: 'paste', agent: 'ChatGPT', tool: 'chatgpt.com', text: pasted,
    documentPath: notes.file('methods.md'), hostApp: 'TextEdit' });

  fs.writeFileSync(notes.file('methods.md'), 'The method is described below.\nSamples were centrifuged at 3,000 g for ten minutes before analysis.\n');
  await notes.save();

  const found = notes.authorship('methods.md');
  assert.deepEqual(found.spans.map((span) => span.text), ['Samples were centrifuged at 3,000 g for ten minutes before analysis.']);
  assert.equal(found.marks[0].agent.name, 'ChatGPT');
  assert.equal(found.marks[0].kind, 'paste');
  assert.equal(found.marks[0].hostApp, 'TextEdit');
});

test('The same text pasted again is credited to the latest paste', async (t) => {
  const notes = folder(t, { 'methods.md': 'Methods.\n' });
  const pasted = 'Samples were centrifuged at 3,000 g for ten minutes before analysis.';
  notes.application.authorship.record({ kind: 'paste', agent: 'ChatGPT', tool: 'chatgpt.com', text: pasted, hostApp: 'TextEdit' });
  notes.application.authorship.record({ kind: 'paste', agent: 'ChatGPT', tool: 'chatgpt.com', text: pasted, hostApp: 'Pages' });

  fs.writeFileSync(notes.file('methods.md'), `Methods.\n${pasted}\n`);
  await notes.save();

  const found = notes.authorship('methods.md');
  assert.equal(found.spans.length, 1);
  assert.equal(found.marks.length, 1);
  assert.equal(found.marks[0].hostApp, 'Pages');
});

test('A paste is not claimed by a few common words a person typed', async (t) => {
  const notes = folder(t, { 'notes.md': 'Start.\n' });
  notes.application.authorship.record({ kind: 'paste', agent: 'Claude', text: 'Results of the trial show the pump is reliable under load.' });

  fs.writeFileSync(notes.file('notes.md'), 'Start.\nWe wrote up the results of the meeting.\n');
  await notes.save();

  assert.deepEqual(notes.authorship('notes.md').spans, []);
});

test('The writer\'s answer is marked with the prompt it answered', async (t) => {
  const notes = folder(t, { 'draft.txt': 'Dear team,\n' });
  notes.application.authorship.record({ kind: 'writer', agent: 'ChatGPT', tool: 'Lasso writer', prompt: 'summarise the pump trial',
    text: 'The pump trial ran for six hours at a steady flow.', hostApp: 'Mail' });

  fs.writeFileSync(notes.file('draft.txt'), 'Dear team,\nThe pump trial ran for six hours at a steady flow.\nThanks\n');
  await notes.save();

  const found = notes.authorship('draft.txt');
  assert.deepEqual(found.spans.map((span) => span.text), ['The pump trial ran for six hours at a steady flow.']);
  assert.equal(found.marks[0].prompt, 'summarise the pump trial');
  assert.equal(found.marks[0].kind, 'writer');
});

test('A command Claude ran marks the file it wrote while it ran', async (t) => {
  const notes = folder(t, { 'readme.md': 'Readme.\n' });
  const call = { tool_name: 'Bash', tool_use_id: crypto.randomUUID(), tool_input: { command: 'python make_report.py' } };
  await notes.hook({ hook_event_name: 'PreToolUse', ...call });
  fs.writeFileSync(notes.file('report.md'), 'Report\n\nAll six runs passed.\n');
  await notes.hook({ hook_event_name: 'PostToolUse', ...call });
  await notes.save();

  const found = notes.authorship('report.md');
  assert.deepEqual(found.spans.map((span) => span.text), ['Report\n\nAll six runs passed.']);
  assert.equal(found.marks[0].kind, 'command');
  assert.equal(found.marks[0].command, 'python make_report.py');
  assert.deepEqual(notes.authorship('readme.md').spans, []);
});

test('A Word document\'s paragraph that Claude\'s command wrote is marked', async (t) => {
  const paragraph = (text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const docx = (paragraphs) => writeZip([
    { name: '[Content_Types].xml', content: Buffer.from('<Types/>') },
    { name: 'word/document.xml', content: Buffer.from(`<w:document><w:body>${paragraphs.map(paragraph).join('')}</w:body></w:document>`) },
  ]);
  const notes = folder(t, { 'report.docx': docx(['Pump trial report', 'The pump ran for six hours.']) });
  const call = { tool_name: 'Bash', tool_use_id: crypto.randomUUID(), tool_input: { command: 'python add_summary.py report.docx' } };
  await notes.hook({ hook_event_name: 'PreToolUse', ...call });
  fs.writeFileSync(notes.file('report.docx'), docx(['Pump trial report', 'The pump ran for six hours.', 'In summary, the flow held steady.']));
  await notes.hook({ hook_event_name: 'PostToolUse', ...call });
  await notes.save();

  assert.deepEqual(notes.authorship('report.docx').spans.map((span) => span.text), ['In summary, the flow held steady.']);
});

test('An edit whose finish is heard after its save still marks its words, and the save stays as recorded', async (t) => {
  const notes = folder(t, { 'notes.md': 'One.\n' });
  const finish = await notes.claudeWrites('notes.md', 'One.\nTwo, from Claude.\n', { finish: false });
  await notes.save();
  assert.deepEqual(notes.authorship('notes.md').spans, []);

  await finish();
  await notes.application.authorship.enqueue(() => notes.application.authorship.ingest());

  assert.deepEqual(notes.authorship('notes.md').spans.map((span) => span.text), ['Two, from Claude.']);
  assert.equal(notes.latestEvent().actor.displayName, 'Writer');
});

test('The hook records nothing for files outside Lasso\'s folders, and no library means no record', async (t) => {
  const notes = folder(t, { 'notes.md': 'One.\n' });
  const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-elsewhere-')));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));

  const line = await notes.hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 'x',
    tool_input: { file_path: path.join(elsewhere, 'other.md') } });

  assert.equal(line, null);
  const { libraryFolder } = await import('../src/cli/ai-hook.js');
  assert.equal(libraryFolder({ LASSO_DATA_DIR: elsewhere }), null);
});

test('The Mac app asks which parts of a file an AI wrote by the file\'s path', async (t) => {
  const notes = folder(t, { 'notes.md': 'One.\n' });
  notes.application.server.listen(0, '127.0.0.1');
  await new Promise((resolve) => notes.application.server.once('listening', resolve));
  const base = `http://127.0.0.1:${notes.application.server.address().port}`;

  const posted = await fetch(`${base}/api/ai-marks`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'paste', agent: 'Claude', tool: 'Claude', text: 'Two lines Claude wrote for the notes.', documentPath: notes.file('notes.md') }) });
  assert.equal(posted.status, 201);
  fs.writeFileSync(notes.file('notes.md'), 'One.\nTwo lines Claude wrote for the notes.\n');
  await notes.save();
  const answer = await (await fetch(`${base}/api/ai-authorship?path=${encodeURIComponent(notes.file('notes.md'))}`)).json();
  const outside = await (await fetch(`${base}/api/ai-authorship?path=${encodeURIComponent('/nowhere/at/all.md')}`)).json();

  assert.equal(answer.found, true);
  assert.equal(answer.spans[0].text, 'Two lines Claude wrote for the notes.');
  assert.deepEqual(answer.spans[0].pieces.map((piece) => piece.text), ['Two lines Claude wrote for the notes.']);
  assert.equal(answer.spans[0].prefix, 'One.\n');
  assert.equal(answer.marks[0].agent.name, 'Claude');
  assert.equal(outside.found, false);
});

test('Lasso\'s hook is added to Claude Code\'s settings once, beside hooks already there, and taken out again', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const settingsFile = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile));
  const theirs = { model: 'opus', hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'prettier --write' }] }] } };
  fs.writeFileSync(settingsFile, JSON.stringify(theirs));

  runHooksCommand('install', { home });
  runHooksCommand('install', { home });
  const installed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const removed = runHooksCommand('remove', { home });

  assert.equal(installed.model, 'opus');
  assert.equal(installed.hooks.PostToolUse.length, 2);
  assert.equal(installed.hooks.PreToolUse.length, 1);
  assert.equal(installed.hooks.UserPromptSubmit.length, 1);
  assert.equal(hookStatus(installed).installed, true);
  assert.equal(removed.code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), theirs);
  assert.ok(fs.existsSync(`${settingsFile}.before-lasso`));
  assert.deepEqual(withoutLasso(withLasso({})), {});
});

test('Characters keep their writer through lines added above them, and only fresh words can be claimed', () => {
  const before = 'alpha\nbeta gamma\n';
  const owners = new Int32Array(before.length).fill(NOBODY).fill(0, 6, 16);
  const after = 'new line\nalpha\nbeta gamma delta\n';

  const carried = carryForward(before, after, owners, FRESH);
  const claimed = claimText(after, carried, 'beta gamma delta', 1);
  settle(carried);

  assert.deepEqual(spansOf(carried, after, (index) => `m${index}`).map((span) => [after.slice(span.s, span.e), span.m]),
    [['beta gamma', 'm0']]);
  assert.equal(claimed, 0);
});
