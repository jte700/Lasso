// TerminalCommandParser.
//
// Splits a line into a command, its positional arguments and its flags. It
// knows nothing about what any command means — a command that does not accept
// a flag is the executor's problem, not the parser's.

const DURATION_UNITS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

/** Splits on whitespace, honouring single and double quotes. */
export function tokenize(input) {
  const source = String(input ?? '');
  const output = [];
  let current = '';
  let quote = null;
  let started = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; started = true; continue; }
    if (/\s/.test(character)) {
      if (started) { output.push(current); current = ''; started = false; }
      continue;
    }
    current += character;
    started = true;
  }
  if (started) output.push(current);
  return output;
}

/**
 * `30d`, `7d`, `24h`, `yesterday`, `today`, `2026-08-19` → epoch milliseconds,
 * or null when the value is not a time the terminal understands.
 */
export function parseSince(value, reference = Date.now()) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'today') {
    const start = new Date(reference);
    start.setHours(0, 0, 0, 0);
    return start.getTime();
  }
  if (raw === 'yesterday') {
    const start = new Date(reference);
    start.setDate(start.getDate() - 1);
    start.setHours(0, 0, 0, 0);
    return start.getTime();
  }
  const duration = raw.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/);
  if (duration) return reference - Number(duration[1]) * DURATION_UNITS[duration[2]];
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Same vocabulary, expressed as a window rather than an instant. */
export function parseDuration(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  const duration = raw.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/);
  if (duration) return Number(duration[1]) * DURATION_UNITS[duration[2]];
  return null;
}

/**
 * `find revenue --source xlsx --updated 30d` becomes
 * `{ name: 'find', args: ['revenue'], flags: { source: 'xlsx', updated: '30d' } }`.
 *
 * A flag with no value is `true`; `--flag=value` and `--flag value` are the
 * same. `--` ends flag parsing, so a literal `--x` can be searched for.
 */
export function parseCommand(input, booleanFlags = new Set()) {
  const tokens = tokenize(input);
  const raw = String(input ?? '').trim();
  if (!tokens.length) return { empty: true, name: '', args: [], flags: {}, raw, rest: '' };
  const [name, ...rest] = tokens;
  const args = [];
  const flags = {};
  let literal = false;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (literal || !token.startsWith('--')) { args.push(token); continue; }
    if (token === '--') { literal = true; continue; }
    const body = token.slice(2);
    const equals = body.indexOf('=');
    if (equals >= 0) {
      flags[body.slice(0, equals)] = body.slice(equals + 1);
      continue;
    }
    const next = rest[index + 1];
    // A flag known to take no value leaves the following word alone, so
    // `changes --unresolved --since 7d` and `find --all revenue` both parse.
    if (next !== undefined && !next.startsWith('--') && !booleanFlags.has(body)) {
      flags[body] = next;
      index += 1;
    } else {
      flags[body] = true;
    }
  }
  // The text after the command name, unsplit — `ask` and `rules add` want it whole.
  const afterName = raw.slice(raw.indexOf(name) + name.length).trim();
  return { empty: false, name: name.toLowerCase(), args, flags, raw, rest: afterName };
}

/**
 * Where the caret sits in a partially typed line, so completion knows whether
 * to offer command names, dependency names, or flags.
 */
export function completionContext(input, booleanFlags = new Set()) {
  const source = String(input ?? '');
  const trailingSpace = /\s$/.test(source);
  const tokens = tokenize(source);
  const base = { position: 'command', fragment: '', command: null, flag: null, argIndex: 0 };
  if (!tokens.length) return base;
  const command = tokens[0].toLowerCase();
  if (tokens.length === 1 && !trailingSpace) return { ...base, fragment: tokens[0] };
  const fragment = trailingSpace ? '' : tokens.at(-1);
  if (fragment.startsWith('--')) {
    return { position: 'flag', fragment: fragment.slice(2), command, flag: null, argIndex: 0 };
  }

  const preceding = trailingSpace ? tokens.slice(1) : tokens.slice(1, -1);
  const takesValue = (token) => token?.startsWith('--') && !token.includes('=')
    && !booleanFlags.has(token.slice(2));

  // The word right before the caret may be a flag still waiting for its value.
  if (takesValue(preceding.at(-1))) {
    return { position: 'flagValue', fragment, command, flag: preceding.at(-1).slice(2), argIndex: 0 };
  }

  const argIndex = preceding.filter((token, index) => !token.startsWith('--')
    && !takesValue(preceding[index - 1])).length;
  return { position: 'argument', fragment, command, flag: null, argIndex };
}
