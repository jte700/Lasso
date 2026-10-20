import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApplication} from '../src/server.js';
import {anchorForSpan} from '../src/dependencies/service.js';
import {createSourceWorkbench,groupSourceObjects} from '../public/source-workbench.js';
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
 const copied=[];
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{async writeText(value){if(copyFails)throw new Error('Denied');copied.push(value);}}}});
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
 const usage=[],opened=[],documentsOpened=[],requests=[];
 let project='project-one';
 let version='snapshot-one';
 const libraryObjects=[
  {id:'z',path:'Z.csv',label:'Supplies',objectType:'DATASET_VALUE',snapshotId:'snapshot',ranking:{reason:'Recently used in this project'}},
  {id:'a',path:'A.csv',label:'Travel',objectType:'DATASET_VALUE',snapshotId:'snapshot',ranking:{reason:'Matches your context'}},
 ];
 const api=options.api??(async(url)=>{
  if(url.includes('/source-library'))return {objects:libraryObjects};
  if(url.endsWith('/terminal/session'))return {session:{files:2}};
  if(url.endsWith('/terminal/preview'))return {preview:{kind:'text',lines:[{lineNumber:1,text:'Supplies 400',highlighted:true}]}};
  if(url.includes('/source-review/'))return {plan:options.plan??{edits:[]}};
  throw new Error(`Unexpected URL: ${url}`);
 });
 const workbench=createSourceWorkbench({input,api:async(url,args)=>{requests.push({url,args});return api(url,args);},
  getProjectId:()=>project,getProjectVersion:()=>version,getDocumentPath:()=> 'Draft.md',getContext:()=> 'We found supplies',getActor:()=>actor,
  getWorkspaceId:options.workspace?()=>version:undefined,getDocumentProjectId:options.workspace?()=>project:undefined,
  onRecommendationUsage:(...args)=>usage.push(args),onOpenSource:(...args)=>opened.push(args),onOpenDocument:(...args)=>documentsOpened.push(args),onStatus(){}});
 workbench.setHost(host);
 return {workbench,host,input,listeners,fileList,usage,opened,documentsOpened,requests,libraryObjects,copied,
  failCopy(value){copyFails=value;},setProject(value){project=value;},setVersion(value){version=value;}};
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

