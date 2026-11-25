// Captures the card scenes in scenes.html as the pictures and clips the pages use, in light and dark.
// Serve the site first (see README.txt), then:  node media-src/render.mjs [scene ...]
// Stills are WebP from Chrome itself; clips are H.264 MP4 from ffmpeg, with a WebP poster.
// Each frame is drawn by the scene's own tick(t), so a clip is the same every time it is made.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.BASE || 'http://localhost:8765';
const OUT = fileURLToPath(new URL('../assets/media/', import.meta.url));
const JOBS = {
  writer: 'clip', share: 'clip', loop: 'clip', autocomplete: 'clip', usb: 'clip', recording: 'clip', passage: 'clip',
  picker: 'still', provenance: 'still', mcp: 'still', 'loop-review': 'still', 'loop-sources': 'still', 'loop-share': 'still',
  card: 'still', scope: 'still', keys: 'still',
};
const STILL_PX = 1088; // twice the card's width on a wide screen
const CLIP_PX = 880;
const FPS = 30;

function launch() {
  const profile = mkdtempSync(join(tmpdir(), 'lasso-render-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', '--force-color-profile=srgb', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  return new Promise((resolve, reject) => {
    let log = '';
    chrome.stderr.on('data', (d) => {
      log += d;
      const m = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) resolve({ chrome, ws: m[1], profile });
    });
    chrome.on('exit', (code) => reject(new Error(`Chrome exited (${code}): ${log.slice(-400)}`)));
  });
}

function connect(url) {
  const socket = new WebSocket(url);
  let next = 1;
  const pending = new Map();
  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const wait = msg.id && pending.get(msg.id);
    if (!wait) return;
    pending.delete(msg.id);
    if (msg.error) wait.reject(new Error(`${wait.method}: ${msg.error.message}`)); else wait.resolve(msg.result);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject, method });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  return new Promise((resolve) => { socket.onopen = () => resolve({ send, close: () => socket.close() }); });
}

async function openScene(cdp, scene, theme, px) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => cdp.send(method, params, sessionId);
  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: px, height: px, deviceScaleFactor: 1, mobile: false });
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
  await call('Page.navigate', { url: `${BASE}/media-src/scenes.html?s=${encodeURIComponent(scene)}&theme=${theme}` });
  const evaluate = async (expression) => (await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
  for (let i = 0; i < 200 && !(await evaluate('window.ready === true')); i++) await new Promise((r) => setTimeout(r, 50));
  const paint = (t) => evaluate(`render(${t}), new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
  const shot = async (format, quality) => Buffer.from((await call('Page.captureScreenshot', { format, quality })).data, 'base64');
  return { evaluate, paint, shot, close: () => cdp.send('Target.closeTarget', { targetId }) };
}

async function still(cdp, scene, theme) {
  const page = await openScene(cdp, scene, theme, STILL_PX);
  const { still: at } = await page.evaluate('window.sceneInfo');
  await page.paint(at);
  writeFileSync(join(OUT, `${scene}-${theme}.webp`), await page.shot('webp', 86));
  await page.close();
}

async function clip(cdp, scene, theme) {
  const page = await openScene(cdp, scene, theme, CLIP_PX);
  const { duration, still: at } = await page.evaluate('window.sceneInfo');
  await page.paint(at);
  writeFileSync(join(OUT, `${scene}-${theme}.webp`), await page.shot('webp', 80));
  const ffmpeg = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'slow', '-crf', '26', '-tune', 'animation', '-movflags', '+faststart', '-an',
    join(OUT, `${scene}-${theme}.mp4`)], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((resolve, reject) => ffmpeg.on('exit', (code) => (code ? reject(new Error(`ffmpeg ${code}`)) : resolve())));
  const frames = Math.round((duration / 1000) * FPS);
  for (let i = 0; i < frames; i++) {
    await page.paint((i * 1000) / FPS);
    const jpeg = await page.shot('jpeg', 92);
    if (!ffmpeg.stdin.write(jpeg)) await new Promise((r) => ffmpeg.stdin.once('drain', r));
  }
  ffmpeg.stdin.end();
  await done;
  await page.close();
}

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(JOBS);
mkdirSync(OUT, { recursive: true });
const { chrome, ws, profile } = await launch();
const cdp = await connect(ws);
try {
  for (const scene of wanted) {
    for (const theme of ['light', 'dark']) {
      const started = Date.now();
      await (JOBS[scene] === 'clip' ? clip : still)(cdp, scene, theme);
      console.log(`${scene} ${theme} ${JOBS[scene]} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
  }
} finally {
  cdp.close();
  const exited = new Promise((r) => chrome.once('exit', r));
  chrome.kill();
  await exited;
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
