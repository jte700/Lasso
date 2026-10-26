// Colours for code: keywords, strings, numbers, comments, types, calls and
// the names a line declares, as Xcode's default themes draw them. The
// languages and colours are code-syntax.json, which the Mac app reads too
// (desktop/CodeSyntax.swift), so a file looks alike in the suggestion card,
// The Ranch and the source inspector. Both read text as UTF-16 code units,
// step for step alike, and must agree on every token;
// test/fixtures/code-syntax-cases.json holds them to it.

import CATALOG from './code-syntax.json' with { type: 'json' };

const NEWLINE = 10;
const STAR = 42;
const PLUS = 43;
const MINUS = 45;
const DOT = 46;
const ZERO = 48;
const LESS = 60;
const GREATER = 62;
const BACKSLASH = 92;
const PAREN = 40;
const BRACE = 123;
/** Starting a line (-1) or one of `{ , - ( ;`: what may come before a key. */
const KEY_OPENERS = new Set([-1, 123, 44, 45, 40, 59]);
/** `/`, `!` and `?`, which may follow a tag's `<`. */
const TAG_MARKS = new Set([47, 33, 63]);

const words = (list, ignoreCase) => new Set(String(list ?? '').split(/\s+/).filter(Boolean)
  .map((word) => (ignoreCase ? word.toLowerCase() : word)));
const codes = (text) => new Set([...String(text ?? '')].map((character) => character.charCodeAt(0)));
const longestFirst = (left, right) => right.length - left.length;

function compile(definition) {
  const ignoreCase = definition.ignoreCase === true;
  return {
    name: definition.name,
    extensions: new Set(definition.extensions ?? []),
    fileNames: new Set(definition.fileNames ?? []),
    lineComments: definition.lineComments ?? [],
    blockComments: definition.blockComments ?? [],
    // Longest first, so """ is not read as an empty "" and a quote.
    strings: [...(definition.strings ?? [])].sort((left, right) => longestFirst(left.delimiter, right.delimiter)),
    stringPrefixes: codes(definition.stringPrefixes),
    keywords: words(definition.keywords, ignoreCase),
    types: words(definition.types, ignoreCase),
    typesAfter: codes(definition.typesAfter),
    declarators: words(definition.declarators, ignoreCase),
    capitalizedTypes: definition.capitalizedTypes === true,
    ignoreCase,
    identifierSymbols: codes(definition.identifierSymbols),
    attributePrefixes: definition.attributePrefixes ?? [],
    directiveLines: definition.directiveLines ?? [],
    variablePrefixes: [...(definition.variablePrefixes ?? [])].sort(longestFirst),
    keySeparators: codes((definition.keySeparators ?? []).join('')),
    markup: definition.markup === true,
  };
}

const LANGUAGES = CATALOG.languages.map(compile);

/** The language a file is written in, from its name or extension, or null for prose and data Lasso doesn't colour. */
export function codeLanguage(fileName) {
  const name = String(fileName ?? '').split(/[\\/]/).pop().toLowerCase();
  const dot = name.lastIndexOf('.');
  const extension = dot >= 0 ? name.slice(dot + 1) : '';
  return LANGUAGES.find((language) => language.fileNames.has(name))
    ?? (extension ? LANGUAGES.find((language) => language.extensions.has(extension)) : undefined)
    ?? null;
}

const isDigit = (unit) => unit >= 48 && unit <= 57;
// Letters, `_`, and anything past ASCII, so a name in any script stays whole.
const isLetter = (unit) => (unit >= 65 && unit <= 90) || (unit >= 97 && unit <= 122) || unit === 95 || unit >= 128;
const isSpace = (unit) => unit === 32 || unit === 9 || unit === 13;
const isCapitalized = (word) => /^[A-Z]/.test(word) && /[a-z]/.test(word);

/** Reads one text from start to end, noting what each stretch is. */
class CodeReader {
  constructor(source, language) {
    this.source = source;
    this.length = source.length;
    this.language = language;
    this.tokens = [];
    /** After `def`, `let mut` or `export function`, the next name is the one declared. */
    this.declaring = false;
    /** In markup, between a tag's `<` and `>`. */
    this.inTag = false;
  }

  read() {
    let index = 0;
    let lineStart = true;
    while (index < this.length) {
      const unit = this.unit(index);
      if (unit === NEWLINE) { lineStart = true; this.declaring = false; index += 1; continue; }
      if (isSpace(unit)) { index += 1; continue; }
      const firstOnLine = lineStart;
      lineStart = false;
      index = this.comment(index) ?? this.directive(index, firstOnLine) ?? this.string(index)
        ?? (this.language.markup ? this.markup(index) : this.code(index));
    }
    return this.tokens;
  }

  code(index) {
    return this.variable(index) ?? this.attribute(index) ?? this.number(index) ?? this.word(index) ?? this.punctuation(index);
  }