test('workbench opens the pinned PDF page and preserves its excerpt for copying',async t=>{
 const object={id:'paper/one',projectId:'project-two',path:'Plans/Concept.PDF',label:'Concept plan',objectType:'PASSAGE',versionId:'version/one',anchor:{kind:'pdf-text',pageNumber:3}};
 const h=workbenchHarness(t,{workspace:true,api:async url=>{
  if(url.includes('/source-library'))return {objects:[object]};
  if(url.endsWith('/terminal/session'))return {session:{files:1}};
  if(url.includes('/source-review/'))return {plan:{edits:[]}};
  if(url.startsWith('/api/dependency-objects/'))return {preview:{kind:'pdf',fileUrl:'/api/dependency-objects/paper%2Fone/source?version=version%2Fone',pageNumber:3,selectedText:'Kitchen < 40 m² & dining area'}};
  throw new Error(`Unexpected URL: ${url}`);
 }});
 await h.workbench.refresh();
 await h.host.querySelector('[data-object]').click();
 assert.ok(h.requests.some(request=>request.url==='/api/dependency-objects/paper%2Fone/preview?version=version%2Fone'),'the preview must retain the selected source version');
 assert.ok(!h.requests.some(request=>request.url.endsWith('/terminal/preview')),'PDFs use the source preview endpoint');
 assert.match(h.host.innerHTML,/class="wb-pdf"/);
 assert.match(h.host.innerHTML,/source\?version=version%2Fone#page=3&amp;zoom=page-width/);
 assert.match(h.host.innerHTML,/Page 3/);
 assert.match(h.host.innerHTML,/Kitchen &lt; 40 m² &amp; dining area/);
 assert.doesNotMatch(h.host.innerHTML,/A visual preview is unavailable/);
 await h.host.querySelector('[data-copy]').click();
 assert.match(h.copied[0],/^Kitchen < 40 m² & dining area\nSource:/);
 assert.match(h.copied[0],/Page 3/);
 assert.equal(h.usage[0][2].projectId,'project-two');
});

test('an obsolete PDF preview cannot replace a newly selected source',async t=>{
 let finishPdf, pdfSignal;
 const h=workbenchHarness(t,{api:async(url,args)=>{
  if(url.includes('/source-library'))return {objects:[
   {id:'pdf',path:'Concept.pdf',label:'Concept plan',objectType:'PAPER',versionId:'old-version'},
   {id:'text',path:'Notes.md',label:'Current notes',objectType:'PASSAGE'},
  ]};
  if(url.endsWith('/terminal/session'))return {session:{files:2}};
  if(url.includes('/source-review/'))return {plan:{edits:[]}};
  if(url.startsWith('/api/dependency-objects/')){pdfSignal=args.signal;return new Promise(resolve=>{finishPdf=resolve;});}
  if(url.endsWith('/terminal/preview'))return {preview:{kind:'text',lines:[{lineNumber:1,text:'Current source context',highlighted:true}]}};
  throw new Error(`Unexpected URL: ${url}`);
 }});
 await h.workbench.refresh();
 const pdfSelecting=h.host.querySelector('[data-object]').click();
 h.host.querySelectorAll('[data-file]')[1].click();
 await h.host.querySelector('[data-object]').click();
 assert.equal(pdfSignal.aborted,true);
 finishPdf({preview:{kind:'pdf',fileUrl:'/obsolete.pdf',page:7,selectedText:'Obsolete PDF evidence'}});
 await pdfSelecting;
 assert.match(h.host.innerHTML,/Current source context/);
 assert.doesNotMatch(h.host.innerHTML,/Obsolete PDF evidence|obsolete\.pdf|class="wb-pdf"/);
});

test('workbench asks the shared search for queries and ignores obsolete responses',async t=>{
 const pending=[];
 const harness=workbenchHarness(t,{api:async url=>{
  if(url.endsWith('/terminal/session'))return {session:{files:1}};
  return new Promise(resolve=>pending.push({url,resolve}));
 }});
 const first=harness.workbench.refresh();
 harness.input.value='DOI-identifier';harness.listeners.get('input')();
 assert.equal(harness.requests.find(request=>request.url.includes('/source-library')).args.signal.aborted,true,'new input immediately cancels obsolete search work');
 await new Promise(resolve=>setTimeout(resolve,120));
 assert.equal(pending.length,2);
 assert.equal(new URL(pending[1].url,'http://localhost').searchParams.get('query'),'DOI-identifier');
 pending[1].resolve({objects:[{id:'paper',path:'Reference.bib',label:'Semantic metadata match',objectType:'REFERENCE',ranking:{reason:'Exact identifier match'}}]});
 await new Promise(resolve=>setImmediate(resolve));
 assert.match(harness.host.innerHTML,/Semantic metadata match/,'client does not discard server metadata matches');
 pending[0].resolve({objects:[{id:'old',path:'Obsolete.csv',label:'Obsolete',objectType:'DATASET_VALUE'}]});
 await first;
 assert.doesNotMatch(harness.host.innerHTML,/Obsolete.csv/);
 assert.equal(harness.requests.filter(request=>request.url.endsWith('/terminal/session')).length,1,'searches reuse the project session summary');
});

test('source grouping preserves ranked matches and browse semantics with linear work',()=>{
 const objects=[
  {id:'summary',path:'Z.csv',objectType:'DATASET'},
  {id:'value',path:'Z.csv',objectType:'DATASET_VALUE',ranking:{reason:'Recent'}},
  {id:'row',path:'Z.csv',objectType:'DATASET_ROW'},
  {id:'other',path:'A.csv',objectType:'DATASET_ROW'},
 ];
 const browse=groupSourceObjects(objects);
 assert.deepEqual([...browse.keys()],['Z.csv','A.csv']);
 assert.deepEqual(browse.get('Z.csv').items.map(item=>item.id),['value']);
 assert.equal(browse.get('Z.csv').reason,'Recent');
 assert.deepEqual(groupSourceObjects(objects,'metadata query').get('Z.csv').items.map(item=>item.id),['summary','value','row'],'search retains all server matches');
 let pathReads=0;
 const large=Array.from({length:10000},(_,index)=>({id:String(index),objectType:'PASSAGE',get path(){pathReads+=1;return `source-${index%5000}.md`;}}));
 assert.equal(groupSourceObjects(large).size,5000);
 assert.ok(pathReads<=40000,`grouping should touch paths a bounded number of times, got ${pathReads}`);
});

test('workspace source grouping keeps identical paths and dataset summaries in separate directories',()=>{
 const objects=[
  {id:'value',projectId:'one',path:'Data.csv',objectType:'DATASET_VALUE'},
  {id:'summary',projectId:'one',path:'Data.csv',objectType:'DATASET'},
  {id:'other-summary',projectId:'two',path:'Data.csv',objectType:'DATASET'},
 ];
 const groups=[...groupSourceObjects(objects).values()];
 assert.equal(groups.length,2);
 assert.deepEqual(groups.map(group=>group.projectId),['one','two']);
 assert.deepEqual(groups.map(group=>group.items.map(object=>object.id)),[['value'],['other-summary']]);
});

test('workspace browsing routes source actions to their owner and document navigation to the destination',async t=>{
 const plan={edits:[{documentPath:'Draft.md',dependencyId:'link-two',projectId:'project-two',action:'MANUAL',spanText:'Supplies cost 400.'}]};
 const h=workbenchHarness(t,{workspace:true,plan});
 h.libraryObjects.splice(0,h.libraryObjects.length,
  {id:'one',projectId:'project-one',projectName:'Research',path:'Data.csv',label:'Travel',objectType:'DATASET_VALUE',snapshotId:'snapshot-one'},
  {id:'two',projectId:'project-two',projectName:'Finance',path:'Data.csv',label:'Supplies',objectType:'DATASET_VALUE',snapshotId:'snapshot-two'});
 await h.workbench.refresh();
 assert.equal(h.host.querySelectorAll('[data-file]').length,2,'same relative path remains independently selectable');
 assert.match(h.host.innerHTML,/Research/);assert.match(h.host.innerHTML,/Finance/);
 const libraryRequest=h.requests.find(request=>request.url.includes('/source-library'));
 assert.ok(libraryRequest.url.startsWith('/api/workspace/source-library?'));
 assert.equal(new URL(libraryRequest.url,'http://localhost').searchParams.get('documentProjectId'),'project-one');
 assert.ok(h.requests.some(request=>request.url==='/api/workspace/terminal/session'));
 h.host.querySelectorAll('[data-file]')[1].click();
 await h.host.querySelector('[data-object]').click();
 const previewRequest=h.requests.find(request=>request.url.endsWith('/terminal/preview'));
 const previewBody=JSON.parse(previewRequest.args.body);
 assert.equal(previewBody.projectId,'project-two');assert.equal(previewBody.ref.projectId,'project-two');
 assert.ok(h.requests.some(request=>request.url==='/api/workspace/source-review/two'));
 await h.host.querySelector('[data-copy]').click();
 assert.equal(h.usage[0][0].projectId,'project-two');assert.equal(h.usage[0][2].projectId,'project-two');
 h.host.querySelector('[data-open]').click();
 assert.equal(h.opened[0][0].snapshotId,'snapshot-two');assert.equal(h.opened[0][1].projectId,'project-two');
 h.host.querySelector('[data-document]').click();
 assert.deepEqual(h.documentsOpened[0],['Draft.md',{dependencyId:'link-two',projectId:'project-two'}]);
});

test('search reuses session counters until the project snapshot changes',async t=>{
 const h=workbenchHarness(t);
 await h.workbench.refresh();
 await h.workbench.refresh({refreshSession:false});
 assert.equal(h.requests.filter(request=>request.url.endsWith('/terminal/session')).length,1);
 h.setVersion('snapshot-two');
 await h.workbench.refresh({refreshSession:false});
 assert.equal(h.requests.filter(request=>request.url.endsWith('/terminal/session')).length,2);
});

test('source pagination keeps every ranked file and every indexed item reachable',async t=>{
 const {workbench,host,fileList,libraryObjects}=workbenchHarness(t);
 libraryObjects.splice(0,libraryObjects.length,...Array.from({length:205},(_,index)=>({id:`file-${index}`,path:`Source-${index}.md`,label:`Evidence ${index}`,objectType:'PASSAGE'})));
 await workbench.refresh();
 assert.equal(host.querySelectorAll('[data-file]').length,100);
 assert.equal(host.querySelectorAll('[data-file]')[0].dataset.file,'Source-0.md');
 host.querySelectorAll('[data-file]').at(-1).focus();
 fileList.handlers.get('keydown')({key:'ArrowDown',preventDefault(){}});
 assert.equal(host.querySelectorAll('[data-file]')[0].dataset.file,'Source-100.md','arrow navigation crosses page boundaries');
 fileList.handlers.get('keydown')({key:'ArrowUp',preventDefault(){}});
 assert.equal(host.querySelectorAll('[data-file]')[0].dataset.file,'Source-0.md');
 host.querySelectorAll('[data-file-page]').find(button=>button.dataset.filePage==='1').click();
 assert.equal(host.querySelectorAll('[data-file]')[0].dataset.file,'Source-100.md');
 host.querySelectorAll('[data-file-page]').find(button=>button.dataset.filePage==='2').click();
 assert.equal(host.querySelectorAll('[data-file]').length,5);
 assert.equal(host.querySelectorAll('[data-file]').at(-1).dataset.file,'Source-204.md');
 host.querySelectorAll('[data-file]').at(-1).click();
 await workbench.refresh();
 assert.match(host.innerHTML,/class="wb-file selected" data-file="Source-204.md"/,'refresh keeps the selected file and its page');
 libraryObjects.splice(0,libraryObjects.length,...Array.from({length:850},(_,index)=>({id:`item-${index}`,path:'Table.csv',label:`Value ${index}`,objectType:'DATASET_VALUE'})));
 await workbench.refresh();
 assert.equal(host.querySelectorAll('[data-object]').length,400);
 host.querySelector('[data-more-items]').click();
 assert.equal(host.querySelectorAll('[data-object]').length,800);
 host.querySelector('[data-more-items]').click();
 assert.equal(host.querySelectorAll('[data-object]').length,850);
 assert.equal(host.querySelector('[data-more-items]'),null);
});

test('reset cancels library and source detail requests without applying old results',async t=>{
 const pending=[];
 const harness=workbenchHarness(t,{api:async(url,args)=>{
  if(url.endsWith('/terminal/session'))return {session:{files:1}};
  if(url.includes('/source-library'))return {objects:[{id:'one',path:'Source.md',label:'Source',objectType:'PASSAGE'}]};
  return new Promise(resolve=>pending.push({url,signal:args.signal,resolve}));
 }});
 await harness.workbench.refresh();
 const selecting=harness.host.querySelector('[data-object]').click();
 assert.equal(pending.length,2);
 harness.workbench.reset();harness.workbench.mount();
 assert.ok(pending.every(request=>request.signal.aborted));
 const resetHTML=harness.host.innerHTML;
 pending.find(request=>request.url.endsWith('/terminal/preview')).resolve({preview:{kind:'text',lines:[{lineNumber:1,text:'Old preview'}]}});
 pending.find(request=>request.url.includes('/source-review/')).resolve({plan:{edits:[]}});
 await selecting;
 assert.equal(harness.host.innerHTML,resetHTML);
});

test('selecting a report without a source cancels the previous source inspection',async t=>{
 const pending=[];
 const h=workbenchHarness(t,{api:async(url,args)=>{
  if(url.includes('/source-library'))return {objects:[]};
  if(url.endsWith('/terminal/session'))return {session:{files:1}};
  if(url.endsWith('/terminal'))return {result:{headline:'Source changes',results:[
   {title:'Previous source',ref:{objectId:'old',path:'Old.csv'}},
   {title:'Indexing failure',lines:['Retry this file'],ref:{kind:'indexFailure',path:'Current.csv',retryable:true}},
  ]}};
  return new Promise(resolve=>pending.push({url,signal:args.signal,resolve}));
 }});
 await h.workbench.run('changes');
 const inspecting=h.host.querySelectorAll('[data-report]')[0].click();
 await h.host.querySelectorAll('[data-report]')[1].click();
 assert.ok(pending.every(request=>request.signal.aborted),'a new report selection cancels source detail work');
 const selectedHTML=h.host.innerHTML;
 pending.find(request=>request.url.endsWith('/terminal/preview')).resolve({preview:{kind:'text',lines:[{lineNumber:1,text:'Obsolete evidence'}]}});
 pending.find(request=>request.url.includes('/source-review/')).resolve({plan:{edits:[]}});
 await inspecting;
 assert.equal(h.host.innerHTML,selectedHTML,'old evidence must not be attached to the new report');
 assert.match(selectedHTML,/Retry this file/);
});

test('an old command failure cannot replace the current report',async t=>{
 let rejectPrevious;
 const h=workbenchHarness(t,{api:async(url,args)=>{
  if(url.includes('/source-library'))return {objects:[]};
  if(url.endsWith('/terminal/session'))return {session:{files:1}};
  if(JSON.parse(args.body).input==='trace previous')return new Promise((resolve,reject)=>{rejectPrevious=reject;});
  return {result:{headline:'Current source changes',results:[]}};
 }});
 const previous=h.workbench.run('trace previous');
 await h.workbench.run('changes');
 const currentHTML=h.host.innerHTML;
 rejectPrevious(new Error('Obsolete command failure'));
 await previous;
 assert.equal(h.host.innerHTML,currentHTML);
 assert.doesNotMatch(h.host.innerHTML,/Obsolete command failure/);
});
