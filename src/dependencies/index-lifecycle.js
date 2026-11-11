// Building, carrying forward and re-reading a snapshot's object index.

import path from 'node:path';
import { transaction } from '../db.js';
import { HttpError, VersionConflictError } from '../history/errors.js';
import { isDesignFile } from './drawing-objects.js';
import { FULL_WRITE_SHARE, storedFields } from '../history/object-versions.js';
import { sameVersion } from '../history/object-identity.js';
import { runSync, workUnits } from '../history/work.js';
import { currentFileType } from '../history/file-types.js';
import { now } from './basics.js';
import { EXTRACTOR_VERSION, INDEX_VERSION } from './constants.js';
import { readerFor, readerVersions, readerVersionsAfter, readersChangedSince } from './readers.js';
import { dependencyFilePriority } from './file-objects.js';
import { READER_CHANGED } from './table-sources.js';
import {
  applyVariableDefinitions, indexIsCurrent, indexSummary, isDictionaryVariable, kindsChangedSince,
} from './index-state.js';

const STEP_FILE = /\.(?:step|stp)$/i;

/**
 * Steps reading one file, reported as part of the whole read: `toStep(share)`
 * turns the share of the file read so far into the read's progress.
 */
function* withinFile(steps, toStep) {
  let next = steps.next();
  while (!next.done) {
    const step = next.value ?? {};
    const reported = toStep(step.share ?? 0);
    const reply = yield typeof step.offThread === 'function'
      ? { ...reported, offThread: (report) => step.offThread((share) => report?.(toStep(share))) }
      : reported;
    next = steps.next(reply);
  }
  return next.value;
}

