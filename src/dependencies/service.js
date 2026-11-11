import path from 'node:path';
import { json } from '../db.js';
import { extractDocxDocument, extractPdfFullText } from './document-extraction.js';
import { RecommendationRanking } from './ranking.js';
import { BoundedCache } from '../cache.js';
import { releaseAfterWork } from '../memory.js';
import { workUnits } from '../history/work.js';
import { TextStore } from './text-store.js';
import { IFC_MODEL_VERSION, keepIfcModelsIn } from './ifc-geometry.js';
import { TableIndex } from './table-index.js';
import { extractDrawingDocument } from './drawing-extraction.js';
import { presentationOutline, readPresentation } from './presentation-extraction.js';
import { claimCandidatesMethods } from './claim-candidates.js';
import { PDF_TEXT_VERSION } from './constants.js';
import { dependencyLinksMethods } from './dependency-links.js';
import { dependencyPreviewsMethods } from './dependency-previews.js';
import { dependencySharingMethods } from './dependency-sharing.js';
import { documentEditingMethods } from './document-editing.js';
import { indexLifecycleMethods } from './index-lifecycle.js';
import { indexSummaryMethods } from './index-summaries.js';
import { valueChangeMethods } from './value-changes.js';
import { linkedContextMethods } from './linked-context.js';
import { linkedFieldsMethods } from './linked-fields.js';
import { linkedValuesMethods } from './linked-values.js';
import { objectAccessMethods } from './object-access.js';
import { objectExtractionMethods } from './object-extraction.js';
import { objectHistoryMethods } from './object-history.js';
import { contextOverlap, reconciliationMethods } from './reconciliation.js';
import { rowIdentityMethods } from './row-identity.js';
import { sourceSearchMethods } from './source-search.js';
import { sourceUpdatesMethods } from './source-updates.js';
import { studyVariablesMethods } from './study-variables.js';
import { tableReadingMethods } from './table-reading.js';
import { TABLE_CLEANUP_DELAY_MS, tableRetentionMethods } from './table-retention.js';
import { isPassageExcerpt } from './workspace-completion.js';
import { workspaceSuggestionsMethods } from './workspace-suggestions.js';
import { writingPredictionMethods } from './writing-prediction.js';
import { TRANSCRIPT_VERSION } from './video-extraction.js';
import { videoTranscriptMethods } from './video-transcripts.js';

export { SUGGESTIONS_SHOWN, LINKED_VALUES_SHOWN, OBJECT_TYPES, EXTRACTOR_VERSION } from './constants.js';
export { currentClauseStart, writtenBeforeCaret, namesFocusedFile } from './writing-context.js';
export { isPassageExcerpt } from './workspace-completion.js';
export { isComponentIdentifier } from './file-objects.js';
export { detectClaimSpans } from './claim-detection.js';
export { spreadsheetLayout, tabularLayout } from './tabular.js';
export { anchorForSpan } from './object-descriptors.js';

// Installs each group's methods on the class as its own methods would be: writable and not enumerable.
function installMethods(prototype, ...groups) {
  for (const group of groups) {
    for (const [name, method] of Object.entries(group)) {
      Object.defineProperty(prototype, name, { value: method, writable: true, configurable: true, enumerable: false });
    }
  }
}

// About what one mapped source object takes in memory (label, search text,
// metadata), for the shared cache budget.
const MAPPED_OBJECT_BYTES = 1_200;

