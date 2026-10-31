// Linked claims in the text: how a source is described, its hover preview and where each claim sits.
import { state } from './state.js?v=1';
import { escapeHtml, reportError, formatDateTime } from './utilities.js?v=1';
import { api } from './api.js?v=1';
import { renderBlockDependencyContent, settleAcceptedDependencyReveal } from './editor-document.js?v=1';
import { focusEditorBlock } from './editor-surface.js?v=1';
import { editorAssistStatus } from './editor-predictions.js?v=1';
import { showDependencyInspector } from './dependency-inspector.js?v=1';

export function spreadsheetColumnLabel(index) {
  if (!Number.isInteger(index) || index < 0) return '';
  let value = index + 1;
  let label = '';
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function dependencyReferencesRow(dependency) {
  const source = dependency?.source ?? {};
  const anchor = source.anchor ?? {};
  if (source.objectType === 'DATASET_ROW' || anchor.kind === 'table-row') return true;
  if (anchor.kind !== 'table-cell' || !anchor.rowKey) return false;
  const comparable = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const linkedText = comparable(dependency?.spanText);
  return Boolean(linkedText && linkedText === comparable(anchor.rowKey)
    && linkedText !== comparable(source.valueText));
}

export function dependencySourceForDisplay(dependency) {
  const source = dependency?.source ?? {};
  if (!dependencyReferencesRow(dependency)) return source;
  const anchor = source.anchor ?? {};
  const rowKey = String(anchor.rowKey ?? source.metadata?.row ?? dependency.spanText ?? '').trim();
  return {
    ...source,
    label: rowKey || source.label,
    objectType: 'DATASET_ROW',
    valueText: null,
    anchor: { kind: 'table-row', rowKey, rowIndex: anchor.rowIndex, sheet: anchor.sheet },
    metadata: { ...source.metadata, row: rowKey, column: null, referenceKind: 'ROW' },
  };
}

export function dependencySourcePresentation(dependency) {
  const source = dependencySourceForDisplay(dependency);
  const anchor = source.anchor ?? {};
  const fileName = String(source.path ?? source.label ?? 'Project source').split('/').pop();
  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  const tabular = ['xls', 'xlsx', 'csv', 'tsv'].includes(extension)
    || ['table-cell', 'table-row', 'table-column'].includes(anchor.kind);
  const coordinate = Number.isInteger(anchor.columnIndex) && Number.isInteger(anchor.rowIndex)
    ? `${spreadsheetColumnLabel(anchor.columnIndex)}${anchor.rowIndex}` : '';
  const scope = [anchor.sheet, coordinate || anchor.rowKey || anchor.column].filter(Boolean).join('!');
  const context = [anchor.sheet, anchor.rowKey, anchor.column].filter(Boolean).join('  ›  ')
    || source.metadata?.title || source.metadata?.subject || source.label;
  return {
    fileName,
    typeLabel: tabular ? 'XLS' : extension === 'pdf' ? 'PDF' : extension === 'docx' ? 'DOC' : extension.slice(0, 3).toUpperCase() || 'SRC',
    typeClass: tabular ? 'sheet' : extension === 'pdf' ? 'pdf' : extension === 'docx' ? 'doc' : 'source',
    sourceLine: scope ? `${fileName} → ${scope}` : fileName,
    context,
  };
}

export function dependencyDisplayValue(dependency) {
  const raw = String(dependencySourceForDisplay(dependency).valueText ?? '').trim();
  const claim = String(dependency.spanText ?? '').trim();
  if (!raw || !claim) return raw;
  const comparableNumber = (value) => {
    const percent = /%/.test(value);
    const numeric = Number(String(value).replace(/[^0-9.eE+-]/g, ''));
    return Number.isFinite(numeric) ? (percent ? numeric / 100 : numeric) : null;
  };
  const sourceNumber = comparableNumber(raw);
  const claimNumber = comparableNumber(claim);
  if (sourceNumber != null && claimNumber != null) {
    const directMatch = Math.abs(sourceNumber - claimNumber) <= Math.max(1e-9, Math.abs(sourceNumber) * 1e-8);
    const percentMatch = Math.abs(sourceNumber - claimNumber * 100) <= Math.max(1e-9, Math.abs(sourceNumber) * 1e-8)
      || Math.abs(sourceNumber * 100 - claimNumber) <= Math.max(1e-9, Math.abs(claimNumber) * 1e-8);
    if (directMatch || percentMatch) return claim;
  }
  return raw;
}

function scheduleSourcePeekClose(delay = 160) {
  clearTimeout(state.editor.sourcePeekTimer);
  state.editor.sourcePeekTimer = setTimeout(() => {
    const peek = document.getElementById('source-peek');
    if (peek) { peek.hidden = true; peek.replaceChildren(); }
  }, delay);
}

async function showSourcePeek(dependencyId, sourceNode) {
  const peek = document.getElementById('source-peek');
  const host = document.querySelector('.editor-workspace');
  if (!peek || !host || !sourceNode?.isConnected) return;
  const request = ++state.editor.sourcePeekRequest;
  try {
    const { dependency } = await api(`/api/dependencies/${dependencyId}`);
    if (request !== state.editor.sourcePeekRequest || !sourceNode.isConnected) return;
    const presentation = dependencySourcePresentation(dependency);
    const displayValue = dependencyDisplayValue(dependency);
    const displaySource = dependencySourceForDisplay(dependency);
    peek.innerHTML = `<header><span class="source-peek-icon">${escapeHtml(presentation.typeLabel)}</span><span><strong>Source preview</strong><small>${escapeHtml(presentation.sourceLine)}</small></span><button aria-label="Close source preview">×</button></header>
      <div class="source-peek-body">${displayValue ? `<div class="source-peek-row value"><small>Value</small><strong>${escapeHtml(displayValue)}</strong></div>` : ''}<div class="source-peek-row"><small>Source</small><strong>${escapeHtml(displaySource.label)}</strong></div><div class="source-peek-row"><small>Updated</small><strong>${escapeHtml(formatDateTime(dependency.createdAt))} by ${escapeHtml(dependency.linkedBy?.displayName ?? dependency.createdBy.displayName)}</strong></div></div>
      <button class="source-peek-open">Open source inspector <span>↗</span></button>`;
    const sourceRect = sourceNode.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const left = Math.max(12, Math.min(sourceRect.left - hostRect.left, host.clientWidth - 322));
    const below = sourceRect.bottom - hostRect.top + 10;
    const top = below + 300 < host.clientHeight ? below : Math.max(12, sourceRect.top - hostRect.top - 300);
    peek.style.left = `${left}px`;
    peek.style.top = `${top}px`;
    peek.hidden = false;
    peek.onpointerenter = () => clearTimeout(state.editor.sourcePeekTimer);
    peek.onpointerleave = () => scheduleSourcePeekClose();
    peek.querySelector('header button').addEventListener('click', () => scheduleSourcePeekClose(0));
    peek.querySelector('.source-peek-open').addEventListener('click', () => {
      scheduleSourcePeekClose(0);
      showDependencyInspector(dependencyId, sourceNode).catch(reportError);
    });
  } catch {
    if (peek) peek.hidden = true;
  }
}

export function bindLinkedClaimNode(node) {
  node.addEventListener('click', (event) => {
    event.stopPropagation();
    if (node.dataset.pendingLinkId) {
      editorAssistStatus('Source selected · autosave pending');
      return;
    }
    if (node.dataset.dependencyId) {
      scheduleSourcePeekClose(0);
      showDependencyInspector(node.dataset.dependencyId, node).catch(reportError);
    }
  });
  if (node.dataset.dependencyId) {
    node.addEventListener('pointerenter', () => {
      clearTimeout(state.editor.sourcePeekTimer);
      state.editor.sourcePeekTimer = setTimeout(() => showSourcePeek(node.dataset.dependencyId, node), 320);
    });
    node.addEventListener('pointerleave', () => scheduleSourcePeekClose());
  }
}

export function resolveDependencyAnchor(dependency, blockText, blockIndex) {
  if (dependency.anchor.blockIndex !== blockIndex) return dependency.anchor;
  const expected = dependency.spanText;
  if (blockText.slice(dependency.anchor.start, dependency.anchor.end) === expected) return dependency.anchor;
  const matches = [];
  let offset = blockText.indexOf(expected);
  while (offset >= 0) {
    matches.push(offset);
    offset = blockText.indexOf(expected, offset + Math.max(1, expected.length));
  }
  if (matches.length !== 1) return null;
  return { ...dependency.anchor, start: matches[0], end: matches[0] + expected.length };
}

function editorDependenciesForBlock(block) {
  const blockIndex = Number(block.dataset.blockIndex);
  const blockText = block.textContent;
  return [...(state.editor.document?.dependencies ?? []), ...state.editor.pendingLinks]
    .map((dependency) => {
      const anchor = resolveDependencyAnchor(dependency, blockText, blockIndex);
      if (!anchor) return null;
      if (dependency.pending) dependency.anchor = anchor;
      return { ...dependency, anchor };
    }).filter(Boolean);
}

export function renderLocalDependencies(block, focusPosition = null) {
  if (!block?.isConnected) return;
  const text = block.textContent;
  const blockIndex = Number(block.dataset.blockIndex);
  block.innerHTML = renderBlockDependencyContent(text, blockIndex, editorDependenciesForBlock(block)) || '<br>';
  block.querySelectorAll('.linked-claim').forEach(bindLinkedClaimNode);
  if (Number.isInteger(focusPosition)) focusEditorBlock(block, focusPosition);
  else if (focusPosition === true) focusEditorBlock(block);
  settleAcceptedDependencyReveal();
}

export function pendingDependenciesForPrediction() {
  return state.editor.pendingLinks.map((dependency) => {
    const block = document.querySelector(`.manuscript-block[data-block-index="${dependency.anchor.blockIndex}"]`);
    const anchor = block ? resolveDependencyAnchor(dependency, block.textContent, dependency.anchor.blockIndex) : null;
    if (!anchor) return null;
    dependency.anchor = anchor;
    return {
      id: dependency.id,
      blockIndex: anchor.blockIndex,
      start: anchor.start,
      end: anchor.end,
      sourceObjectId: dependency.source.id,
      sourceSnapshotId: dependency.source.snapshotId,
    };
  }).filter(Boolean);
}
