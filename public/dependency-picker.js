// The picker for choosing a source by hand or changing the one a claim is linked to.
import { state } from './state.js?v=1';
import { escapeHtml, toast, textOffset } from './utilities.js?v=1';
import { api } from './api.js?v=1';
import { clearPrediction } from './editor-predictions.js?v=1';
import { linkCandidate } from './editor-save.js?v=1';

function selectedClaim() {
  const selection = window.getSelection();
  const block = selection?.focusNode?.parentElement?.closest?.('.manuscript-block')
    ?? selection?.focusNode?.closest?.('.manuscript-block') ?? state.editor.activeBlock;
  if (!block) return null;
  const text = block.textContent;
  let start = 0; let end = text.length;
  if (selection && !selection.isCollapsed && block.contains(selection.anchorNode) && block.contains(selection.focusNode)) {
    start = textOffset(block, selection.anchorNode, selection.anchorOffset);
    end = textOffset(block, selection.focusNode, selection.focusOffset);
    if (start > end) [start, end] = [end, start];
  } else {
    const claims = state.editor.prediction?.claim ? [state.editor.prediction.claim] : [];
    if (claims.length) ({ start, end } = claims[0]);
  }
  return {
    start, end, text: text.slice(start, end), searchText: text, type: 'MANUAL', value: null,
    blockIndex: Number(block.dataset.blockIndex), blockType: block.dataset.blockType,
  };
}

export function openManualPickerFromSelection() {
  const claim = selectedClaim();
  if (!claim?.text.trim()) { toast('Select a manuscript phrase first', 'error'); return; }
  showDependencyPicker(claim, 'link');
}

export async function showDependencyPicker(claim, mode = 'link', dependency = null) {
  hideDependencyPicker();
  clearPrediction();
  state.editor.manualClaim = claim;
  state.editor.pickerMode = mode;
  const picker = document.getElementById('dependency-picker');
  if (!picker) return;
  const inspector = document.getElementById('dependency-inspector');
  if (inspector) inspector.hidden = true;
  picker.hidden = false;
  picker.className = 'dependency-picker';
  picker.innerHTML = `<header><div><span class="eyebrow">Select dependency</span><strong>${mode === 'change' ? 'Change linked source' : `“${escapeHtml(claim.text.slice(0, 70))}”`}</strong></div><button id="close-picker" aria-label="Close dependency picker">×</button></header><label><span class="sr-only">Search active directories</span><input id="dependency-search" placeholder="Search sources, figures, datasets, and code"></label><div class="picker-results" id="picker-results"><p>Searching active directories…</p></div>`;
  document.getElementById('close-picker').addEventListener('click', hideDependencyPicker);
  const input = document.getElementById('dependency-search');
  input.value = wordTokensForSearch(dependency
    ? `${dependency.source.label} ${dependency.source.valueText ?? ''}`
    : claim.searchText ?? claim.text);
  input.addEventListener('input', () => {
    clearTimeout(state.editor.pickerTimer);
    state.editor.pickerController?.abort();
    state.editor.pickerTimer = setTimeout(() => loadPickerResults(input.value, dependency), 220);
  });
  await loadPickerResults(input.value, dependency);
  if (input.isConnected && !picker.hidden) input.focus();
}

function wordTokensForSearch(value) {
  return (String(value).match(/[A-Za-z][A-Za-z0-9-]{2,}/g) ?? []).slice(0, 4).join(' ');
}

async function loadPickerResults(query, dependency = null) {
  const target = document.getElementById('picker-results');
  if (!target) return;
  state.editor.pickerController?.abort();
  const controller = new AbortController();
  state.editor.pickerController = controller;
  const documentAtStart = state.editor.document;
  const claim = state.editor.manualClaim;
  const isCurrent = () => state.editor.pickerController === controller && !controller.signal.aborted && target.isConnected && state.editor.document === documentAtStart;
  const parameters = new URLSearchParams({ query });
  if (state.editor.document?.path) parameters.set('documentPath', state.editor.document.path);
  if (state.editor.document?.projectId) parameters.set('documentProjectId', state.editor.document.projectId);
  try {
  const { objects } = await api(`/api/workspace/source-library?${parameters}`, { signal: controller.signal });
  if (!isCurrent()) return;
  target.innerHTML = objects.length ? objects.map((object) => `<button class="picker-result" data-object-id="${object.id}" data-object-snapshot="${object.snapshotId}"><i class="object-type">${escapeHtml(object.objectType)}</i><span><strong>${escapeHtml(object.label)} ${object.valueText ? `<b>${escapeHtml(object.valueText)}</b>` : ''}</strong><small>${escapeHtml([object.projectName, object.path, object.ranking?.reason].filter(Boolean).join(' · '))}</small></span></button>`).join('') : '<div class="no-candidate"><strong>No matching dependency in active directories.</strong><span>Lasso will not invent a source.</span></div>';
  target.querySelectorAll('[data-object-id]').forEach((button) => button.addEventListener('click', () => {
    const object = objects.find((candidate) => candidate.id === button.dataset.objectId && candidate.snapshotId === button.dataset.objectSnapshot);
    if (isCurrent() && object) linkCandidate(claim, object, 'MANUAL', dependency);
  }));
  } catch (error) {
    if (isCurrent()) target.innerHTML = `<div class="no-candidate"><strong>Could not search sources.</strong><span>${escapeHtml(error.message)}</span></div>`;
  }
}

export function hideDependencyPicker() {
  clearTimeout(state.editor.pickerTimer);
  state.editor.pickerTimer = null;
  state.editor.pickerController?.abort();
  state.editor.pickerController = null;
  const picker = document.getElementById('dependency-picker');
  if (picker) { picker.hidden = true; picker.replaceChildren(); }
}