  comment(index) {
    const block = this.language.blockComments.find(([open]) => this.startsWith(open, index));
    if (block) {
      const close = this.source.indexOf(block[1], index + block[0].length);
      return this.push(index, close < 0 ? this.length : close + block[1].length, 'comment');
    }
    return this.language.lineComments.some((marker) => this.startsWith(marker, index))
      ? this.push(index, this.endOfLine(index), 'comment') : null;
  }

  directive(index, firstOnLine) {
    return firstOnLine && this.language.directiveLines.some((marker) => this.startsWith(marker, index))
      ? this.push(index, this.endOfLine(index), 'directive') : null;
  }

  string(index) {
    // In markup, quotes are strings only inside a tag; between tags they are prose.
    if (this.language.markup && !this.inTag) return null;
    const string = this.stringAt(index);
    if (!string) return null;
    const end = this.scanString(index, string);
    return this.push(index, end, this.isKey(index, end) ? 'variable' : 'string');
  }

  markup(index) {
    const unit = this.unit(index);
    if (unit === LESS) {
      const start = index + (TAG_MARKS.has(this.unit(index + 1)) ? 2 : 1);
      if (isLetter(this.unit(start))) {
        this.inTag = true;
        return this.push(start, this.scanName(start), 'keyword');
      }
    } else if (unit === GREATER) {
      this.inTag = false;
    } else if (this.inTag && isLetter(unit)) {
      return this.push(index, this.scanName(index), 'variable');
    }
    return index + 1;
  }

  /** `$name`, `${name}`, `$(name)`, `@ivar`: the whole reference. */
  variable(index) {
    const prefix = this.language.variablePrefixes.find((marker) => this.startsWith(marker, index));
    if (!prefix) return null;
    const after = index + prefix.length;
    const open = this.unit(after);
    if (open === BRACE || open === PAREN) {
      const close = this.source.indexOf(open === BRACE ? '}' : ')', after);
      const line = this.endOfLine(after);
      return this.push(index, close < 0 || close > line ? line : close + 1, 'variable');
    }
    return this.isIdentifier(open) ? this.push(index, this.scanName(after), 'variable') : null;
  }

  /** `@dataclass`, `@functools.wraps`, `#selector`. */
  attribute(index) {
    const prefix = this.language.attributePrefixes.find((marker) => this.startsWith(marker, index));
    if (!prefix || !this.isIdentifierStart(this.unit(index + prefix.length))) return null;
    let end = index + prefix.length;
    while (this.isIdentifier(this.unit(end)) || (this.unit(end) === DOT && this.isIdentifierStart(this.unit(end + 1)))) end += 1;
    return this.push(index, end, 'directive');
  }

  /** 42, 3.5, .5, 1_000, 0xFF, 1e-9, 640px. */
  number(index) {
    const unit = this.unit(index);
    if (!isDigit(unit) && !(unit === DOT && isDigit(this.unit(index + 1)) && !this.isIdentifier(this.previous(index)))) return null;
    const hex = unit === ZERO && (this.unit(index + 1) | 32) === 120; // 0x or 0X
    let end = index + 1;
    let dotted = unit === DOT;
    while (end < this.length) {
      const next = this.unit(end);
      if (isLetter(next) || isDigit(next)) { end += 1; continue; }
      if (next === DOT && !dotted && isDigit(this.unit(end + 1))) { dotted = true; end += 1; continue; }
      // An exponent's sign: 1e-9, 2.5E+3.
      const exponent = (this.unit(end - 1) | 32) === 101;
      if ((next === PLUS || next === MINUS) && exponent && !hex && isDigit(this.unit(end + 1))) { end += 1; continue; }
      break;
    }
    return this.push(index, end, 'number');
  }

  word(index) {
    if (!this.isIdentifierStart(this.unit(index))) return null;
    const end = this.scanName(index + 1);
    // Python's f"…" and r'…': the prefix belongs to the string.
    const prefixed = this.stringPrefixAt(index, end);
    if (prefixed) {
      this.declaring = false;
      return this.push(index, this.scanString(end, prefixed), 'string');
    }
    const kind = this.classify(index, end);
    if (kind) this.push(index, end, kind);
    return end;
  }

  classify(index, end) {
    const language = this.language;
    const word = this.source.slice(index, end);
    const lookup = language.ignoreCase ? word.toLowerCase() : word;
    let kind = null;
    if (this.isKey(index, end)) kind = 'variable';
    // After a dot it is a member, such as `.type` or `.get()`, never a keyword.
    else if (this.previous(index) !== DOT && language.keywords.has(lookup)) kind = 'keyword';
    else if (this.declaring) kind = 'variable';
    else if (this.isBuiltinType(lookup, index) || (language.capitalizedTypes && isCapitalized(word))) kind = 'type';
    else if (this.nextSolid(end) === PAREN) kind = 'function';
    this.declaring = kind === 'keyword' && (this.declaring || language.declarators.has(lookup));
    return kind;
  }

