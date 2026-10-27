// Lasso's retrieval engine without its app around it: the same store, the
// same snapshot and object services and the same search graph, opened by an
// agent process only for as long as an agent is connected. It starts no
// HTTP server, watches no folders, syncs no connected apps and leaves the
// removable-drive state alone, so it can run beside the desktop app (both
// read the store in WAL mode) or on its own when the app is closed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createConfig } from '../config.js';
import { openDatabase } from '../db.js';
import { TimelineService } from '../history/service.js';
import { RfiService } from '../history/rfi.js';
import { PredictiveProvenanceService } from '../dependencies/service.js';
import { createTerminal } from '../terminal/service.js';
import { WorkspaceService } from '../workspace.js';
import { AgentScope } from './scope.js';
import { EvidenceService } from './evidence.js';
import { AgentMetrics } from './metrics.js';

/**
 * Where the person's Lasso keeps its data: an explicit choice, then
 * LASSO_DATA_DIR, then the desktop app's own folder when it exists, then the
 * development default beside the checkout.
 */
export function resolveDataDir(explicit = null, { env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (explicit) return path.resolve(explicit);
  if (env.LASSO_DATA_DIR) return path.resolve(env.LASSO_DATA_DIR);
  const desktop = platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Lasso', 'data')
    : platform === 'win32' && env.APPDATA ? path.join(env.APPDATA, 'Lasso', 'data') : null;
  if (desktop && fs.existsSync(path.join(desktop, 'timeline.sqlite'))) return desktop;
  return createConfig().dataDir;
}

/**
 * @param {{ dataDir: string, scope: string[], metrics?: AgentMetrics }} options
 */
export function openEngine({ dataDir, scope = [], metrics = new AgentMetrics() }) {
  const started = performance.now();
  const config = createConfig({ dataDir, watchProjects: false, syncConnections: false, port: 0 });
  if (!fs.existsSync(config.databasePath)) {
    throw new Error(`No Lasso library at ${config.dataDir}. Open Lasso and add a folder first, or pass --data-dir.`);
  }
  const db = openDatabase(config);
  const timeline = new TimelineService(db, config);
  const rfi = new RfiService(timeline);
  const dependencies = new PredictiveProvenanceService(timeline, rfi);
  timeline.dependencies = dependencies;
  rfi.dependencies = dependencies;
  const terminal = createTerminal({ timeline, dependencies, objectShares: null });
  const workspace = new WorkspaceService({ timeline, dependencies, terminal });
  const agentScope = new AgentScope({ db, dependencies, rules: terminal.rules, folders: scope });
  const evidence = new EvidenceService({ timeline, dependencies, graph: terminal.graph, scope: agentScope, metrics });
  const openedMs = performance.now() - started;
  metrics.note('engineOpenMs', Math.round(openedMs));
  let closed = false;
  return {
    config, db, timeline, dependencies, terminal, workspace, scope: agentScope, evidence, metrics, openedMs,
    close() {
      if (closed) return;
      closed = true;
      workspace.closed = true;
      terminal.close();
      dependencies.close();
      timeline.close();
      db.close();
    },
  };
}
