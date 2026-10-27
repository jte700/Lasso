#!/usr/bin/env node
// lasso-agent: the entry point AI hosts and scripts start.
//
//   lasso-agent mcp    --scope <folder>…   MCP over stdio; exits when the host disconnects
//   lasso-agent serve  --scope <folder>…   the REST API in the foreground; stops when idle
//   lasso-agent ensure --scope <folder>…   starts the REST API if needed; prints its url and token
//   lasso-agent status | stop
//
// Common options: --data-dir <dir> (default: LASSO_DATA_DIR, then the desktop
// app's library), --idle <seconds> (REST only, default 300; 0 never idles).
// The scope can also come from LASSO_AGENT_SCOPE, as a JSON list or separated by ";".

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openEngine, resolveDataDir } from './engine.js';
import { serveMcp } from './mcp.js';
import { readDiscovery, serveAgentApi } from './rest.js';
import { ensureServer } from './client.js';

const USAGE = `Usage: lasso-agent <mcp|serve|ensure|status|stop> [--data-dir DIR] [--scope FOLDER]... [--idle SECONDS] [--port N]
  --scope names a Lasso folder (its name or root path) an agent may read; "*" shares every enabled folder.`;

export function parseArguments(argv, env = process.env) {
  const [command, ...rest] = argv;
  const options = { command, dataDir: null, scope: [], idleSeconds: 300, port: 0 };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    const needs = () => { if (value == null) throw new Error(`${flag} needs a value.`); index += 1; return value; };
    if (flag === '--data-dir') options.dataDir = needs();
    else if (flag === '--scope') options.scope.push(needs());
    else if (flag === '--idle') options.idleSeconds = Number(needs());
    else if (flag === '--port') options.port = Number(needs());
    else if (flag === '--help' || flag === '-h') options.command = 'help';
    else throw new Error(`Unknown option ${flag}.`);
  }
  if (!options.scope.length && env.LASSO_AGENT_SCOPE) {
    const raw = env.LASSO_AGENT_SCOPE.trim();
    options.scope = raw.startsWith('[') ? JSON.parse(raw) : raw.split(';').map((value) => value.trim()).filter(Boolean);
  }
  if (!Number.isFinite(options.idleSeconds) || options.idleSeconds < 0) throw new Error('--idle must be a number of seconds.');
  return options;
}

async function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    return 2;
  }
  const dataDir = resolveDataDir(options.dataDir);
  const open = () => openEngine({ dataDir, scope: options.scope });

  switch (options.command) {
    case 'mcp': {
      // stdout carries the protocol; anything the engine logs goes to stderr.
      console.log = console.info = console.warn = (...args) => console.error(...args);
      const stop = () => process.stdin.destroy();
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      await serveMcp({ open });
      // The store is closed. Anything still holding the event loop is not
      // a reason to outlive the host that started this process.
      setTimeout(() => process.exit(0), 500).unref();
      return 0;
    }
    case 'serve': {
      const served = await serveAgentApi({ dataDir, scope: options.scope, open, idleSeconds: options.idleSeconds, port: options.port });
      if (!served) {
        console.error('Lasso\'s agent API is already running for this library.');
        return 0;
      }
      console.error(`Lasso agent API at ${served.url} (pid ${process.pid}, idle stop after ${options.idleSeconds}s).`);
      const stop = () => served.stop('signal').then(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      await new Promise((resolve) => served.server.on('close', resolve));
      await served.stop('closed');
      setTimeout(() => process.exit(0), 500).unref();
      return 0;
    }
    case 'ensure': {
      const record = await ensureServer({ dataDir, scope: options.scope, idleSeconds: options.idleSeconds });
      process.stdout.write(`${JSON.stringify({ url: record.url, token: record.token, pid: record.pid, started: record.started })}\n`);
      return 0;
    }
    case 'status': {
      const record = readDiscovery(dataDir);
      process.stdout.write(`${JSON.stringify(record ? { running: true, url: record.url, pid: record.pid, scope: record.scope,
        startedAt: record.startedAt } : { running: false, dataDir })}\n`);
      return 0;
    }
    case 'stop': {
      const record = readDiscovery(dataDir);
      if (!record) { process.stdout.write('{"running":false}\n'); return 0; }
      const response = await fetch(`${record.url}/agent/v1/shutdown`, { method: 'POST',
        headers: { authorization: `Bearer ${record.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ force: true }) });
      process.stdout.write(`${JSON.stringify({ stopping: response.ok, pid: record.pid })}\n`);
      return response.ok ? 0 : 1;
    }
    default:
      console.error(USAGE);
      return options.command === 'help' ? 0 : 2;
  }
}

// realpath handles the npm bin symlink and a symlinked checkout.
const isEntryPoint = process.argv[1] && (() => {
  try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]); }
  catch { return false; }
})();
if (isEntryPoint) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
