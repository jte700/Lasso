// A folder's videos as the service reads them: each heard once (off the
// thread when the caller can wait), kept by content, and searched word for
// word when the writer closes a phrase in quotes.

import path from 'node:path';
import { phraseMoments, phraseTokens, quotedPhraseAtCaret, videoTimestamp } from './quoted-phrase.js';
import {
  isKeptTranscript, reportTranscriptProblem, transcribeVideo, transcribeVideoNow, transcriptKey, videoDescriptors,
} from './video-extraction.js';

// The moments one quoted phrase offers, at most; one per segment.
const MAX_MOMENTS = 8;
// Transcript lines shown around the quoted one in a preview.
const PREVIEW_CONTEXT_SEGMENTS = 6;

export const videoTranscriptMethods = {
  /**
   * A video's objects, from its transcript. The transcript is heard on
   * another thread when the caller reads in slices; otherwise here.
   */
  *videoObjectSteps(file, report) {
    const transcript = yield* this.videoTranscriptSteps(file);
    reportTranscriptProblem(transcript, report);
    return videoDescriptors(file, transcript);
  },

  *videoTranscriptSteps(file) {
    const kept = this.keptTranscript(file.contentHash);
    if (kept) return kept;
    const blobPath = this.timeline.blobs.pathFor(file.contentHash);
    const extension = path.posix.extname(file.path);
    let transcript = yield { share: 0, offThread: () => this.hearVideo(file.contentHash, blobPath, extension) };
    transcript ??= transcribeVideoNow(blobPath, extension);
    if (isKeptTranscript(transcript)) this.keepTranscript(file.contentHash, transcript);
    return transcript;
  },

  /** One transcription per video content at a time; a second asker shares it. */
  hearVideo(contentHash, blobPath, extension) {
    let pending = this.videoHearings.get(contentHash);
    if (!pending) {
      pending = transcribeVideo(blobPath, extension).finally(() => this.videoHearings.delete(contentHash));
      this.videoHearings.set(contentHash, pending);
    }
    return pending;
  },

  /** A transcript heard before, from memory or the transcript store; null when there is none. */
  keptTranscript(contentHash) {
    const key = transcriptKey(contentHash);
    const cached = this.transcriptCache.get(key);
    if (cached) return cached;
    const stored = this.transcriptStore.get(key);
    if (!isKeptTranscript(stored)) return null;
    this.transcriptCache.set(key, stored);
    return stored;
  },

  keepTranscript(contentHash, transcript) {
    const key = transcriptKey(contentHash);
    this.transcriptStore.set(key, transcript);
    this.transcriptCache.set(key, transcript);
  },

  /**
   * The moments in this folder's videos where the phrase closed in quotes at
   * the caret is said, as a claim whose candidates are the spoken sentences,
   * each at the time the phrase starts. Null when no phrase is quoted there
   * or no video says it, so the writing goes on as it would without videos.
   */
  quotedVideoMoments(projectId, input, cursor) {
    const quoted = quotedPhraseAtCaret(String(input.text ?? ''), cursor);
    if (!quoted) return null;
    const wanted = phraseTokens(quoted.phrase);
    const project = this.timeline.getProject(projectId);
    // A version still being read is not read here: a keystroke never waits for a video to be heard.
    if (!wanted.length || !this.isIndexed(project.currentSnapshotId)) return null;
    const videos = this.timeline.snapshotFiles(project.currentSnapshotId).filter((file) => file.fileType === 'video');
    if (!videos.length) return null;
    const segments = this.objectsAt(projectId, project.currentSnapshotId, ['DOCUMENT'])
      .filter((object) => object.metadata.componentType === 'VIDEO_SEGMENT');
    const candidates = [];
    // The citation follows the closing quote with one space between them.
    const spaced = /\s$/.test(String(input.text ?? '').slice(0, cursor));
    for (const file of videos) {
      const transcript = this.keptTranscript(file.contentHash);
      if (!transcript) continue;
      const objects = segments.filter((object) => object.path === file.path);
      for (const moment of phraseMoments(wanted, transcript.segments)) {
        const spoken = transcript.segments[moment.segmentIndex];
        const object = objects.find((candidate) => candidate.anchor?.start === spoken.start && candidate.valueText === spoken.text);
        if (!object || candidates.some((candidate) => candidate.id === object.id)) continue;
        candidates.push(videoMoment(object, file, quoted.phrase, moment.time, spaced));
      }
    }
    if (!candidates.length) return null;
    return {
      type: 'QUOTED_PHRASE', text: quoted.phrase, value: quoted.phrase, start: quoted.start, end: quoted.end,
      quote: quoted.quote, candidates: candidates.slice(0, MAX_MOMENTS),
    };
  },

  /** Where a snapshot's video is in its folder on this Mac, for the card's player. */
  videoLocalPath(snapshotId, filePath) {
    const row = this.db.prepare('SELECT p.root_path AS rootPath FROM snapshots s JOIN projects p ON p.id = s.project_id WHERE s.id = ?')
      .get(snapshotId);
    return row?.rootPath ? path.join(row.rootPath, ...filePath.split('/')) : null;
  },

  /**
   * The card's preview of a spoken sentence: the transcript around it, the
   * quoted words, and the time the player starts at.
   * @param {{ path: string, contentHash: string }} file
   * @param {{ anchor?: object, valueText?: string }} source
   * @param {string} matchText the quoted phrase, when the card asks for one
   * @param {string | null} localPath where the video is on this Mac
   */
  videoPreview(file, source, matchText, localPath) {
    const transcript = this.keptTranscript(file.contentHash);
    const start = Number(source.anchor?.start) || 0;
    const segments = transcript?.segments ?? [];
    const index = Math.max(0, segments.findIndex((segment) => segment.start === start && segment.text === source.valueText));
    const wanted = phraseTokens(matchText);
    const moment = wanted.length
      ? phraseMoments(wanted, segments).find((candidate) => candidate.segmentIndex === index) : null;
    const time = moment?.time ?? start;
    const shown = segments.slice(Math.max(0, index - PREVIEW_CONTEXT_SEGMENTS), index + PREVIEW_CONTEXT_SEGMENTS + 1);
    const lines = shown.map((segment) => ({ value: `[${videoTimestamp(segment.start)}] ${segment.text}`,
      cited: segment === segments[index] }));
    const text = lines.map((line) => line.value).join('\n');
    const selectedText = moment ? matchText.trim() : String(source.valueText ?? '');
    return {
      kind: 'video', format: path.posix.extname(file.path).slice(1).toUpperCase(),
      text, lines, selectedText, selectedStart: text.toLowerCase().indexOf(selectedText.toLowerCase()),
      startTime: time, segmentStart: start, segmentEnd: Number(source.anchor?.end) || start,
      duration: transcript?.duration ?? null, localPath,
      location: `Said at ${videoTimestamp(time)}`, openAt: { time },
    };
  },
};

/** A spoken sentence offered for the phrase, at the moment the phrase starts. */
function videoMoment(object, file, phrase, time, spaced) {
  const timestamp = videoTimestamp(time);
  const fileName = path.posix.basename(file.path);
  return {
    ...object,
    anchor: { ...object.anchor, time },
    quotedPhrase: phrase,
    // Accepting cites the moment after the closing quote, linked to the video.
    completionText: `${spaced ? '' : ' '}(${fileName}, ${timestamp})`,
    matchTier: 0,
    matchStrength: 1,
    score: 1,
    reasons: [`Said at ${timestamp}`],
  };
}
