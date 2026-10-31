// Choosing who may open a linked source through a share link.
import { state } from './state.js?v=1';
import { escapeHtml, toast, formatDateTime } from './utilities.js?v=1';
import { api } from './api.js?v=1';

const SHARE_CHOICES = {
  CONTEXT: {
    label: 'Cited context', badge: 'Recommended',
    description: 'Share the cited cell or passage with labels and nearby context. The rest of the source stays private.',
  },
  PRIVATE: {
    label: 'Keep source private', badge: 'No access',
    description: 'Revoke active source links. Recipients can read the document claim but cannot open its evidence.',
  },
  FULL: {
    label: 'Full source', badge: 'Broad access',
    description: 'Let link recipients inspect the complete indexed source version. Use only when the full file is appropriate to disclose.',
  },
};

export async function openDependencySharing(dependency, alternativesOpen = false) {
  const target = document.getElementById('dependency-sharing');
  if (!target) return;
  const request = ++state.editor.sharingRequest;
  const isCurrent = () => request === state.editor.sharingRequest && target.isConnected;
  target.innerHTML = '<div class="share-loading">Loading source access…</div>';
  try {
    const { sharing } = await api(`/api/dependencies/${dependency.id}/share`);
    if (!isCurrent()) return;
    renderDependencySharing(dependency, sharing, 'CONTEXT', alternativesOpen);
  } catch (error) {
    if (!isCurrent()) return;
    target.innerHTML = `<div class="share-error">${escapeHtml(error.message)}</div>`;
  }
}

function absoluteShareUrl(grant) {
  return new URL(grant.url, window.location.origin).href;
}

function renderShareGrant(grant) {
  const expires = grant.expiresAt ? `Expires ${formatDateTime(grant.expiresAt)}` : 'No expiration';
  return `<div class="share-grant"><div><strong>${grant.scope === 'CONTEXT' ? 'Cited context' : 'Full source'}</strong><span>${escapeHtml(grant.recipientLabel || 'Anyone with this link')} · ${escapeHtml(expires)}</span></div><div><a href="${escapeHtml(absoluteShareUrl(grant))}" target="_blank" rel="noopener">Preview</a><button data-copy-share="${escapeHtml(grant.token)}">Copy</button><button data-revoke-share="${escapeHtml(grant.token)}">Revoke</button></div></div>`;
}

function renderDependencySharing(dependency, sharing, selectedScope = 'CONTEXT', alternativesOpen = false) {
  const target = document.getElementById('dependency-sharing');
  if (!target) return;
  const request = ++state.editor.sharingRequest;
  const isCurrent = () => request === state.editor.sharingRequest && target.isConnected;
  const selected = SHARE_CHOICES[selectedScope];
  const alternatives = Object.entries(SHARE_CHOICES).filter(([scope]) => scope !== selectedScope);
  target.innerHTML = `<section class="share-card">
    <header><div><span class="share-shield" aria-hidden="true">◇</span><span><strong>Source access</strong><small>Choose what a document recipient may open</small></span></div><button id="close-sharing" aria-label="Close source access">×</button></header>
    <button class="share-choice selected" data-current-share-scope="${selectedScope}"><span><b>${escapeHtml(selected.label)}</b><small>${escapeHtml(selected.description)}</small></span><em>${escapeHtml(selected.badge)}</em></button>
    <button class="share-alternatives-toggle" id="share-alternatives-toggle" aria-expanded="${alternativesOpen}"><span>${alternativesOpen ? 'Hide' : 'Show'} other access options</span><i>${alternativesOpen ? '⌃' : '⌄'}</i></button>
    <div class="share-alternatives" ${alternativesOpen ? '' : 'hidden'}>${alternatives.map(([scope, choice]) => `<button class="share-choice" data-share-scope="${scope}"><span><b>${escapeHtml(choice.label)}</b><small>${escapeHtml(choice.description)}</small></span><em>${escapeHtml(choice.badge)}</em></button>`).join('')}</div>
    ${selectedScope === 'PRIVATE' ? '' : `<div class="share-fields"><label>Recipient or group <input id="share-recipient" placeholder="Optional, for example Review team"></label><label>Link expires <output id="share-expiry">In 48 hours</output></label></div>`}
    <div class="share-privacy-note"><strong>${selectedScope === 'FULL' ? 'Full-source disclosure' : selectedScope === 'PRIVATE' ? 'Private by default' : 'Minimum necessary context'}</strong><span>${selectedScope === 'FULL' ? 'This can reveal unrelated rows or passages in the indexed source.' : selectedScope === 'PRIVATE' ? 'No source content is available through a recipient link.' : 'Only the cited evidence and enough surrounding context to interpret it are disclosed.'}</span></div>
    <button class="share-primary" id="apply-share-scope">${selectedScope === 'PRIVATE' ? 'Revoke source access' : `Create ${selectedScope === 'CONTEXT' ? 'context' : 'full-source'} link`}</button>
    ${sharing.grants.length ? `<div class="share-grants"><span class="eyebrow">Active links</span>${sharing.grants.map(renderShareGrant).join('')}</div>` : '<p class="no-share-grants">No active source links. The dependency is private.</p>'}
  </section>`;
  document.getElementById('close-sharing').addEventListener('click', () => { state.editor.sharingRequest += 1; target.replaceChildren(); });
  document.getElementById('share-alternatives-toggle').addEventListener('click', () => renderDependencySharing(dependency, sharing, selectedScope, !alternativesOpen));
  target.querySelectorAll('[data-share-scope]').forEach((button) => button.addEventListener('click', () => renderDependencySharing(dependency, sharing, button.dataset.shareScope, false)));
  document.getElementById('apply-share-scope').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const { sharing: updated } = await api(`/api/dependencies/${dependency.id}/share`, {
        method: 'POST', body: JSON.stringify({
          scope: selectedScope,
          recipientLabel: document.getElementById('share-recipient')?.value ?? '',
          contextRadius: 1,
          actor: state.identity,
        }),
      });
      if (isCurrent()) renderDependencySharing(dependency, updated, selectedScope, false);
      toast(selectedScope === 'PRIVATE' ? 'Source access revoked' : `${selected.label} link created`);
    } catch (error) { toast(error.message, 'error'); button.disabled = false; }
  });
  target.querySelectorAll('[data-copy-share]').forEach((button) => button.addEventListener('click', async () => {
    const grant = sharing.grants.find((item) => item.token === button.dataset.copyShare);
    if (!grant) return;
    try {
      await navigator.clipboard.writeText(absoluteShareUrl(grant));
      toast('Source link copied');
    } catch { toast('Could not copy the link automatically', 'error'); }
  }));
  target.querySelectorAll('[data-revoke-share]').forEach((button) => button.addEventListener('click', async () => {
    try {
      await api(`/api/dependency-shares/${encodeURIComponent(button.dataset.revokeShare)}`, { method: 'DELETE' });
      const { sharing: updated } = await api(`/api/dependencies/${dependency.id}/share`);
      if (isCurrent()) renderDependencySharing(dependency, updated, selectedScope, alternativesOpen);
      toast('Source link revoked');
    } catch (error) { toast(error.message, 'error'); }
  }));
}
