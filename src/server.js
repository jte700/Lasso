import http from 'node:http';
import fs from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createConfig } from './config.js';
import { openDatabase } from './db.js';
import { TimelineService } from './history/service.js';
import { RfiService } from './history/rfi.js';
import { PredictiveProvenanceService } from './dependencies/service.js';
import { createRequestHandler } from './http/api.js';
import { ObjectShareService } from './sharing/object-share.js';
import { RemovableDriveService } from './drives/service.js';
import { createTerminal } from './terminal/service.js';
import { WorkspaceService } from './workspace.js';
import { ConnectionService } from './connections/service.js';
import { RanchService } from './ranch/service.js';
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
  const drives = new RemovableDriveService(timeline, dependencies, config);
  const workspace = new WorkspaceService({ timeline, dependencies, terminal });
  const connections = new ConnectionService({ db, timeline, dependencies, workspace, config, fetchImpl: overrides.fetch });
  const ranch = new RanchService({ timeline, dependencies, terminal, workspace, objectShares });
  if (config.watchProjects) workspace.ready = workspace.restore();
  connections.start();
  const server = http.createServer(createRequestHandler(timeline, rfi, dependencies, config, objectShares, terminal, workspace, connections, ranch));
  // Resolve ephemeral desktop ports before any share links are generated.
  server.on('listening', () => { config.port = server.address().port; });
  let closing;
  return {
    config,
    db,
    timeline,
    rfi,
    dependencies,
    objectShares,
    terminal,
    drives,
    workspace,
    connections,
    ranch,
    server,
    close() {
      if (closing) return closing;
      connections.close();
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

// realpath handles a symlinked checkout and Windows drive-letter casing.
const isEntryPoint = process.argv[1] && (() => {
  try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]); }
  catch { return false; }
})();
if (isEntryPoint) {
  const application = createApplication();
  const preferredPort = application.config.port;
  application.server.on('error', error => {
    if (process.env.LASSO_DESKTOP_NONCE && error.code === 'EADDRINUSE' && application.config.port === preferredPort && preferredPort !== 0) {
      application.config.port = 0;
      application.server.listen(0, '127.0.0.1');
    } else {
      console.error(error);
      application.close().finally(() => process.exit(1));
    }
  });
  application.server.on('listening', () => {
    console.log(`Lasso is running at http://127.0.0.1:${application.config.port}`);
    console.log(`History data: ${application.config.dataDir}`);
    if (process.env.LASSO_DESKTOP_NONCE) {
      console.log(`LASSO_READY ${JSON.stringify({ port: application.config.port, nonce: process.env.LASSO_DESKTOP_NONCE })}`);
    }
  });
  application.server.listen(preferredPort, '127.0.0.1');
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    setTimeout(() => process.exit(0), SHUTDOWN_DEADLINE_MS).unref();
    application.close().finally(() => process.exit(0));
  };
  if (process.env.LASSO_DESKTOP_NONCE) {
    // Only the parent holding this child's private stdin can request shutdown.
    // EOF also closes the child if its desktop host exits unexpectedly.
    const control = createInterface({ input: process.stdin });
    control.on('line', line => {
      if (line === `LASSO_SHUTDOWN ${process.env.LASSO_DESKTOP_NONCE}`) shutdown();
    });
    control.on('close', shutdown);
  }
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
