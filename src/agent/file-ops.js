// Whole-file operations: what a model asks of a workbook, a contract or an
// assembly when the question is about all of it. A total needs every row,
// "which cross-references are broken" every reference, "do any parts
// overlap" every pair of solids, "what would B14 be at 15%" the formulas
// between the two cells. No excerpt holds those, and a model given only
// excerpts asks again and again (trial, 2 and 12 November 2026).
//
// Three sets of operations answer them exactly, each over its file read
// whole at the indexed revision: a workbook's cells with their formulas,
// what a cell feeds or reads, and a recalculated copy with cells changed
// (ops/spreadsheet.js); a PDF's sections, cross-references, defined terms
// and what a change reaches (ops/document.js); a STEP assembly's tree,
// counts over every level, bounds, interference and clearances
// (ops/assembly.js). They came from the operation-preserving trial, where a
// model using them got 23 of 26 steps at a fifth of the tokens.
//
// An agent asks in plain words for the common cases, or writes the
// operations after the file's name ("conveyor.step: whatif move:{…}; clash;
// distance A B"), or as `{file, op, …}`; op-words.js reads all three. Several
// in one ask run in order, each after a what-if on the copy it made. The
// operations are not in the tool's definition, which every call pays for: an
// answer that draws on such a file, for an ask about the whole of it, names
// them. Reached over MCP only, like table-asks.js.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BoundedCache } from '../cache.js';
import { AgentError } from './errors.js';
import { estimateTokens } from './metrics.js';
import { OpError } from './ops/common.js';
import { openAssembly } from './ops/assembly.js';
import { documentFromLines } from './ops/document.js';
import { cellFacts, openWorkbook } from './ops/spreadsheet.js';
import { operationsAsked, operationsWritten } from './op-words.js';

const LINES_WORKER = fileURLToPath(new URL('./ops/pdf-lines-worker.js', import.meta.url));
// An operation's result is sent within this many tokens unless the call's budget is larger.
const OPERATION_TOKENS = 2500;
// A document this long, in indexed passages, is one whose whole no answer shows.
const LONG_DOCUMENT = 400;

/** The kind of whole-file operations a file has, or null. */
export function operationKind(file) {
  if (/\.xls[xm]$/i.test(file.path)) return 'workbook';
  if (/\.pdf$/i.test(file.path)) return 'document';
  if (/\.(?:step|stp)$/i.test(file.path)) return 'assembly';
  return null;
}

// How each kind's operations are named in an answer: enough to write one, in a line.
export const OPERATIONS = {
  workbook: 'cells range:"Sheet!A1:C9" (values and formulas) · deps cell:"Sheet!B3" dir:"dependents"|"precedents" · '
    + 'whatif set:{"Sheet!B3":0.15} formulas:{"Sheet!B12":"=SUM(…)"} show:["Sheet!B14"] (a recalculated copy: an op after it in the ask reads it, or pass its rev)',
  document: 'outline under? · read ids:["5.2","B"] · find any:[…] all:[…] under? · refs to? from? broken? · terms name? · '
    + 'affected term? section? hops? · tables id? · whatif renumber:{"9.4":"9.7"} delete:[…] add:[…] (a copy: an op after it in the ask reads it)',
  assembly: 'count under? · tree under? depth? · find name? def? where:"zmax > 900" · bounds of? · clash under? with? · distance a b · '
    + 'clearance move from dir:[0,0,1] · whatif move:{"Part:1":{dz:10}} (a copy: an op after it in the ask reads it)',
};
const NOUN = { workbook: 'workbook', document: 'document', assembly: 'assembly' };

