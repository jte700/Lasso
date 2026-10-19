import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createConfig } from './config.js';
import { openDatabase } from './db.js';
import { TimelineService } from './history/service.js';
import { RfiService } from './history/rfi.js';
import { PredictiveProvenanceService } from './dependencies/service.js';
import { createRequestHandler } from './http/api.js';
import { ObjectShareService } from './sharing/object-share.js';
import { createTerminal } from './terminal/service.js';
import { WorkspaceService } from './workspace.js';
import { watchParent } from './parent-watchdog.js';

const FORCE_CLOSE_AFTER_MS = 1000;
// The desktop app force-quits a server that has not exited after 3 seconds.
const SHUTDOWN_DEADLINE_MS = 2500;

export function createApplication(overrides = {}) {
  const config = createConfig(overrides);
  const db = openDatabase(config);
  const timeline = new TimelineService(db, config);
  const rfi = new RfiService(timeline);
  const dependencies = new PredictiveProvenanceService(timeline, rfi);
  timeline.dependencies = dependencies;
  rfi.dependencies = dependencies;
  const objectShares = new ObjectShareService(db, timeline, config);
  const terminal = createTerminal({ timeline, dependencies, objectShares });
  const workspace = new WorkspaceService({ timeline, dependencies, terminal });
  if (config.watchProjects) workspace.ready = workspace.restore();
  const server = http.createServer(createRequestHandler(timeline, rfi, dependencies, config, objectShares, terminal, workspace));
  let closing;
  return {
    config,
    db,
    timeline,
    rfi,
    dependencies,
    objectShares,
    terminal,
    workspace,
    server,
    close() {
      if (closing) return closing;
      workspace.close();
      timeline.close();
      dependencies.close();
      terminal.close();
      closing = new Promise((resolve, reject) => {
        if (!server.listening) {
          db.close();
          resolve();
          return;
        }
        server.close((error) => {
          db.close();
          if (error) reject(error);
          else resolve();
        });
        // close() waits for every open connection. Drop idle keep-alive
        // sockets now and any request still open shortly after, so a stalled
        // client cannot hold the database open until the app force-quits it.
        server.closeIdleConnections();
        setTimeout(() => server.closeAllConnections(), FORCE_CLOSE_AFTER_MS).unref();
      });
      return closing;
    },
  };
}

const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntryPoint) {
  const application = createApplication();
  application.server.listen(application.config.port, '127.0.0.1', () => {
    console.log(`Lasso is running at http://127.0.0.1:${application.config.port}`);
    console.log(`History data: ${application.config.dataDir}`);
  });
  const shutdown = () => {
    setTimeout(() => process.exit(0), SHUTDOWN_DEADLINE_MS).unref();
    application.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  watchParent({
    expectedParentPid: Number(process.env.LASSO_PARENT_PID),
    onOrphaned: () => {
      console.log('Lasso app is no longer running; stopping its server.');
      shutdown();
    },
  });
}
