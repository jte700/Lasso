import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApplication} from '../src/server.js';
import {anchorForSpan} from '../src/dependencies/service.js';
import {createSourceWorkbench} from '../public/source-workbench.js';
import {createDependencyShell} from '../public/dependency-shell.js';
const actor={id:'human:reviewer',displayName:'Reviewer',actorType:'HUMAN_SELF'};
test('source workbench reviews the exact project and refuses outdated comparisons',async t=>{
 const sandbox=fs.mkdtempSync(path.join(os.tmpdir(),'lasso-workbench-'));
 const root=path.join(sandbox,'Accounting');fs.mkdirSync(root);
 fs.writeFileSync(path.join(root,'Source.csv'),'Account,Value\nSupplies,400\n');
 fs.writeFileSync(path.join(root,'Report.md'),'# Report\n\nSupplies cost 400.\n');
 const app=createApplication({dataDir:path.join(sandbox,'data'),watchProjects:false});
 t.after(async()=>{await app.close();fs.rmSync(sandbox,{recursive:true,force:true});});
 const {project}=app.timeline.importProject(root,actor,{watch:false});
 app.dependencies.ensureIndex(project.id);
 const object=app.terminal.graph.resolve(project.id,'supplies').object;
 const doc=app.dependencies.getDocument(project.id,'Report.md');
 const i=doc.blocks.findIndex(b=>b.text.includes('400')),block=doc.blocks[i],start=block.text.indexOf('400');
 app.dependencies.link(project.id,{documentPath:'Report.md',anchor:anchorForSpan(i,block.type,block.text,start,start+3),spanText:'400',sourceObjectId:object.id,selectionMethod:'MANUAL',status:'LINKED'},actor);
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}/api/projects/${project.id}`;
 const library=await (await fetch(`${base}/source-library`)).json();
 assert.ok(library.objects.some(o=>o.id===object.id&&o.path==='Source.csv'));
 const otherRoot=path.join(sandbox,'Other');fs.mkdirSync(otherRoot);fs.writeFileSync(path.join(otherRoot,'Other.md'),'Other project');
 const other=app.timeline.importProject(otherRoot,actor,{watch:false}).project;
 assert.equal((await fetch(base.replace(project.id,other.id)+`/source-review/${object.id}`)).status,404);
 fs.writeFileSync(path.join(root,'Source.csv'),'Account,Value\nSupplies,438\n');app.timeline.capture(project.id,actor,{source:'EXPLICIT_CHECKPOINT'});
 const url=`${base}/source-review/${object.id}`;
 const {plan}=await (await fetch(url)).json();assert.equal(plan.rewrites,1);assert.equal(plan.edits[0].nextSpanText,'438');
 const post=expectedPlan=>fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({actor,action:'apply',expectedPlan})});
 assert.equal((await post({...plan,rewrites:99})).status,409);
 assert.ok(app.dependencies.getDocument(project.id,'Report.md').blocks.some(b=>b.text.includes('400')));
 fs.writeFileSync(path.join(root,'Source.csv'),'Account,Value\nSupplies,450\n');app.timeline.capture(project.id,actor,{source:'EXPLICIT_CHECKPOINT'});
 assert.equal((await post(plan)).status,409,'source changes invalidate the displayed comparison');
 const current=(await (await fetch(url)).json()).plan;
 assert.equal((await post(current)).status,200);
 assert.ok(app.dependencies.getDocument(project.id,'Report.md').blocks.some(b=>b.text.includes('450')));
});

test('source library ranks matching files and retains every object in a chosen source',async t=>{
 const sandbox=fs.mkdtempSync(path.join(os.tmpdir(),'lasso-library-ranking-'));
 const root=path.join(sandbox,'Project');fs.mkdirSync(root);
 fs.writeFileSync(path.join(root,'A.csv'),'Account,Value\nSupplies,400\nTravel,80\nPayroll,700\n');
 fs.writeFileSync(path.join(root,'Z.csv'),'Account,Value\nSupplies,400\nTravel,80\nPayroll,700\n');
 fs.writeFileSync(path.join(root,'Draft.md'),'# Draft\n\nSupplies cost 400.\n');
 const app=createApplication({dataDir:path.join(sandbox,'data'),watchProjects:false});
 t.after(async()=>{await app.close();fs.rmSync(sandbox,{recursive:true,force:true});});
 const {project}=app.timeline.importProject(root,actor,{watch:false});
 app.dependencies.ensureIndex(project.id);
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}/api/projects/${project.id}/source-library`;
 const library=async query=>(await (await fetch(`${base}?${new URLSearchParams(query)}`)).json()).objects;
 await library({});
 assert.deepEqual(app.dependencies.ranking.usage(project.id),[],'library impressions are passive');
 app.dependencies.recordRecommendationUsage(project.id,{path:'Z.csv',kind:'accept',sessionId:'library'});
 assert.equal((await library({}))[0].path,'Z.csv','browse starts with recent project sources');
 const exact=await library({query:'A.csv'});
 assert.ok(exact.length>2,'a file selection retains its distinct indexed choices');
 assert.equal(exact.length,app.dependencies.objectsAt(project.id).filter(o=>o.path==='A.csv').length);
 assert.ok(exact.every(o=>o.path==='A.csv'));
 assert.equal(exact[0].ranking.reason,'Exact name match');
 assert.equal((await library({query:'unfindable-text'})).length,0,'usage cannot create a query match');
 const object=app.dependencies.objectsAt(project.id).find(o=>o.path==='A.csv'&&o.label==='Supplies'&&o.objectType==='DATASET_ROW');
 app.dependencies.link(project.id,{documentPath:'Draft.md',anchor:anchorForSpan(1,'paragraph','Supplies cost 400.',0,8),spanText:'Supplies',sourceObjectId:object.id,sourceSnapshotId:object.snapshotId,selectionMethod:'MANUAL',sessionId:'document'},actor);
 const related=await library({query:'Supplies',documentPath:'Draft.md'});
 assert.equal(related[0].path,'A.csv');
 assert.equal(related[0].ranking.relationship,true);
});

