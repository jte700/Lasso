// A file's history in git, for a file in a repository: whether its bytes
// now are committed, the commits that touched it and who made them, the
// first commit that held these exact bytes, and `git blame`. Git is asked
// only inside a repository and only when a real git is installed, so a Mac
// without the developer tools never shows Apple's install prompt.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SYSTEM } from './disk-facts.js';
import { commitAis } from './ai-facts.js';

// Hash, author, address, time, subject, then the Co-authored-by trailers, which name an AI that helped.
const FORMAT = '%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%(trailers:key=Co-authored-by,valueonly,separator=%x1e)';
/** Commits a blame asks git about for their AI co-authors. */
const MOST_BLAME_COMMITS = 300;
const MAX_COMMITS = 12;
export const MAX_BLAME_LINES = 400;

/** The repository a path sits in (the folder holding `.git`), or null. */
export function repositoryOf(target) {
  let folder = path.resolve(target);
  try { if (!fs.statSync(folder).isDirectory()) folder = path.dirname(folder); } catch { folder = path.dirname(folder); }
  for (let depth = 0; depth < 60; depth += 1) {
    if (fs.existsSync(path.join(folder, '.git'))) return folder;
    const parent = path.dirname(folder);
    if (parent === folder) return null;
    folder = parent;
  }
  return null;
}

/** Whether running `git` would run git, rather than the stand-in that asks to install Apple's tools. */
function gitInstalled(system) {
  if (system.gitInstalled !== undefined) return system.gitInstalled;
  if (system.platform !== 'darwin') return true;
  const paths = String(process.env.PATH ?? '').split(':').filter(Boolean);
  if (paths.some((folder) => folder !== '/usr/bin' && fs.existsSync(path.join(folder, 'git')))) return true;
  return Boolean(system.run('xcode-select', ['-p'], { timeout: 1500 })?.trim());
}

function gitIn(root, system) {
  if (!root || !gitInstalled(system)) return null;
  return (args, options = {}) => system.run('git', ['-C', root, '-c', 'core.quotepath=off', ...args], { timeout: 10_000, ...options });
}

const parseLog = (output) => String(output ?? '').split('\n').filter(Boolean).map((line) => {
  const [hash, name, email, at, subject, trailers] = line.split('\x1f');
  return { hash, short: hash.slice(0, 7), author: name, email, at, subject, ai: commitAis(name, email, trailers) };
});

/** An address without any name or token written into it. */
const cleanRemote = (remote) => (remote ? remote.replace(/\/\/[^/@]+@/, '//') : null);

/**
 * { root, path, tracked, state (clean | modified | untracked | ignored),
 * commits, firstWithBytes, remote } for a file in a repository; null
 * outside one.
 */
export function gitFacts(absolute, { system = SYSTEM } = {}) {
  const root = repositoryOf(absolute);
  const git = gitIn(root, system);
  if (!git) return null;
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  const status = git(['status', '--porcelain', '--ignored', '--', relative]);
  if (status === null) return null;
  const tracked = git(['ls-files', '--error-unmatch', '--', relative]) !== null;
  const code = status.slice(0, 2);
  const state = code === '??' ? 'untracked' : code === '!!' ? 'ignored' : status.trim() ? 'modified' : tracked ? 'clean' : 'untracked';
  const commits = tracked ? parseLog(git(['log', '--follow', '-n', String(MAX_COMMITS), `--format=${FORMAT}`, '--', relative])) : [];
  const blob = git(['hash-object', '--', relative])?.trim();
  // Commits that added or removed these exact bytes anywhere in the repository; the oldest added them first.
  const holding = blob ? parseLog(git(['log', '--all', '-n', '40', `--format=${FORMAT}`, `--find-object=${blob}`])) : [];
  return { root, path: relative, tracked, state, commits, firstWithBytes: holding.at(-1) ?? null,
    remote: cleanRemote(git(['config', '--get', 'remote.origin.url'])?.trim() || null) };
}

/**
 * Who last changed each line of a file, from `git blame`: lines in order,
 * each with its commit, author and time, and a tally by author. Null
 * outside a repository or for a file git does not track.
 */