export class PredictiveProvenanceService {
  constructor(timeline, rfi = null) {
    this.timeline = timeline;
    this.db = timeline.db;
    this.rfi = rfi;
    // Every cache below that can grow large also counts against the one
    // budget all derived-data caches share (cache.js, config.cacheBytes).
    const budget = timeline.memoryBudget ?? null;
    const objectBytes = (objects) => objects.length * MAPPED_OBJECT_BYTES;
    this.ranking = new RecommendationRanking(timeline, { budget });
    const corpusBytes = (corpus) => corpus.reduce((bytes, item) => bytes + item.sentence.length * 2 + item.tokens.length * 64, 0);
    this.completionCorpusCache = new BoundedCache({ maxEntries: 16, maxWeight: 16 * 1024 * 1024, weight: corpusBytes,
      budget, bytes: corpusBytes });
    this.studyVariableCache = new BoundedCache({ maxEntries: 16, maxWeight: 100_000, weight: (objects) => objects.length,
      budget, bytes: objectBytes });
    this.workspaceRetrievalCache = new BoundedCache({ maxEntries: 16, maxWeight: 100_000, weight: (objects) => objects.length,
      budget, bytes: objectBytes });
    this.objectCache = new BoundedCache({ maxEntries: 16, maxWeight: 120_000, weight: (objects) => objects.length,
      budget, bytes: objectBytes });
    this.typedObjectCache = new BoundedCache({ maxEntries: 96, maxWeight: 120_000, weight: (objects) => objects.length,
      budget, bytes: objectBytes });
    // Whether an object has values below it, kept with the retrieval objects
    // it was worked out from, so it goes when they are read again.
    this.narrowingCache = new WeakMap();
    // Raw descriptors are cached before dictionary enrichment. Changing a
    // dictionary must still update unchanged source files in the next snapshot.
    // A workbook sheet's objects by its part signature, so an edit to one sheet reads only that sheet.
    this.sheetObjectCache = new BoundedCache({ maxEntries: 512, budget, bytes: objectBytes });
    // A deck slide's reading by its part signature, so an edit to one slide reads only that slide.
    this.slideReadingCache = new BoundedCache({ maxEntries: 4096, budget, bytes: (reading) => JSON.stringify(reading).length * 2 });
    this.extractionCache = new BoundedCache({ maxEntries: 256, maxWeight: 24 * 1024 * 1024,
      weight: (entry) => entry.bytes, budget, bytes: (entry) => entry.bytes });
    // Extracted file text depends only on the file's bytes, so an unchanged
    // PDF is not parsed again after every capture of its folder.
    // Large tables, whole, by file content (see table-index.js).
    // Tables of contents no snapshot keeps are removed after captures (see table-retention.js).
    this.tables = new TableIndex(path.join(timeline.config.dataDir, 'derived'), { keep: (hashes) => this.tableContentToKeep(hashes), budget });
    this.tableCleanupTimer = null;
    this.tableKeepAnswers = null;
    this.tableCleanupDelayMs = TABLE_CLEANUP_DELAY_MS;
    this.tableBuilds = new Map();
    this.tableReadings = new BoundedCache({ maxEntries: 256 });
    this.snapshotTableCache = new BoundedCache({ maxEntries: 32 });
    // Rows of large tables already offered at a snapshot, by snapshot and key.
    this.deepObjects = new BoundedCache({ maxEntries: 4_096, budget, bytes: () => MAPPED_OBJECT_BYTES });
    this.objectKeySets = new WeakMap();
    this.variableIndexes = new WeakMap();
    this.retrievalIndexes = new WeakMap();
    // PDFs' text outlives the process, so a restart does not read every PDF again.
    this.textStore = new TextStore(path.join(timeline.config.dataDir, 'derived', 'text'), PDF_TEXT_VERSION);
    // So are videos' transcripts, which take the speech model a while each.
    this.transcriptStore = new TextStore(path.join(timeline.config.dataDir, 'derived', 'transcripts'), TRANSCRIPT_VERSION);
    const transcriptBytes = (transcript) => transcript.segments.reduce((bytes, segment) => bytes + segment.text.length * 2 + segment.words.length * 64, 64);
    this.transcriptCache = new BoundedCache({ maxEntries: 64, maxWeight: 32 * 1024 * 1024, weight: transcriptBytes,
      budget, bytes: transcriptBytes });
    this.videoHearings = new Map();
    // So are IFC plans, which can take the geometry engine several seconds each.
    keepIfcModelsIn(new TextStore(path.join(timeline.config.dataDir, 'derived', 'ifc-models'), IFC_MODEL_VERSION));
    // A drawing PDF keeps one entry per page, so the bound is on bytes.
    const textBytes = (text) => text.length * 2;
    this.extractedTextCache = new BoundedCache({ maxEntries: 1024, maxWeight: 32 * 1024 * 1024, weight: textBytes,
      budget, bytes: textBytes });
    this.sourceTextCache = new BoundedCache({ maxEntries: 64, maxWeight: 8 * 1024 * 1024, weight: textBytes,
      budget, bytes: textBytes });
    this.figurePreviewCache = new BoundedCache({ maxEntries: 12, maxWeight: 24 * 1024 * 1024,
      weight: (preview) => preview.image.length, budget, bytes: (preview) => preview.image.length });
    this.reconcilingProjects = new Set();
    // Runs a full collection after an index read many bytes (memory.js).
    this.releaseMemory = releaseAfterWork;
    // Recent indexes' summaries, which later indexes carry unchanged files forward from.
    // Each is also stored in the database (index-summaries.js), so a restart keeps them.
    this.indexedHere = new BoundedCache({ maxEntries: 64 });
    this.unsubscribe = timeline.onCapture((capture) => {
      // Snapshot keys are immutable. A change in one directory must leave the
      // other enabled directories warm while releasing the superseded head.
      const previous = capture?.event?.previousSnapshotId;
      if (previous) {
        for (const cache of [this.completionCorpusCache, this.studyVariableCache, this.workspaceRetrievalCache]) {
          cache.delete(previous);
        }
      }
      this.reconcileAfterCapture(capture);
      if (capture?.changed || capture?.removedProjectIds?.length) this.tableContentChanged();
    });
  }

