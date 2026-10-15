import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
const output='/tmp/lasso-live-duplex-ui';
const profile=await mkdtemp('/tmp/lasso-live-ui-chrome-');
const url='http://127.0.0.1:56857/';
const project='84f23556-27d7-4de2-938f-f47ee6b146f0';
const transcript={url,project,question:'What is the square footage of A102?',interactions:[],screens:[]};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=30000){const end=Date.now()+timeout;let error;while(Date.now()<end){try{const v=await fn();if(v)return v;}catch(e){error=e;}await delay(100);}throw new Error(label+(error?': '+error.message:''));}
let chrome,socket,call,evaluate;
try {
 chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',[`--user-data-dir=${profile}`,'--headless=new','--remote-debugging-port=0','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--window-size=1440,1000',url],{stdio:'ignore'});
 const port=await until(async()=>Number((await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]),'Chrome did not start');
 const page=await until(async()=>(await(await fetch(`http://127.0.0.1:${port}/json`)).json()).find(p=>p.url.startsWith(url)),'App page missing');
 socket=new WebSocket(page.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
 let id=0;const pending=new Map();
 socket.addEventListener('message',event=>{const message=JSON.parse(event.data);const entry=pending.get(message.id);if(!entry)return;pending.delete(message.id);clearTimeout(entry.timer);message.error?entry.reject(new Error(message.error.message)):entry.resolve(message.result);});
 call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>{pending.delete(n);reject(new Error('CDP timed out '+method));},15000);pending.set(n,{resolve,reject,timer});socket.send(JSON.stringify({id:n,method,params}));});
 evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description??'Evaluation failed');return r.result.value;};
 async function text(){return evaluate('document.body.innerText');}
 async function screenshot(name){const r=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(path.join(output,name),Buffer.from(r.data,'base64'));transcript.screens.push(name);}
 async function click(selector){const rect=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Control missing');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height};})()`);assert.ok(rect.width>0&&rect.height>0,selector+' is visible');await call('Input.dispatchMouseEvent',{type:'mousePressed',x:rect.x,y:rect.y,button:'left',clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:rect.x,y:rect.y,button:'left',clickCount:1});transcript.interactions.push({type:'click',selector});}
 await until(()=>evaluate('document.querySelector("#project-pill") && document.querySelector("[data-directory]")'),'Projects did not load');
 await click('#project-pill');
 await click(`[data-directory="${project}"]`);
 await until(()=>evaluate('document.querySelector("#window-project-name")?.textContent === "Accounting" && document.querySelector(".wb") && document.querySelector(".wb-inspector")?.getAttribute("aria-busy") === "false"'),'Accounting sources did not load');
 transcript.initial=await text();
 await screenshot('01-accounting-sources.png');
 await click('#terminal-input');
 await call('Input.insertText',{text:transcript.question});
 transcript.interactions.push({type:'type',text:transcript.question});
 await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});
 await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
 transcript.interactions.push({type:'key',key:'Enter'});
 await until(async()=>{const t=await text();return /324\.442/.test(t)&&t.includes('Duplex_A_20110907.ifc')&&await evaluate('Boolean(document.querySelector("[data-report]"))');},'Expected live answer not displayed');
 transcript.answer=await text();
 await screenshot('02-a102-square-footage-answer.png');
 await click('[data-report="0"]');
 await until(()=>evaluate('Boolean(document.querySelector(".wb-preview")) && !document.querySelector(".wb-preview").innerText.includes("Loading source preview")'),'Source preview did not load');
 transcript.source=await text();
 await screenshot('03-a102-source-property.png');
 console.log(transcript.source);
 transcript.checks={selectedAccounting:transcript.initial.includes('Accounting'),showsSquareFeet:/324\.442\s*ft²/.test(transcript.answer),showsSourceFile:transcript.answer.includes('Duplex_A_20110907.ifc'),showsExactProperty:transcript.source.includes('#170')};
 assert.ok(transcript.checks.showsSquareFeet,'Answer must visibly show 324.442 ft²');
 assert.ok(transcript.checks.showsExactProperty,'Source preview must cite exact property #170');
 transcript.status='passed';
} catch(error) {
 transcript.status='failed';transcript.error=error.stack;
 if(evaluate)transcript.failureDOM=await evaluate('document.body.innerText').catch(()=>null);
 if(call){const r=await call('Page.captureScreenshot',{format:'png'}).catch(()=>null);if(r)await writeFile(path.join(output,'failure.png'),Buffer.from(r.data,'base64'));}
 console.error(error.stack);process.exitCode=1;
} finally {
 await writeFile(path.join(output,'transcript.json'),JSON.stringify(transcript,null,2));
 socket?.close();
 if(chrome){chrome.kill('SIGTERM');await new Promise(resolve=>{chrome.once('exit',resolve);setTimeout(resolve,2000);});}
 await rm(profile,{recursive:true,force:true});
}
