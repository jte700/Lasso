// A folder's videos as the service reads them: each heard once (off the
// thread when the caller can wait), kept by content, and searched word for
// word when the writer closes a phrase in quotes.

import path from 'node:path';
import { phraseMoments, phraseTokens, quotedPhraseAtCaret, videoTimestamp } from './quoted-phrase.js';
import {
  isKeptTranscript, reportTranscriptProblem, transcribeVideo, transcribeVideoNow, transcriptDisplayLines, transcriptExcerpts, transcriptKey,
  transcriptProblem, untranscribableLine, videoDescriptors,
} from './video-extraction.js';

// The moments one quoted phrase offers, at most; one per segment.
const MAX_MOMENTS = 8;
// Transcript lines shown around the quoted one in a preview.
const PREVIEW_CONTEXT_SEGMENTS = 6;
// The mark that closes each opening quote, so a citation closes the quote the writer opened.
const CLOSING_QUOTES = Object.freeze({ '"': '"', '“': '”', '„': '“', "'": "'", '‘': '’' });
// A time asked for past this is not a moment of any video: a day.
const MAX_VIDEO_SECONDS = 86_400;

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
    const typed = String(input.text ?? '').slice(0, cursor);
    const candidates = [];
    for (const file of videos) {
      const transcript = this.keptTranscript(file.contentHash);
      if (!transcript) continue;
      const objects = segments.filter((object) => object.path === file.path);
      const excerpts = transcriptExcerpts(transcript);
      for (const moment of phraseMoments(wanted, transcript.segments, { partialLast: quoted.partialLast })) {
        const excerpt = excerpts.find((candidate) => candidate.start <= moment.time && moment.time < candidate.end);
        const object = excerpt && objects.find((candidate) => candidate.anchor?.start === excerpt.start && candidate.valueText === excerpt.text);
        if (!object || candidates.some((candidate) => candidate.id === object.id)) continue;
        const citation = `(${path.posix.basename(file.path)}, ${videoTimestamp(moment.time)})`;
        candidates.push(videoMoment(object, quoted.phrase, moment.time,
          quotedCompletion(quoted, typed, wanted, moment, citation, transcript.segments[moment.endSegmentIndex])));
      }
    }
    if (!candidates.length) return null;
    return {
      type: 'QUOTED_PHRASE', text: quoted.phrase, value: quoted.phrase, start: quoted.start, end: quoted.end,
      quote: quoted.quote, open: quoted.open, candidates: candidates.slice(0, MAX_MOMENTS),
    };
  },

  /** Where a snapshot's video is in its folder on this Mac, for the card's player. */
  videoLocalPath(snapshotId, filePath) {
    const row = this.db.prepare('SELECT p.root_path AS rootPath FROM snapshots s JOIN projects p ON p.id = s.project_id WHERE s.id = ?')
      .get(snapshotId);
    return row?.rootPath ? path.join(row.rootPath, ...filePath.split('/')) : null;
  },

  /**
   * The transcript around a spoken sentence: its segments, the sentence's
   * place among them (-1 when the source is the video itself), and the lines
   * shown. A video with no transcript shows one line saying why.
   */
  videoTranscriptLines(file, source) {
    const transcript = this.keptTranscript(file.contentHash);
    const start = Number(source.anchor?.start) || 0;
    const segments = transcript?.segments ?? [];
    if (!segments.length) {
      const reason = transcript ? transcriptProblem(transcript)
        : source.metadata?.transcriptProblem ?? 'This video has not been transcribed yet.';
      return { transcript, segments, index: -1, start, lines: [untranscribableLine(reason)] };
    }
    const excerpts = transcriptExcerpts(transcript);
    const index = source.anchor?.kind === 'video-time'
      ? excerpts.findIndex((excerpt) => excerpt.start === start && excerpt.text === source.valueText) : -1;
    return { transcript, segments, excerpt: excerpts[index] ?? null, index, start,
      lines: transcriptDisplayLines(transcript, index, { segments: excerpts }) };
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
    const { transcript, segments, excerpt, start, lines } = this.videoTranscriptLines(file, source);
    const wanted = phraseTokens(matchText);
    // The card asks with the words typed so far, so the last may be unfinished.
    const moment = wanted.length && excerpt ? phraseMoments(wanted, segments, { partialLast: true })
      .find((candidate) => excerpt.start <= candidate.time && candidate.time < excerpt.end) : null;
    const time = moment?.time ?? start;
    const shown = lines.map((line) => ({ value: line.timestamp ? `[${line.timestamp}] ${line.text}` : line.text, cited: line.cited }));
    const text = shown.map((line) => line.value).join('\n');
    const selectedText = moment ? matchText.trim() : String(source.valueText ?? '');
    return {
      kind: 'video', format: path.posix.extname(file.path).slice(1).toUpperCase(),
      text, lines: shown, selectedText,
      selectedStart: text.toLowerCase().indexOf(selectedText.toLowerCase()),
      startTime: time, segmentStart: start, segmentEnd: Number(source.anchor?.end) || start,
      duration: transcript?.duration ?? null, localPath,
      location: `Said at ${videoTimestamp(time)}`, openAt: { time },
    };
  },

  /**
   * The source inspector's video: played from `fileUrl` at the moment a link
   * cites (`time`, the exact second the quoted words start), or at its
   * sentence's start when the link has none, over the transcript around it.
   */
  videoInspectorPreview(file, source, time, fileUrl) {
    const { transcript, start, lines } = this.videoTranscriptLines(file, source);
    const latest = transcript?.duration || MAX_VIDEO_SECONDS;
    const asked = time == null || time === '' ? NaN : Number(time);
    const moment = Number.isFinite(asked) && asked >= 0 && asked <= latest ? Math.round(asked * 1000) / 1000 : start;
    return {
      kind: 'video', fileUrl, startTime: moment, duration: transcript?.duration ?? null,
      lines: lines.map(({ timestamp, text, cited }) => ({ timestamp, text, cited })),
      location: `Said at ${videoTimestamp(moment)}`, openAt: { time: moment },
    };
  },
};

/**
 * What accepting a moment types at the caret: the rest of a word still being
 * typed and the quote's closing mark when it is open, then the citation.
 */
function quotedCompletion(quoted, typed, wanted, moment, citation, sentence) {
  if (!quoted.open) return `${/\s$/.test(typed) ? '' : ' '}${citation}`;
  // The rest of a word still being typed, then the rest of the sentence it is said in.
  const word = quoted.partialLast ? moment.lastWord.slice(wanted.at(-1).length) : '';
  const following = (sentence?.words ?? []).slice(moment.endWordIndex + 1).map((spoken) => spoken.text).join(' ');
  const joiner = following && (quoted.partialLast || !/\s$/.test(typed)) ? ' ' : '';
  return `${word}${joiner}${following}${CLOSING_QUOTES[typed[quoted.start]] ?? '"'} ${citation}`;
}

/** A spoken sentence offered for the phrase, at the moment the phrase starts. */
function videoMoment(object, phrase, time, completionText) {
  return {
    ...object,
    anchor: { ...object.anchor, time },
    quotedPhrase: phrase,
    // Accepting cites the moment, linked to the video.
    completionText,
    matchTier: 0,
    matchStrength: 1,
    score: 1,
    reasons: [`Said at ${videoTimestamp(time)}`],
  };
}