export const indexLifecycleMethods = {
  ensureIndex(projectId, snapshotId = null) {
    return runSync(this.ensureIndexSteps(projectId, snapshotId));
  },

  /** The snapshot's index row, as `ensureIndex` decides whether it has work to do. */
  indexState(snapshotId) {
    // Do not materialize the entire file manifest on every warm prediction.
    return this.db.prepare(`SELECT s.project_id, i.snapshot_id AS indexed, i.drawing_index_version, i.spreadsheet_index_version
      FROM snapshots s LEFT JOIN snapshot_object_indexes i ON i.snapshot_id = s.id WHERE s.id = ?`)
      .get(snapshotId);
  },

  /** Whether a snapshot's objects can be read without indexing anything first. */
  isIndexed(snapshotId) {
    return indexIsCurrent(snapshotId ? this.indexState(snapshotId) : null);
  },

  /**
   * Reads the files a snapshot's index lacks, yielding
   * `{ phase: 'indexing', done, total }` after each file and
   * `{ phase: 'saving' }` before recording what it read.
   */
  *ensureIndexSteps(projectId, snapshotId = null) {
    const project = this.timeline.getProject(projectId);
    const targetSnapshotId = snapshotId ?? project.currentSnapshotId;
    const indexed = this.indexState(targetSnapshotId);
    if (!indexed) throw new HttpError(404, 'Snapshot not found.');
    if (indexed.project_id !== projectId) throw new HttpError(400, 'Snapshot does not belong to this project.');
    if (indexIsCurrent(indexed)) return;
    const files = this.indexableFiles(this.timeline.getSnapshot(targetSnapshotId), indexed);
    const versions = this.timeline.objectVersions;
    // An index row cleared to force a re-index still leaves the snapshot's
    // records in place; like an upgrade pass, that only adds missing objects.
    const existing = Boolean(indexed.indexed) || versions.hasRecords(targetSnapshotId);
    const carry = existing ? null : yield* this.carryPlanSteps(projectId, targetSnapshotId, files);
    // Rows without names take the identities they had in the reading this
    // one follows: the snapshot's own records for an upgrade pass, otherwise
    // the nearest earlier index.
    const identityBase = existing ? targetSnapshotId : versions.previousIndexed(projectId, targetSnapshotId);
    const index = carry ? this.carriedDescriptors(files, { ...carry, projectId })
      : yield* this.indexDescriptorSteps(files, { projectId, base: identityBase });
    // Other requests ran between the slices of a sliced index. If one of them
    // indexed this snapshot meanwhile, what was read here is already recorded,
    // or was decided against an older state; start over from the new one. The
    // files read so far stay in the extraction cache.
    const latest = this.indexState(targetSnapshotId);
    if (latest.indexed !== indexed.indexed || latest.drawing_index_version !== indexed.drawing_index_version
      || latest.spreadsheet_index_version !== indexed.spreadsheet_index_version
      || existing !== (Boolean(latest.indexed) || versions.hasRecords(targetSnapshotId))) {
      return yield* this.ensureIndexSteps(projectId, targetSnapshotId);
    }
    yield { phase: 'saving' };
    try {
      transaction(this.db, () => {
        const recorded = versions.record(projectId, targetSnapshotId, this.indexEntries(projectId, index.descriptors),
          { existing, carriedPaths: carry?.carriedPaths });
        // A full index names the reader that produced it. An upgrade pass adds
        // to an older reading, so the snapshot keeps the reader it had, and a
        // cleared index row over older records cannot vouch for one (0).
        this.db.prepare(`INSERT INTO snapshot_object_indexes(snapshot_id, indexed_at, object_count, drawing_index_version, spreadsheet_index_version, extractor_version)
          VALUES (?, ?, ?, ?, 2, ?)
          ON CONFLICT(snapshot_id) DO UPDATE SET drawing_index_version = excluded.drawing_index_version, spreadsheet_index_version = 2, indexed_at = excluded.indexed_at, object_count = excluded.object_count`)
          .run(targetSnapshotId, now(), recorded ?? versions.count(targetSnapshotId), INDEX_VERSION, existing ? 0 : EXTRACTOR_VERSION);
        // An upgrade pass reads only some files and keeps what was there, so
        // later indexes cannot carry objects forward from it without reading
        // them again; a full index or a carried one can be built on.
        if (existing) this.forgetIndexSummary(targetSnapshotId);
        else this.saveIndexSummary(targetSnapshotId, index.summary, { base: carry?.base, known: carry?.known });
        // Files carried from a base keep the readers that read them there.
        if (!existing) {
          this.recordReaderVersions(targetSnapshotId, carry
            ? readerVersionsAfter(this.readerVersionsAt(carry.base), this.readersOf(files, carry.carriedPaths))
            : readerVersions());
        }
      });
    } catch (error) {
      // The index was read into memory as it was written; drop it with the rollback.
      versions.forget(targetSnapshotId);
      throw error;
    }
    // An upgrade pass reads only some files and keeps what was there, so later
    // indexes cannot carry objects forward from it without reading them again.
    if (existing) this.indexedHere.delete(targetSnapshotId);
    else this.indexedHere.set(targetSnapshotId, index.summary);
    this.forgetObjects(targetSnapshotId);
    // Reading changed files leaves their parsed rows behind as garbage; give
    // it back now rather than letting the heap grow across a run of edits.
    this.releaseMemory((carry ? files.filter((file) => !carry.carriedPaths.has(file.path)) : files)
      .reduce((bytes, file) => bytes + (file.size ?? 0), 0));
    this.completionCorpusCache.delete(targetSnapshotId);
    this.workspaceRetrievalCache.delete(targetSnapshotId);
    this.ranking.invalidateSnapshot(targetSnapshotId);
    // An upgrade pass re-reads only some files, so only a full index of the
    // current version can say which files are now fine.
    if (!indexed.indexed && targetSnapshotId === project.currentSnapshotId) this.onIndexProblems?.(projectId, index.problems);
  },

  /** Every object the current reader reads out of a snapshot's files, recording nothing. */
  extractDescriptors(snapshot) {
    return this.indexDescriptors(this.indexableFiles(snapshot, { indexed: null })).descriptors;
  },

  /**
   * Records descriptors as one snapshot's reading by the current reader, inside
   * the caller's transaction. A snapshot without records stores them like a
   * full index; one that already has records only gains the objects it lacks.
   * Returns the snapshot's object count.
   */
  writeObjectIndex(projectId, snapshotId, descriptors, { carriedPaths = null } = {}) {
    const versions = this.timeline.objectVersions;
    const existing = versions.hasRecords(snapshotId);
    const objectCount = versions.record(projectId, snapshotId, this.indexEntries(projectId, descriptors), { existing, carriedPaths })
      ?? versions.count(snapshotId);
    this.db.prepare(`INSERT INTO snapshot_object_indexes(snapshot_id, indexed_at, object_count, drawing_index_version, spreadsheet_index_version, extractor_version)
      VALUES (?, ?, ?, ?, 2, ?)
      ON CONFLICT(snapshot_id) DO UPDATE SET indexed_at = excluded.indexed_at, object_count = excluded.object_count`)
      .run(snapshotId, now(), objectCount, INDEX_VERSION, existing ? 0 : EXTRACTOR_VERSION);
    this.forgetObjects(snapshotId);
    return objectCount;
  },

  /**
   * Which reader produced the project's current reading, and whether a newer
   * one exists. Nothing acts on this by itself: re-indexing records a snapshot
   * and a timeline event, so it stays something the user asks for.
   */
  indexFreshness(projectId) {
    const project = this.timeline.getProject(projectId);
    const row = this.db.prepare('SELECT extractor_version, indexed_at, object_count FROM snapshot_object_indexes WHERE snapshot_id = ?')
      .get(project.currentSnapshotId);
    const readers = row ? readersChangedSince(this.readerVersionsAt(project.currentSnapshotId)) : null;
    // An unindexed snapshot is read by the current reader the moment anything
    // asks it for an object, so it is not behind.
    const indexedWith = row ? (row.extractor_version ?? 0) : null;
    return {
      snapshotId: project.currentSnapshotId,
      extractorVersion: EXTRACTOR_VERSION,
      indexedWith,
      indexedAt: row?.indexed_at ?? null,
      objectCount: row?.object_count ?? null,
      stale: indexedWith !== null && (indexedWith < EXTRACTOR_VERSION || Boolean(readers?.size)),
    };
  },

  /**
   * Re-reads the project's files with the current reader and records the result
   * as a new snapshot carrying the same files.
   *
   * Earlier snapshots keep the objects the build that indexed them produced:
   * recorded evidence never changes, a share grant pins one of those versions
   * deliberately, and the content-addressed blobs are shared rather than
   * copied. What a re-index adds is a newer reading of the same bytes, stored
   * like any index as the differences from the snapshot before it.
   *
   * Whole-project, because the extractor version is recorded against a snapshot
   * and a half-re-read snapshot could not honestly carry one.
   */
  reindex(projectId, actorInput, options = {}) {
    return runSync(this.reindexSteps(projectId, actorInput, options));
  },

  *reindexSteps(projectId, actorInput, options = {}) {
    const project = this.timeline.getProject(projectId);
    if (options.expectedSnapshotId && options.expectedSnapshotId !== project.currentSnapshotId) {
      throw new VersionConflictError(options.expectedSnapshotId, project.currentSnapshotId);
    }
    const previous = this.timeline.getSnapshot(project.currentSnapshotId);
    // The comparison below is against what is actually recorded, so an
    // unindexed snapshot is read first.
    yield* this.ensureIndexSteps(projectId, previous.id);
    const versions = this.timeline.objectVersions;
    const indexable = this.indexableFiles(previous, { indexed: null });
    // A reader upgrade re-reads only the kinds of file it reads differently,
    // and carries the rest of the recorded reading forward. A data dictionary
    // can describe variables in any file, so a folder with one is read whole,
    // as is one whose index cannot build on its last.
    // An index that recorded its readers' versions re-reads the files of the
    // readers that changed; an older one, the kinds of file its build read differently.
    // Reader versions decide only once the build that read it is the current one.
    const indexedWith = this.indexFreshness(projectId).indexedWith;
    // With no reader changed, a re-read the user asks for reads everything, as before.
    const changedReaders = indexedWith === EXTRACTOR_VERSION ? readersChangedSince(this.readerVersionsAt(previous.id)) : null;
    const readers = changedReaders?.size ? changedReaders : null;
    const kinds = readers ? null : kindsChangedSince(indexedWith);
    const rereads = readers ? (file) => readers.has(readerFor(file).id) : kinds ? (file) => kinds.has(file.fileType) : null;
    const partial = Boolean(rereads) && versions.canBuildOn(previous.id)
      && !this.objectsAt(projectId, previous.id, ['VARIABLE']).some((object) => object.metadata.dictionary);
    const files = partial ? indexable.filter(rereads) : indexable;
    const reread = new Set(files.map((file) => file.path));
    const carriedPaths = partial ? new Set(previous.files.map((file) => file.path).filter((filePath) => !reread.has(filePath))) : null;
    const index = yield* this.indexDescriptorSteps(files, { projectId, base: previous.id });
    // A file saved while a sliced re-read ran makes a newer version, which
    // this reading does not describe. Read that version instead.
    if (this.timeline.getProject(projectId).currentSnapshotId !== previous.id) {
      return yield* this.reindexSteps(projectId, actorInput, { ...options, expectedSnapshotId: null });
    }
    yield { phase: 'saving' };
    const carriedVersions = carriedPaths
      ? readerVersionsAfter(this.readerVersionsAt(previous.id), this.readersOf(previous.files, carriedPaths))
      : readerVersions();
    const recordedCount = versions.indexedCount(previous.id);
    // Compare one stored row at a time. Keeping serialized Maps of both
    // readings alongside the descriptors doubled large folders' memory use.
    const identical = (() => {
      const byKey = new Map();
      for (const descriptor of index.descriptors) {
        if (!byKey.has(descriptor.key)) byKey.set(descriptor.key, descriptor);
      }
      let compared = 0;
      for (const row of versions.iterateResolved(previous.id)) {
        if (partial && !reread.has(row.path)) continue;
        compared += 1;
        const descriptor = byKey.get(row.object_key);
        if (!descriptor || row.object_type !== descriptor.type) return false;
        // The rule an index uses to keep a version: a part keeps the one an
        // earlier file revision recorded while it reads the same.
        if (!sameVersion(row, storedFields(descriptor))) return false;
      }
      return compared === byKey.size;
    })();
    if (identical) {
      // The current reader reads these files exactly as the snapshot already
      // says. Naming the reader that produced an identical reading is
      // bookkeeping about the index, not a change to the evidence, so the
      // project stops being offered a re-read it does not need.
      this.db.prepare('UPDATE snapshot_object_indexes SET extractor_version = ? WHERE snapshot_id = ? AND extractor_version < ?')
        .run(EXTRACTOR_VERSION, previous.id, EXTRACTOR_VERSION);
      this.recordReaderVersions(previous.id, carriedVersions);
      if (!partial) {
        this.indexedHere.set(previous.id, index.summary);
        transaction(this.db, () => this.saveIndexSummary(previous.id, index.summary));
      }
      this.onIndexProblems?.(projectId, index.problems, partial ? reread : null);
      return {
        changed: false, reason: 'IDENTICAL_READING', projectId, snapshot: previous, event: null,
        objects: { before: recordedCount, after: recordedCount }, dependenciesNeedingReview: 0,
        freshness: this.indexFreshness(projectId),
      };
    }

    const fileCount = partial ? files.length : previous.files.length;
    const reason = String(options.reason ?? '').trim().slice(0, 120);
    const title = `Re-read ${fileCount} file${fileCount === 1 ? '' : 's'} with the current reader`
      + '; the files did not change' + (reason ? ` (${reason})` : '');
    let objectCount = 0;
    let newSnapshotId = null;
    let result;
    try {
      result = this.cloneTransition(projectId, actorInput, {
        source: 'REINDEX', title, initiatedBy: options.initiatedBy ?? null,
      }, ({ resultingSnapshotId }) => {
        newSnapshotId = resultingSnapshotId;
        objectCount = this.writeObjectIndex(projectId, resultingSnapshotId, index.descriptors, { carriedPaths });
        // Readers whose files were all read again are current; one with carried files keeps its version.
        this.recordReaderVersions(resultingSnapshotId, carriedVersions);
        if (!partial) this.saveIndexSummary(resultingSnapshotId, index.summary);
      });
    } catch (error) {
      // The index was read into memory as it was written; drop it with the rollback.
      if (newSnapshotId) versions.forget(newSnapshotId);
      throw error;
    }
    if (!partial) this.indexedHere.set(result.snapshot.id, index.summary);
    for (const cache of [this.completionCorpusCache, this.studyVariableCache, this.workspaceRetrievalCache]) {
      cache.delete(previous.id);
    }
    this.forgetObjects(previous.id);
    this.ranking.invalidateSnapshot(previous.id);
    this.onIndexProblems?.(projectId, index.problems, partial ? reread : null);

    // A better reader can key an object differently (the row-label fix renames
    // every indented line item), so a claim whose source is absent from the new
    // reading follows the same object under its new key when there is exactly
    // one, and otherwise needs a person, not a verdict of BROKEN. Its evidence
    // is intact and still pinned in the snapshot it was linked at.
    const reconciled = this.reconcileProject(projectId, result.snapshot.id, { missingSource: READER_CHANGED });

    return {
      changed: true,
      projectId,
      snapshot: result.snapshot,
      event: result.event,
      objects: { before: recordedCount, after: objectCount },
      dependenciesNeedingReview: reconciled?.changed
        ? this.currentDependencies(projectId).filter((dependency) => dependency.status === 'NEEDS_REVIEW').length
        : 0,
      freshness: this.indexFreshness(projectId),
    };
  },

  /** The readers of those of `files` whose paths are in `paths`. */
  readersOf(files, paths) {
    return new Set(files.filter((file) => paths.has(file.path)).map((file) => readerFor(file).id));
  },

  /** Records which reader versions read a snapshot's index (readers.js). */
  recordReaderVersions(snapshotId, versions) {
    this.db.prepare('UPDATE snapshot_object_indexes SET reader_versions_json = ? WHERE snapshot_id = ?')
      .run(versions ? JSON.stringify(versions) : null, snapshotId);
  },

  /** The reader versions a snapshot's index was read with, or null when it recorded none. */
  readerVersionsAt(snapshotId) {
    const row = this.db.prepare('SELECT reader_versions_json FROM snapshot_object_indexes WHERE snapshot_id = ?').get(snapshotId);
    try { return row?.reader_versions_json ? JSON.parse(row.reader_versions_json) : null; } catch { return null; }
  },

  /** The files an index pass reads, in the order their objects are indexed. */
  indexableFiles(snapshot, indexed) {
    // An upgrade pass reads only what its index lacks: PDF and drawing passages
    // (2), Markdown and text passages (3), STEP models (4), video transcripts
    // (5), Word passages (6) and worksheet rows.
    const version = indexed.drawing_index_version ?? 0;
    const upgrades = (file, design, prose) => (version < 2 && (file.fileType === 'pdf' || design))
      || (version < 3 && prose) || (version < 4 && STEP_FILE.test(file.path)) || (version < 5 && file.fileType === 'video') || (version < 6 && file.fileType === 'document')
      || (!(indexed.spreadsheet_index_version >= 2) && file.fileType === 'spreadsheet');
    return [...snapshot.files].sort((left, right) => dependencyFilePriority(right) - dependencyFilePriority(left)
      || left.path.localeCompare(right.path)).filter((file) => {
      const design = isDesignFile(file);
      const prose = file.fileType === 'markdown' || (file.fileType === 'text' && path.extname(file.path).toLowerCase() === '.txt');
      if (indexed.indexed && !upgrades(file, design, prose)) return false;
      // Tables of any size are read a batch of rows at a time (table-index.js).
      // A deck's size is mostly its pictures; only its slides' text is read.
      // A video's sound is heard from the file; its bytes are not read here.
      const packaged = ['image', 'pdf', 'document', 'presentation', 'table', 'spreadsheet', 'video'].includes(file.fileType);
      if (file.size > 5_000_000 && !design && !packaged) return false;
      if (!design && !['table', 'spreadsheet', 'code', 'yaml', 'notebook', 'image', 'json', 'text', 'markdown', 'pdf',
        'document', 'presentation', 'video'].includes(file.fileType)) return false;
      return !(file.fileType === 'text' && !['.txt', '.bib', '.ris', '.enw', '.nbib'].includes(path.extname(file.path).toLowerCase()));
    });
  },

  /**
   * Every object of the files, as a full index records them, with what a
   * later index needs to carry them forward without reading them again.
   */
  indexDescriptors(files, options = {}) {
    return runSync(this.indexDescriptorSteps(files, options));
  },

  /**
   * The same, yielding `{ phase: 'indexing', done, total }` in work units
   * after each file. With `base`, an index of `projectId`, the rows without
   * names of each table keep the identities they had there.
   */
  *indexDescriptorSteps(files, { projectId = null, base = null } = {}) {
    const descriptors = [];
    const problems = [];
    const counts = new Map();
    const total = files.reduce((sum, file) => sum + workUnits(file.size), 0);
    let done = 0;
    for (const file of files) {
      const units = workUnits(file.size);
      const extracted = yield* withinFile(this.extractedObjectSteps(file),
        (share) => ({ phase: 'indexing', done: done + share * units, total }));
      const objects = this.withStableRowIdentities(projectId, base, file,
        [...extracted.objects, ...this.recordedDescriptors(file, extracted.objects, extracted)]);
      counts.set(file.path, objects.length);
      if (extracted.problem) problems.push({ path: file.path, ...extracted.problem });
      // Readers bound each file's bytes, rows and geometry. A folder-wide
      // budget must not silently exclude every file after an arbitrary cutoff.
      for (const descriptor of objects) {
        descriptors.push({ ...descriptor, metadata: { ...descriptor.metadata } });
      }
      done += units;
      yield { phase: 'indexing', done, total };
    }
    const definitions = descriptors.filter(isDictionaryVariable);
    applyVariableDefinitions(descriptors, definitions);
    return { descriptors, problems, summary: indexSummary(counts, problems, definitions, false) };
  },

  /** The same, yielding `{ phase: 'indexing', done, total }` as it reads the files that changed. */
  *carryPlanSteps(projectId, snapshotId, files) {
    const base = this.timeline.objectVersions.baseFor(projectId, snapshotId);
    const known = base ? this.knownIndexSummary(base) : null;
    if (!known || known.truncated) return null;
    const before = this.timeline.files.manifest(base).byPath;
    const unchanged = (file) => {
      const previous = before.get(file.path);
      return previous?.project_file_id === file.projectFileId && previous.content_hash === file.contentHash
        && currentFileType(previous.path, previous.file_type) === file.fileType && known.counts.has(file.path);
    };
    const carriedPaths = new Set(files.filter(unchanged).map((file) => file.path));
    if ([...known.dictionaryPaths].some((filePath) => !carriedPaths.has(filePath))) return null;
    // Carrying a few files forward from a much larger base would record a
    // removal for most of it; such an index is read and written in full.
    const carried = [...carriedPaths].reduce((sum, filePath) => sum + known.counts.get(filePath), 0);
    const based = [...known.counts.values()].reduce((sum, count) => sum + count, 0);
    if (carried * FULL_WRITE_SHARE < based) return null;
    // The files that changed are read here, once; carriedDescriptors then
    // takes them from the extraction cache.
    const changed = files.filter((file) => !carriedPaths.has(file.path));
    const total = changed.reduce((sum, file) => sum + workUnits(file.size), 0);
    let done = 0;
    for (const file of changed) {
      const units = workUnits(file.size);
      const extracted = yield* withinFile(this.extractedObjectSteps(file),
        (share) => ({ phase: 'indexing', done: done + share * units, total }));
      if (extracted.objects.some(isDictionaryVariable)) return null;
      done += units;
      yield { phase: 'indexing', done, total };
    }
    return { base, known, carriedPaths };
  },

  /** The objects of the files that changed since the base; the others are carried forward. */
  carriedDescriptors(files, { base, known, carriedPaths, projectId = null }) {
    const descriptors = [];
    const problems = [];
    const counts = new Map();
    for (const file of files) {
      if (carriedPaths.has(file.path)) {
        counts.set(file.path, known.counts.get(file.path));
        problems.push(...(known.problems.get(file.path) ?? []));
        continue;
      }
      const extracted = this.extractedObjects(file);
      const objects = this.withStableRowIdentities(projectId, base, file,
        [...extracted.objects, ...this.recordedDescriptors(file, extracted.objects, extracted)]);
      counts.set(file.path, objects.length);
      if (extracted.problem) problems.push({ path: file.path, ...extracted.problem });
      descriptors.push(...objects.map((descriptor) => ({ ...descriptor, metadata: { ...descriptor.metadata } })));
    }
    applyVariableDefinitions(descriptors, known.definitions);
    return { descriptors, problems, summary: indexSummary(counts, problems, known.definitions, false) };
  },
};
