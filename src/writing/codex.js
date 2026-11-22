// ChatGPT as a writer, through the Codex CLI that the ChatGPT app carries.
//
// Codex signs in with the person's ChatGPT account, so writing is covered by
// their subscription and Lasso holds no key. Its app server speaks JSON-RPC,
// one message per line over stdio: a thread is started with Lasso's
// instructions and tools, a turn with the person's prompt, and the answer
// arrives as deltas while tool calls come back here to be answered. One
// process is kept between prompts, since starting it is most of a second,
// and stopped once it has been idle.
//
// Only what writing needs of the protocol is used: initialize, account/read,
// thread/start, turn/start, turn/interrupt, the item/tool/call request, and
// the agent message, turn and error notifications.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

// What Codex offers a coding agent and a writer has no use for. Each is one
// less tool described to the model on every call. A Codex that no longer
// knows one of these names refuses to start, and is then started without them.
const UNUSED_FEATURES = ['plugins', 'apps', 'shell_tool', 'unified_exec', 'computer_use', 'browser_use', 'browser_use_external',
  'in_app_browser', 'image_generation', 'multi_agent', 'skill_search', 'sleep_tool', 'hooks', 'goals', 'tool_suggest'];
const START_TIMEOUT_MS = 15_000;
const IDLE_MS = 10 * 60 * 1000;
// How long an interrupted turn may take to say it has stopped.
const INTERRUPT_WAIT_MS = 3000;
// Pages of model/list read at most; one has always been enough.
const MODEL_PAGES = 5;

/** A failure worded for the person, such as not being signed in. */
export class WriterError extends Error {
  constructor(message, { code = 'writer-failed' } = {}) {
    super(message);
    this.code = code;
  }
}

const runnable = (file) => {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
};

/**
 * Where the Codex CLI is: LASSO_CODEX_PATH, the ChatGPT app's own copy, or
 * one installed on the PATH or where npm and Homebrew put it. Null when there is none.
 */
