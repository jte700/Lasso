#!/usr/bin/env node
// Claude Code runs this on its hooks (installed by `lasso hooks install`):
// before and after each file edit and command, and on each prompt. It writes
// one line per event to a spool beside the Lasso library, which Lasso reads
// to know which words Claude wrote: for a file edit, the file's text before
// and after; for a command, when it ran; for a prompt, its words. It reads
// only the folders Lasso follows, never blocks Claude (it always exits 0),
// and does nothing when there is no Lasso library on this computer.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const LONGEST_FILE = 4 * 1024 * 1024;
/** A spool this large is left alone: Lasso has not read it for a long while. */
const LARGEST_SPOOL = 64 * 1024 * 1024;
const TRANSCRIPT_TAIL = 256 * 1024;

/** The library a hook writes beside: LASSO_DATA_DIR, else the Mac or Windows app's; null when there is none. */
export function libraryFolder(env = process.env, home = os.homedir(), platform = process.platform) {
  const named = env.LASSO_DATA_DIR ?? env.COLAB_DRY_DATA_DIR;
  const candidates = named ? [path.resolve(named)] : [
    platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Lasso', 'data') : null,
    platform === 'win32' && env.APPDATA ? path.join(env.APPDATA, 'Lasso', 'data') : null,
  ].filter(Boolean);
  return candidates.find((folder) => fs.existsSync(path.join(folder, 'timeline.sqlite'))) ?? null;
}

/** The folders Lasso follows, read from its library without changing it. */
async function followedFolders(library) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(library, 'timeline.sqlite'), { readOnly: true });
    try {
      return db.prepare('SELECT root_path FROM projects').all().map((row) => {
        try { return fs.realpathSync(row.root_path); } catch { return path.resolve(row.root_path); }
      });
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/** A file's text and hash: '' for a file not there yet, null text for one too large or not text. */
function fileNow(file) {
  let bytes;
  try { bytes = fs.readFileSync(file); } catch (error) { return error.code === 'ENOENT' ? { text: '', hash: null } : null; }
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (bytes.length > LONGEST_FILE || bytes.subarray(0, 8192).includes(0)) return { text: null, hash };
  return { text: bytes.toString('utf8'), hash };
}

/** The model the session's last answer came from, read from the end of its transcript. */
function modelOf(transcript) {
  if (typeof transcript !== 'string' || !transcript) return null;
  try {
    const handle = fs.openSync(transcript, 'r');
    try {
      const size = fs.fstatSync(handle).size;
      const length = Math.min(size, TRANSCRIPT_TAIL);
      const buffer = Buffer.alloc(length);
      fs.readSync(handle, buffer, 0, length, size - length);
      const found = [...buffer.toString('utf8').matchAll(/"model"\s*:\s*"([^"]{3,80})"/g)];
      return found.at(-1)?.[1] ?? null;
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return null;
  }
}

/** The spool line one hook event writes, or null when the event concerns nothing Lasso follows. */
export async function spoolLine(input, { library, now = new Date() }) {
  const event = input?.hook_event_name;
  const base = { v: 1, at: now.toISOString(), agent: 'Claude', tool: 'Claude Code', session: input?.session_id ?? null };
  if (event === 'UserPromptSubmit') {
    return { ...base, event: 'prompt', prompt: String(input.prompt ?? '').slice(0, 4000), model: modelOf(input.transcript_path) };
  }
  if (event !== 'PreToolUse' && event !== 'PostToolUse') return null;
  const toolName = input.tool_name;
  const phase = event === 'PreToolUse' ? 'pre' : 'post';
  const key = input.tool_use_id ?? crypto.createHash('sha1')
    .update(`${input.session_id}\n${toolName}\n${JSON.stringify(input.tool_input ?? {})}`).digest('hex');
  const model = phase === 'pre' ? modelOf(input.transcript_path) : null;
  if (toolName === 'Bash') {
    return { ...base, event: phase, key, toolName, model, cwd: input.cwd ?? null,
      command: phase === 'pre' ? String(input.tool_input?.command ?? '').slice(0, 4000) : undefined };
  }
  if (!FILE_TOOLS.has(toolName)) return null;
  const named = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (typeof named !== 'string' || !named) return null;
  let file = path.resolve(input.cwd ?? process.cwd(), named);
  try { file = fs.realpathSync(file); } catch { /* not written yet */ }
  const folders = await followedFolders(library);
  if (!folders.some((root) => file.startsWith(`${root}${path.sep}`))) return null;
  const current = fileNow(file);
  if (!current) return null;
  return { ...base, event: phase, key, toolName, model, path: file, text: current.text, hash: current.hash };
}

/** Appends a line to the spool, as one write. */
export function appendToSpool(library, line) {
  const folder = path.join(library, 'ai-hooks');
  fs.mkdirSync(folder, { recursive: true });
  const spool = path.join(folder, 'spool.jsonl');
  try { if (fs.statSync(spool).size > LARGEST_SPOOL) return false; } catch { /* none yet */ }
  fs.appendFileSync(spool, `${JSON.stringify(line)}\n`);
  return true;
}

async function readInput(stdin) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export async function runHook({ stdin = process.stdin, env = process.env } = {}) {
  try {
    const library = libraryFolder(env);
    if (!library) return 0;
    const line = await spoolLine(await readInput(stdin), { library });
    if (line) appendToSpool(library, line);
  } catch {
    // A hook that fails must not stop Claude; the edit simply goes unrecorded.
  }
  return 0;
}

const isEntryPoint = process.argv[1] && (() => {
  try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]); } catch { return false; }
})();
if (isEntryPoint) runHook().then((code) => process.exit(code));
