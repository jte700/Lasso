// The next words a linked source offers: a record's fields, a code file's lines
// and a paper's findings.

import path from 'node:path';
import { buildSentenceCorpus, completeFromLinkedSource, sourceFindingFragment } from './completion.js';
import { normalizedVariable } from './tabular.js';
import { fieldCue } from './record-fields.js';
import {
  MAX_CODE_LINES, codeOnOwnLines, fileLines, fileNameBefore, lineMentionAtEnd, lineMentionBeforeName, linesLabel,
} from './code-lines.js';
import { isCodePath, isCodeType } from '../history/file-types.js';
import { CODE_LINES_KEY } from './constants.js';
import { codeLinesDescriptor } from './file-objects.js';
import { OPEN_FIELD_CUES } from './row-field-match.js';
import { contextualCompletionRange, isPassageExcerpt, normalizedCompletionPhrase } from './workspace-completion.js';
import { endsSentence } from './writing-context.js';

export const linkedFieldsMethods = {
  /**
   * A linked record's fields, as the word after it asks for them: "on" its
   * date, "at" its time or place, "with" its people, "from" its sender. What
   * has been typed of a value since narrows them; fields already written in
   * the sentence are not offered again.
   */
  fieldsFromLinkedRecord(projectId, input, cursor, dependency) {
    const linked = this.linkedRecord(projectId, dependency);
    if (!linked) return null;
    const text = String(input.text ?? '');
    const tail = text.slice(linked.anchor.end, cursor);
    const cue = endsSentence(tail) ? null : fieldCue(tail);
    if (!cue) return null;
    const source = linked.source;
    const written = this.valuesWrittenInSentence(projectId, input, cursor);
    const typed = normalizedCompletionPhrase(cue.typed);
    const matchesTyped = (value) => {
      const words = normalizedCompletionPhrase(value).split(' ');
      return !typed || words.some((_, index) => words.slice(index).join(' ').startsWith(typed));
    };
    const candidates = this.objectsAt(this.sourceProjectId(source) ?? projectId, source.snapshotId, ['VALUE'])
      .filter((object) => object.path === source.path && object.metadata.componentType === 'RECORD_FIELD'
        && object.valueText && !written.has(object.id) && matchesTyped(object.valueText))
      .map((object) => {
        const role = cue.roles.indexOf(object.metadata.role);
        const rank = normalizedVariable(object.metadata.field) === cue.word ? 0 : role >= 0 ? role + 1 : Infinity;
        // Fields keep the order the record lists them in.
        return { object, order: object.metadata.lineStart ?? 0, rank };
      });
    if (!candidates.length) return null;
    // The fields the cue names come first, and alone when it names any.
    const named = candidates.filter((candidate) => candidate.rank !== Infinity);
    const offered = (named.length ? named : candidates)
      .sort((left, right) => left.rank - right.rank || left.order - right.order).slice(0, 8);
    const completions = offered.map(({ object }, index) => {
      // Spaced wider than a ranking band, so the order chosen here holds.
      const confidence = Number(Math.max(0.3, 0.95 - index * 0.1).toFixed(3));
      return {
        id: `${object.id}:field:${index}`,
        replacementText: object.valueText,
        category: object.metadata.field,
        provenanceLabel: `${source.label} · ${object.metadata.field}`,
        ...contextualCompletionRange(text, cursor, object.valueText, { floor: linked.anchor.end }),
        confidence,
        dependencyCandidate: this.enrichObject(projectId, {
          ...object, score: confidence,
          reasons: [cue.word && !OPEN_FIELD_CUES.has(cue.word) ? `${object.metadata.field}, after “${cue.word}”` : 'field of the linked record'],
        }),
        generated: false,
      };
    });
    return { dependencyId: linked.id, source, variable: source.label, heading: source.label, completions };
  },

  /**
   * The code file and lines the writer names: after a code file they
   * accepted ("server.js line 42", "lines 10 through 20"), just before it
   * ("line 42 of server.js"), after one of its lines ("and line 50"), or
   * after its name written out ("app.py lines 3-9").
   */
  namedCodeLines(projectId, input, cursor, dependency) {
    const text = String(input.text ?? '');
    if (dependency && isCodePath(dependency.source.path)) {
      const after = lineMentionAtEnd(text, dependency.anchor.end, cursor);
      const before = !after && /^\s*:?\s*$/.test(text.slice(dependency.anchor.end, cursor))
        ? lineMentionBeforeName(text, dependency.anchor.start) : null;
      const mention = after ?? before;
      return mention ? { ...mention, path: dependency.source.path, dependency,
        ownerId: this.sourceProjectId(dependency.source) ?? projectId } : null;
    }
    const mention = lineMentionAtEnd(text, 0, cursor);
    const written = mention && fileNameBefore(text, mention.start);
    if (!written) return null;
    const name = written.name.toLowerCase();
    const file = this.objectsAt(projectId, null, ['CODE_BLOCK', 'MODEL'])
      .filter((object) => object.metadata.codeFile && object.path !== input.documentPath)
      .map((object) => object.path)
      .filter((filePath) => filePath.toLowerCase() === name || filePath.toLowerCase().endsWith(`/${name}`))
      .sort((left, right) => left.length - right.length || left.localeCompare(right))[0];
    return file ? { ...mention, path: file, dependency: null, ownerId: projectId } : null;
  },

  /**
   * The lines named while writing, as one suggestion whose Tab inserts their
   * code after the words that named them and a colon, on lines of their own:
   * one line without its indentation, several indented as in the file.
   */
  linesFromCode(projectId, input, cursor, dependency) {
    const named = this.namedCodeLines(projectId, input, cursor, dependency);
    if (!named) return null;
    const { first, last, ownerId } = named;
    const snapshotId = this.timeline.getProject(ownerId).currentSnapshotId;
    const file = this.timeline.snapshotFile(snapshotId, named.path);
    if (!file || !isCodeType(file.fileType)) return null;
    const fileName = path.posix.basename(file.path);
    const sourceObject = named.dependency?.source ?? this.objectsAt(ownerId, snapshotId, ['CODE_BLOCK', 'MODEL'])
      .find((object) => object.path === file.path && object.metadata.codeFile) ?? null;
    const result = (completions, notice = null) => ({ dependencyId: named.dependency?.id ?? null,
      source: sourceObject ?? completions[0]?.dependencyCandidate ?? null, completions, notice,
      heading: `${linesLabel(first, last ?? first)} of ${fileName}` });
    // "lines 10 through" or "lines 10 through 2" is still being typed: nothing yet, and nothing else either.
    if (named.pending || last < first) return sourceObject ? result([]) : null;
    const lines = fileLines(this.timeline.blobs.get(file.contentHash)?.toString('utf8') ?? '');
    if (last > lines.length) {
      return sourceObject ? result([], `${fileName} has ${lines.length} line${lines.length === 1 ? '' : 's'}.`) : null;
    }
    if (last - first + 1 > MAX_CODE_LINES) {
      return sourceObject ? result([], `Tab inserts up to ${MAX_CODE_LINES} lines at once.`) : null;
    }
    const descriptor = codeLinesDescriptor(file, lines, first, last);
    if (!descriptor) {
      return sourceObject ? result([], `${linesLabel(first, last)} of ${fileName} ${first === last ? 'is' : 'are'} blank.`) : null;
    }
    this.ensureIndex(ownerId, snapshotId);
    const [object] = this.indexedObjects(ownerId, snapshotId, { keyPrefix: `${file.projectFileId}:${CODE_LINES_KEY}` }, [descriptor]);
    if (!object) return null;
    const code = object.valueText;
    const block = first !== last;
    const firstLine = code.split('\n').find((line) => line.trim()) ?? code;
    const inserted = codeOnOwnLines(code, String(input.text ?? '').slice(0, cursor));
    return result([{
      id: `${object.id}:lines`,
      replacementText: inserted.text,
      // Typed key by key, code would meet the host's auto-indent, closing brackets and smart quotes.
      verbatim: true,
      label: block ? `${firstLine.trim()} \u2026` : code,
      detail: block ? `${last - first + 1} lines` : '',
      category: 'Code',
      provenanceLabel: `${fileName} · ${object.label}`,
      // The colon takes the place of spaces typed after the line numbers.
      claimStart: cursor - inserted.replaced, claimEnd: cursor,
      confidence: 0.99,
      dependencyCandidate: this.enrichObject(ownerId, { ...object, score: 0.99, matchTier: 0,
        reasons: [`${object.label} of ${fileName}`] }),
      generated: false,
    }]);
  },

  findingsFromLinkedPaper(projectId, input, cursor, dependency = this.linkedPaperContext(projectId, input, cursor)) {
    if (dependency && !['PAPER', 'REFERENCE'].includes(dependency.source.objectType)) return null;
    if (!dependency) return null;
    const fragment = sourceFindingFragment(input.text, cursor, dependency.anchor.end);
    if (!fragment) return null;
    const source = dependency.source;
    const sourceText = /\.pdf$/i.test(source.path) ? this.sourceText(source).replace(/\s*\n\s*/g, ' ') : this.sourceText(source);
    const corpus = buildSentenceCorpus([{
      text: sourceText,
      path: source.path,
      snapshotId: source.snapshotId,
      dependencyCandidate: source,
    }]);
    const passages = this.objectsAt(this.sourceProjectId(source) ?? projectId, source.snapshotId, ['DOCUMENT'])
      .filter(object => object.path === source.path && isPassageExcerpt(object) && object.metadata.excerptType === 'sentence');
    // Markdown sentences are compared without their inline markers.
    const comparable = value => String(value ?? '').toLowerCase().replace(/[\W_]+/g, ' ').trim();
    const completions = completeFromLinkedSource(corpus, input, source, {
      sourceEnd: dependency.anchor.end, limit: 12,
    }).map(completion => {
      const passage = passages.find(object => object.metadata.rawText === completion.sourceSentence)
        ?? passages.find(object => object.metadata.componentType === 'TEXT_EXCERPT'
          && comparable(object.metadata.rawText) === comparable(completion.sourceSentence));
      return passage ? { ...completion, dependencyCandidate: { ...passage,
        score: completion.confidence, reasons: completion.dependencyCandidate.reasons } } : completion;
    });
    return {
      dependencyId: dependency.id,
      source,
      fragment,
      completions,
    };
  },
};
