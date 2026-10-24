import { renderModelPlan, bindModelPlans } from './model-preview.js?v=3';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// One modal for local inspection and deliberate, version-pinned sharing.
// Showing a source never creates a grant; only Create link sends a POST.
export function createSourceDialog({ api, getActor, onStatus }) {
  let generation = 0;
  let dialog;
  return async function openSource({ sourceId, versionId, projectId, openSharing = false, shareInsertionId = null }) {
    const current = ++generation;
    dialog?.close(); dialog?.remove();
    dialog = document.createElement('dialog');
    const panel = dialog;
    panel.className = 'modal utility-dialog source-dialog';
    panel.setAttribute('aria-label', 'Source evidence');
    panel.innerHTML = '<p role="status">Loading recorded source…</p><button class="secondary-button" data-close-dialog>Close</button>';
    document.body.append(panel); panel.showModal();
    panel.addEventListener('close', () => { if (generation === current) generation++; panel.remove(); });
    try {
      const { object } = await api(`/api/dependency-objects/${encodeURIComponent(sourceId)}`);
      const pinnedVersion = versionId || object.versionId;
      const owner = object.projectId;
      if (!pinnedVersion || !owner || (projectId && owner !== projectId)) throw new Error('This source does not belong to the selected project.');
      const parameters = new URLSearchParams({ version: pinnedVersion });
      const [context, full, sharing] = await Promise.all([
        api(`/api/dependency-objects/${encodeURIComponent(sourceId)}/preview?${parameters}`),
        api(`/api/dependency-objects/${encodeURIComponent(sourceId)}/document?${parameters}`),
        api('/api/sharing/status'),
      ]);
      if (current !== generation) return;
      const source = context.source;
      const doc = full.document;
      // The server says which scopes this source can be shared with: none for code, no redaction for slides.
      const allowed = full.shareScopes ?? ['INDEXED', 'DOCUMENT', 'REDACTED'];
      const redactionSupported = ['table', 'text'].includes(doc?.kind) && allowed.includes('REDACTED');
      const scopes = ['INDEXED', 'DOCUMENT', 'REDACTED'].filter(option => allowed.includes(option) && (option !== 'REDACTED' || redactionSupported));
      const deck = /\.pptx$/i.test(full.path ?? '');
      let scope = scopes[0] ?? 'INDEXED', redact = new Map(), creating = false, created = null;
      const insertable = Boolean(shareInsertionId && window.lassoPlatform?.isNative && window.lassoPlatform?.isWindows);
      panel.innerHTML = `<header class="dialog-heading"><div><span class="eyebrow">Recorded source · Version ${escape(source.snapshotVersion)}</span><h2>${escape(source.label)}</h2></div><button class="dialog-close toolbar-icon" data-close-dialog aria-label="Close">×</button></header>
        <p class="source-dialog-location">${escape(full.path)} · ${escape(source.location)}</p>
        <div class="source-dialog-preview"></div>
        ${scopes.length ? '' : '<p class="source-share-local">Code files are not shared with links. Send a copy of the file instead.</p>'}
        <details class="source-share-controls" ${openSharing ? 'open' : ''} ${scopes.length ? '' : 'hidden'}><summary>Share this evidence</summary>
          <label>Recipients can access<select data-share-scope>${scopes.map(option => `<option value="${option}">${{
            INDEXED: deck ? 'Cited slide only' : 'Indexed part only',
            DOCUMENT: 'Entire document, including download',
            REDACTED: 'Document with selected content hidden' }[option]}</option>`).join('')}</select></label>
          <p data-scope-help></p><p class="source-share-local">${sharing.localOnly ? 'These links work on this PC while Lasso is running. Remote recipients need a reachable Lasso server.' : 'Anyone with the link can access the evidence you choose to share.'}</p>
          <div class="source-share-result" hidden><label>Share link<input readonly data-share-url /></label>${insertable ? '<button class="primary-button" data-insert-share>Insert link into document</button>' : ''}<button class="secondary-button" data-copy-share>Copy link</button><button class="secondary-button" data-revoke-share>Revoke link</button></div>
          <p class="source-share-error" role="alert"></p>
          <div class="dialog-actions"><button class="primary-button" data-create-share>Create link</button></div>
        </details>`;
      const preview = panel.querySelector('.source-dialog-preview');
      const create = panel.querySelector('[data-create-share]');
      const select = panel.querySelector('[data-share-scope]');
      const error = panel.querySelector('.source-share-error');
      const helpers = {
        INDEXED: deck ? 'Only the slide this evidence is on is shared, without speaker notes or comments.'
          : 'Only this indexed evidence and its nearby context are shared. The original file cannot be downloaded.',
        DOCUMENT: 'Recipients can download the complete recorded file, including all its contents.',
        REDACTED: 'Select cells or text blocks in the preview to hide them. The original file cannot be downloaded. Review all sheets and blocks before creating the link.',
      };
      function renderPreview() {
        panel.querySelector('[data-scope-help]').textContent = helpers[scope];
        const fullView = scope !== 'INDEXED';
        if (fullView && doc?.kind === 'table') {
          preview.innerHTML = doc.sheets.map((sheet, si) => `<section><h3>${escape(sheet.name)}</h3><div class="source-share-table"><table><tbody>${sheet.rows.map((row, ri) => `<tr>${row.map((cell, ci) => {
            const key = `${si}:${ri}:${ci}`;
            return `<td>${scope === 'REDACTED' ? `<button type="button" data-mask="${key}" aria-pressed="${redact.has(key)}" aria-label="${escape(`Sheet ${si + 1}, row ${ri + 1}, column ${ci + 1}: ${redact.has(key) ? 'hidden' : cell}`)}">${redact.has(key) ? '••••••' : escape(cell) || '&nbsp;'}</button>` : escape(cell)}</td>`;
          }).join('')}</tr>`).join('')}</tbody></table></div></section>`).join('');
        } else if (fullView && doc?.kind === 'text') {
          preview.innerHTML = doc.blocks.map((block, i) => scope === 'REDACTED'
            ? `<button class="source-share-block" type="button" data-mask="${i}" aria-pressed="${redact.has(String(i))}">${redact.has(String(i)) ? `Block ${i + 1} hidden · Click to restore` : escape(block)}</button>`
            : `<p>${escape(block)}</p>`).join('');
        } else if ((fullView ? doc : context.preview)?.kind === 'model-plan') {
          preview.innerHTML = renderModelPlan(fullView ? doc : context.preview); bindModelPlans(preview);
        } else if (!fullView && context.preview?.headers?.length) {
          const p = context.preview;
          preview.innerHTML = `<div class="source-share-table"><table><thead><tr>${p.headers.map(h => `<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${p.rows.map(row => `<tr>${(row.cells ?? row).map(cell => `<td${cell?.cited ? ' class="source-cited-cell"' : ''}>${escape(cell?.value ?? cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
        } else {
          preview.innerHTML = `<p>${escape(source.valueText || source.context || 'No inline preview is available for this source.')}</p>`;
        }
        preview.querySelectorAll('[data-mask]').forEach(button => { button.disabled = creating || Boolean(created); });
        preview.querySelectorAll('[data-mask]').forEach(button => button.addEventListener('click', () => {
          const key = button.dataset.mask;
          if (redact.has(key)) redact.delete(key);
          else {
            if (redact.size >= 512) { error.textContent = 'A share supports up to 512 hidden areas.'; return; }
            const indices = key.split(':').map(Number);
            redact.set(key, indices.length === 3 ? { kind: 'CELL', sheet: indices[0], row: indices[1], column: indices[2], effect: 'BLANK' } : { kind: 'BLOCK', block: indices[0], effect: 'BLANK' });
          }
          renderPreview();
        }));
        create.disabled = creating || Boolean(created) || (scope === 'REDACTED' && !redact.size);
      }
      select.addEventListener('change', () => { scope = select.value; redact.clear(); error.textContent = ''; renderPreview(); });
      create.addEventListener('click', async () => {
        if (creating || created) return;
        creating = true; select.disabled = true; error.textContent = ''; renderPreview();
        try {
          const { share } = await api(`/api/projects/${encodeURIComponent(owner)}/object-shares`, { method: 'POST', body: JSON.stringify({ objectId: sourceId, versionId: pinnedVersion, accessScope: scope, redactions: [...redact.values()], actor: getActor() }) });
          if (current !== generation) { onStatus('Source link created. You can manage it in Shared links.'); return; }
          created = share; select.disabled = true;
          preview.querySelectorAll('button').forEach(button => { button.disabled = true; });
          panel.querySelector('.source-share-result').hidden = false;
          panel.querySelector('[data-share-url]').value = share.url;
          create.textContent = 'Link created';
        } catch (caught) { error.textContent = caught.message; }
        finally { creating = false; select.disabled = Boolean(created); preview.querySelectorAll('[data-mask]').forEach(button => { button.disabled = Boolean(created); }); create.disabled = Boolean(created) || (scope === 'REDACTED' && !redact.size); }
      });
      panel.querySelector('[data-insert-share]')?.addEventListener('click', event => {
        event.currentTarget.disabled = true;
        error.textContent = '';
        window.lassoPlatform.postMessage({ action: 'insertSharedLink', targetId: shareInsertionId, token: created.token });
      });
      if (insertable) {
        const insertionResult = event => {
          if (event.detail.targetId !== shareInsertionId) return;
          if (event.detail.error) { error.textContent = event.detail.error + ' Check Shared links before sharing again.'; }
          else { onStatus('Source link inserted.'); panel.close(); }
        };
        window.addEventListener('lasso-share-inserted', insertionResult);
        panel.addEventListener('close', () => window.removeEventListener('lasso-share-inserted', insertionResult), { once: true });
      }
      panel.querySelector('[data-copy-share]').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(created.url); onStatus('Share link copied.'); }
        catch { panel.querySelector('[data-share-url]').select(); error.textContent = 'Press Ctrl+C to copy the selected link.'; }
      });
      panel.querySelector('[data-revoke-share]').addEventListener('click', async event => {
        const button = event.currentTarget; button.disabled = true;
        try {
          await api(`/api/object-shares/${encodeURIComponent(created.token)}/revoke`, { method: 'POST', body: '{}' });
          created = null; select.disabled = false; create.textContent = 'Create link';
          panel.querySelector('.source-share-result').hidden = true; renderPreview(); onStatus('Source link revoked.');
        } catch (caught) { error.textContent = caught.message; }
        finally { button.disabled = false; }
      });
      renderPreview();
    } catch (error) {
      if (current !== generation) return;
      panel.innerHTML = `<h2>Source unavailable</h2><p role="alert">${escape(error.message)}</p><button class="secondary-button" data-close-dialog>Close</button>`;
    }
  };
}
