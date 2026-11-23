// Records of what an AI wrote, as each tool reported it at the time: Claude
// Code's hooks leave a line per event in a spool beside the library (the hook
// never opens the database, so it is quick and works while Lasso is closed),
// and the Mac app reports what its writer typed and what was pasted from an
// AI app. Nothing here judges words: a mark is only ever what a tool said it
// wrote, waiting for a save of the file that holds it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../history/errors.js';

/** A spool of hook events, appended by src/cli/ai-hook.js. */
export const SPOOL_FOLDER = 'ai-hooks';
export const SPOOL_FILE = 'spool.jsonl';

/** Who did the asking when a person's own tool reports an AI's write. */
export const PERSON = Object.freeze({ id: 'human:desktop', displayName: 'Desktop', actorType: 'HUMAN_SELF' });

const KNOWN_AGENTS = new Map([
  ['claude', 'Claude'], ['chatgpt', 'ChatGPT'], ['codex', 'ChatGPT'], ['openai', 'ChatGPT'],
  ['gemini', 'Gemini'], ['copilot', 'Copilot'], ['perplexity', 'Perplexity'], ['mistral', 'Mistral'], ['grok', 'Grok'],
]);

/** The actor an AI's name stands for: agent:claude for "Claude", one of its own for a name Lasso does not know. */
export function agentActor(name) {
  const said = String(name ?? '').trim();
  if (!said) throw new HttpError(400, 'Which AI wrote it is required.');
  const key = said.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const known = [...KNOWN_AGENTS].find(([prefix]) => key.startsWith(prefix));
  const displayName = known ? known[1] : said.slice(0, 40);
  return { id: `agent:${displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, displayName, actorType: 'AI_AGENT' };
}

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const LONGEST_TEXT = 200_000;
const DAY = 24 * 60 * 60 * 1000;
/** Words typed or pasted wait this long for a save; a hook's edit or command a day. */
const TYPED_WAIT = 7 * DAY;
const HOOK_WAIT = DAY;
/** A file written this long either side of a command's run still counts as written by it. */
const COMMAND_SLACK_MS = 1500;

const clip = (text, length = LONGEST_TEXT) => (text == null ? null : String(text).slice(0, length));

export class AiMarks {
  constructor({ db, timeline, config }) {
    this.db = db;
    this.timeline = timeline;
    this.spoolDir = path.join(config.dataDir, SPOOL_FOLDER);
  }

  /** The folder and path inside it that hold an absolute path, or null. */
  locate(absolute) {
    if (typeof absolute !== 'string' || !path.isAbsolute(absolute)) return null;
    let target = path.resolve(absolute);
    try { target = fs.realpathSync(target); } catch { /* a file not written yet */ }
    for (const project of this.timeline.listProjects()) {
      let root = path.resolve(project.rootPath);
      try { root = fs.realpathSync(root); } catch { /* a drive away */ }
      if (target.startsWith(`${root}${path.sep}`)) {
        return { project, path: path.relative(root, target).split(path.sep).join('/'), absolute: target };
      }
    }
    return null;
  }

  // ── what the Mac app reports ─────────────────────────────────────────

  /** Words the writer typed or a paste brought in: { kind, agent, model, tool, prompt, text, hostApp, documentPath }. */
  record(input) {
    const kind = input?.kind;
    if (!['writer', 'paste'].includes(kind)) throw new HttpError(400, 'A mark is a writer\'s answer or a paste.');
    const text = typeof input.text === 'string' ? input.text : '';
    if (!text.trim()) throw new HttpError(400, 'The words written are required.');
    const agent = this.timeline.upsertActor(agentActor(input.agent));
    const person = this.timeline.upsertActor(PERSON);
    const located = input.documentPath ? this.locate(input.documentPath) : null;
    const mark = {
      id: id(), kind, agent: agent.id, person: person.id, model: clip(input.model, 80), tool: clip(input.tool, 80),
      prompt: clip(input.prompt, 4000), hostApp: clip(input.hostApp, 120),
      documentPath: located?.absolute ?? clip(input.documentPath, 2000), projectId: located?.project.id ?? null,
      path: located?.path ?? null, text: clip(text), at: now(),
    };
    this.db.prepare(`
      INSERT INTO ai_marks(id, kind, agent_actor_id, initiated_by_actor_id, model, tool, prompt, host_app, document_path,
        project_id, path, text, started_at, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(mark.id, mark.kind, mark.agent, mark.person, mark.model, mark.tool, mark.prompt, mark.hostApp, mark.documentPath,
      mark.projectId, mark.path, mark.text, mark.at, mark.at);
    return { id: mark.id, kind, agent, projectId: mark.projectId, path: mark.path };
  }

  // ── what Claude Code's hooks report ──────────────────────────────────

  /**
   * Reads the hook spool and records its events. The spool is moved aside
   * first, so lines appended while it is read go to a new one. Returns the
   * edits whose after-text arrived, for a save recorded before them.
   */
  ingest() {
    let names;
    try { names = fs.readdirSync(this.spoolDir); } catch { return []; }
    if (!names.includes(SPOOL_FILE) && !names.some((name) => name.endsWith('.reading'))) return [];
    if (names.includes(SPOOL_FILE)) {
      try { fs.renameSync(path.join(this.spoolDir, SPOOL_FILE), path.join(this.spoolDir, `${Date.now()}-${process.pid}.reading`)); }
      catch { /* another reader took it */ }
    }
    const finished = [];
    for (const name of fs.readdirSync(this.spoolDir).filter((entry) => entry.endsWith('.reading')).sort()) {
      const file = path.join(this.spoolDir, name);
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        try {
          const done = this.hookEvent(event);
          if (done) finished.push(done);
        } catch (error) {
          console.warn(`An AI hook event was not recorded: ${error.message}`);
        }
      }
      fs.rmSync(file, { force: true });
    }
    this.forgetStale();
    return finished;
  }

  hookEvent(event) {
    const at = typeof event.at === 'string' ? event.at : now();
    const session = typeof event.session === 'string' ? event.session : null;
    if (event.event === 'prompt') {
      if (!session) return null;
      this.db.prepare(`INSERT INTO ai_hook_sessions(session_id, prompt, model, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET prompt = excluded.prompt, model = COALESCE(excluded.model, ai_hook_sessions.model),
          updated_at = excluded.updated_at`).run(session, clip(event.prompt, 4000), clip(event.model, 80), at);
      return null;
    }
    const key = typeof event.key === 'string' ? event.key : null;
    if (!key) return null;
    if (event.event === 'pre') return this.hookStarted(event, { at, session, key });
    if (event.event === 'post') return this.hookFinished(event, { at, session, key });
    return null;
  }

  hookStarted(event, { at, session, key }) {
    const known = session ? this.db.prepare('SELECT prompt, model FROM ai_hook_sessions WHERE session_id = ?').get(session) : null;
    const agent = this.timeline.upsertActor(agentActor(event.agent ?? 'Claude'));
    const person = this.timeline.upsertActor(PERSON);
    const shared = [agent.id, person.id, clip(event.model, 80) ?? known?.model ?? null, clip(event.tool, 80) ?? 'Claude Code',
      known?.prompt ?? null, key, session, at];
    if (event.toolName === 'Bash') {
      this.db.prepare(`INSERT INTO ai_marks(id, kind, agent_actor_id, initiated_by_actor_id, model, tool, prompt, hook_key,
          session_id, started_at, command, cwd) VALUES (?, 'command', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id(), ...shared, clip(event.command, 4000), clip(event.cwd, 2000));
      return null;
    }
    const located = this.locate(event.path);
    if (!located) return null;
    this.db.prepare(`INSERT INTO ai_marks(id, kind, agent_actor_id, initiated_by_actor_id, model, tool, prompt, hook_key,
        session_id, started_at, project_id, path, document_path, before_text, before_hash)
      VALUES (?, 'edit', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id(), ...shared, located.project.id, located.path, located.absolute,
        typeof event.text === 'string' ? event.text : null, clip(event.hash, 80));
    return null;
  }

  hookFinished(event, { at, session, key }) {
    const started = this.db.prepare('SELECT id, kind FROM ai_marks WHERE hook_key = ? AND ended_at IS NULL').get(key);
    const after = typeof event.text === 'string' ? event.text : null;
    if (started) {
      this.db.prepare(`UPDATE ai_marks SET ended_at = ?, after_text = ?, after_hash = ?, model = COALESCE(?, model) WHERE id = ?`)
        .run(at, after, clip(event.hash, 80), clip(event.model, 80), started.id);
      return started.kind === 'edit' ? this.mark(started.id) : null;
    }
    // A finish with no start (the hook was installed mid-edit): the edit is recorded from what came before it.
    if (event.toolName === 'Bash' || after == null) return null;
    this.hookStarted({ ...event, text: null, hash: null }, { at, session, key });
    return this.hookFinished(event, { at, session, key });
  }

  /** Marks nothing claimed in time, which no save will claim now. */
  forgetStale() {
    const typed = new Date(Date.now() - TYPED_WAIT).toISOString();
    const hooked = new Date(Date.now() - HOOK_WAIT).toISOString();
    this.db.prepare(`DELETE FROM ai_marks WHERE matched_at IS NULL AND (
      (kind IN ('writer', 'paste') AND started_at < ?) OR (kind IN ('edit', 'command') AND started_at < ?))`).run(typed, hooked);
  }

  // ── what a save is checked against ───────────────────────────────────

  mark(markId) {
    return this.db.prepare('SELECT * FROM ai_marks WHERE id = ?').get(markId) ?? null;
  }

  /** Claude Code's finished edits of one file no save has held yet, oldest first. */
  edits(projectId, filePath) {
    return this.db.prepare(`SELECT * FROM ai_marks WHERE kind = 'edit' AND matched_at IS NULL AND ended_at IS NOT NULL
      AND project_id = ? AND path = ? ORDER BY started_at, rowid`).all(projectId, filePath);
  }

  /** The command that was running when a file was written there, if Claude Code ran one. */
  commandFor(absolute, modifiedMs) {
    if (!Number.isFinite(modifiedMs)) return null;
    const from = new Date(modifiedMs - COMMAND_SLACK_MS - HOOK_WAIT).toISOString();
    const candidates = this.db.prepare(`SELECT * FROM ai_marks WHERE kind = 'command' AND ended_at IS NOT NULL
      AND started_at >= ? ORDER BY started_at DESC`).all(from);
    const name = path.basename(absolute);
    return candidates.find((mark) => {
      const start = Date.parse(mark.started_at) - COMMAND_SLACK_MS;
      const end = Date.parse(mark.ended_at) + COMMAND_SLACK_MS;
      if (!(modifiedMs >= start && modifiedMs <= end)) return false;
      const inside = mark.cwd && absolute.startsWith(`${path.resolve(mark.cwd)}${path.sep}`);
      return inside || String(mark.command ?? '').includes(name);
    }) ?? null;
  }

  /** Words typed or pasted that a save of this file could hold, latest first: words pasted again are the latest paste's. */
  typed(absolute) {
    return this.db.prepare(`SELECT * FROM ai_marks WHERE kind IN ('writer', 'paste') AND matched_at IS NULL
      AND (document_path IS NULL OR document_path = ?) ORDER BY started_at DESC, rowid DESC`).all(absolute);
  }

  /** A mark for a save an AI made itself, as Review Changes records ChatGPT's edits. */
  forAgentEvent(event) {
    const existing = this.db.prepare(`SELECT * FROM ai_marks WHERE kind = 'agent' AND hook_key = ?`).get(`event:${event.id}`);
    if (existing) return existing;
    const request = event.agentExecutionId
      ? this.db.prepare('SELECT request_text FROM agent_executions WHERE id = ?').get(event.agentExecutionId)?.request_text ?? null
      : null;
    const markId = id();
    this.db.prepare(`INSERT INTO ai_marks(id, kind, agent_actor_id, initiated_by_actor_id, tool, prompt, hook_key, started_at, ended_at)
      VALUES (?, 'agent', ?, ?, 'Lasso', ?, ?, ?, ?)`)
      .run(markId, event.actor.id, event.initiatedBy?.id ?? null, request, `event:${event.id}`, event.occurredAt, event.occurredAt);
    return this.mark(markId);
  }

  matched(markId, snapshotId, written) {
    this.db.prepare(`UPDATE ai_marks SET matched_at = COALESCE(matched_at, ?), matched_snapshot_id = COALESCE(matched_snapshot_id, ?),
      written_chars = COALESCE(written_chars, ?) WHERE id = ?`).run(now(), snapshotId, written, markId);
  }
}