test('terminal completion API keeps weak typing quiet and broadens explicit invocation',async t=>{
 const sandbox=fs.mkdtempSync(path.join(os.tmpdir(),'lasso-completion-api-'));
 const root=path.join(sandbox,'Project');fs.mkdirSync(root);
 for(let index=0;index<6;index+=1)fs.writeFileSync(path.join(root,`Source${index}.csv`),`Account,Current Period,Prior Period\nOffice Supplies ${index},400,310\n`);
 const app=createApplication({dataDir:path.join(sandbox,'data'),watchProjects:false});
 t.after(async()=>{await app.close();fs.rmSync(sandbox,{recursive:true,force:true});});
 const {project}=app.timeline.importProject(root,actor,{watch:false});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}/api/projects/${project.id}/terminal/complete`;
 const complete=async params=>(await (await fetch(`${base}?${new URLSearchParams(params)}`)).json()).completion.suggestions;
 assert.deepEqual(await complete({input:'trace supplies'}),[]);
 const explicit=await complete({input:'trace supplies',surface:'search'});
 assert.ok(explicit.length>5&&explicit.length<=14);
 assert.ok(explicit.every(candidate=>candidate.kind==='related'));
 const strong=await complete({input:'trace office'});
 assert.ok(strong.length>0&&strong.length<=5);
 assert.deepEqual(app.dependencies.ranking.usage(project.id),[],'autocomplete responses are passive');
});

// A small DOM adapter exercises the real workbench's ordering and handlers
// without adding a browser dependency to the local application.
function workbenchHarness(t,options={}) {
 const listeners=new Map();
 const input={value:'',addEventListener(name,handler){listeners.set(name,handler);},focus(){}};
 const originalDocument=Object.getOwnPropertyDescriptor(globalThis,'document');
 const originalNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
 const document={activeElement:null,querySelectorAll(){return [];},getElementById(){return null;}};
 Object.defineProperty(globalThis,'document',{configurable:true,value:document});
 let copyFails=false;
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{async writeText(){if(copyFails)throw new Error('Denied');}}}});
 t.after(()=>{
  if(originalDocument)Object.defineProperty(globalThis,'document',originalDocument);else delete globalThis.document;
  if(originalNavigator)Object.defineProperty(globalThis,'navigator',originalNavigator);else delete globalThis.navigator;
 });
 const fileList={handlers:new Map(),addEventListener(name,handler){this.handlers.set(name,handler);}};
 const inspector={scrollTop:0};
 const host={isConnected:true,buttons:[],html:'',
  set innerHTML(value){
   this.html=value;
   this.buttons=[...value.matchAll(/<button\b([^>]*)>/g)].map(match=>{
    const attrs=match[1],dataset={};
    for(const attribute of attrs.matchAll(/data-([\w-]+)(?:="([^"]*)")?/g))dataset[attribute[1].replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=attribute[2]??'';
    const classes=/class="([^"]*)"/.exec(attrs)?.[1]??'';
    return {dataset,classes,handlers:new Map(),addEventListener(name,handler){this.handlers.set(name,handler);},
     click(){return this.onclick?.()??this.handlers.get('click')?.();},
     focus(){document.activeElement=this;},closest(selector){return selector==='.wb-file'&&this.classes.split(' ').includes('wb-file')?this:null;}};
   });
  },get innerHTML(){return this.html;},
  querySelectorAll(selector){
   if(selector==='.wb-file')return this.buttons.filter(button=>button.classes.split(' ').includes('wb-file'));
   const key=/^\[data-([\w-]+)\]$/.exec(selector)?.[1]?.replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase());
   return key?this.buttons.filter(button=>Object.hasOwn(button.dataset,key)):[];
  },
  querySelector(selector){return selector==='.wb-file-list'?fileList:selector==='.wb-inspector'?inspector:this.querySelectorAll(selector)[0]??null;},
 };
 const usage=[],opened=[],requests=[];
 let project='project-one';
 const libraryObjects=[
  {id:'z',path:'Z.csv',label:'Supplies',objectType:'DATASET_VALUE',snapshotId:'snapshot',ranking:{reason:'Recently used in this project'}},
  {id:'a',path:'A.csv',label:'Travel',objectType:'DATASET_VALUE',snapshotId:'snapshot',ranking:{reason:'Matches your context'}},
 ];
 const api=options.api??(async(url)=>{
  if(url.includes('/source-library'))return {objects:libraryObjects};
  if(url.endsWith('/terminal/session'))return {session:{files:2}};
  if(url.endsWith('/terminal/preview'))return {preview:{kind:'text',lines:[{lineNumber:1,text:'Supplies 400',highlighted:true}]}};
  if(url.includes('/source-review/'))return {plan:{edits:[]}};
  throw new Error(`Unexpected URL: ${url}`);
 });
 const workbench=createSourceWorkbench({input,api:async(url,args)=>{requests.push({url,args});return api(url,args);},
  getProjectId:()=>project,getDocumentPath:()=> 'Draft.md',getContext:()=> 'We found supplies',getActor:()=>actor,
  onRecommendationUsage:(...args)=>usage.push(args),onOpenSource:(...args)=>opened.push(args),onStatus(){}});
 workbench.setHost(host);
 return {workbench,host,input,listeners,fileList,usage,opened,requests,libraryObjects,
  failCopy(value){copyFails=value;},setProject(value){project=value;}};
}

test('workbench preserves ranking and selection and counts only successful deliberate reuse',async t=>{
 const harness=workbenchHarness(t);
 const {workbench,host,fileList,usage,opened,requests,libraryObjects}=harness;
 await workbench.refresh();
 assert.deepEqual(host.querySelectorAll('[data-file]').map(button=>button.dataset.file),['Z.csv','A.csv']);
 assert.match(host.innerHTML,/Recently used in this project/);
 const parameters=new URL(requests.find(request=>request.url.includes('/source-library')).url,'http://localhost').searchParams;
 assert.equal(parameters.get('documentPath'),'Draft.md');
 assert.equal(parameters.get('context'),'We found supplies');
 host.querySelectorAll('[data-file]')[1].click();
 libraryObjects.reverse();await workbench.refresh();
 assert.match(host.innerHTML,/class="wb-file selected" data-file="A.csv"/,'ranking refresh preserves a chosen source');
 host.querySelectorAll('[data-file]')[0].focus();
 fileList.handlers.get('keydown')({key:'ArrowDown',preventDefault(){}});
 assert.equal(usage.length,0,'file selection and arrow previews are passive');
 await host.querySelector('[data-object]').click();
 assert.equal(usage.length,0,'automatic evidence preview is passive');
 host.querySelector('[data-open]').click();
 assert.equal(opened.length,1);
 assert.equal(opened[0][1].projectId,'project-one');
 assert.equal(usage.length,0,'open completion is recorded by the source viewer after success');
 harness.failCopy(true);await host.querySelector('[data-copy]').click();
 assert.equal(usage.length,0,'failed clipboard actions are not usage');
 harness.failCopy(false);const copying=host.querySelector('[data-copy]').click();
 harness.setProject('project-two');await copying;
 assert.equal(usage.length,1);
 assert.equal(usage[0][1],'accept');
 assert.equal(usage[0][2].projectId,'project-one','async reuse remains scoped to its original project');
 assert.equal(usage[0][2].documentPath,'Draft.md');
});

test('workbench asks the shared search for queries and ignores obsolete responses',async t=>{
 const pending=[];
 const harness=workbenchHarness(t,{api:async url=>{
  if(url.endsWith('/terminal/session'))return {session:{files:1}};
  return new Promise(resolve=>pending.push({url,resolve}));
 }});
 const first=harness.workbench.refresh();
 harness.input.value='DOI-identifier';harness.listeners.get('input')();
 await new Promise(resolve=>setTimeout(resolve,120));
 assert.equal(pending.length,2);
 assert.equal(new URL(pending[1].url,'http://localhost').searchParams.get('query'),'DOI-identifier');
 pending[1].resolve({objects:[{id:'paper',path:'Reference.bib',label:'Semantic metadata match',objectType:'REFERENCE',ranking:{reason:'Exact identifier match'}}]});
 await new Promise(resolve=>setImmediate(resolve));
 assert.match(harness.host.innerHTML,/Semantic metadata match/,'client does not discard server metadata matches');
 pending[0].resolve({objects:[{id:'old',path:'Obsolete.csv',label:'Obsolete',objectType:'DATASET_VALUE'}]});
 await first;
 assert.doesNotMatch(harness.host.innerHTML,/Obsolete.csv/);
});

test('terminal shell distinguishes automatic completion from explicit Tab invocation',async t=>{
 const {input,listeners}=workbenchHarness(t);
 input.closest=()=>({classList:{toggle(){}}});
 input.setSelectionRange=()=>{};
 input.value='trace supplies';
 const requests=[];
 const shell=createDependencyShell({input,getProjectId:()=> 'project-one',getDocumentPath:()=> 'Draft.md',
  api:async url=>{requests.push(url);return {completion:{fragment:'supplies',suggestions:Array.from({length:20},(_,index)=>({value:`source-${index}`,kind:'related'}))}};}});
 listeners.get('input')();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(new URL(requests[0],'http://localhost').searchParams.has('surface'),false);
 assert.equal(shell.state.completion.suggestions.length,5);
 listeners.get('keydown')({key:'Escape'});
 listeners.get('keydown')({key:'Tab',preventDefault(){}});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(new URL(requests[1],'http://localhost').searchParams.get('surface'),'search');
 assert.equal(shell.state.completion.suggestions.length,14);
});

test('an older automatic terminal response cannot replace explicit results or reopen dismissal',async t=>{
 const {input,listeners}=workbenchHarness(t);
 input.closest=()=>({classList:{toggle(){}}});input.value='trace supplies';
 const pending=[];
 const shell=createDependencyShell({input,getProjectId:()=> 'project-one',api:()=>new Promise(resolve=>pending.push(resolve))});
 listeners.get('input')();
 listeners.get('keydown')({key:'Tab',preventDefault(){}});
 const body={completion:{fragment:'supplies',suggestions:Array.from({length:14},(_,index)=>({value:`source-${index}`}))}};
 pending[1](body);await new Promise(resolve=>setImmediate(resolve));
 pending[0](body);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(shell.state.completion.suggestions.length,14);
 listeners.get('input')();
 shell.reset();pending[2](body);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(shell.state.completion,null);
});
