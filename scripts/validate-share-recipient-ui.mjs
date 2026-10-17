// Isolated recipient rendering and real downloads. Uses fictional sources and
// a temporary browser profile, never the user's workspace or browser session.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createApplication } from '../src/server.js';

const temporary = await fs.mkdtemp(path.join(tmpdir(), 'lasso-recipient-ui-'));
const root = path.join(temporary, 'Sources');
await fs.mkdir(root);
await fs.writeFile(path.join(root, 'Accounts-Payable.csv'), [
  'Supplier,Invoice,Invoice Date,Due Date,Outstanding CAD,Status',
  'Maple Paper Distribution,BILL-1160,2026-08-18,2026-09-17,22000,Overdue',
  'Harbour Office Furniture,BILL-1174,2026-09-12,2026-10-12,18400,Due within seven days',
  'North Ridge Technology,BILL-1181,2026-09-20,2026-10-20,35000,Not yet due',
].join('\n'));
await fs.writeFile(path.join(root, 'Approval-Notes.txt'), 'Invoices must be checked against the approved purchase order before payment. Keep the approval record with the invoice.');
await fs.copyFile(new URL('../test/fixtures/drawings/cedar-lane-residence-realistic.dxf', import.meta.url), path.join(root, 'Floor-Plan.dxf'));
// A one-metre IFC plan makes accidental inherited SVG strokes obvious: the
// recipient's 1.5-unit icon stroke would cover more than the entire model.
await fs.writeFile(path.join(root, 'Metre-Plan.ifc'), `ISO-10303-21;
HEADER;FILE_DESCRIPTION(('Share regression'),'2;1');FILE_NAME('plan.ifc','2026-10-16T00:00:00',(),(),'Lasso','Lasso','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCPROJECT('project',$,'Plan',$,$,$,$,(#10),#9);
#2=IFCCARTESIANPOINT((0.,0.,0.));#3=IFCDIRECTION((0.,0.,1.));#4=IFCDIRECTION((1.,0.,0.));#5=IFCAXIS2PLACEMENT3D(#2,#3,#4);#6=IFCLOCALPLACEMENT($,#5);
#7=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);#8=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);#9=IFCUNITASSIGNMENT((#7,#8));#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#5,$);
#11=IFCBUILDINGSTOREY('floor',$,'PRIVATE-FLOOR',$,$,#6,$,$,.ELEMENT.,0.);
#30=IFCCARTESIANPOINT((0.,0.));#31=IFCCARTESIANPOINT((1.,0.));#32=IFCCARTESIANPOINT((1.,1.));#33=IFCCARTESIANPOINT((0.,1.));
#40=IFCPOLYLINE((#30,#31,#32,#33,#30));#41=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#40);#42=IFCEXTRUDEDAREASOLID(#41,#5,#3,3.);#43=IFCSHAPEREPRESENTATION(#10,'Body','SweptSolid',(#42));#44=IFCPRODUCTDEFINITIONSHAPE($,$,(#43));
#100=IFCSPACE('private-room',$,'PRIVATE-ROOM',$,$,#6,#44,'PRIVATE-ROOM',.ELEMENT.,.INTERNAL.,$);#200=IFCRELAGGREGATES('rooms',$,$,$,#11,(#100));
ENDSEC;END-ISO-10303-21;`);
const app = createApplication({ dataDir: path.join(temporary, 'data'), watchProjects: false, port: 0 });
const actor = { id: 'human:qa', displayName: 'QA', actorType: 'HUMAN_SELF' };
const { project } = app.timeline.importProject(root, actor, { watch: false });
app.dependencies.ensureIndex(project.id);
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
const column = app.db.prepare(`SELECT v.object_id AS objectId,v.id AS versionId FROM scientific_object_versions v JOIN scientific_objects o ON o.id=v.object_id WHERE o.project_id=? AND json_extract(v.anchor_json,'$.kind')='table-column' AND v.label='Invoice' LIMIT 1`).get(project.id);
const sourceFor = filename => app.db.prepare(`SELECT v.object_id AS objectId,v.id AS versionId FROM scientific_object_versions v JOIN scientific_objects o ON o.id=v.object_id WHERE o.project_id=? AND v.path=? ORDER BY CASE json_extract(v.anchor_json,'$.kind') WHEN 'cad-model' THEN 0 ELSE 1 END LIMIT 1`).get(project.id, filename);
const create = (source, scope, redactions = []) => {
  const share = app.objectShares.createShare({ projectId: project.id, ...source, actor, accessScope: scope, redactions });
  return { url: `${base}/d/${share.token}`, share };
};
assert.ok(column);
const records = ['INDEXED', 'DOCUMENT', 'REDACTED'].map(scope => ({ ...create(column, scope,
  scope === 'REDACTED' ? [{ kind: 'CELL', sheet: 0, row: 1, column: 1, effect: 'BLANK' }] : []), name: scope.toLowerCase(), format: 'CSV' }));
