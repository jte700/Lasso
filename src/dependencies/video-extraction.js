// Videos read as what is said in them: the sound track transcribed on this
// Mac by scripts/transcribe-video.swift (macOS's own on-device speech model),
// one object per spoken sentence with the time it starts and ends. A
// transcript depends only on the file's bytes, so it is kept by content hash
// and a video is heard once however often its folder is read again.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { execute, swiftHelper } from '../sharing/swift-helper.js';
import { sha } from './basics.js';
import { objectDescriptor } from './object-descriptors.js';

// Bumped when the helper hears differently enough that kept transcripts should be heard again.
// 2: QuickTime movies are heard; stored without their extension, they read as having no sound.
export const TRANSCRIPT_VERSION = 2;
// Speech is heard about twenty to thirty times faster than it plays, so an
// hour of video takes two or three minutes; this stops a stuck reading.
const TRANSCRIBE_TIMEOUT_MS = 30 * 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_SEGMENTS = 20_000;
const MAX_SEGMENT_TEXT = 2_000;
const MAX_WORDS_PER_SEGMENT = 400;
const LABEL_LENGTH = 110;
// Readings that hold for these bytes on this Mac: kept. A missing speech model
// or a failed run may succeed later, so those are heard again next time.
const KEPT_STATUSES = new Set(['ok', 'no-audio']);

const helper = swiftHelper('transcribe-video', ['AVFoundation', 'Speech'], 'Video transcripts are made on a Mac.');
let runs = 0;

/** How many times this process has run the transcriber; a video kept already is not heard again. */
export function transcriptionRuns() {
  return runs;
}

export function transcriptKey(contentHash) {
  return `${contentHash}|video|transcript`;
}

/** Whether a reading is the same for these bytes from now on. */
export function isKeptTranscript(transcript) {
  return KEPT_STATUSES.has(transcript?.status);
}

/**
 * The stored bytes under a name with the video's own extension. Stored files
 * have none, and macOS tells a QuickTime movie only by its extension; an
 * MPEG-4 file it recognises either way.
 * @returns {{ path: string, remove: () => void }}
 */
function namedLink(blobPath, extension) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-video-'));
  const link = path.join(directory, `video${/^\.[a-z0-9]{1,8}$/i.test(extension) ? extension.toLowerCase() : ''}`);
  fs.symlinkSync(blobPath, link);
  return { path: link, remove: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

/**
 * Hears a video's sound track off this thread.
 * @param {string} blobPath the video's stored bytes
 * @param {string} extension the video's own, such as ".mov"
 * @returns {Promise<Transcript>}
 */
export async function transcribeVideo(blobPath, extension) {
  runs += 1;
  let named = null;
  try {
    named = namedLink(blobPath, extension);
    const executable = await helper();
    const { stdout } = await execute(executable, [named.path], { timeout: TRANSCRIBE_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES });
    return normalizedTranscript(JSON.parse(stdout));
  } catch (error) {
    return failed(error);
  } finally {
    named?.remove();
  }
}

/** The same, for a caller that must have the transcript now. */
export function transcribeVideoNow(blobPath, extension) {
  runs += 1;
  let named = null;
  try {
    named = namedLink(blobPath, extension);
    const stdout = execFileSync(helper.sync(), [named.path], { timeout: TRANSCRIBE_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES });
    return normalizedTranscript(JSON.parse(String(stdout)));
  } catch (error) {
    return failed(error);
  } finally {
    named?.remove();
  }
}

function failed(error) {
  return { status: 'failed', reason: error?.killed ? 'Transcribing this video took too long.' : 'This video could not be transcribed.' };
}

/**
 * @typedef {{ text: string, start: number, end: number }} SpokenWord
 * @typedef {{ start: number, end: number, text: string, words: SpokenWord[] }} SpokenSegment
 * @typedef {{ status: string, reason?: string, locale?: string, duration?: number, segments: SpokenSegment[] }} Transcript
 */

/**
 * The helper's output with every field checked: times are finite seconds
 * rounded to milliseconds, text is trimmed and bounded.
 * @param {unknown} raw
 * @returns {Transcript}
 */
export function normalizedTranscript(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const status = typeof value.status === 'string' ? value.status : 'failed';
  if (status !== 'ok') {
    return { status, reason: typeof value.reason === 'string' ? value.reason.slice(0, 300) : 'This video could not be transcribed.', segments: [] };
  }
  const segments = (Array.isArray(value.segments) ? value.segments : []).slice(0, MAX_SEGMENTS).flatMap((segment) => {
    const text = cleanText(segment?.text).slice(0, MAX_SEGMENT_TEXT);
    const start = seconds(segment?.start);
    const end = Math.max(start, seconds(segment?.end));
    if (!text) return [];
    const words = (Array.isArray(segment.words) ? segment.words : []).slice(0, MAX_WORDS_PER_SEGMENT).flatMap((word) => {
      const spoken = cleanText(word?.text);
      return spoken ? [{ text: spoken, start: seconds(word.start), end: Math.max(seconds(word.start), seconds(word.end)) }] : [];
    });
    return [{ start, end, text, words }];
  }).sort((left, right) => left.start - right.start);
  return { status, locale: typeof value.locale === 'string' ? value.locale.slice(0, 35) : null,
    duration: seconds(value.duration), segments };
}

function cleanText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function seconds(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number * 1000) / 1000 : 0;
}