  close() {
    this.unsubscribe?.();
    this.stopTableCleanup();
    this.ranking.close();
    for (const cache of [this.completionCorpusCache, this.studyVariableCache, this.workspaceRetrievalCache,
      this.objectCache, this.typedObjectCache, this.extractionCache, this.sheetObjectCache, this.slideReadingCache,
      this.sourceTextCache, this.figurePreviewCache,
      this.indexedHere, this.tableReadings, this.snapshotTableCache, this.deepObjects, this.transcriptCache]) cache.clear();
    this.tables.close();
  }

  sourceText(source) {
    if (isPassageExcerpt(source)) return source.metadata.rawText ?? source.valueText ?? '';
    const key = `${source.snapshotId}|${source.id}|${source.contentHash}`;
    if (this.sourceTextCache.has(key)) return this.sourceTextCache.get(key);
    const file = this.timeline.snapshotFile(source.snapshotId, source.path);
    const extractedText = file ? this.fileText(file, source.objectType, source.anchor?.pageNumber) : '';
    const text = [extractedText, source.metadata.textExcerpt, source.metadata.subject,
      source.metadata.title, source.valueText].filter(Boolean).join('\n');
    this.sourceTextCache.set(key, text);
    return text;
  }

  /** A file's text: a whole PDF, one page of a PDF drawing, or a document's. */
  fileText(file, objectType, pageNumber) {
    const page = file.fileType === 'pdf' && objectType === 'DRAWING' ? pageNumber ?? '' : '';
    const extractedKey = `${file.contentHash}|${file.fileType}|${objectType === 'DRAWING' ? `page:${page}` : 'all'}`;
    let extractedText = this.extractedTextCache.get(extractedKey);
    if (extractedText !== undefined) return extractedText;
    extractedText = '';
    if (file.fileType === 'pdf' && objectType === 'DRAWING') {
      // One reading has every page, and the next page's object asks next.
      const pages = this.pdfText(file, 'pages', (layout) => layout.pages.map((item) => ({
        pageNumber: item.pageNumber, text: item.text ?? '' })));
      for (const item of pages) this.extractedTextCache.set(`${file.contentHash}|pdf|page:${item.pageNumber}`, item.text);
      extractedText = pages.find(item => item.pageNumber === pageNumber)?.text ?? '';
    } else if (file.fileType === 'pdf') {
      extractedText = this.pdfText(file, 'all', (_layout, buffer) => extractPdfFullText(buffer));
    } else if (file.fileType === 'document') {
      extractedText = extractDocxDocument(this.timeline.blobs.get(file.contentHash)).textExcerpt;
    } else if (file.fileType === 'presentation') {
      extractedText = presentationOutline(readPresentation(this.timeline.blobs.get(file.contentHash))).text;
    } else if (['markdown', 'text'].includes(file.fileType)) {
      extractedText = this.timeline.blobs.get(file.contentHash).toString('utf8');
    }
    this.extractedTextCache.set(extractedKey, extractedText);
    return extractedText;
  }

