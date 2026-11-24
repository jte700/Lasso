// What a file or its git history says on its own about an AI having made
// it, for files Lasso never saw being written: the IPTC digital source type
// an image or video carries in its XMP, the tools named in its Content
// Credentials (C2PA), the generation settings Stable Diffusion, ComfyUI or
// InvokeAI write into a PNG, the AI record a Lasso wrote into a Word
// document, and commits an AI made or is named a co-author of. Each is a
// label a tool wrote; nothing is guessed from the content.

import fs from 'node:fs';
import { inflateSync } from 'node:zlib';
import { readCarried } from '../provenance/carried-record.js';

/** Files whose own bytes may carry these labels. */
const LABELLED = /\.(png|jpe?g|webp|heic|heif|avif|gif|tiff?|dng|mp4|mov|m4v|m4a|mp3|wav|pdf|svg)$/i;
/** How much of a file is read for them: XMP and Content Credentials sit near the start. */
const HEAD_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_CHUNK = 1024 * 1024;

/** The IPTC digital source types that name a trained model, in the IPTC's own words. */
const SOURCE_TYPES = new Map([
  ['trainedalgorithmicmedia', 'trained algorithmic media'],
  ['compositewithtrainedalgorithmicmedia', 'composite with trained algorithmic media'],
]);

/** PNG text keys that generators write, and who writes them. */
const GENERATION_KEYS = new Map([
  ['parameters', null], ['prompt', 'ComfyUI'], ['workflow', 'ComfyUI'],
  ['invokeai_metadata', 'InvokeAI'], ['sd-metadata', 'InvokeAI'], ['dream', 'InvokeAI'],
]);

/**
 * { sourceType, credentials, generation, software, madeWithAi } for a
 * file, or null when it carries no source type, credentials or generation
 * settings. madeWithAi: the file itself says a trained model made it.
 */
export function aiLabels(absolute) {
  if (/\.docx$/i.test(absolute)) return recordLabels(absolute);
  if (!LABELLED.test(absolute)) return null;
  let head;
  try { head = readHead(absolute, HEAD_BYTES); } catch { return null; }
  const texts = isPng(head) ? pngTexts(absolute) : [];
  const found = { sourceType: null, credentials: null, generation: null, software: null };
  for (const source of [head, ...texts.map((entry) => Buffer.from(entry.text, 'utf8'))]) {
    found.sourceType ??= sourceTypeIn(source.toString('latin1'));
  }
  const generators = credentialTools(head);
  for (const entry of texts.filter((text) => text.key === 'caBX')) generators.push(...credentialTools(Buffer.from(entry.text, 'latin1')));
  if (generators.length || /jumb[\s\S]{0,64}c2pa/.test(head.toString('latin1'))) {
    found.credentials = { tools: [...new Set(generators)] };
  }
  for (const entry of texts) {
    const key = entry.key.toLowerCase();
    if (GENERATION_KEYS.has(key) && !found.generation) {
      found.generation = { key: entry.key, by: GENERATION_KEYS.get(key), text: entry.text.replace(/\s+/g, ' ').trim().slice(0, 400) };
    }
    if (key === 'software' && entry.text.trim()) found.software = entry.text.trim().slice(0, 80);
  }
  // A Software tag alone ("PyMOL") says nothing of AI; Content Credentials say who made it, AI or not.
  found.madeWithAi = Boolean(found.sourceType || found.generation);
  return found.sourceType || found.credentials || found.generation ? found : null;
}

/** A Word document's Lasso record: who recorded it, whether its signature holds, and which AIs wrote how many parts. */
function recordLabels(absolute) {
  let carried = null;
  try {
    if (fs.statSync(absolute).size <= LONGEST_DOCUMENT) carried = readCarried(fs.readFileSync(absolute));
  } catch { return null; }
  if (!carried) return null;
  const agentOf = new Map((carried.payload.marks ?? []).map((mark) => [mark.id, String(mark.agent ?? 'AI')]));
  const agents = new Map();
  for (const span of carried.payload.spans ?? []) {
    const name = agentOf.get(span.mark);
    if (!name) continue;
    const entry = agents.get(name) ?? { name, parts: 0, characters: 0 };
    entry.parts += 1;
    entry.characters += String(span.text ?? '').length;
    agents.set(name, entry);
  }
  const record = { by: carried.signer.name, valid: carried.valid, writtenAt: carried.payload.writtenAt ?? null,
    agents: carried.valid ? [...agents.values()] : [] };
  return { sourceType: null, credentials: null, generation: null, software: null, record,
    madeWithAi: Boolean(carried.valid && agents.size) };
}

const LONGEST_DOCUMENT = 64 * 1024 * 1024;

