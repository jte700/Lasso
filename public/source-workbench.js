// Source browsing and evidence review. The command API remains an adapter for
// existing reports; users work with files, excerpts, and explicit actions.
import { renderModelPlan, bindModelPlans } from './model-preview.js?v=2';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const quote = value => String(value).split("'").map(part => `'${part}'`).join(`"'"`);
const basename = value => String(value ?? '').split('/').pop();
const sourceFileKey = object => object.projectId ? `directory:${encodeURIComponent(object.projectId)}:${encodeURIComponent(object.path)}` : object.path;
const icons = {
 file:'<path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v5h4M9 12h6M9 16h6"/>',
 table:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11M3 14h18"/>',
 search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
 check:'<path d="m5 12 4 4L19 6"/>',
 warning:'<path d="m12 3 10 18H2Z"/><path d="M12 9v5m0 3v.1"/>',
 arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] ?? icons.file}</svg>`;
const fileIcon = path => icon(/\.(csv|tsv|xlsx?|numbers)$/i.test(path) ? 'table' : 'file');
const location = object => {
 const a = object.anchor ?? {};
 if(a.kind==='cad-property') return [object.metadata?.storey, a.layer, a.propertySet, a.propertyName, a.elementId].filter(Boolean).join(' · ');
 if(a.kind==='drawing-sheet'||a.kind==='drawing-annotation') return [a.sheetNumber, a.pageNumber?`Page ${a.pageNumber}`:null].filter(Boolean).join(' · ');
 if(a.kind==='cad-model') return object.metadata?.format ? `${object.metadata.format} model` : 'Design model';
 return a.kind==='table-cell' ? [a.sheet, `Row ${(a.rowIndex??0)+1}`, a.column].filter(Boolean).join(' · ') : a.cellId ? [a.sheet, a.cellId].filter(Boolean).join('!') : a.rowKey ? `Row ${a.rowKey}` : a.pageNumber||a.page ? `Page ${a.pageNumber??a.page}` : a.line ? `Line ${a.line}` : a.blockIndex != null ? `Passage ${a.blockIndex + 1}` : object.objectType?.toLowerCase().replaceAll('_',' ') ?? 'Source';
};
// Keep the server's ranked order while grouping in one pass. Dataset summary
// rows are redundant in browse mode when the file has individual values.
export function groupSourceObjects(objects, query = '') {
 const valuedFiles = query ? null : new Set(objects.filter(o=>o.objectType==='DATASET_VALUE').map(sourceFileKey));
 const groups = new Map();
 for (const object of objects) {
  const key=sourceFileKey(object);
  if (valuedFiles?.has(key) && ['DATASET','DATASET_ROW','VARIABLE'].includes(object.objectType)) continue;
  let group=groups.get(key);
  if(!group){group={path:object.path,projectId:object.projectId,projectName:object.projectName,items:[],reason:object.ranking?.reason};groups.set(key,group);}
  group.items.push(object);
 }
 return groups;
}

export function createSourceWorkbench({input, api, getProjectId, getProjectVersion, getWorkspaceId, getDocumentProjectId, getDocumentPath, getContext, getActor, onRecommendationUsage, onOpenDocument, onOpenSource, onStatus, onSession}) {
 let host, epoch=0, detailEpoch=0, timer, objects=[], mode='library', query='', selectedPath='', selectedObject=null, report=null, preview=null, plan=null, busy=false, problem='', candidates=null;
 let session=null, renderedKey='';
 let groupedObjects=null, groupedQuery=null, groups=new Map(), visibleItemCount=400;
 let libraryController=null, detailController=null, sessionRequest=null, sessionProject=null, sessionVersion=null;
 const filePageSize=100;
 const scope = () => getWorkspaceId?.() ?? getProjectId();
 const base = () => getWorkspaceId ? '/api/workspace' : `/api/projects/${encodeURIComponent(getProjectId())}`;
 const usageContext = () => ({projectId:selectedObject?.projectId??getProjectId(),documentPath:getDocumentPath?.()});
 const command = async (line,projectId) => (await api(`${base()}/terminal`, {method:'POST',body:JSON.stringify({input:line,projectId,actor:getActor(),documentProjectId:getDocumentProjectId?.(),documentPath:getDocumentPath?.(),context:getContext?.()})})).result;
 const empty = (title,copy) => `<div class="wb-empty">${icon('search')}<h2>${escape(title)}</h2><p>${escape(copy)}</p></div>`;
 const sourceGroups = () => {
  if(groupedObjects!==objects || groupedQuery!==query){groups=groupSourceObjects(objects,query);groupedObjects=objects;groupedQuery=query;}
  return groups;
 };
 function cancelDetails(){++detailEpoch;detailController?.abort();detailController=null;}
 function cancelLibrary(){++epoch;libraryController?.abort();libraryController=null;}
 function loadSession(project, force) {
  const version=getProjectVersion?.()??null;
  if(sessionRequest?.project===project && sessionRequest.version===version)return sessionRequest.promise;
  if(!force && sessionProject===project && sessionVersion===version && session)return Promise.resolve(session);
  sessionRequest?.controller.abort();
  const controller=new AbortController(), request={project,version,controller,promise:null};
  sessionRequest=request;
  request.promise=api(`${base()}/terminal/session`,{signal:controller.signal}).then(body=>{
   if(!controller.signal.aborted && project===scope()){session=body.session;sessionProject=project;sessionVersion=version;onSession?.(session);}
   return body.session;
  }).finally(()=>{if(sessionRequest===request)sessionRequest=null;});
  return request.promise;
 }
 const title = () => ({library:'Source library',attention:'Needs attention',changes:'Recent changes',shares:'Shared links',names:'Repeated source names',report:'Results'}[mode]);
 function syncNavigation() {
  document.querySelectorAll('.rail-item').forEach(button => {
   const match = mode === 'library' ? button.id === 'workspace-nav' : ({attention:'conflicts',changes:'changes',shares:'share list'}[mode] === button.dataset.workspaceQuery);
   button.classList.toggle('active', match); if(match) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current');
  });
 }
 function render() {
  if(!host?.isConnected) return;
  const focus=document.activeElement?.closest('.wb-file');
  const focusFile=focus?.dataset.file, focusReport=focus?.dataset.report;
  const renderKey=`${mode}:${selectedPath}:${selectedObject?.id??''}`;
  const scroll=renderedKey===renderKey ? host.querySelector('.wb-inspector')?.scrollTop??0 : 0;
  renderedKey=renderKey;
  syncNavigation();
  // The server ranks eligible objects before grouping. Preserve that order so
  // an exact filename or recently used source remains the first file shown.
  const grouped=sourceGroups(), paths=[...grouped.keys()];
  const itemCount=[...grouped.values()].reduce((count,group)=>count+group.items.length,0);
  if(!paths.includes(selectedPath)){selectedPath=paths[0]??'';visibleItemCount=400;}
  const page=Math.max(0,Math.floor(paths.indexOf(selectedPath)/filePageSize));
  const list = mode==='library' ? paths.slice(page*filePageSize,(page+1)*filePageSize).map(path => {
   const {items,reason,path:sourcePath,projectName}=grouped.get(path),count=items.length;
   return `<button class="wb-file ${selectedPath===path?'selected':''}" data-file="${escape(path)}" aria-pressed="${selectedPath===path}">${fileIcon(sourcePath)}<span><strong>${escape(basename(sourcePath))}</strong><small>${escape([projectName,reason ?? `${count} indexed items`].filter(Boolean).join(' · '))}</small></span></button>`;
  }).join('') : (report?.results ?? []).map((item,i)=>`<button class="wb-file ${selectedObject?.listIndex===i?'selected':''}" data-report="${i}">${icon(item.tone==='warn'?'warning':'file')}<span><strong>${escape(item.title)}</strong><small>${escape(item.lines?.[0]??'')}</small></span>${item.tone==='warn'?'<i class="wb-dot"></i>':''}</button>`).join('');
  host.innerHTML = `<section class="wb" aria-label="${title()}">
   <header class="wb-heading"><div><h1>${title()}</h1><p>${escape(mode==='library' ? 'Find the evidence you need. Keep its source attached.' : mode==='attention' ? 'Compare changed values and choose what your documents should keep.' : mode==='changes' ? 'See what changed at the source.' : mode==='shares' ? 'See which evidence is available to others.' : mode==='names' ? 'The same name can refer to different evidence. Compare before choosing.' : report?.headline??'')}</p></div>${mode==='library' && session?.conflicts?'<button class="wb-button" data-names>Compare repeated names</button>':''}<button class="wb-button" data-refresh title="Refresh sources">↻ <span>Refresh</span></button></header>
   ${problem?`<div class="wb-error" role="alert">${escape(problem)} <button class="wb-button" data-refresh>Try again</button></div>`:''}
   <div class="wb-split"><section class="wb-browser" aria-label="Sources"><header><span>${mode==='library'?(query?'Matching files':'Files'):'Items'}</span><small>${busy?'Loading…':mode==='library'?paths.length:report?.results?.length??0}</small></header><div class="wb-file-list">${list || `<p class="wb-list-empty">${busy?'Loading sources…':query?'No matching sources':'Nothing here yet'}</p>`}</div><footer>${mode==='library'&&paths.length>filePageSize?`<button class="wb-button" data-file-page="${page-1}" ${page===0?'disabled':''}>Previous</button> <span>${page*filePageSize+1}–${Math.min(paths.length,(page+1)*filePageSize)} of ${paths.length}</span> <button class="wb-button" data-file-page="${page+1}" ${(page+1)*filePageSize>=paths.length?'disabled':''}>Next</button>`:mode==='library'?'Files stay in their original folder.':'Select an item to inspect it.'}</footer></section>
   <section class="wb-inspector" aria-label="Source evidence" aria-busy="${busy}">${detail(grouped.get(selectedPath)?.items??[])}</section></div>
   <footer class="wb-status"><span>${mode==='library'?`${paths.length} files · ${itemCount} indexed items`:escape(report?.headline??'')}</span><span>Local workspace${session?.version?` · Version ${session.version}`:''}</span></footer>
  </section>`;
  bind();
  bindModelPlans(host);
  const inspector=host.querySelector('.wb-inspector');if(inspector)inspector.scrollTop=scroll;
  if(focusFile!==undefined||focusReport!==undefined)[...host.querySelectorAll('.wb-file')].find(b=>focusFile!==undefined?b.dataset.file===focusFile:b.dataset.report===focusReport)?.focus({preventScroll:true});
 }
 function previewHTML() {
  if(!preview) return '<p class="wb-muted">Loading source preview…</p>';
  if(preview.kind==='model-plan') return renderModelPlan(preview);
  if(preview.kind==='model-unavailable') return `<p class="wb-prose">${escape(preview.reason ?? 'No displayable geometry was found for this indexed element.')}</p>`;
  if(preview.kind==='pdf') {
   const page=Math.max(1,Math.floor(Number(preview.pageNumber??preview.page)||1));
   const text=preview.selectedText||preview.text;
   return `${preview.fileUrl?`<iframe class="wb-pdf" src="${escape(`${preview.fileUrl}#page=${page}&zoom=page-width`)}" title="${escape(selectedObject?.path??'PDF source')}"></iframe>`:'<p class="wb-muted">The PDF page could not be loaded. Open the source to inspect its recorded version.</p>'}${text?`<p class="wb-prose">${escape(text)}</p>`:''}`;
  }
  if(preview.kind==='table') return `<div class="wb-table-scroll"><table class="wb-evidence-table"><thead><tr><th scope="col" aria-label="Row number"></th>${(preview.headerRow??preview.columns??[]).map((heading,i)=>`<th scope="col"><span>${escape(heading||(preview.columns?.[i]?`Column ${preview.columns[i]}`:'Column'))}</span></th>`).join('')}</tr></thead><tbody>${preview.rows.map(row=>`<tr class="${row.highlighted?'cited':''}"><th>${row.rowNumber}</th>${row.cells.map((cell,i)=>`<td class="${row.highlighted && i===preview.highlightColumn?'cited-cell':''}">${escape(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  if(preview.kind==='text') return `<div class="wb-excerpt">${preview.lines.map(line=>`<div class="${line.highlighted?'cited':''}"><span>${line.lineNumber}</span><p>${escape(line.text)||' '}</p></div>`).join('')}</div>`;
  return `<p class="wb-prose">${escape(preview.reason??preview.value??'A visual preview is unavailable for this source. Open its recorded version to inspect it.')}</p>`;
 }
 function planHTML() {
  if(!plan) return '';
  return `<section class="wb-usage"><h3>${mode==='attention'?'Review document wording':'Used in documents'}</h3>${plan.edits.length?plan.edits.map(edit=>`<article><header><button class="wb-text-button" data-document="${escape(edit.documentPath)}" data-dependency="${escape(edit.dependencyId)}" data-project="${escape(edit.projectId??getProjectId())}">${escape(basename(edit.documentPath))} ↗</button><small>${escape(edit.action==='REWRITE'?'Value changed':edit.action==='MANUAL'?'Review in document':edit.action==='RELINK'?'Source moved':'Current')}</small></header><p>${escape(edit.spanText)}</p>${edit.action==='REWRITE'?`<p class="wb-replacement">${icon('arrow')}${escape(edit.nextSpanText)}</p>`:edit.reason?`<small>${escape(edit.reason)}</small>`:''}</article>`).join(''):'<p class="wb-muted">No document links to this item yet. Use Lasso’s suggestions while writing to create a tracked reference.</p>'}
  ${mode==='attention' && plan.edits.length?`<div class="wb-review-actions"><button class="wb-button" data-keep ${busy?'disabled':''}>Keep existing wording</button>${plan.rewrites+plan.relinks?`<button class="wb-button emphasized" data-apply ${busy?'disabled':''}>Apply ${plan.rewrites+plan.relinks} reviewed ${plan.rewrites+plan.relinks===1?'change':'changes'}</button>`:''}</div><p class="wb-fine">${plan.manual?`${plan.manual} reference(s) require manual review. `:''}Keeping wording pins references to their recorded source version.</p>`:''}</section>`;
 }
 function detail(items) {
  const sourcePath=items[0]?.path??selectedObject?.path??selectedPath;
  const projectName=items[0]?.projectName??selectedObject?.projectName;
  if(candidates) return `<div class="wb-detail"><div class="wb-overline">More than one source</div><h2>${escape(candidates.name)}</h2><p class="wb-muted">Compare the locations below. Give the intended source a distinct name so it is easy to find while writing.</p>${candidates.candidates.map((c,i)=>`<button class="wb-candidate" data-candidate="${i}"><span><strong>${escape(basename(c.path))}</strong><small>${escape(c.locator)}</small></span><b>${escape(c.value??'')}</b>${icon('arrow')}</button>`).join('')}</div>`;
  if(selectedObject) {
   const o=selectedObject;
   return `<div class="wb-detail"><button class="wb-text-button wb-back" data-back>‹ ${escape(mode==='library'?basename(sourcePath):title())}</button><div class="wb-overline">${escape([o.projectName,o.path?basename(o.path):'Selected source'].filter(Boolean).join(' · '))}</div><h2>${escape(o.label)}</h2><div class="wb-detail-meta">${escape(location(o))}${o.snapshotVersion?` · Version ${o.snapshotVersion}`:''}</div>
   ${o.valueText!=null && o.valueText!==''?`<div class="wb-value">${escape(o.valueText)}</div>`:''}
   <div class="wb-actions">${o.id?'<button class="wb-button emphasized" data-copy>Copy with citation</button><button class="wb-button" data-open>Open source ↗</button>':''}${o.shareUrl?'<button class="wb-button" data-copy-link>Copy shared link</button>':''}${o.retryPath?'<button class="wb-button emphasized" data-retry>Retry indexing</button>':''}</div>
   ${o.aliasAddress?`<form class="wb-alias"><label>Name this source<input name="alias" required placeholder="For example, current-period-revenue" /></label><button class="wb-button" type="submit">Save source name</button></form>`:''}
   <section class="wb-preview"><header><h3>Source context</h3><small>${escape(preview?.locator??'Recorded evidence')}</small></header>${previewHTML()}</section>${planHTML()}</div>`;
  }
  if(mode==='library' && selectedPath) {
   return `<div class="wb-detail"><div class="wb-source-heading">${fileIcon(sourcePath)}<div><div class="wb-overline">${escape([projectName,sourcePath.includes('/')?sourcePath.slice(0,sourcePath.lastIndexOf('/')):'Work directory'].filter(Boolean).join(' · '))}</div><h2>${escape(basename(sourcePath))}</h2><p>${items.length} indexed items · Select one to inspect its evidence</p></div></div><div class="wb-items-heading"><span>Indexed content</span><span>Value / excerpt</span></div><div class="wb-items">${items.slice(0,visibleItemCount).map(o=>`<button class="wb-item" data-object="${escape(o.id)}"><span><strong>${escape(o.label)}</strong><small>${escape(location(o))}</small></span><span>${escape(o.valueText??'View source')}</span>${icon('arrow')}</button>`).join('')}</div>${items.length>visibleItemCount?`<button class="wb-button" data-more-items>Show ${Math.min(400,items.length-visibleItemCount)} more items</button>`:''}</div>`;
  }
  if(mode==='attention' && report?.results?.length) return empty('Choose an item to review','Inspect changed wording or compare sources with the same name.');
  if(mode==='attention') return empty('Your linked sources are up to date','No stale document links or indexing failures were found.');
  if(mode==='names') return empty(report?.results?.length?'Choose a name to compare':'No repeated names',report?.results?.length?'See the source files and values side by side, then give the intended source an easy-to-find name.':'Each indexed source name is distinct.');
  if(mode==='shares') return empty('No shared links','Sharing starts from a linked source in your document. You choose exactly what the recipient can see.');
  if(mode==='changes') return empty('No source changes','Changes to indexed values will appear here, with their previous and current values.');
  if(report && mode==='report') return `<div class="wb-detail"><h2>${escape(report.headline)}</h2>${(report.blocks??[]).map(block=>block.kind==='text'?`<p>${escape(block.text)}</p>`:block.kind==='fields'?`<dl>${block.rows.map(r=>`<dt>${escape(r.label)}</dt><dd>${escape(r.value)}</dd>`).join('')}</dl>`:'').join('')}</div>`;
  if(busy && !objects.length) return empty('Loading sources','Reading the indexed files in your work directories.');
  if(!query && objects.length) return empty('Choose a source','Select a file to inspect its indexed evidence.');
  return empty(query?'No matching evidence':'Add sources to this project',query?'Try a file name, a phrase, or a value from your source.':'Documents and data in your project folder will appear here after indexing.');
 }
 async function selectObject(object,extra={}) {
  // Explicit selection cancels a pending search before it can clear the preview.
  clearTimeout(timer);query=input.value.trim();
  cancelDetails();const token=detailEpoch, project=scope(),controller=new AbortController();detailController=controller; selectedObject={...object,...extra}; candidates=null; preview=null;plan=null;render();
  try {
   const [p,r]=await Promise.all([
    /\.pdf$/i.test(object.path??'')
     ? api(`/api/dependency-objects/${encodeURIComponent(object.id)}/preview${object.versionId?`?version=${encodeURIComponent(object.versionId)}`:''}`,{signal:controller.signal})
     : api(`${base()}/terminal/preview`,{method:'POST',body:JSON.stringify({projectId:object.projectId,ref:{kind:'object',objectId:object.id,projectId:object.projectId}}),signal:controller.signal}),
    api(`${base()}/source-review/${encodeURIComponent(object.id)}`,{signal:controller.signal}),
   ]);
   if(token!==detailEpoch || project!==scope())return;
   preview=p.preview??{reason:'No preview is available for this source.'};plan=r.plan;render();
  }catch(error){if(token!==detailEpoch || controller.signal.aborted)return;preview={reason:error.message};render();}
  finally{if(detailController===controller)detailController=null;}
 }
 async function selectReport(index) {
  const item=report.results[index];if(!item)return;
  cancelDetails();
  if(item.ref?.kind==='conflict') {
   const token=detailEpoch;
   try {
    const result=await command(`conflicts -- ${quote(item.ref.name)}`,item.ref.projectId);
    if(token!==detailEpoch)return;
    const conflict=result.data?.conflict??result.data?.projects?.find(project=>project.projectId===item.ref.projectId)?.conflict;
    candidates=conflict ? {...conflict,candidates:conflict.candidates.map(candidate=>({...candidate,projectId:candidate.projectId??item.ref.projectId,projectName:candidate.projectName??item.ref.projectName}))} : null;
    selectedObject=null;render();
   }catch(e){if(token===detailEpoch)onStatus(e.message);}return;
  }
  if(item.ref?.objectId){
   const object=objects.find(o=>o.id===item.ref.objectId)??{id:item.ref.objectId,projectId:item.ref.projectId,projectName:item.ref.projectName,label:item.title,path:item.ref.path,valueText:item.value};
   return selectObject(object,{listIndex:index,shareUrl:item.ref.kind==='share'?item.ref.url:null});
  } else {selectedObject={projectId:item.ref?.projectId,projectName:item.ref?.projectName,label:item.title,path:item.ref?.path,retryPath:item.ref?.kind==='indexFailure' && item.ref.retryable?item.ref.path:null};preview={reason:item.lines?.join(' · ')??'This item has no preview.'};plan=null;candidates=null;render();}
 }
 async function refresh({refreshSession=true}={}) {
  const project=scope();if(!project)return;
  cancelLibrary();const token=epoch,controller=new AbortController();libraryController=controller;busy=true;problem='';render();
  try {
   const parameters=new URLSearchParams({query});
   const documentPath=getDocumentPath?.();if(documentPath)parameters.set('documentPath',documentPath);
   const documentProjectId=getDocumentProjectId?.();if(documentProjectId)parameters.set('documentProjectId',documentProjectId);
   const context=getContext?.();if(context)parameters.set('context',context);
   const [library]=await Promise.all([api(`${base()}/source-library?${parameters}`,{signal:controller.signal}),loadSession(project,refreshSession)]);
   if(token!==epoch || project!==scope())return;
   objects=library.objects;groupedObjects=null;
   if(mode==='attention') {
    const parts=await Promise.all(['stale','index failures'].map(line=>command(line)));
    if(token!==epoch || project!==scope())return;
    report={headline:'Sources to review',results:parts.flatMap(p=>p.results??[]).filter(r=>r.badge!=='aliased')};
    const badge=document.getElementById('rail-review-count');if(badge)badge.textContent=report.results.length||'';
   }else if(['changes','shares','names'].includes(mode)){
    const next=await command(mode==='changes'?'changes':mode==='names'?'conflicts':'shares');
    if(token!==epoch || project!==scope())return;report=next;
   }
   if(token!==epoch || project!==scope())return;
  }catch(error){if(token!==epoch || controller.signal.aborted)return;problem=error.message;}
  finally{if(libraryController===controller)libraryController=null;}
  busy=false;render();
 }
 async function run(line) {
  clearTimeout(timer);cancelDetails();cancelLibrary();selectedObject=null;candidates=null;preview=null;plan=null;query='';input.value='';report=null;problem='';
  mode=line==='names'?'names':['conflicts','stale'].includes(line)?'attention':line==='changes'?'changes':['share list','shares'].includes(line)?'shares':line==='index status'?'library':'report';
  if(mode==='report') {const token=++epoch;busy=true;render();try{const result=await command(line);if(token!==epoch)return;report=result;}catch(e){if(token!==epoch)return;problem=e.message;}busy=false;render();return;}
  await refresh();
 }
 async function apply(action) {
  if(!plan||busy)return;
  const expectedPlan=plan, project=scope(), id=selectedObject.id;busy=true;render();
  try {
   await api(`${base()}/source-review/${encodeURIComponent(id)}`,{method:'POST',body:JSON.stringify({action,expectedPlan,actor:getActor()})});
   if(project!==scope())return;
   onStatus(action==='keep'?'Existing wording kept at its recorded version.':'Reviewed changes applied.');selectedObject=null;plan=null;await refresh();
  }catch(e){if(project!==scope())return;problem=e.message;busy=false;render();}
 }
 function bind() {
  const selectFile=path=>{cancelDetails();selectedPath=path;visibleItemCount=400;selectedObject=null;preview=null;plan=null;candidates=null;render();};
  host.querySelectorAll('[data-file]').forEach(b=>b.onclick=()=>selectFile(b.dataset.file));
  host.querySelectorAll('[data-file-page]').forEach(b=>b.onclick=()=>{const path=[...sourceGroups().keys()][Number(b.dataset.filePage)*filePageSize];if(path){selectFile(path);host.querySelector('.wb-file')?.focus();}});
  host.querySelector('[data-more-items]')?.addEventListener('click',()=>{visibleItemCount+=400;render();});
  host.querySelectorAll('[data-object]').forEach(b=>b.onclick=()=>selectObject(objects.find(o=>o.id===b.dataset.object)));
  host.querySelectorAll('[data-report]').forEach(b=>b.onclick=()=>selectReport(Number(b.dataset.report)));
  host.querySelectorAll('[data-refresh]').forEach(b=>b.onclick=()=>{cancelDetails();selectedObject=null;plan=null;refresh();});
  host.querySelector('[data-names]')?.addEventListener('click',()=>run('names'));
  host.querySelector('[data-retry]')?.addEventListener('click',async()=>{try{const result=await command(`index retry -- ${quote(selectedObject.retryPath)}`,selectedObject.projectId);onStatus(result.headline);selectedObject=null;refresh();}catch(error){onStatus(error.message);}});
  host.querySelector('[data-back]')?.addEventListener('click',()=>{cancelDetails();selectedObject=null;candidates=null;render();});
  host.querySelector('[data-open]')?.addEventListener('click',()=>onOpenSource?.(selectedObject,usageContext()));
  host.querySelector('[data-copy]')?.addEventListener('click',async()=>{
   const o=selectedObject, context=usageContext(), excerpt=preview?.lines?.filter(l=>l.highlighted).map(l=>l.text).join('\n') || preview?.lines?.map(l=>l.text).join('\n') || preview?.selectedText || preview?.text;
   const text=`${o.valueText || excerpt || o.label}\nSource: ${[o.projectName,o.path].filter(Boolean).join(' / ')} · ${location(o)}${o.snapshotVersion?` · Version ${o.snapshotVersion}`:''}`;
   try{await navigator.clipboard.writeText(text);onRecommendationUsage?.({objectId:o.id,projectId:o.projectId},'accept',context);onStatus('Copied with source citation.');}catch{onStatus('Could not access the clipboard. Select and copy the displayed value.');}
  });
  host.querySelector('[data-copy-link]')?.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(selectedObject.shareUrl);onStatus('Shared link copied.');}catch{onStatus('Could not access the clipboard.');}});
  host.querySelectorAll('[data-document]').forEach(b=>b.onclick=()=>onOpenDocument(b.dataset.document,{dependencyId:b.dataset.dependency,projectId:b.dataset.project}));
  host.querySelector('[data-apply]')?.addEventListener('click',()=>apply('apply'));
  host.querySelector('[data-keep]')?.addEventListener('click',()=>apply('keep'));
  host.querySelectorAll('[data-candidate]').forEach(b=>b.onclick=()=>{const c=candidates.candidates[Number(b.dataset.candidate)];selectObject(objects.find(o=>o.id===c.objectId)??{id:c.objectId,projectId:c.projectId,projectName:c.projectName,label:c.name,path:c.path,valueText:c.value},{aliasAddress:c.address});});
  host.querySelector('.wb-alias')?.addEventListener('submit',async event=>{event.preventDefault();try{const form=event.currentTarget;const name=new FormData(form).get('alias').trim();if(!name)return;const result=await command(`alias -- ${quote(name)} ${quote(selectedObject.aliasAddress)}`,selectedObject.projectId);if(!result.ok){onStatus(result.headline);return;}onStatus('Source name saved.');await run('names');}catch(error){onStatus(error.message);}});
  host.querySelector('.wb-file-list')?.addEventListener('keydown',event=>{
   if(!['ArrowDown','ArrowUp'].includes(event.key))return;
   const direction=event.key==='ArrowDown'?1:-1;
   if(mode==='library'){
    const paths=[...sourceGroups().keys()],index=paths.indexOf(document.activeElement?.dataset.file??selectedPath);
    const path=paths[Math.max(0,Math.min(paths.length-1,index+direction))];
    if(path){event.preventDefault();selectFile(path);[...host.querySelectorAll('[data-file]')].find(button=>button.dataset.file===path)?.focus();}
    return;
   }
   const buttons=[...host.querySelectorAll('.wb-file')],index=buttons.indexOf(document.activeElement);
   const next=buttons[Math.max(0,Math.min(buttons.length-1,index+direction))];
   if(next){event.preventDefault();next.click();host.querySelectorAll('.wb-file')[buttons.indexOf(next)]?.focus();}
  });
 }
 input.addEventListener('input',()=>{clearTimeout(timer);cancelLibrary();cancelDetails();timer=setTimeout(()=>{query=input.value.trim();mode='library';visibleItemCount=400;selectedObject=null;candidates=null;preview=null;plan=null;refresh({refreshSession:false});},100);});
 input.addEventListener('keydown',async event=>{
  if(event.key==='Enter' && /^(?:ask\s|what\b|which\b|where\b|when\b|how\b|show\s+me\b|give\s+me\b)/i.test(input.value.trim())){
   event.preventDefault();const question=input.value.trim().replace(/^ask\s+/i,'');await run(`ask ${question}`);return;
  }
if(event.key==='ArrowDown'){event.preventDefault();host?.querySelector('.wb-file')?.focus();}});
 return {setHost(node){host=node;},mount(){render();},refresh,run,reset(){cancelLibrary();cancelDetails();sessionRequest?.controller.abort();sessionRequest=null;sessionProject=null;sessionVersion=null;clearTimeout(timer);objects=[];query='';input.value='';selectedObject=null;selectedPath='';visibleItemCount=400;candidates=null;report=null;plan=null;preview=null;mode='library';session=null;problem='';busy=false;},focus(){input.focus();},get state(){return {session};}};
}