export function findCodex({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (env.LASSO_CODEX_PATH) return runnable(env.LASSO_CODEX_PATH) ? env.LASSO_CODEX_PATH : null;
  const name = platform === 'win32' ? 'codex.exe' : 'codex';
  const bundled = platform === 'darwin' ? ['/Applications', path.join(home, 'Applications')]
    .map((applications) => path.join(applications, 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin', 'codex')) : [];
  const onPath = String(env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const usual = platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin')];
  return [...bundled, ...[...onPath, ...usual].map((directory) => path.join(directory, name))].find(runnable) ?? null;
}

export class CodexAppServer {
  /**
   * @param {{ codexPath?: string|null, workingDirectory: string, model?: string|null, effort?: string, idleMs?: number,
   *   clientVersion?: string }} options  `workingDirectory` is an empty folder the agent is started in.
   */
  constructor({ codexPath = null, workingDirectory, model = null, effort = 'low', idleMs = IDLE_MS, clientVersion = '1.0.0' }) {
    this.codexPath = codexPath;
    this.workingDirectory = workingDirectory;
    this.model = model;
    this.effort = effort;
    this.idleMs = idleMs;
    this.clientVersion = clientVersion;
    this.child = null;
    this.starting = null;
    this.pending = new Map();
    this.threads = new Map();
    this.nextId = 1;
    this.idleTimer = null;
    this.lean = true;
    this.writingModel = model;
    // Counts stops, so a start that was stopped meanwhile is not mistaken for one Codex refused.
    this.stops = 0;
    this.closed = false;
  }

  /** The Codex to run: the one this was given, else the one found. Null when neither can be run. */
  located() {
    return this.codexPath ? (runnable(this.codexPath) ? this.codexPath : null) : findCodex();
  }

  /** Whether a Codex to run was found; nothing is started. */
  get installed() {
    return this.located() !== null;
  }

  /** The running app server, started and signed in to if it is not yet. */
  ready() {
    if (this.closed) return Promise.reject(new WriterError('Stopped.', { code: 'writer-stopped' }));
    if (this.child && !this.starting) return Promise.resolve();
    this.starting ??= this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  async start() {
    const codex = this.located();
    if (!codex) {
      throw new WriterError('ChatGPT is not set up on this computer. Install the ChatGPT app and sign in to it.', { code: 'writer-missing' });
    }
    fs.mkdirSync(this.workingDirectory, { recursive: true });
    const stops = this.stops;
    const stoppedMeanwhile = () => new WriterError('Stopped.', { code: 'writer-stopped' });
    try {
      await this.launch(codex, this.lean ? UNUSED_FEATURES.flatMap((feature) => ['--disable', feature]) : []);
    } catch (error) {
      if (stops !== this.stops) throw stoppedMeanwhile();
      if (!this.lean) throw error;
      // This Codex may not know a feature named above. It is started as it comes.
      this.lean = false;
      try {
        await this.launch(codex, []);
      } catch (again) {
        throw stops !== this.stops ? stoppedMeanwhile() : again;
      }
    }
    const { account, requiresOpenaiAuth } = await this.request('account/read', { refreshToken: false });
    if (!account && requiresOpenaiAuth) {
      this.halt();
      throw new WriterError('ChatGPT is not signed in. Open the ChatGPT app and sign in, then try again.', { code: 'writer-signed-out' });
    }
    this.account = account ?? null;
    this.writingModel = await this.chooseModel();
  }

  /**
   * The model writing runs on: the one Lasso was given when the account offers
   * it, else the account's own default. Never left to the person's Codex
   * settings, which may name a model their plan does not include. Null, and
   * Codex chooses, when this Codex cannot list its models.
   */
  async chooseModel() {
    const models = [];
    try {
      let cursor = null;
      for (let page = 0; page < MODEL_PAGES; page += 1) {
        const { data = [], nextCursor = null } = await this.request('model/list', cursor ? { cursor } : {});
        models.push(...data);
        if (!nextCursor) break;
        cursor = nextCursor;
      }
    } catch {
      return this.model;
    }
    if (this.model && models.some((entry) => entry.model === this.model || entry.id === this.model)) return this.model;
    const preferred = models.find((entry) => entry.isDefault) ?? models.find((entry) => !entry.hidden) ?? models[0];
    return preferred?.model ?? preferred?.id ?? this.model;
  }

  async launch(codex, flags) {
    const child = spawn(codex, ['app-server', ...flags], { cwd: this.workingDirectory, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-2000); });
    child.stdin.on('error', () => {});
    createInterface({ input: child.stdout }).on('line', (text) => this.receive(text));
    const ended = new Promise((resolve) => {
      child.once('error', (error) => resolve(error));
      child.once('exit', (code) => resolve(new Error(`Codex stopped (${code ?? 'signal'}). ${stderr.trim().split('\n').at(-1) ?? ''}`.trim())));
    });
    ended.then((error) => this.died(child, error));
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(new Error('Codex did not start in time.')), START_TIMEOUT_MS); });
    const initialized = this.request('initialize', { clientInfo: { name: 'lasso', title: 'Lasso', version: this.clientVersion },
      capabilities: { experimentalApi: true } });
    try {
      const first = await Promise.race([initialized, ended, late]);
      if (first instanceof Error) throw first;
    } catch (error) {
      this.halt();
      throw error;
    } finally {
      clearTimeout(timer);
    }
    this.send({ method: 'initialized' });
  }

  send(message) {
    if (this.child?.stdin.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.child) { reject(new Error('Codex is not running.')); return; }
      const id = this.nextId;
      this.nextId += 1;
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  receive(text) {
    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (message === null || typeof message !== 'object') return;
    if (message.id !== undefined && message.method === undefined) {
      const waiting = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) waiting?.reject(new Error(message.error.message ?? 'Codex refused the request.'));
      else waiting?.resolve(message.result ?? {});
      return;
    }
    const thread = this.threads.get(message.params?.threadId);
    if (message.id !== undefined) {
      // A request from Codex: a tool of ours to run. Nothing else is granted.
      if (message.method === 'item/tool/call' && thread) {
        Promise.resolve().then(() => thread.callTool(message.params.tool, message.params.arguments ?? {}))
          .then((output) => this.send({ id: message.id, result: { success: true, contentItems: [{ type: 'inputText', text: String(output) }] } }),
            (error) => this.send({ id: message.id, result: { success: false, contentItems: [{ type: 'inputText', text: `Failed: ${error.message}` }] } }));
        return;
      }
      this.send({ id: message.id, error: { code: -32601, message: 'Lasso does not allow this.' } });
      return;
    }
    thread?.notified(message.method, message.params);
  }

  died(child, error) {
    if (this.child !== child) return;
    this.child = null;
    clearTimeout(this.idleTimer);
    for (const waiting of this.pending.values()) waiting.reject(error);
    this.pending.clear();
    for (const thread of this.threads.values()) thread.failed(error);
    this.threads.clear();
  }

  /** Ends the process, whatever it was doing. */
  halt() {
    const child = this.child;
    if (!child) return;
    this.died(child, new Error('Codex was stopped.'));
    child.kill();
  }

  /** Stops it from outside: when idle, or as Lasso closes. A start under way gives up rather than trying again. */
  stop() {
    this.stops += 1;
    this.halt();
  }

  /** Stops the process once nothing has been written for a while. */
  restAfterUse() {
    clearTimeout(this.idleTimer);
    if (!this.child || this.threads.size) return;
    this.idleTimer = setTimeout(() => this.stop(), this.idleMs);
    this.idleTimer.unref?.();
  }

  /**
   * Writes an answer to `prompt`. `onText` is given the answer as it arrives;
   * `callTool(name, arguments)` answers the tools declared in `tools`, and
   * `onTool(name, arguments)` is told as each is called. `signal` stops it.
   * Resolves when the answer is complete, rejects with a WriterError otherwise.
   */
  async write({ instructions, tools = [], prompt, onText, callTool, onTool = () => {}, signal }) {
    clearTimeout(this.idleTimer);
    await this.ready();
    clearTimeout(this.idleTimer);
    if (signal?.aborted) {
      this.restAfterUse();
      throw new WriterError('Stopped.', { code: 'writer-stopped' });
    }
    let started;
    try {
      started = await this.startThread(instructions, tools);
    } catch (error) {
      this.restAfterUse();
      throw error;
    }
    return this.answer(started.thread.id, { prompt, onText, callTool, onTool, signal });
  }

  startThread(instructions, tools) {
    return this.request('thread/start', {
      cwd: this.workingDirectory, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never',
      baseInstructions: instructions,
      dynamicTools: tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
      config: { model_reasoning_effort: this.effort },
      ...(this.writingModel ? { model: this.writingModel } : {}),
    });
  }

  /** One turn on a started thread: the prompt in, the answer out through `onText`. */
  async answer(threadId, { prompt, onText, callTool, onTool, signal }) {
    let turnId = null;
    let stopped = false;
    let settle;
    const finished = new Promise((resolve) => { settle = resolve; });
    // Words said before a tool call ("I'll look that up") are not the answer.
    const commentary = new Set();
    let lastError = null;
    this.threads.set(threadId, {
      callTool: (name, input) => { onTool(name, input); return callTool(name, input); },
      failed: (error) => settle({ status: 'failed', message: error.message }),
      notified: (method, params) => {
        if (method === 'item/started' && params.item?.type === 'agentMessage' && params.item.phase === 'commentary') commentary.add(params.item.id);
        else if (method === 'item/agentMessage/delta' && !commentary.has(params.itemId)) onText(params.delta);
        else if (method === 'error' && !params.willRetry) lastError = params.error?.message ?? lastError;
        else if (method === 'turn/completed') settle({ status: params.turn?.status, message: params.turn?.error?.message ?? lastError });
      },
    });
    const interrupt = () => {
      stopped = true;
      if (turnId) this.request('turn/interrupt', { threadId, turnId }).catch(() => {});
      // A turn that never says it stopped is taken as stopped.
      setTimeout(() => settle({ status: 'interrupted' }), INTERRUPT_WAIT_MS).unref?.();
    };
    signal?.addEventListener('abort', interrupt, { once: true });
    try {
      const turn = await this.request('turn/start', { threadId, input: [{ type: 'text', text: prompt }] });
      turnId = turn.turn?.id ?? null;
      if (stopped) interrupt();
      const outcome = await finished;
      if (stopped || outcome.status === 'interrupted') throw new WriterError('Stopped.', { code: 'writer-stopped' });
      if (outcome.status !== 'completed') {
        throw new WriterError(outcome.message ? `ChatGPT could not write this: ${outcome.message}` : 'ChatGPT could not write this.');
      }
    } catch (error) {
      if (error instanceof WriterError) throw error;
      throw new WriterError(stopped ? 'Stopped.' : `ChatGPT could not write this: ${error.message}`, { code: stopped ? 'writer-stopped' : 'writer-failed' });
    } finally {
      signal?.removeEventListener('abort', interrupt);
      this.threads.delete(threadId);
      if (this.child) this.request('thread/unsubscribe', { threadId }).catch(() => {});
      this.restAfterUse();
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.idleTimer);
    this.stop();
  }
}
