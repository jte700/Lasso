import test from 'node:test';
import assert from 'node:assert/strict';
import {createVisibilityRefresh} from '../public/visibility-refresh.js';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
function harness(visible=true) {
 const timers=new Map(),requests=[],applied=[],errors=[];
 let nextTimer=0;
 const refresh=createVisibilityRefresh({visible,
  load:(projectId,signal)=>new Promise((resolve,reject)=>requests.push({projectId,signal,resolve,reject})),
  apply:(result,projectId)=>applied.push({result,projectId}),onError:error=>errors.push(error),
  setTimer:callback=>{const id=++nextTimer;timers.set(id,callback);return id;},
  clearTimer:id=>timers.delete(id),
 });
 return {refresh,timers,requests,applied,errors,tick(){const [id,callback]=timers.entries().next().value;timers.delete(id);callback();}};
}

test('visible refreshes share one request and poll only after it settles',async()=>{
 const h=harness();h.refresh.setProject('one');
 const first=h.refresh.refresh();
 assert.equal(h.refresh.refresh(),first);
 await flush();assert.equal(h.requests.length,1);assert.equal(h.timers.size,0);
 h.requests[0].resolve('first');await first;
 assert.equal(h.timers.size,1);
 h.tick();await flush();assert.equal(h.requests.length,2);assert.equal(h.timers.size,0);
 h.requests[1].resolve('second');await flush();
 assert.deepEqual(h.applied.map(item=>item.result),['first','second']);
 h.refresh.setProject(null);assert.equal(h.timers.size,0);
});

test('hidden windows stop timers and resume exactly once after cancelling old work',async()=>{
 const h=harness(false);h.refresh.setProject('one');
 assert.equal(h.timers.size,0);assert.equal(h.requests.length,0);
 h.refresh.setVisible(true);await flush();assert.equal(h.requests.length,1);
 h.refresh.setVisible(false);assert.equal(h.requests[0].signal.aborted,true);
 h.refresh.setVisible(true);h.refresh.setVisible(true);await flush();
 assert.equal(h.requests.length,1,'resume waits for the aborted request to settle');
 h.requests[0].resolve('obsolete');await flush();
 assert.equal(h.requests.length,2);assert.equal(h.applied.length,0);
 h.requests[1].resolve('current');await flush();
 assert.deepEqual(h.applied,[{result:'current',projectId:'one'}]);
 h.refresh.setVisible(false);assert.equal(h.timers.size,0);assert.deepEqual(h.errors,[]);
});

test('project switches cancel old work and serialize the new project refresh',async()=>{
 const h=harness();h.refresh.setProject('one');const first=h.refresh.refresh();await flush();
 h.refresh.setProject('two');const second=h.refresh.refresh();await flush();
 assert.equal(h.requests[0].signal.aborted,true);assert.equal(h.requests.length,1);
 h.requests[0].resolve('old project');await first;await flush();
 assert.equal(h.requests[1].projectId,'two');
 h.requests[1].resolve('new project');await second;
 assert.deepEqual(h.applied,[{result:'new project',projectId:'two'}]);
 h.refresh.setProject(null);
});

test('hiding again cancels a queued resume and aborted failures stay silent',async()=>{
 const h=harness();h.refresh.setProject('one');const first=h.refresh.refresh();await flush();
 h.refresh.setVisible(false);h.refresh.setVisible(true);h.refresh.setVisible(false);
 h.requests[0].reject(new Error('Cancelled'));await first;await flush();
 assert.equal(h.requests.length,1);assert.equal(h.timers.size,0);assert.deepEqual(h.errors,[]);
});

test('hiding before a scheduled request starts prevents its load entirely',async()=>{
 const h=harness();h.refresh.setProject('one');h.tick();
 h.refresh.setVisible(false);await flush();
 assert.equal(h.requests.length,0);assert.equal(h.timers.size,0);
 h.refresh.setVisible(true);await flush();assert.equal(h.requests.length,1);
 h.requests[0].resolve('resumed');await flush();
 h.refresh.setVisible(false);
});

test('showing the window during an explicit startup load reuses its current result',async()=>{
 const h=harness(false);h.refresh.setProject('one');
 const startup=h.refresh.refresh();await flush();
 h.refresh.setVisible(true);await flush();assert.equal(h.requests.length,1);
 h.requests[0].resolve('startup');await startup;
 assert.deepEqual(h.applied,[{result:'startup',projectId:'one'}]);
 assert.equal(h.timers.size,1);h.refresh.setVisible(false);
});

test('a failed refresh aborts sibling work and permits a later retry',async()=>{
 const h=harness();h.refresh.setProject('one');const first=h.refresh.refresh();await flush();
 const failure=new Error('Failed');h.requests[0].reject(failure);await first;
 assert.equal(h.requests[0].signal.aborted,true);assert.deepEqual(h.errors,[failure]);
 assert.equal(h.timers.size,1);h.tick();await flush();
 assert.equal(h.requests.length,2);h.requests[1].resolve('recovered');await flush();
 assert.deepEqual(h.applied,[{result:'recovered',projectId:'one'}]);h.refresh.setVisible(false);
});
