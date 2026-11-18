// A stand-in for `codex app-server` in tests: the same JSON-RPC lines over
// stdio, answered by a script instead of a model. It searches Lasso for the
// last word of the prompt, then writes a sentence citing the first values it
// was shown, in deltas that cut the citation marks in two.
//
// What it does differently is chosen by the prompt and by FAKE_CODEX_*:
//   prompt contains "fail"     the turn fails with a usage-limit message
//   prompt contains "slow"     one delta, then it waits to be interrupted
//   FAKE_CODEX_SIGNED_OUT=1    account/read reports no account
//   FAKE_CODEX_REJECT_FLAGS=1  started with --disable, it refuses to run
//   FAKE_CODEX_LOG=<file>      each request's method (and thread/start's params) is appended there
//   FAKE_CODEX_REPLY_FILE=<file>  while the file exists, each turn answers with its contents and nothing else

import fs from 'node:fs';
import { createInterface } from 'node:readline';

// The test runner runs every file under test/, this one included: run that way, it has nothing to do.
if (process.argv[2] !== 'app-server') process.exit(0);
if (process.env.FAKE_CODEX_REJECT_FLAGS && process.argv.includes('--disable')) {
  process.stderr.write('error: unknown feature\n');
  process.exit(2);
}

const log = (entry) => { if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify(entry)}\n`); };
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });
const waiting = new Map();
let nextRequest = 1000;
let turns = 0;
const interrupted = new Map();

function ask(method, params) {
  return new Promise((resolve) => {
    const id = nextRequest;
    nextRequest += 1;
    waiting.set(id, resolve);
    send({ id, method, params });
  });
}

async function turn(threadId, turnId, request) {
  // The person's prompt is the first line; what Lasso found for it follows.
  const prompt = request.split('\n')[0];
  const completed = (status, error = null) => notify('turn/completed', { threadId, turn: { id: turnId, status, error, items: [] } });
  if (/fail/i.test(prompt)) {
    notify('error', { threadId, turnId, willRetry: false, error: { message: 'You have reached your usage limit.' } });
    completed('failed', { message: 'You have reached your usage limit.' });
    return;
  }
  // A scripted answer, read afresh each turn: the reply to a review's request for an edit.
  const scripted = process.env.FAKE_CODEX_REPLY_FILE;
  if (scripted && fs.existsSync(scripted)) {
    log({ method: 'turn/request', request });
    notify('item/started', { threadId, turnId, item: { type: 'agentMessage', id: 'scripted', phase: 'final_answer', text: '' } });
    const answer = fs.readFileSync(scripted, 'utf8');
    for (let at = 0; at < answer.length; at += 11) {
      notify('item/agentMessage/delta', { threadId, turnId, itemId: 'scripted', delta: answer.slice(at, at + 11) });
    }
    completed('completed');
    return;
  }
  if (/slow/i.test(prompt)) {
    notify('item/started', { threadId, turnId, item: { type: 'agentMessage', id: 'slow', phase: 'final_answer', text: '' } });
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'slow', delta: 'Starting' });
    await new Promise((resolve) => { interrupted.set(turnId, resolve); });
    completed('interrupted');
    return;
  }
  // Words before a tool call are commentary, which Lasso must not write.
  notify('item/started', { threadId, turnId, item: { type: 'agentMessage', id: 'aside', phase: 'commentary', text: '' } });
  notify('item/agentMessage/delta', { threadId, turnId, itemId: 'aside', delta: 'Looking that up.' });
  const query = prompt.trim().split(/\s+/).at(-1).replace(/[^\p{L}\p{N}]/gu, '');
  const found = await ask('item/tool/call', { threadId, turnId, callId: 'call-1', tool: 'lasso_search', arguments: { queries: [query] } });
  const shown = found?.contentItems?.[0]?.text ?? '';
  const lines = [...shown.matchAll(/^\[(\d+)\] (.+?): (.+)$/gm)].slice(0, 2);
  const answer = lines.length
    ? `\n\n${lines.map(([, number, label, value]) => `${label} is [[${number}|${value}]].`).join(' ')} Nothing else is [[99|known]] [here].`
    : 'Nothing was found.';
  notify('item/started', { threadId, turnId, item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: '' } });
  // Seven characters at a time, so marks arrive in pieces.
  for (let at = 0; at < answer.length; at += 7) {
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'answer', delta: answer.slice(at, at + 7) });
  }
  completed('completed');
}

createInterface({ input: process.stdin }).on('line', (text) => {
  const message = JSON.parse(text);
  if (message.id !== undefined && message.method === undefined) {
    waiting.get(message.id)?.(message.result);
    waiting.delete(message.id);
    return;
  }
  if (message.id === undefined) return;
  log({ method: message.method, ...(message.method === 'thread/start' ? { params: message.params } : {}) });
  const reply = (result) => send({ id: message.id, result });
  switch (message.method) {
    case 'initialize': reply({ userAgent: 'fake-codex' }); break;
    case 'account/read':
      reply(process.env.FAKE_CODEX_SIGNED_OUT ? { account: null, requiresOpenaiAuth: true }
        : { account: { type: 'chatgpt', email: null, planType: 'plus' }, requiresOpenaiAuth: true });
      break;
    case 'thread/start': reply({ thread: { id: `thread-${process.pid}-${message.id}` } }); break;
    case 'turn/start': {
      turns += 1;
      const turnId = `turn-${turns}`;
      reply({ turn: { id: turnId } });
      turn(message.params.threadId, turnId, message.params.input.map((part) => part.text).join(' '));
      break;
    }
    case 'turn/interrupt':
      reply({});
      interrupted.get(message.params.turnId)?.();
      break;
    default: reply({});
  }
});
process.stdin.on('end', () => process.exit(0));