/**
 * Why a reading offers nothing, in the words `index failures` reports.
 * @param {Transcript} transcript
 * @param {(code: string, reason: string) => void} report
 */
export function reportTranscriptProblem(transcript, report) {
  if (transcript.status === 'ok' && transcript.segments.length) return;
  if (transcript.status === 'ok') report('UNREADABLE_CONTENT', 'No speech was heard in this video.');
  else if (transcript.status === 'no-audio') report('UNREADABLE_CONTENT', 'This video has no sound track to transcribe.');
  else report('UNREADABLE_CONTENT', transcript.reason ?? 'This video could not be transcribed.');
}

/**
 * The video as a whole, nameable by its file name, and each spoken sentence
 * with the times it is said, offered as the video's own text.
 * @param {{ projectFileId: string, path: string, contentHash: string }} file
 * @param {Transcript} transcript
 */
export function videoDescriptors(file, transcript) {
  const fileName = path.posix.basename(file.path, path.posix.extname(file.path));
  const format = path.posix.extname(file.path).slice(1).toUpperCase();
  const base = file.projectFileId;
  const segments = transcript.status === 'ok' ? transcript.segments : [];
  const repeats = new Map();
  return [
    objectDescriptor({
      key: `${base}:video`, type: 'DOCUMENT', path: file.path, label: fileName,
      value: segments.slice(0, 3).map((segment) => segment.text).join(' ') || null,
      contentHash: file.contentHash,
      metadata: { format, componentType: 'VIDEO', fileName: path.posix.basename(file.path),
        duration: transcript.duration ?? null, locale: transcript.locale ?? null, segmentCount: segments.length },
    }),
    ...segments.map((segment) => {
      const fingerprint = sha(segment.text.toLowerCase()).slice(0, 24);
      const occurrence = repeats.get(fingerprint) ?? 0;
      repeats.set(fingerprint, occurrence + 1);
      return objectDescriptor({
        key: `${base}:video-segment:${fingerprint}:${occurrence}`, type: 'DOCUMENT', path: file.path,
        label: segment.text.length > LABEL_LENGTH ? `${segment.text.slice(0, LABEL_LENGTH - 3)}…` : segment.text,
        value: segment.text, contentHash: file.contentHash,
        anchor: { kind: 'video-time', start: segment.start, end: segment.end, selectedText: segment.text },
        metadata: { format, componentType: 'VIDEO_SEGMENT', rawText: segment.text, textExcerpt: segment.text,
          startTime: segment.start, endTime: segment.end, parentTitle: fileName },
      });
    }),
  ];
}