function readHead(file, length) {
  const handle = fs.openSync(file, 'r');
  try {
    const size = Math.min(length, fs.fstatSync(handle).size);
    const buffer = Buffer.alloc(size);
    fs.readSync(handle, buffer, 0, size, 0);
    return buffer;
  } finally {
    fs.closeSync(handle);
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPng = (buffer) => buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);

/** The IPTC words for the digital source type named in some text, when it names a trained model. */
export function sourceTypeIn(text) {
  const match = String(text).match(/digitalsourcetype\/([A-Za-z]+)/i);
  const code = match?.[1]?.toLowerCase();
  return code && SOURCE_TYPES.has(code) ? { code: match[1], words: SOURCE_TYPES.get(code) } : null;
}

/**
 * The tools a Content Credentials manifest names: its claim generator, the
 * names in its claim generator info, and each action's software agent, as
 * CBOR text found after those keys. Library versions ("c2pa-rs/0.31") are
 * left out.
 */
export function credentialTools(buffer) {
  const tools = [];
  const latin = buffer.toString('latin1');
  const keyed = (key, read) => {
    const header = String.fromCharCode(0x60 + key.length);
    let at = latin.indexOf(`${header}${key}`);
    while (at !== -1 && tools.length < 12) {
      read(at + 1 + key.length);
      at = latin.indexOf(`${header}${key}`, at + 1);
    }
  };
  const named = (from) => {
    // A map's "name" within the next few fields.
    const near = latin.slice(from, from + 240);
    const at = near.indexOf('\x64name');
    return at === -1 ? null : cborText(buffer, from + at + 5);
  };
  keyed('claim_generator', (from) => tools.push(cborText(buffer, from)));
  keyed('claim_generator_info', (from) => tools.push(named(from)));
  keyed('softwareAgent', (from) => tools.push(cborText(buffer, from) ?? named(from)));
  return tools.map(cleanTool).filter(Boolean);
}

const cleanTool = (value) => {
  if (!value) return null;
  const words = String(value).split(/\s+/).filter((word) => word && !/^c2pa[-_\w]*\/[\d.]+/i.test(word));
  const text = words.join(' ').replace(/_/g, ' ').replace(/\/[\d.]+$/, '').trim();
  return text && /\p{L}/u.test(text) ? text.slice(0, 60) : null;
};

/** A CBOR text string starting at `at`, or null. */
function cborText(buffer, at) {
  const head = buffer[at];
  let length;
  let start;
  if (head >= 0x60 && head <= 0x77) { length = head - 0x60; start = at + 1; }
  else if (head === 0x78) { length = buffer[at + 1]; start = at + 2; }
  else if (head === 0x79) { length = buffer.readUInt16BE(at + 1); start = at + 3; }
  else return null;
  if (!Number.isFinite(length) || length > 400 || start + length > buffer.length) return null;
  return buffer.toString('utf8', start, start + length);
}

/** A PNG's text chunks ({ key, text }) and its Content Credentials chunk, read a chunk at a time. */
export function pngTexts(file) {
  const out = [];
  const handle = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(handle).size;
    const header = Buffer.alloc(8);
    let at = 8;
    for (let count = 0; at + 8 <= size && count < 10_000; count += 1) {
      fs.readSync(handle, header, 0, 8, at);
      const length = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      if (['tEXt', 'iTXt', 'zTXt', 'caBX'].includes(type) && length <= (type === 'caBX' ? HEAD_BYTES : MAX_TEXT_CHUNK)) {
        const data = Buffer.alloc(length);
        fs.readSync(handle, data, 0, length, at + 8);
        const entry = type === 'caBX' ? { key: 'caBX', text: data.toString('latin1') } : textChunk(type, data);
        if (entry) out.push(entry);
      }
      if (type === 'IEND') break;
      at += 12 + length;
    }
  } finally {
    fs.closeSync(handle);
  }
  return out;
}

function textChunk(type, data) {
  const zero = data.indexOf(0);
  if (zero <= 0) return null;
  const key = data.toString('latin1', 0, zero);
  try {
    if (type === 'tEXt') return { key, text: data.toString('latin1', zero + 1) };
    if (type === 'zTXt') return { key, text: inflateSync(data.subarray(zero + 2)).toString('latin1') };
    // iTXt: compression flag, method, language and translated keyword, then the text.
    const compressed = data[zero + 1] === 1;
    const language = data.indexOf(0, zero + 3);
    const translated = data.indexOf(0, language + 1);
    if (language === -1 || translated === -1) return null;
    const body = data.subarray(translated + 1);
    return { key, text: (compressed ? inflateSync(body) : body).toString('utf8') };
  } catch {
    return null;
  }
}

// ── git ──────────────────────────────────────────────────────────────────

/** Addresses only an AI's commits use. */
const AI_ADDRESSES = [
  [/^noreply@anthropic\.com$/, 'Claude'],
  [/^(noreply|codex|chatgpt)[^@]*@openai\.com$/, 'ChatGPT'],
  [/(^|\+)copilot@users\.noreply\.github\.com$/, 'Copilot'],
  [/^cursoragent@cursor\.com$/, 'Cursor'],
  [/@aider\.chat$/, 'Aider'],
];
/** Bot accounts ("claude[bot]", "copilot-swe-agent[bot]") named for an AI. */
const AI_BOTS = [['claude', 'Claude'], ['copilot', 'Copilot'], ['gemini', 'Gemini'], ['devin', 'Devin'], ['codex', 'ChatGPT'],
  ['chatgpt', 'ChatGPT'], ['openai', 'ChatGPT'], ['cursor', 'Cursor']];

/**
 * The AI a git identity is, from its address or bot account, or null. A
 * person's name alone never counts: "Claude" is also a person's name.
 */
export function aiIdentity(name, email) {
  const address = String(email ?? '').trim().toLowerCase();
  const said = String(name ?? '').trim().toLowerCase();
  const byAddress = AI_ADDRESSES.find(([pattern]) => pattern.test(address));
  if (byAddress) return byAddress[1];
  if (/\[bot\]$/.test(said) || /\[bot\]@users\.noreply\.github\.com$/.test(address)) {
    const bot = AI_BOTS.find(([prefix]) => said.startsWith(prefix) || address.replace(/^\d+\+/, '').startsWith(prefix));
    if (bot) return bot[1];
  }
  if (/\(aider\)$/.test(said)) return 'Aider';
  return null;
}

/** The AIs a commit names: its author when that is one, and its Co-authored-by trailers. */
export function commitAis(author, email, trailers) {
  const found = [aiIdentity(author, email)];
  for (const value of String(trailers ?? '').split('\x1e')) {
    const match = value.trim().match(/^(.*?)\s*<([^>]*)>$/);
    if (match) found.push(aiIdentity(match[1], match[2]));
  }
  return [...new Set(found.filter(Boolean))];
}
