// Real browser regression with fake removable-media events; never scans user drives.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lasso-drives-ui-'));
const fixture = `<!doctype html><html data-theme="alabaster"><head><link rel="stylesheet" href="/terminal.css"><link rel="stylesheet" href="/macos.css"><link rel="stylesheet" href="/utility.css"><link rel="stylesheet" href="/removable-drives.css"></head><body><header class="utility-toolbar"><div>Lasso</div><input id="writing" value="Keep writing here"><button id="removable-drives-button" class="toolbar-icon drive-toolbar-button" hidden><svg viewBox="0 0 20 20"><path d="M10 2v16m0-8L5 6m5 7 5-6"/></svg><span data-drive-count hidden></span></button></header><script type="module">
import { createRemovableDrives } from '/removable-drives.js';
window.calls=[];window.changes=[];window.canRemove=true;window.failIndex=false;
window.drives=[{id:'drive/one',name:'Research USB',rootPath:'/Volumes/Research USB',connected:true,pendingAction:'connected',projects:[]}];
window.control=createRemovableDrives({getActor:()=>({id:'local'}),beforeRemove:()=>window.canRemove,onProjectsChanged:async event=>window.changes.push(event),onStatus:()=>{},api:async(url,options={})=>{
 window.calls.push({url,...options});
 if(url==='/api/drives')return {supported:true,drives:structuredClone(window.drives)};
 if(url.includes('/folders')){const p=new URL(url,location.origin).searchParams.get('path');return {path:p,folders:p==='.'?[{name:'Research',path:'Research'},{name:'Notes',path:'Notes'}]:p==='Research'?[{name:'Methods',path:'Research/Methods'},{name:'Results',path:'Research/Results'}]:[]};}
 if(url.endsWith('/index')){if(window.failIndex)throw new Error('Drive disconnected during indexing.');window.drives[0].projects=[{id:'usb-project',name:'Research USB',rootPath:'/Volumes/Research USB'}];window.drives[0].pendingAction=null;return {projects:window.drives[0].projects,drive:window.drives[0]};}
 if(url.endsWith('/decision')){const action=JSON.parse(options.body).action;window.drives[0].pendingAction=null;if(action==='remove'){window.drives=[];return {drive:null,removedProjectIds:['usb-project']};}return {drive:window.drives[0],removedProjectIds:[]};}
 throw new Error(url);
}});window.control.start();document.querySelector('#writing').focus();window.ready=true;
</script></body></html>`;
const server = http.createServer(async (request,response) => {
  try {
    const pathname = new URL(request.url,'http://localhost').pathname;
    if(pathname==='/'){response.setHeader('Content-Type','text/html');response.end(fixture);return;}
    if(!['/terminal.css','/macos.css','/utility.css','/removable-drives.css','/removable-drives.js'].includes(pathname)){response.writeHead(404).end();return;}
    response.setHeader('Content-Type',pathname.endsWith('.js')?'text/javascript':'text/css');
    response.end(await fs.readFile(new URL(`../public${pathname}`,import.meta.url)));
  } catch(error){response.writeHead(500).end(String(error));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}/`;
const chromePath=process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){const end=Date.now()+15000;while(Date.now()<end){if(await check())return;await delay(75);}throw new Error(label);}
let chrome,socket;const errors=[];
try {
  const profile=path.join(root,'chrome');
  chrome=spawn(chromePath,[`--user-data-dir=${profile}`,'--headless=new','--remote-debugging-port=0','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync',url],{stdio:'ignore'});
  let port;await until(async()=>{try{port=Number((await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);return port;}catch{return false;}},'Chrome startup');
  const pages=await(await fetch(`http://127.0.0.1:${port}/json`)).json();socket=new WebSocket(pages.find(page=>page.url.startsWith(url)).webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let id=0;const pending=new Map();socket.addEventListener('message',event=>{const result=JSON.parse(event.data);if(result.method==='Runtime.exceptionThrown')errors.push(result.params.exceptionDetails.text);const task=pending.get(result.id);if(task){pending.delete(result.id);result.error?task.reject(new Error(result.error.message)):task.resolve(result.result);}});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});socket.send(JSON.stringify({id:key,method,params}));});
  const evaluate=async expression=>{const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,replMode:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result.value;};
  const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await call('Runtime.enable');await call('Emulation.setDeviceMetricsOverride',{width:1100,height:820,deviceScaleFactor:1,mobile:false});
  await until(()=>evaluate(`window.ready && !document.querySelector('#removable-drives-button').hidden`),'Drive notification');
  assert.equal(await evaluate('document.activeElement.id'),'writing','Insertion must not steal writing focus');
  assert.equal(await evaluate('document.querySelector(".drive-dialog").open'),false,'No unsolicited modal');
  assert.equal(await evaluate('window.calls.filter(c=>c.method==="POST").length'),0,'Insertion never authorizes indexing');
  await click('[data-review-drives]');await until(()=>evaluate('document.querySelector(".drive-dialog").open'),'Review dialog');
  await click('[data-choose-folders]');await until(()=>evaluate('document.querySelectorAll("[data-select-folder]").length===2'),'Root folders');
  await click('[data-open-folder="Research"]');await until(()=>evaluate('!!document.querySelector("[data-select-folder=\\"Research/Methods\\"]")'),'Nested folders');
  await click('[data-select-folder="Research/Methods"]');await click('[data-open-folder="."]');await until(()=>evaluate('!!document.querySelector("[data-select-folder=Notes]")'),'Back to root');
  await click('[data-select-folder="Notes"]');await click('[data-index-folders]');
  await until(()=>evaluate('window.changes.some(c=>c.preferredId==="usb-project")'),'Selected folders indexed');
  const request=await evaluate('window.calls.find(c=>c.url.endsWith("/index"))');assert.equal(request.url,'/api/drives/drive%2Fone/index');assert.deepEqual(JSON.parse(request.body).paths,['Notes','Research/Methods']);
  assert.equal(await evaluate('document.querySelector(".drive-notification").hidden'),true);
  await evaluate('window.drives[0].connected=false;window.drives[0].pendingAction="disconnected";await window.control.refresh()');
  assert.match(await evaluate('document.querySelector(".drive-dialog").textContent'),/Saved copies remain searchable/);
  await click('[data-keep-drive]');await until(()=>evaluate('window.calls.some(c=>c.body && JSON.parse(c.body).action==="keep")'),'Keep saved data');
  await click('[data-remove-drive]');assert.match(await evaluate('document.querySelector(".drive-remove-confirm").textContent'),/cached file copies, and version history/);
  assert.equal(await evaluate('window.calls.filter(c=>c.body && JSON.parse(c.body).action==="remove").length'),0,'Removal needs explicit confirmation');
  await evaluate('window.canRemove=false');await click('[data-confirm-remove]');await until(()=>evaluate('document.querySelector("[data-drive-error]").textContent.includes("unsaved")'),'Unsaved content protected');
  assert.equal(await evaluate('window.calls.filter(c=>c.body && JSON.parse(c.body).action==="remove").length'),0);
  await evaluate('window.canRemove=true');await click('[data-confirm-remove]');await until(()=>evaluate('window.changes.some(c=>c.removedProjectIds?.includes("usb-project"))'),'Removed project callback');
  await evaluate('window.drives=[{id:"drive/one",name:"Research USB",rootPath:"/Volumes/Research USB",connected:true,pendingAction:"connected",projects:[]}];await window.control.refresh();window.failIndex=true');
  await click('[data-index-whole]');await until(()=>evaluate('document.querySelector("[data-drive-error]").textContent.includes("disconnected during indexing")'),'Index errors visible');
  assert.deepEqual(await evaluate('JSON.parse(window.calls.filter(c=>c.url.endsWith("/index")).at(-1).body).paths'),['.']);
  const screenshot=await call('Page.captureScreenshot',{format:'png'});await fs.writeFile('/tmp/lasso-removable-drives-ui.png',Buffer.from(screenshot.data,'base64'));
  assert.deepEqual(errors,[]);console.log('Passed: opt-in notification, no focus theft, nested multi-folder selection, encoded drive identity, keep/remove confirmation, dirty-state removal guard, full-drive selection, and indexing failure recovery. Screenshot: /tmp/lasso-removable-drives-ui.png');
} finally {socket?.close();chrome?.kill();await new Promise(resolve=>server.close(resolve));await delay(300);await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
