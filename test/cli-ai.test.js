// The lasso CLI says which parts of a file an AI wrote, from what the tools
// recorded when they wrote it: Lasso's own record (Claude Code's hooks,
// pastes from AI apps), the labels a file carries in its own bytes, and
// commits that name an AI. Nothing is guessed from the words.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createApplication } from '../src/server.js';
import { appendToSpool, spoolLine } from '../src/cli/ai-hook.js';
import { openBackend } from '../src/cli/backend.js';
import { Anywhere } from '../src/cli/anywhere.js';
import { aiIdentity, aiLabels, credentialTools } from '../src/cli/ai-facts.js';
import { renderAnywhereBlame, renderAnywhereDiff, renderAnywhereLog, renderWhence } from '../src/cli/anywhere-views.js';
import { execute } from '../src/cli/commands.js';
import { renderStatus } from '../src/cli/views.js';
import { createPainter } from '../src/cli/style.js';

const plain = createPainter('none');
const OFFLINE = { platform: 'test', gitInstalled: false, run: () => null };
const writer = { id: 'human:writer', displayName: 'Writer', actorType: 'HUMAN_SELF' };

/** A Lasso folder with Claude Code's hook reporting into its library, and the CLI opened on it. */
function notesFolder(t, files) {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-cli-ai-')));
  const root = path.join(sandbox, 'Notes');
  fs.mkdirSync(root);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
  const application = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false, port: 0 });
  const project = application.timeline.importProject(root, writer, { watch: false }).project;
  const library = application.config.dataDir;
  const file = (name) => path.join(root, name);
  const hook = async (input) => {
    const line = await spoolLine({ session_id: 'session-1', cwd: root, ...input }, { library });
    if (line) appendToSpool(library, line);
  };
  const claudeWrites = async (name, content) => {
    const call = { tool_name: 'Edit', tool_use_id: crypto.randomUUID(), tool_input: { file_path: file(name) } };
    await hook({ hook_event_name: 'PreToolUse', ...call });
    fs.writeFileSync(file(name), content);
    await hook({ hook_event_name: 'PostToolUse', ...call });
  };
  const save = async () => {
    application.timeline.capture(project.id, writer);
    await application.authorship.settled();
  };
  let backend = null;
  const cli = () => {
    backend ??= openBackend({ dataDir: library, cwd: root, readHistory: false, system: OFFLINE, home: sandbox });
    return backend;
  };
  t.after(async () => {
    backend?.close();
    await application.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  return { application, root, sandbox, file, hook, claudeWrites, save, cli };
}

test('whence says how much of a file Claude wrote, how, and the prompt that asked for it', async (t) => {
  // Arrange
  const notes = notesFolder(t, { 'notes.md': '# Pump trial\n\nThe pump ran for six hours.\n' });
  await notes.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Add a line on the flow rate' });
  await notes.claudeWrites('notes.md', '# Pump trial\n\nThe pump ran for six hours.\nThe flow rate held at 4.2 L/min throughout.\n');
  await notes.save();

  // Act
  const data = await notes.cli().call('whence', notes.file('notes.md'));
  const shown = renderWhence(data, plain, 120).join('\n');

  // Assert
  const [claude] = data.ai.agents;
  assert.equal(claude.agent.name, 'Claude');
  assert.equal(claude.parts, 1);
  assert.equal(claude.letters, 'Theflowrateheldat4.2L/minthroughout.'.length);
  assert.ok(claude.share > 0.4 && claude.share < 0.6);
  assert.equal(data.ai.current, true);
  assert.match(shown, /Written with AI {2}as the tools recorded it/);
  assert.match(shown, /\[Claude\] +\d+% of the text · 1 part · with its edit tool/);
  assert.match(shown, /asked: "Add a line on the flow rate"/);
});

test('diff marks the lines Claude wrote, and log names what it wrote in each save', async (t) => {
  // Arrange
  const notes = notesFolder(t, { 'notes.md': 'Intro.\nMethods.\n' });
  await notes.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Add the result' });
  await notes.claudeWrites('notes.md', 'Intro.\nMethods.\nAll six runs passed.\nThe seventh was stopped early.\n');
  await notes.save();
  const backend = notes.cli();

  // Act
  const diff = await backend.call('diff', ['notes.md']);
  const diffShown = renderAnywhereDiff(diff, plain, 120).join('\n');
  const log = await backend.call('log', {});
  const logShown = renderAnywhereLog(log, plain, 140).join('\n');

  // Assert
  assert.deepEqual(Object.keys(diff.ai.lines).map(Number), [3, 4]);
  assert.match(diffShown, /▎Claude wrote all 2 added lines with its edit tool {2}asked: "Add the result"/);
  assert.match(diffShown, /3▎ \+ All six runs passed\./);
  assert.match(diffShown, /2 {2}  Methods\./);
  assert.match(logShown, /◆ Claude edited Notes\/notes\.md/);
  assert.match(logShown, /\[Claude\] wrote 51 characters with its edit tool/);
  assert.match(logShown, /"Add the result" · asked by Writer/);
});

test('a ChatGPT answer pasted into a file is named in whence, log and status, and the hook\'s state shows', async (t) => {
  // Arrange
  const notes = notesFolder(t, { 'summary.md': 'Summary.\n' });
  const answer = 'The trial met its primary endpoint with a clear margin over placebo.';
  notes.application.authorship.record({ kind: 'paste', agent: 'ChatGPT', text: answer, hostApp: 'TextEdit', documentPath: notes.file('summary.md') });
  fs.writeFileSync(notes.file('summary.md'), `Summary.\n${answer}\nWritten up by hand afterwards.\n`);
  await notes.save();
  const backend = notes.cli();

  // Act
  const origin = renderWhence(await backend.call('whence', notes.file('summary.md')), plain, 120).join('\n');
  const log = renderAnywhereLog(await backend.call('log', {}), plain, 140).join('\n');
  const summary = await backend.call('summary');
  const status = renderStatus(summary, plain, 120).join('\n');

  // Assert
  assert.match(origin, /\[ChatGPT\] +\d+% of the text · 1 part · pasted/);
  assert.match(log, /Writer edited Notes\/summary\.md/);
  assert.match(log, /\[ChatGPT\] \d+ characters of its answer pasted in/);
  assert.match(status, /written by AI +\[ChatGPT\] 1 paste/);
  assert.match(status, /Claude Code +○ not recorded {2}\(\/hooks install\)/);
});

test('/hooks installs Lasso\'s hook in Claude Code\'s settings, says so, and takes it out again', async (t) => {
  // Arrange
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-hooks-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const context = { paint: plain, columns: 100, cwd: home, home, dataDir: null, call: async () => null };

  const settingsFile = path.join(home, '.claude', 'settings.json');

  // Act
  const before = await execute('/hooks', context);
  const installed = await execute('/hooks install', context);
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const after = await execute('hooks status', context);
  const removed = await execute('/hooks remove', context);
  const wrong = await execute('/hooks sideways', context);

  // Assert
  assert.equal(before.exitCode, 1);
  assert.match(before.lines.join('\n'), /○ Claude Code {2}Lasso's hook in its settings\n.*not recorded\. Run `?lasso hooks install/);
  assert.match(installed.lines.join('\n'), /Lasso now records what Claude Code writes/);
  assert.match(installed.lines.join('\n'), /no Lasso library on this computer, so the hook writes nothing/);
  assert.equal(settings.hooks.PostToolUse.length, 1);
  assert.equal(after.exitCode, 0);
  assert.match(after.lines.join('\n'), /● Claude Code[\s\S]*Lasso records what Claude writes/);
  assert.match(removed.lines.join('\n'), /taken out/);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).hooks, undefined);
  assert.equal(wrong.exitCode, 2);
});