export function gitBlame(absolute, { system = SYSTEM, limit = MAX_BLAME_LINES } = {}) {
  const root = repositoryOf(absolute);
  const git = gitIn(root, system);
  if (!git) return null;
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  if (git(['ls-files', '--error-unmatch', '--', relative]) === null) return null;
  const output = git(['blame', '--line-porcelain', '--', relative], { timeout: 20_000 });
  if (output === null) return null;
  const lines = [];
  const commits = new Map();
  let current = null;
  for (const line of output.split('\n')) {
    const head = line.match(/^([0-9a-f]{40}) \d+ (\d+)/);
    if (head) {
      current = commits.get(head[1]) ?? { hash: head[1], short: head[1].slice(0, 7), committed: !/^0+$/.test(head[1]) };
      commits.set(head[1], current);
      lines.push({ number: Number(head[2]), commit: current, text: '' });
      continue;
    }
    if (!current) continue;
    if (line.startsWith('\t')) lines.at(-1).text = line.slice(1);
    else if (line.startsWith('author ')) current.author = current.committed ? line.slice(7) : null;
    else if (line.startsWith('author-time ')) current.at = new Date(Number(line.slice(12)) * 1000).toISOString();
    else if (line.startsWith('summary ')) current.subject = line.slice(8);
  }
  // Which commits an AI made or helped write, read from their authors and trailers in one call.
  const hashes = [...commits.values()].filter((commit) => commit.committed).map((commit) => commit.hash).slice(0, MOST_BLAME_COMMITS);
  if (hashes.length) {
    for (const commit of parseLog(git(['log', '--no-walk=unsorted', `--format=${FORMAT}`, ...hashes]))) {
      if (commits.has(commit.hash)) commits.get(commit.hash).ai = commit.ai;
    }
  }
  const authors = new Map();
  const ais = new Map();
  for (const line of lines) {
    const name = line.commit.committed ? line.commit.author : null;
    const key = name ?? '\u0000';
    const entry = authors.get(key) ?? { name, lines: 0, last: null };
    entry.lines += 1;
    if (line.commit.at && (!entry.last || line.commit.at > entry.last)) entry.last = line.commit.at;
    authors.set(key, entry);
    for (const ai of line.commit.ai ?? []) ais.set(ai, (ais.get(ai) ?? 0) + 1);
  }
  return { root, path: relative, total: lines.length, lines: lines.slice(0, limit).map((line) => ({ number: line.number, text: line.text,
    hash: line.commit.committed ? line.commit.short : null, author: line.commit.author ?? null, at: line.commit.committed ? line.commit.at : null,
    subject: line.commit.subject ?? null, ai: line.commit.ai ?? [] })), authors: [...authors.values()].sort((a, b) => b.lines - a.lines),
  ais: [...ais].map(([name, count]) => ({ name, lines: count })).sort((a, b) => b.lines - a.lines) };
}

/** A folder's commits since a time, newest first, when it is in a repository. */
export function folderCommits(folder, from, { system = SYSTEM, limit = 15 } = {}) {
  const root = repositoryOf(folder);
  const git = gitIn(root, system);
  if (!git) return [];
  const relative = path.relative(root, folder).split(path.sep).join('/') || '.';
  return parseLog(git(['log', `--since=${new Date(from).toISOString()}`, '-n', String(limit), `--format=${FORMAT}`, '--', relative]));
}

/** The file's bytes as of its last commit (or the one before, when it is unchanged since), for comparing. */
export function committedVersion(absolute, { system = SYSTEM } = {}) {
  const facts = gitFacts(absolute, { system });
  if (!facts?.tracked || !facts.commits.length) return null;
  const git = gitIn(facts.root, system);
  const against = facts.state === 'modified' ? facts.commits[0] : facts.commits[1];
  if (!against) return null;
  const blob = git(['rev-parse', `${against.hash}:${facts.path}`])?.trim();
  if (!blob) return null;
  const bytes = gitBytes(facts.root, blob, system);
  return bytes ? { commit: against, bytes, state: facts.state, newer: facts.state === 'modified' ? null : facts.commits[0] } : null;
}

/** A blob's bytes as they are, since `system.run` reads output as text. */
function gitBytes(root, blob, system) {
  if (system.runBytes) return system.runBytes('git', ['-C', root, 'cat-file', 'blob', blob]);
  try {
    return execFileSync('git', ['-C', root, 'cat-file', 'blob', blob], { maxBuffer: 64 << 20, timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}