  /** A PDF's text, from the text store when an earlier reading kept it. */
  pdfText(file, kind, read) {
    const key = `${file.contentHash}|pdf|${kind}`;
    const stored = this.textStore.get(key);
    if (stored !== undefined) return stored;
    const buffer = this.timeline.blobs.get(file.contentHash);
    const layout = extractDrawingDocument(buffer);
    const value = read(layout, buffer);
    // A reading the native reader failed, such as a timeout under load, is not kept.
    if (layout.status !== 'error') this.textStore.set(key, value);
    return value;
  }

  /**
   * Reads the text of a snapshot's PDFs, one file per step, yielding
   * `{ phase: 'warming', done, total }`. Search over a PDF's objects includes
   * its text, and the native reader takes a moment per file, so this is done
   * while a folder starts rather than on the first keystroke after it.
   */
  *pdfTextSteps(projectId, snapshotId) {
    const pdfs = this.timeline.snapshotFiles(snapshotId).filter((file) => file.fileType === 'pdf');
    if (!pdfs.length) return;
    const drawings = new Map();
    for (const row of this.timeline.objectVersions.resolvedTypes(snapshotId, ['DRAWING']).rows) {
      if (row.project_id === projectId && /\.pdf$/i.test(row.path)) drawings.set(row.path, json(row.anchor_json, {})?.pageNumber);
    }
    // PDFs not yet in the text store are read by a worker; a caller that
    // cannot wait for one reads them below, on this thread.
    const unread = pdfs.filter((file) => this.textStore.get(`${file.contentHash}|pdf|all`) === undefined)
      .map((file) => ({ blobPath: this.timeline.blobs.rawPath(file.contentHash), contentHash: file.contentHash,
        pages: drawings.has(file.path) }));
    if (unread.length) {
      yield { phase: 'warming', done: 0, total: 1, offThread: (report) => this.readPdfTexts(unread,
        (share) => report?.({ phase: 'warming', done: share, total: 1 })) };
    }
    const total = pdfs.reduce((sum, file) => sum + workUnits(file.size), 0);
    let done = 0;
    for (const file of pdfs) {
      this.fileText(file, 'PAPER');
      if (drawings.has(file.path)) this.fileText(file, 'DRAWING', drawings.get(file.path));
      done += workUnits(file.size);
      yield { phase: 'warming', done, total };
    }
  }

  /** How much of a recorded neighbour survived, 0..1; see contextOverlap in reconciliation.js. */
  static contextOverlap(recorded, actual, side) {
    return contextOverlap(recorded, actual, side);
  }
}

// The rest of the class lives in sibling modules, grouped by what the methods do.
installMethods(PredictiveProvenanceService.prototype,
  indexLifecycleMethods,
  indexSummaryMethods,
  valueChangeMethods,
  objectExtractionMethods,
  tableReadingMethods,
  tableRetentionMethods,
  rowIdentityMethods,
  objectAccessMethods,
  objectHistoryMethods,
  studyVariablesMethods,
  workspaceSuggestionsMethods,
  claimCandidatesMethods,
  linkedContextMethods,
  linkedFieldsMethods,
  linkedValuesMethods,
  writingPredictionMethods,
  videoTranscriptMethods,
  sourceSearchMethods,
  documentEditingMethods,
  dependencyLinksMethods,
  dependencySharingMethods,
  dependencyPreviewsMethods,
  sourceUpdatesMethods,
  reconciliationMethods);