test('git blame and whence mark the commits that name an AI as author or co-author, and never a person called Claude', async (t) => {
  // Arrange
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-cli-ai-git-')));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', folder, ...args], { stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Maya Chen', GIT_AUTHOR_EMAIL: 'maya@example.com', GIT_COMMITTER_NAME: 'Maya Chen',
      GIT_COMMITTER_EMAIL: 'maya@example.com' } });
  try { git('init', '-q'); } catch { t.skip('git is not installed'); return; }
  fs.writeFileSync(path.join(folder, 'pump.py'), 'rate = 4.2\n');
  git('add', '.');
  git('commit', '-q', '-m', 'First rate', '-m', 'Co-authored-by: Claude Dupont <claude@example.com>');
  fs.writeFileSync(path.join(folder, 'pump.py'), 'rate = 4.2\nhours = 6\nruns = 7\n');
  git('commit', '-q', '-am', 'Add the run counts', '-m', 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>');
  const system = { platform: 'test', gitInstalled: true, run: (command, args, options) => {
    try { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...options }); } catch { return null; }
  } };
  const anywhere = new Anywhere({ system, cwd: folder });

  // Act
  const blame = anywhere.blame('pump.py');
  const blameShown = renderAnywhereBlame(blame, plain, 100).join('\n');
  const originShown = renderWhence(anywhere.whence('pump.py'), plain, 120).join('\n');

  // Assert
  assert.deepEqual(blame.lines.map((line) => line.ai), [[], ['Claude'], ['Claude']]);
  assert.deepEqual(blame.ais, [{ name: 'Claude', lines: 2 }]);
  assert.match(blameShown, /▎Claude is named as author or co-author on the commits of 2 lines/);
  assert.match(blameShown, /2▎ hours = 6/);
  assert.match(blameShown, /1  rate = 4\.2/);
  assert.match(originShown, /git +Claude named as author or co-author on 1 of its 2 commits/);
  assert.match(originShown, /last commit +\w{7} Maya Chen with Claude/);
});

