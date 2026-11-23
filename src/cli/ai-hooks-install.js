// `lasso hooks install | remove | status`: Lasso's hook in Claude Code's own
// settings (~/.claude/settings.json), so Lasso records what Claude writes
// into the folders it follows. Other hooks there are left as they are; a copy
// of the settings is kept beside them before the first change.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_SCRIPT = fileURLToPath(new URL('./ai-hook.js', import.meta.url));
const MARKER = 'ai-hook.js';
const EDITING_TOOLS = 'Write|Edit|MultiEdit|NotebookEdit|Bash';
const EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit'];

export function claudeSettingsPath(home = os.homedir()) {
  return path.join(home, '.claude', 'settings.json');
}

/** The command Claude Code runs: this Node and this checkout's (or app's) hook script. */
export function hookCommand({ node = process.execPath, script = HOOK_SCRIPT } = {}) {
  return `"${node}" --disable-warning=ExperimentalWarning "${script}"`;
}

function readSettings(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch {
    throw new Error(`${file} is not valid JSON, so Lasso left it alone. Fix it, then run this again.`);
  }
}

function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const backup = `${file}.before-lasso`;
  if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
  const temporary = `${file}.lasso-${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

const ours = (entry) => (entry?.hooks ?? []).some((hook) => String(hook?.command ?? '').includes(MARKER));

/** The settings without Lasso's hook entries. */
export function withoutLasso(settings) {
  const next = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  for (const event of EVENTS) {
    if (!Array.isArray(next.hooks[event])) continue;
    next.hooks[event] = next.hooks[event].filter((entry) => !ours(entry));
    if (!next.hooks[event].length) delete next.hooks[event];
  }
  if (!Object.keys(next.hooks).length) delete next.hooks;
  return next;
}

/** The settings with Lasso's hook on file edits, commands and prompts, once. */
export function withLasso(settings, command = hookCommand()) {
  const next = withoutLasso(settings);
  next.hooks = { ...(next.hooks ?? {}) };
  const hook = { type: 'command', command, timeout: 10 };
  next.hooks.PreToolUse = [...(next.hooks.PreToolUse ?? []), { matcher: EDITING_TOOLS, hooks: [hook] }];
  next.hooks.PostToolUse = [...(next.hooks.PostToolUse ?? []), { matcher: EDITING_TOOLS, hooks: [hook] }];
  next.hooks.UserPromptSubmit = [...(next.hooks.UserPromptSubmit ?? []), { hooks: [hook] }];
  return next;
}

export function hookStatus(settings) {
  const entries = EVENTS.flatMap((event) => (settings.hooks?.[event] ?? []).filter(ours));
  const command = entries[0]?.hooks?.find((hook) => String(hook.command).includes(MARKER))?.command ?? null;
  const script = command?.match(/"([^"]*ai-hook\.js)"/)?.[1] ?? null;
  return { installed: entries.length === EVENTS.length, partial: entries.length > 0 && entries.length < EVENTS.length,
    command, scriptFound: script ? fs.existsSync(script) : false };
}

/** Whether Lasso's hook is in Claude Code's settings, for `/status`; null when the settings cannot be read. */
export function hookState({ home = os.homedir() } = {}) {
  try { return hookStatus(readSettings(claudeSettingsPath(home))); } catch { return null; }
}

/** Runs `lasso hooks <action>`; returns { code, text }. */
export function runHooksCommand(action = 'status', { home = os.homedir() } = {}) {
  const file = claudeSettingsPath(home);
  try {
    if (action === 'install') {
      writeSettings(file, withLasso(readSettings(file)));
      return { code: 0, text: `Lasso now records what Claude Code writes into your Lasso folders.\nHook added to ${file}. Claude Code picks it up in new sessions.` };
    }
    if (action === 'remove') {
      const settings = readSettings(file);
      if (!hookStatus(settings).installed && !hookStatus(settings).partial) return { code: 0, text: 'Lasso\'s hook was not in Claude Code\'s settings.' };
      writeSettings(file, withoutLasso(settings));
      return { code: 0, text: `Lasso's hook was taken out of ${file}.` };
    }
    if (action === 'status') {
      const status = hookStatus(readSettings(file));
      if (status.installed && status.scriptFound) return { code: 0, text: 'Claude Code: Lasso records what Claude writes.' };
      if (status.installed) return { code: 1, text: 'Claude Code: Lasso\'s hook is set, but its script has moved. Run `lasso hooks install` again.' };
      return { code: 1, text: 'Claude Code: not recorded. Run `lasso hooks install` to record what Claude writes into your Lasso folders.' };
    }
    return { code: 2, text: 'Usage: lasso hooks install | remove | status' };
  } catch (error) {
    return { code: 1, text: error.message };
  }
}