records.push({ ...create(sourceFor('Floor-Plan.dxf'), 'REDACTED', [{ kind: 'DRAWING', effect: 'BLUR', x: .4, y: .4, width: .2, height: .2 }]), name: 'drawing', format: 'SVG' });
const metreMasks = [{ kind: 'DRAWING', effect: 'BLUR', x: .1, y: .15, width: .15, height: .2 },
  { kind: 'DRAWING', effect: 'BLUR', x: .2, y: .55, width: .4, height: .2 },
  { kind: 'DRAWING', effect: 'BLANK', x: .75, y: .2, width: .1, height: .25 }];
const metreSource = sourceFor('Metre-Plan.ifc');
const metreDocument = (await (await fetch(`${base}/api/dependency-objects/${metreSource.objectId}/document?version=${metreSource.versionId}`)).json()).document;
assert.equal(metreDocument.kind, 'model-plan');
records.push({ ...create(metreSource, 'REDACTED', metreMasks), name: 'metre-drawing', format: 'SVG', regions: metreMasks, bounds: metreDocument.bounds });
records.push({ ...create(sourceFor('Approval-Notes.txt'), 'INDEXED'), name: 'text', format: 'TXT' });
const profile = path.join(temporary, 'chrome');
const downloadPath = path.join(temporary, 'downloads'); await fs.mkdir(downloadPath);
let chrome, socket, sequence = 0, checks = 0;
const pending = new Map(), exceptions = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label) {
  for (let attempt = 0; attempt < 150; attempt++) { try { const value = await read(); if (value) return value; } catch {} await delay(50); }
  throw Error(label);
}
try {
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [`--user-data-dir=${profile}`, '--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', 'about:blank'], { stdio: 'ignore' });
  const port = await until(async () => Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]), 'Chrome did not start');
  const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(target => target.type === 'page');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
    const entry = pending.get(message.id);
    if (entry) { pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(Error(message.error.message)) : entry.resolve(message.result); }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? 'Browser evaluation failed');
    return result.result.value;
  };
  await call('Runtime.enable'); await call('Page.enable');
  await call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath });
  for (const record of records) {
    for (const theme of ['light', 'dark']) for (const width of [390, 1280]) {
      await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
      await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await call('Page.navigate', { url: record.url });
      await until(() => evaluate(`location.href === ${JSON.stringify(record.url)} && document.readyState === 'complete' && Boolean(document.querySelector('.shared-window'))`), 'Shared page did not load');
      const state = await evaluate(`({width:innerWidth,scroll:document.documentElement.scrollWidth,title:getComputedStyle(document.querySelector('h1')).fontSize,text:document.body.innerText,links:[...document.querySelectorAll('.actions a')].map(a=>({href:a.href,label:a.innerText,rect:(()=>{const r=a.getBoundingClientRect();return {x:r.x,right:r.right}})()}))})`);
      assert.ok(state.scroll <= state.width + 1, `${record.name}/${theme}/${width}: page overflow`);
      assert.ok(parseFloat(state.title) <= 20);
      assert.doesNotMatch(state.text, /inferred categorical variable|observed range/);
      assert.ok(state.links.some(link => link.href.endsWith('/excerpt') && link.label.includes(record.format)));
      assert.equal(state.links.some(link => link.href.endsWith('/download')), record.share.accessScope === 'DOCUMENT');
      for (const link of state.links) assert.ok(link.rect.x >= 0 && link.rect.right <= width + 1, 'Download control clipped');
      if (record.name === 'redacted') assert.doesNotMatch(state.text, /BILL-1160/);
      if (record.regions) {
        const shapes = await evaluate(`(()=>{const svg=document.querySelector('.model-plan-svg');return [...svg.querySelectorAll('.drawing-redaction>rect')].map(rect=>({x:rect.x.baseVal.value,y:rect.y.baseVal.value,width:rect.width.baseVal.value,height:rect.height.baseVal.value,stroke:getComputedStyle(rect).stroke,fill:getComputedStyle(rect).fill,blurStroke:[...rect.parentElement.querySelectorAll('rect')].every(shape=>getComputedStyle(shape).stroke==='none')}))})()`);
        assert.equal(shapes.length, record.regions.length);
        shapes.forEach((shape, index) => {
          const region = record.regions[index];
          const bounds = record.bounds, modelWidth = bounds.maxX - bounds.minX, modelHeight = bounds.maxY - bounds.minY;
          assert.equal(shape.stroke, 'none', 'Icon styling must never paint strokes around a drawing mask');
          assert.equal(shape.blurStroke, true, 'Synthetic blur bars must not inherit drawing strokes');
          for (const [actual, expected] of [[shape.x, bounds.minX + region.x * modelWidth], [shape.y, -bounds.maxY + region.y * modelHeight], [shape.width, region.width * modelWidth], [shape.height, region.height * modelHeight]]) assert.ok(Math.abs(actual - expected) < 1e-6, `Mask extents must match the normalized selection: ${actual} versus ${expected}`);
          assert.equal(shape.fill, region.effect === 'BLANK' ? 'rgb(0, 0, 0)' : 'rgb(181, 189, 201)');
        });
        assert.doesNotMatch(state.text, /PRIVATE-/);
      }
      if (process.env.LASSO_SHARE_SCREENSHOTS && (record.name === 'indexed' || (theme === 'dark' && width === 1280))) {
        const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        await fs.writeFile(`/tmp/lasso-recipient-${record.name}-${theme}-${width}.png`, Buffer.from(screenshot.data, 'base64'));
      }
      checks++;
    }
    // Click the real download control and compare the saved file to the exact
    // payload used by the HTTP route. No synthetic click handler is involved.
    const recordDownloadPath = path.join(downloadPath, record.name);
    await fs.mkdir(recordDownloadPath);
    await call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: recordDownloadPath });
    const before = new Set(await fs.readdir(recordDownloadPath));
    await evaluate(`document.querySelector('a[href$="/excerpt"]').click()`);
    const filename = await until(async () => (await fs.readdir(recordDownloadPath)).find(name => !before.has(name) && !name.endsWith('.crdownload')), 'Excerpt did not download');
    const bytes = await fs.readFile(path.join(recordDownloadPath, filename));
    const response = await fetch(`${record.url}/excerpt`); assert.equal(response.status, 200);
    assert.deepEqual(bytes, Buffer.from(await response.arrayBuffer()));
    if (record.format === 'SVG') {
      const svg = bytes.toString();
      assert.equal(await evaluate(`new DOMParser().parseFromString(${JSON.stringify(svg)},'image/svg+xml').querySelector('parsererror') === null`), true, 'Downloaded SVG must be valid XML');
      assert.equal(await evaluate(`(async()=>{const image=new Image();image.src='data:image/svg+xml;base64,${bytes.toString('base64')}';await image.decode();return image.naturalWidth>0})()`), true, 'Downloaded drawing must render as an image');
      if (record.regions) {
        const paint = await evaluate(`(async()=>{
          const original=document.querySelector('.model-plan-svg'), onPage=original.cloneNode(true);
          const {width,height}=original.getBoundingClientRect();
          onPage.setAttribute('width',width);onPage.setAttribute('height',height);
          // Freeze the browser's actual recipient styles into its cloned SVG.
          const originals=[original,...original.querySelectorAll('*')], clones=[onPage,...onPage.querySelectorAll('*')];
          originals.forEach((element,index)=>{const style=getComputedStyle(element);for(const key of ['fill','stroke','stroke-width','stroke-linejoin','stroke-linecap','vector-effect','background-color'])clones[index].style.setProperty(key,style.getPropertyValue(key));});
          const exported=new DOMParser().parseFromString(${JSON.stringify(svg)},'image/svg+xml').documentElement;
          exported.setAttribute('width',width);exported.setAttribute('height',height);
          const pixels=async(element)=>{const image=new Image();image.src='data:image/svg+xml;base64,'+btoa(unescape(encodeURIComponent(new XMLSerializer().serializeToString(element))));await image.decode();const canvas=document.createElement('canvas');canvas.width=Math.ceil(width);canvas.height=Math.ceil(height);const context=canvas.getContext('2d');context.drawImage(image,0,0,width,height);return {context,data:context.getImageData(0,0,canvas.width,canvas.height).data};};
          const a=await pixels(onPage), b=await pixels(exported);
          // Sample every mask interior and a narrow ring outside it. This catches
          // inflated paint even when the rectangle's geometric bbox is correct.
          const matrix=original.getScreenCTM(), viewport=original.getBoundingClientRect();
          const samples=[];
          for(const rect of original.querySelectorAll('.drawing-redaction>rect')){const x=rect.x.baseVal.value,y=rect.y.baseVal.value,w=rect.width.baseVal.value,h=rect.height.baseVal.value;
            for(const [px,py] of [[x+w*.05,y+h*.05],[x-.025,y+h/2],[x+w+.025,y+h/2],[x+w/2,y-.025],[x+w/2,y+h+.025]]){const point=new DOMPoint(px,py).matrixTransform(matrix), sx=Math.floor(point.x-viewport.x),sy=Math.floor(point.y-viewport.y);samples.push({recipient:[...a.context.getImageData(sx,sy,1,1).data],download:[...b.context.getImageData(sx,sy,1,1).data]});}}
          return samples;
        })()`);
        for (const sample of paint) assert.deepEqual(sample.recipient, sample.download, 'Recipient mask pixels must match the downloaded SVG inside and outside each selected region');
      }
    }
    console.log(`PASS ${record.name}: four responsive/theme layouts and real ${record.format} download`);
  }
  assert.deepEqual(exceptions, []);
  console.log(`PASS ${checks} recipient layouts, ${records.length} real downloads, metre-scale mask extents and standalone drawing rendering`);
} finally {
  socket?.close();
  if (chrome && chrome.exitCode === null) { chrome.kill('SIGTERM'); await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), delay(3000)]); }
  await app.close();
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