test('an AI is known by its address or bot account, never by a name alone', () => {
  assert.equal(aiIdentity('Claude', 'noreply@anthropic.com'), 'Claude');
  assert.equal(aiIdentity('Copilot', '175728472+Copilot@users.noreply.github.com'), 'Copilot');
  assert.equal(aiIdentity('devin-ai-integration[bot]', '158243242+devin-ai-integration[bot]@users.noreply.github.com'), 'Devin');
  assert.equal(aiIdentity('Paul Gauthier (aider)', 'paul@example.com'), 'Aider');
  assert.equal(aiIdentity('Claude Monet', 'claude@giverny.fr'), null);
  assert.equal(aiIdentity('Gemini Smith', 'gemini@example.com'), null);
});

/** A PNG holding the given text chunks, in tEXt, iTXt or zTXt. */
function png(chunks) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header),
    ...chunks.map(([type, key, text]) => chunk(type, type === 'iTXt'
      ? Buffer.concat([Buffer.from(`${key}\0\0\0\0\0`, 'latin1'), Buffer.from(text, 'utf8')])
      : type === 'zTXt' ? Buffer.concat([Buffer.from(`${key}\0\0`, 'latin1'), zlib.deflateSync(Buffer.from(text, 'latin1'))])
        : Buffer.from(`${key}\0${text}`, 'latin1'))),
    chunk('IEND', Buffer.alloc(0))]);
}

/** CBOR text: a header then the UTF-8 bytes. */
const cbor = (text) => {
  const bytes = Buffer.from(text, 'utf8');
  return Buffer.concat([bytes.length < 24 ? Buffer.from([0x60 + bytes.length]) : Buffer.from([0x78, bytes.length]), bytes]);
};

test('whence reads the AI labels an image carries: its IPTC source type, Content Credentials and generation settings', async (t) => {
  // Arrange
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-cli-ai-labels-')));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const generated = path.join(folder, 'pump-render.png');
  fs.writeFileSync(generated, png([
    ['tEXt', 'parameters', 'a centrifugal pump on a lab bench, studio light\nSteps: 30, Sampler: Euler a, Seed: 1234'],
    ['iTXt', 'XML:com.adobe.xmp', '<x:xmpmeta><Iptc4xmpExt:DigitalSourceType>http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia</Iptc4xmpExt:DigitalSourceType></x:xmpmeta>'],
  ]));
  const credentialed = path.join(folder, 'poster.jpg');
  fs.writeFileSync(credentialed, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xeb]), Buffer.from('jumbjumdc2pa', 'latin1'),
    cbor('claim_generator'), cbor('ChatGPT c2pa-rs/0.33.1'), cbor('softwareAgent'), cbor('GPT-4o'), Buffer.from([0xff, 0xd9])]));
  const anywhere = new Anywhere({ system: OFFLINE, cwd: folder });

  // Act
  const labels = aiLabels(generated);
  const shown = renderWhence(anywhere.whence(generated), plain, 140).join('\n');
  const poster = renderAnywhereBlame(anywhere.blame(credentialed), plain, 120).join('\n');

  // Assert
  assert.equal(labels.sourceType.words, 'trained algorithmic media');
  assert.equal(labels.generation.key, 'parameters');
  assert.match(shown, /source type +trained algorithmic media · the IPTC label written in the file/);
  assert.match(shown, /generated with +settings in its "parameters" text: a centrifugal pump on a lab bench/);
  assert.match(poster, /credentials +ChatGPT, GPT-4o · named in its Content Credentials \(C2PA\)/);
  assert.equal(aiLabels(path.join(folder, 'missing.png')), null);
});

test('Content Credentials name a tool in claim generator info as well as in a claim generator', () => {
  const manifest = Buffer.concat([cbor('claim_generator_info'), Buffer.from([0x81, 0xa2]), cbor('name'), cbor('Adobe_Firefly'),
    cbor('version'), cbor('1.0')]);
  assert.deepEqual(credentialTools(manifest), ['Adobe Firefly']);
});

test('a Software tag alone is not an AI label, and Content Credentials that name no AI sit under the file\'s own facts', async (t) => {
  // Arrange
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-cli-ai-plain-')));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const render = path.join(folder, 'protein.png');
  fs.writeFileSync(render, png([['tEXt', 'Software', 'PyMOL']]));
  const photo = path.join(folder, 'bench.jpg');
  fs.writeFileSync(photo, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xeb]), Buffer.from('jumbjumdc2pa', 'latin1'),
    cbor('claim_generator'), cbor('Adobe_Photoshop/26.0'), Buffer.from([0xff, 0xd9])]));
  const anywhere = new Anywhere({ system: OFFLINE, cwd: folder });

  // Act
  const shown = renderWhence(anywhere.whence(photo), plain, 140).join('\n');

  // Assert
  assert.equal(aiLabels(render), null);
  assert.equal(aiLabels(photo).madeWithAi, false);
  assert.doesNotMatch(shown, /with AI/);
  assert.match(shown, /Inside the file[\s\S]*credentials +Adobe Photoshop · named in its Content Credentials/);
});