  punctuation(index) {
    // `function* name` still declares `name`.
    if (this.unit(index) !== STAR) this.declaring = false;
    return index + 1;
  }

  unit(at) { return at >= 0 && at < this.length ? this.source.charCodeAt(at) : -1; }

  previous(index) { return index > 0 ? this.unit(index - 1) : NEWLINE; }

  startsWith(prefix, at) { return this.source.startsWith(prefix, at); }

  push(start, end, kind) {
    if (end > start) this.tokens.push({ start, end, kind });
    return end;
  }

  endOfLine(at) {
    const stop = this.source.indexOf('\n', at);
    return stop < 0 ? this.length : stop;
  }

  isIdentifierStart(unit) { return isLetter(unit) || (unit === 36 /* $ */ && this.language.identifierSymbols.has(unit)); }

  isIdentifier(unit) { return isLetter(unit) || isDigit(unit) || this.language.identifierSymbols.has(unit); }

  scanName(at) {
    let end = at;
    while (this.isIdentifier(this.unit(end))) end += 1;
    return end;
  }

  stringAt(at) { return this.language.strings.find((string) => this.startsWith(string.delimiter, at)); }

  stringPrefixAt(index, end) {
    if (end - index > 2) return undefined;
    for (let at = index; at < end; at += 1) if (!this.language.stringPrefixes.has(this.unit(at))) return undefined;
    return this.stringAt(end);
  }

  scanString(at, string) {
    let index = at + string.delimiter.length;
    while (index < this.length) {
      const unit = this.unit(index);
      if (unit === BACKSLASH && !string.raw) { index += 2; continue; }
      if (this.startsWith(string.delimiter, index)) return index + string.delimiter.length;
      if (unit === NEWLINE && !string.multiline) return index;
      index += 1;
    }
    return this.length;
  }

  /** The next character on this line that isn't a space, or -1 at its end. */
  nextSolid(at) {
    let index = at;
    while (isSpace(this.unit(index))) index += 1;
    return this.unit(index) === NEWLINE ? -1 : this.unit(index);
  }

  /** The character before `at` on its line that isn't a space, or -1 at the line's start. */
  previousSolid(at) {
    let index = at;
    while (isSpace(this.unit(index - 1))) index -= 1;
    return this.unit(index - 1) === NEWLINE ? -1 : this.unit(index - 1);
  }

  /** `string` in `name: string`, but not `number` the variable where the language says where types go. */
  isBuiltinType(lookup, index) {
    const after = this.language.typesAfter;
    return this.language.types.has(lookup) && (after.size === 0 || after.has(this.previousSolid(index)));
  }

  /** A name that starts a line, an entry or a declaration, followed by `:` or `=`. */
  isKey(start, end) {
    return this.language.keySeparators.has(this.nextSolid(end)) && KEY_OPENERS.has(this.previousSolid(start));
  }
}

/**
 * The coloured stretches of `text`, in order and never overlapping, as
 * { start, end, kind } in UTF-16 offsets. Text between them is plain.
 */
export function codeTokens(text, language) {
  return new CodeReader(String(text ?? ''), language).read();
}

/**
 * Each line's tokens, with offsets into that line. The lines are read as one
 * text, so a comment or string that spans lines colours every line it covers.
 */
export function codeLineTokens(lines, language) {
  const tokens = codeTokens(lines.join('\n'), language);
  const result = [];
  let offset = 0;
  let index = 0;
  for (const line of lines) {
    const end = offset + line.length;
    const own = [];
    while (index < tokens.length && tokens[index].start < end) {
      const token = tokens[index];
      const start = Math.max(token.start, offset);
      if (token.end > start) own.push({ start: start - offset, end: Math.min(token.end, end) - offset, kind: token.kind });
      if (token.end > end) break;
      index += 1;
    }
    result.push(own);
    offset = end + 1;
  }
  return result;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

/** The lines as escaped HTML with coloured spans, or null when `fileName` is not code Lasso colours. */
export function highlightCodeLines(lines, fileName) {
  const language = codeLanguage(fileName);
  if (!language) return null;
  const values = lines.map((line) => String(line ?? ''));
  return codeLineTokens(values, language).map((tokens, index) => {
    const line = values[index];
    let html = '';
    let at = 0;
    for (const token of tokens) {
      html += `${escapeHtml(line.slice(at, token.start))}<span class="code-${token.kind}">${escapeHtml(line.slice(token.start, token.end))}</span>`;
      at = token.end;
    }
    return html + escapeHtml(line.slice(at));
  });
}

const rules = (shade) => Object.entries(CATALOG.colors)
  .map(([kind, color]) => `.code-${kind}{color:${color[shade]}${color.bold ? ';font-weight:600' : ''}}`).join('');

/** The token colours, light and dark, for any page that shows highlightCodeLines output. */
export const CODE_SYNTAX_STYLE = `${rules('light')}@media(prefers-color-scheme:dark){${rules('dark')}}`;
