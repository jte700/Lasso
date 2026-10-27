// A small Lasso library for the agent tests: two folders that each hold an
// app.py, a finance folder with two competing budgets, a note, a credential
// file, and a code file long enough to page through.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../../src/server.js';

export const actor = { id: 'human:agent-tests', displayName: 'Agent tests', actorType: 'HUMAN_SELF' };
export const agent = { id: 'agent:test', displayName: 'Test agent', actorType: 'AI_AGENT' };

export const API_APP = [
  'import json',
  '',
  '',
  '@route("/items")',
  'def handle(request):',
  '    """Return every item."""',
  '    items = load()',
  '    return json.dumps(items)',
  '',
  '',
  'def load():',
  '    return [1, 2, 3]',
  '',
  'class Store:',
  '    def get(self, key):',
  '        return self.data[key]',
  '',
  '    def put(self, key, value):',
  '        self.data[key] = value',
  '',
].join('\n');

export const WEB_APP = [
  "import { createServer } from 'node:http';",
  '',
  'export function start(port) {',
  '  const server = createServer((request, response) => {',
  "    response.end('ok');",
  '  });',
  '  server.listen(port);',
  '  return server;',
  '}',
  '',
  'export const stop = (server) => server.close();',
  '',
].join('\n');

export function writeTree(root, files) {
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
}

/** Creates the folders, adds them to a fresh library and returns the open app. */
export async function agentLibrary(t, { extra = {} } = {}) {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-agent-')));
  const files = {
    'Api/app.py': API_APP,
    'Web/src/app.py': '# The web front end lives in server.js\n',
    'Web/src/server.js': WEB_APP,
    'Finance/Planning/budget.csv': 'Division,Revenue,Reporting period,Scenario\nNorth division,12.4,FY2025,Planning\nSouth division,9.10,FY2025,Planning\n',
    'Finance/Approved/budget.csv': 'Division,Revenue,Reporting period,Scenario\nNorth division,11.9,FY2025,Approved\n',
    'Finance/notes.md': '# Notes\n\nThe North division revenue figure excludes the one-time grant.\n',
    'Finance/.env': 'API_TOKEN=hunter2-secret\n',
    'Finance/Private/salaries.csv': 'Name,Salary\nAvery,120000\n',
    ...extra,
  };
  writeTree(sandbox, files);
  const dataDir = path.join(sandbox, 'library');
  const app = createApplication({ dataDir, watchProjects: false, port: 0 });
  t.after(async () => {
    await app.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  await app.workspace.add(['Api', 'Web', 'Finance'].map((name) => path.join(sandbox, name)), actor);
  const folders = Object.fromEntries(app.workspace.state().directories.map((directory) => [directory.name, directory.id]));
  return { app, sandbox, dataDir, folders };
}
