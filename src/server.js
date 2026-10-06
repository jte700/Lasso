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
  const server = http.createServer(createRequestHandler(timeline, rfi, dependencies, config, objectShares, terminal));
  return {
    config,
    db,
    timeline,
    rfi,
    dependencies,
    objectShares,
    terminal,
    server,
    close() {
      timeline.close();
      dependencies.close();
      terminal.close();
      return new Promise((resolve, reject) => {
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
      });
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
  const shutdown = () => application.close().finally(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
