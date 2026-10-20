import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { normalizeProjectRootPath } from '../src/history/service.js';

const serverPath = fileURLToPath(new URL('../src/server.js', import.meta.url));

async function launch(t, preferredPort = 0) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso desktop server '));
  const nonce = randomBytes(32).toString('hex');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', serverPath], {
    cwd: directory, env: { ...process.env, PORT: String(preferredPort), LASSO_DATA_DIR: path.join(directory, 'history'), LASSO_DESKTOP_NONCE: nonce },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const closed = once(child, 'close');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode == null) child.kill();
    await closed;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const ready = await new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    const timeout = setTimeout(() => reject(new Error(`Desktop server did not start: ${stderr}`)), 10_000);
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited with ${code}: ${stderr}`)); });
    lines.on('line', line => {
      if (!line.startsWith('LASSO_READY ')) return;
      clearTimeout(timeout);
      try { resolve(JSON.parse(line.slice('LASSO_READY '.length))); } catch (error) { reject(error); }
    });
  });
  assert.equal(ready.nonce, nonce);
  assert.ok(Number.isInteger(ready.port) && ready.port > 0);
  return { child, nonce, base: `http://127.0.0.1:${ready.port}`, closed };
}

test('desktop child reports its actual port and serves installed assets from another working directory', { timeout: 15_000 }, async t => {
  const { child, nonce, base, closed } = await launch(t);
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Lasso/);
  const sharing = await (await fetch(`${base}/api/sharing/status`)).json();
  assert.equal(new URL(sharing.baseUrl).port, new URL(base).port);
  child.stdin.write('LASSO_SHUTDOWN incorrect-nonce\n');
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  child.stdin.write(`LASSO_SHUTDOWN ${nonce}\n`);
  const [code] = await closed;
  assert.equal(code, 0);
});

test('desktop child exits cleanly when its parent closes the private control pipe', { timeout: 15_000 }, async t => {
  const { child, closed } = await launch(t);
  child.stdin.end();
  const [code] = await closed;
  assert.equal(code, 0);
});

test('project folder normalization preserves quoted spaces and expands the home directory', () => {
  const folder = path.join(os.tmpdir(), 'Lasso project', ' sources');
  assert.equal(normalizeProjectRootPath(`"${folder}"`), path.resolve(folder));
  assert.equal(normalizeProjectRootPath('~'), os.homedir());
  assert.equal(normalizeProjectRootPath(process.platform === 'win32' ? '~\\Documents' : '~/Documents'), path.join(os.homedir(), 'Documents'));
});


test('desktop child falls back from an occupied preferred port without adopting its listener', { timeout: 15_000 }, async t => {
  const occupied = http.createServer((request, response) => response.end('unrelated'));
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const preferredPort = occupied.address().port;
  const { child, nonce, base, closed } = await launch(t, preferredPort);
  assert.notEqual(Number(new URL(base).port), preferredPort);
  assert.equal((await (await fetch(`${base}/api/health`)).json()).ok, true);
  assert.equal(await (await fetch(`http://127.0.0.1:${preferredPort}`)).text(), 'unrelated');
  child.stdin.write(`LASSO_SHUTDOWN ${nonce}\n`);
  assert.equal((await closed)[0], 0);
});