// An ask about the whole of a document or an assembly, not a place in it.
const WHOLE_DOCUMENT = /\b(?:every|all|any|each|anywhere|throughout|list|which (?:sections?|provisions?|clauses?)|how many|count|cross[- ]?references?|refer(?:s|ring|ences?)? to|defin(?:ed|ition|itions)|amend(?:ed|ment|ments)|supersed\w*|affected|renumber\w*|exceptions?|outline)\b/i;
const WHOLE_ASSEMBLY = /\b(?:how many|count|every|all|any|overall|bounding|extent|size|length|width|height|deepest|levels?|most[- ]used|above|below|higher|lower|overlap\w*|interpenetrat\w*|interfer\w*|clash\w*|collid\w*|gap|clearance|distance|mov(?:e|ed|ing)|rais(?:e|ed|ing)|instances?|occurrences?)\b/i;
const WHOLE_WORKBOOK = /\b(?:formulas?|depends?|dependents?|precedents?|recalculat\w*|what if|would (?:be|become)|suppose|if .* (?:were|was|is) changed|corrected)\b/i;

/**
 * An ask's words without the file they name: what is left says what is asked of it. The file is looked for by its
 * own name ("Engineering/Conveyor module.step", which an ask's parse splits at the space), then as the ask's parse had it.
 */
function withoutFile(text, file, mention) {
  for (const name of [path.posix.basename(file.path), mention.name]) {
    const pattern = new RegExp(`["'\`“‘]?(?:[^\\s/"'\`“‘:;,]+/)*${String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'\`”’]?\\s*:?`, 'i');
    if (pattern.test(text)) return String(text).replace(pattern, ' ').trim();
  }
  return String(text);
}

export const fileOperationMethods = {
  /** A file's operations, opened once per revision: the adapter of its kind, and this connection's what-if revisions of it. */
  openOperations(file) {
    const kind = operationKind(file);
    if (!kind) throw new AgentError('unsupported', `${file.path} has no whole-file operations: they are for .xlsx workbooks, PDF documents and STEP assemblies.`);
    this.operationAdapters ??= new BoundedCache({ maxEntries: 8 });
    this.operationSessions ??= new Map();
    let adapter = this.operationAdapters.get(file.contentHash);
    if (!adapter) {
      const options = { path: file.path, revision: 'r1', hash: file.contentHash };
      try {
        if (kind === 'workbook') adapter = openWorkbook(this.timeline.blobs.get(file.contentHash), options);
        else if (kind === 'assembly') adapter = openAssembly(this.timeline.blobs.get(file.contentHash), options);
        else {
          // pdf.js reads a PDF's layout asynchronously; a worker does it, and this thread waits for its lines.
          const read = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', LINES_WORKER, this.timeline.blobs.pathFor(file.contentHash)],
            { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 120_000 });
          if (read.status !== 0) throw new Error(String(read.stderr || read.error?.message || 'the PDF could not be read').trim().split('\n').at(-1));
          adapter = documentFromLines(JSON.parse(read.stdout), options);
        }
      } catch (error) {
        if (error instanceof AgentError) throw error;
        throw new AgentError('unsupported', `${file.path} could not be read for whole-file operations: ${error.message}`);
      }
      // A file the reader could not structure has no operations to offer: a PDF without numbered sections set apart
      // as headings, a STEP file that is one part. Said, rather than answered with an empty result.
      if (kind === 'document' && adapter.model.order.length - 1 < 3) {
        adapter = { unreadable: `${file.path} has no numbered sections Lasso can read as such (headings set apart from the text), so it has no whole-document operations.` };
      } else if (kind === 'assembly' && adapter.base.occurrences.length < 2) {
        adapter = { unreadable: `${file.path} is one part, not an assembly; ask about its dimensions or features in plain words.` };
      }
      adapter.kind = kind;
      this.operationAdapters.set(file.contentHash, adapter);
    }
    if (adapter.unreadable) throw new AgentError('unsupported', adapter.unreadable);
    if (!this.operationSessions.has(file.contentHash)) this.operationSessions.set(file.contentHash, { revisions: new Map() });
    return { kind, adapter, session: this.operationSessions.get(file.contentHash) };
  },

  /** What a file calls its own things, for reading an ask's words: an assembly's occurrences, a workbook's sheets and cells. Read when asked for. */
  operationNames(file, kind) {
    let opened;
    const adapter = () => {
      if (opened === undefined) {
        try { opened = this.openOperations(file).adapter; } catch (error) { if (!(error instanceof AgentError)) throw error; opened = null; }
      }
      return opened;
    };
    let occurrences;
    return {
      get occurrences() { return (occurrences ??= kind === 'assembly' ? adapter()?.base.occurrences.map((occurrence) => occurrence.path) ?? [] : []); },
      get sheets() { return kind === 'workbook' ? [...(adapter()?.state.sheets.keys() ?? [])] : []; },
      cell: (sheet, address) => (kind === 'workbook' && adapter() ? cellFacts(adapter().state, sheet, address) : null),
    };
  },

  /**
   * Several operations on one file, in order. After a what-if, each one that names no revision reads the copy it
   * made, so "move it, then measure the gap" is one ask. Asked in plain words (`lenient`), an operation the file
   * cannot answer is passed over; written out, it is said where it stood, beside the others' results.
   */
  runOperations(context, located, operations, { lenient = false } = {}) {
    const items = [];
    let whole = true;
    let revision = null;
    let failure = null;
    for (const operation of operations) {
      const chained = revision && operation.rev == null && operation.base == null ? { ...operation, [operation.op === 'whatif' ? 'base' : 'rev']: revision } : operation;
      try {
        const answer = this.askOperation(context, chained, located);
        items.push(...answer.items);
        whole &&= answer.status === 'complete';
        if (operation.op === 'whatif' && answer.items[0]?.rev) revision = answer.items[0].rev;
      } catch (error) {
        if (!(error instanceof AgentError)) throw error;
        failure ??= error;
        whole = false;
        if (!lenient) items.push({ src: this.sourceFor(context, located.project, located.file), type: 'operation', op: String(operation.op), text: error.message, certainty: 'not done' });
      }
    }
    if (failure && !lenient && items.every((item) => item.certainty === 'not done')) throw failure;
    return items.length ? { kind: 'operation', status: whole ? 'complete' : 'partial', items } : null;
  },

  /** `{ file, op, … }` as sent: one operation, or several written into `op` or `ops` the way a model writes them. */
  askOperations(context, item) {
    const { file: name, folder, op, ops, format, budget, ...rest } = item;
    const located = this.resolveFile(context, { file: String(name), ...(folder != null ? { folder } : {}) });
    const kind = located.file.disk ? null : operationKind(located.file);
    const written = kind ? operationsWritten(kind, { op, ops }, this.operationNames(located.file, kind)) : null;
    if (!written) return this.askOperation(context, item, located);
    return this.runOperations(context, located, written.length === 1 ? [{ ...rest, ...written[0] }] : written);
  },

  /**
   * One operation on one file: `{ file, op, …params }`. Its result says what it covered, and is complete unless the
   * operation itself is bounded (a pair of solids it could not settle) or its text is cut to the budget.
   */
  askOperation(context, item, located = null) {
    const { file: name, folder, op, format, budget, ...params } = item;
    const { project, file } = located ?? this.resolveFile(context, { file: String(name), ...(folder != null ? { folder } : {}) });
    const { kind, adapter, session } = this.openOperations(file);
    // "formulas" is a workbook's own account of itself: its sheets, columns and formula regions with their exceptions.
    const handler = kind === 'workbook' && op === 'formulas' ? () => ({ status: 'exact', coverage: { universe: 'every cell' }, forms: [{ form: 'full', text: adapter.card(), complete: true }] })
      : adapter.ops[String(op)];
    if (!handler) throw new AgentError('unsupported', `No operation "${op}" for a ${NOUN[kind]}; its operations are: ${OPERATIONS[kind]}.`);
    let outcome;
    try { outcome = handler(params, session); } catch (error) {
      if (error instanceof OpError) throw new AgentError('invalid_request', `${op}: ${error.message}`);
      throw error;
    }
    if (outcome.status === 'error' || outcome.status === 'unsupported') throw new AgentError('invalid_request', `${op}: ${outcome.forms[0].text}`);
    const limit = Math.max(OPERATION_TOKENS, context.budget ?? 0);
    const fits = outcome.forms.find((candidate) => estimateTokens(candidate.text) <= limit);
    const smallest = outcome.forms.reduce((least, candidate) => (candidate.text.length < least.text.length ? candidate : least));
    let text = (fits ?? smallest).text;
    const cut = !fits;
    if (cut) text = `${text.slice(0, limit * 4).replace(/\n[^\n]*$/, '')}\n… cut to the budget; narrow the operation, or give a larger "budget"`;
    const whole = outcome.status === 'exact' && !cut && (fits ?? smallest).complete !== false;
    return { kind: 'operation', status: whole ? 'complete' : 'partial', items: [{ src: this.sourceFor(context, project, file), type: 'operation', op: String(op), text,
      ...(outcome.coverage?.universe ? { over: outcome.coverage.universe } : {}), ...(outcome.status !== 'exact' ? { certainty: outcome.status } : {}),
      ...(outcome.revision && outcome.revision !== 'r1' ? { rev: outcome.revision } : {}), ...(outcome.guarantee && outcome.status !== 'exact' ? { guarantee: outcome.guarantee } : {}) }] };
  },

  /**
   * The operations an ask's plain words mean on the one file it names ("broken cross-references in the supply
   * agreement.pdf", "how many bolts in conveyor.step", "formulas in Operations 2025.xlsx"), each answered. Null when
   * the ask names no such file or says none outright.
   */
  askFileOperations(context, parsed) {
    if (!parsed.files.length) return null;
    const located = this.tryMention(context, parsed.files[0], parsed);
    const kind = located && !located.file.disk ? operationKind(located.file) : null;
    if (!kind) return null;
    // Operations written after the file's name are run as written; otherwise the ones its plain words say outright.
    const said = withoutFile(parsed.original, located.file, parsed.files[0]);
    const names = this.operationNames(located.file, kind);
    const written = operationsWritten(kind, said, names);
    const asked = written ?? operationsAsked(kind, said, names);
    if (!asked.length) return null;
    const answer = this.runOperations(context, located, asked, { lenient: !written });
    // Asked in plain words, the answer also names the file's operations: the next step may need one the words did not say.
    return answer && !written ? { ...answer, operations: [{ file: path.posix.basename(located.file.path), kind }] } : answer;
  },

  /**
   * The whole-file operations of the files behind an answer, named where the ask is about the whole of one and the
   * answer is not already an operation's: `{ operations: [{ file, kind }] }`. A document is offered them only when
   * it is long, an assembly or a workbook whenever the ask's words are of that kind.
   */
  operationsOffered(context, answer, text, parsed = null) {
    // An answer that is already worked out (an operation's, a query's) needs no pointer to the operations, and one
    // that names them already keeps what it has. A cell read from a workbook is where formulas and what-ifs start.
    if (answer.operations || ['operation', 'computed'].includes(answer.kind)) return {};
    const offered = [];
    const seen = new Set();
    const consider = (project, file) => {
      const kind = file && !file.disk ? operationKind(file) : null;
      const key = `${project?.id}|${file?.path}`;
      if (!kind || seen.has(key) || !this.allowed(context, project.id, file.path)) return;
      seen.add(key);
      const about = kind === 'document' ? WHOLE_DOCUMENT.test(text) && this.objectsOfFile(project, file.path).length >= LONG_DOCUMENT
        : kind === 'assembly' ? WHOLE_ASSEMBLY.test(text) : WHOLE_WORKBOOK.test(text) || Boolean(answer.query_tables) || answer.kind === 'cells';
      if (!about) return;
      try { this.openOperations(file); } catch (error) { if (error instanceof AgentError) return; throw error; }
      offered.push({ file: path.posix.basename(file.path), kind });
    };
    const sources = new Map([...context.sources.values()].map((entry) => [entry.id, entry.body]));
    for (const src of new Set((answer.items ?? []).map((item) => item.src).filter(Boolean))) {
      const body = sources.get(src);
      const project = context.projects.find((candidate) => candidate.name === body?.folder);
      if (project) consider(project, this.snapshotFile(context, project, body.path));
    }
    const named = parsed?.files?.length ? this.tryMention(context, parsed.files[0], parsed) : null;
    if (named) consider(named.project, named.file);
    return offered.length ? { operations: offered.slice(0, 2) } : {};
  },
};
