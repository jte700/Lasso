// The editable page: the caret, undo history, paragraph blocks and keyboard shortcuts.
import { caretPointForTextLengths } from './editor-acceptance.js';
import { AUTOSAVE_INTERVAL_MS, state } from './state.js?v=1';
import { toast, textOffset } from './utilities.js?v=1';
import { projectIsOffline } from './workspace-projects.js?v=1';
import { renderEditableBlock } from './editor-document.js?v=1';
import {
  predictForBlock, showPredictionCompletion, clearPrediction, endSourceContext, acceptPrediction,
} from './editor-predictions.js?v=1';
import { saveDocument } from './editor-save.js?v=1';
import { bindLinkedClaimNode, renderLocalDependencies } from './linked-claims.js?v=1';
import { openManualPickerFromSelection } from './dependency-picker.js?v=1';

function editorBlockFromSelection(target = null) {
  const direct = target?.closest?.('.manuscript-block');
  if (direct) return direct;
  const selection = window.getSelection();
  const focusElement = selection?.focusNode?.nodeType === Node.ELEMENT_NODE
    ? selection.focusNode : selection?.focusNode?.parentElement;
  return focusElement?.closest?.('.manuscript-block') ?? state.editor.activeBlock;
}

export function focusEditorBlock(block, offset = null) {
  const surface = document.getElementById('document-body');
  if (!surface || !block) return;
  surface.focus({ preventScroll: true });
  if (offset == null) placeCaretAtEnd(block);
  else placeCaretAtOffset(block, offset);
  state.editor.activeBlock = block;
}

export function bindEditorSurface() {
  const surface = document.getElementById('document-body');
  if (!surface) return;
  const rememberActiveBlock = (event) => {
    const block = editorBlockFromSelection(event.target);
    if (block?.isConnected) state.editor.activeBlock = block;
  };
  surface.addEventListener('focusin', rememberActiveBlock);
  surface.addEventListener('pointerup', rememberActiveBlock);
  surface.addEventListener('keyup', rememberActiveBlock);
  surface.addEventListener('beforeinput', (event) => {
    if (!state.editor.restoringHistory) recordEditorHistory(event.inputType ?? 'input');
  });
  surface.addEventListener('input', (event) => {
    const block = editorBlockFromSelection(event.target);
    if (!block?.isConnected) return;
    state.editor.activeBlock = block;
    repairLinkedClaimBoundaries(block);
    markEditorDirty();
    clearPrediction();
    clearTimeout(state.editor.predictionTimer);
    state.editor.predictionTimer = setTimeout(() => predictForBlock(block), 45);
  });
}

/**
 * Keeps a claim's highlight to the claim.
 *
 * Typing immediately after a linked claim is merged into it by the browser,
 * however the caret was placed — the span is inline, and that is what inline
 * editing does. Rather than fight the caret, the extra characters are lifted
 * back out into a sibling text node, which leaves the document text untouched
 * and the highlight exactly as wide as what was linked.
 */
function repairLinkedClaimBoundaries(block) {
  const known = new Map([...(state.editor.document?.dependencies ?? []), ...state.editor.pendingLinks]
    .map((dependency) => [dependency.id, dependency.spanText]));
  for (const claim of block.querySelectorAll('.linked-claim')) {
    const id = claim.dataset.dependencyId ?? claim.dataset.pendingLinkId;
    const expected = known.get(id);
    const text = claim.textContent;
    // Only the append case is repaired. Editing the claim itself is a real
    // change to the writing, and belongs to review rather than to this.
    if (!expected || text === expected || !text.startsWith(expected) || text.length <= expected.length) continue;
    const overflow = text.slice(expected.length);
    claim.textContent = expected;
    const tail = document.createTextNode(overflow);
    claim.after(tail);
    const range = document.createRange();
    range.setStart(tail, tail.textContent.length);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

export function editorHistorySnapshot() {
  const active = editorBlockFromSelection() ?? state.editor.activeBlock;
  return {
    blocks: [...document.querySelectorAll('.manuscript-block')].map((block) => ({
      type: block.dataset.blockType ?? 'paragraph',
      text: block.textContent,
      headingLevel: block.dataset.headingLevel,
      listStyle: block.dataset.listStyle,
      codeFence: block.dataset.codeFence,
    })),
    activeIndex: active ? Number(active.dataset.blockIndex) : 0,
    caret: active ? caretOffsetWithin(active) : 0,
    dependencyAnchors: Object.fromEntries((state.editor.document?.dependencies ?? []).map((dependency) => [dependency.id, { ...dependency.anchor }])),
    pendingLinks: structuredClone(state.editor.pendingLinks),
  };
}

export function recordEditorHistory(inputType = 'edit', force = false) {
  if (state.editor.restoringHistory || !document.getElementById('document-body')) return;
  const timestamp = Date.now();
  const coalescible = /^(?:insertText|deleteContentBackward|deleteContentForward)$/.test(inputType);
  const coalesced = !force && coalescible && state.editor.lastHistoryType === inputType
    && timestamp - state.editor.lastHistoryAt < 750;
  if (!coalesced) {
    const snapshot = editorHistorySnapshot();
    const historyKey = (value) => JSON.stringify({
      blocks: value.blocks,
      dependencyAnchors: value.dependencyAnchors,
      pendingLinks: value.pendingLinks.map((dependency) => ({
        id: dependency.id, anchor: dependency.anchor, spanText: dependency.spanText,
      })),
    });
    if (!state.editor.undoStack.length || historyKey(state.editor.undoStack.at(-1)) !== historyKey(snapshot)) {
      state.editor.undoStack.push(snapshot);
    }
    if (state.editor.undoStack.length > 50) state.editor.undoStack.shift();
    state.editor.redoStack = [];
  }
  state.editor.lastHistoryAt = timestamp;
  state.editor.lastHistoryType = force ? null : inputType;
}

function restoreEditorHistory(snapshot) {
  if (!snapshot) return;
  const surface = document.getElementById('document-body');
  if (!surface) return;
  state.editor.restoringHistory = true;
  clearPrediction();
  for (const dependency of state.editor.document?.dependencies ?? []) {
    if (snapshot.dependencyAnchors[dependency.id]) dependency.anchor = { ...snapshot.dependencyAnchors[dependency.id] };
  }
  state.editor.pendingLinks = structuredClone(snapshot.pendingLinks);
  const dependencies = [...(state.editor.document?.dependencies ?? []), ...state.editor.pendingLinks];
  surface.innerHTML = snapshot.blocks.map((block, index) => renderEditableBlock(block, index, dependencies)).join('');
  surface.querySelectorAll('.linked-claim').forEach(bindLinkedClaimNode);
  const active = surface.querySelector(`.manuscript-block[data-block-index="${Math.min(snapshot.activeIndex, snapshot.blocks.length - 1)}"]`)
    ?? surface.querySelector('.manuscript-block');
  if (active) focusEditorBlock(active, Math.min(snapshot.caret, active.textContent.length));
  state.editor.restoringHistory = false;
  state.editor.lastHistoryType = null;
  markEditorDirty();
}

function undoEditor() {
  const snapshot = state.editor.undoStack.pop();
  if (!snapshot) return;
  state.editor.redoStack.push(editorHistorySnapshot());
  restoreEditorHistory(snapshot);
}

function redoEditor() {
  const snapshot = state.editor.redoStack.pop();
  if (!snapshot) return;
  state.editor.undoStack.push(editorHistorySnapshot());
  restoreEditorHistory(snapshot);
}

export function markEditorDirty() {
  state.editor.dirty = true;
  state.editor.editRevision += 1;
  const save = document.getElementById('save-document');
  if (save) save.disabled = false;
  const status = document.getElementById('editor-save-state');
  if (status) status.textContent = 'Autosave pending';
  scheduleEditorAutosave();
}

export function scheduleEditorAutosave() {
  if (projectIsOffline()) return;
  if (state.editor.autosaveTimer || state.editor.savePromise) return;
  state.editor.autosaveTimer = setTimeout(() => {
    state.editor.autosaveTimer = null;
    saveDocument({ automatic: true });
  }, AUTOSAVE_INTERVAL_MS);
}

export function markPendingDependency() {
  const save = document.getElementById('save-document');
  if (save) save.disabled = false;
  const status = document.getElementById('editor-save-state');
  if (status) status.textContent = 'Source selected · autosave pending';
  scheduleEditorAutosave();
}

export function caretOffsetWithin(block) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !block.contains(selection.focusNode)) return block.textContent.length;
  return textOffset(block, selection.focusNode, selection.focusOffset);
}

function placeCaretAtEnd(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  // A block that ends in a linked claim would otherwise keep growing it.
  const last = node.lastChild;
  if (last?.nodeType === Node.ELEMENT_NODE && last.classList?.contains('linked-claim')) {
    range.setStartAfter(last);
    range.collapse(true);
  }
  selection.addRange(range);
}

function editorDependencyRecords() {
  return [...(state.editor.document?.dependencies ?? []), ...state.editor.pendingLinks];
}

function reindexEditorBlocks() {
  document.querySelectorAll('.manuscript-block').forEach((block, index) => {
    block.dataset.blockIndex = String(index);
  });
}

function createEditorBlockElement(type = 'paragraph', text = '', options = {}) {
  const block = document.createElement('div');
  block.className = `manuscript-block ${type}`;
  block.dataset.blockType = type;
  if (type === 'heading') block.dataset.headingLevel = String(options.headingLevel ?? 2);
  if (type === 'list') block.dataset.listStyle = options.listStyle ?? 'unordered';
  if (type === 'code') block.dataset.codeFence = options.codeFence ?? '```';
  block.textContent = text;
  if (!text) block.innerHTML = '<br>';
  return block;
}

/**
 * Moves a caret that landed at the very end of a linked claim to just after
 * it. Left inside, the next character typed would be swallowed by the claim
 * and the highlight would creep across text that is not part of it.
 */
function caretOutsideLinkedClaim(range) {
  const node = range.startContainer;
  if (node?.nodeType !== Node.TEXT_NODE) return range;
  const claim = node.parentElement?.closest?.('.linked-claim');
  if (!claim) return range;
  if (range.startOffset !== node.textContent.length) return range;
  // Only the last text node in the claim sits on its trailing boundary.
  const walker = document.createTreeWalker(claim, NodeFilter.SHOW_TEXT);
  let last = null;
  let current;
  while ((current = walker.nextNode())) last = current;
  if (node !== last) return range;
  const outside = document.createRange();
  outside.setStartAfter(claim);
  outside.collapse(true);
  return outside;
}

function placeCaretAtOffset(node, offset) {
  const requestedOffset = Math.max(0, Math.min(Number(offset) || 0, node.textContent.length));
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let textNode;
  while ((textNode = walker.nextNode())) textNodes.push(textNode);
  const point = caretPointForTextLengths(textNodes.map((item) => item.textContent.length), requestedOffset);
  if (point.atEnd) return placeCaretAtEnd(node);
  const target = textNodes[point.nodeIndex];
  const range = document.createRange();
  range.setStart(target, point.offset);
  range.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(caretOutsideLinkedClaim(range));
}

function splitEditorBlock(block) {
  const index = Number(block.dataset.blockIndex);
  const offset = caretOffsetWithin(block);
  const text = block.textContent;
  const crossesDependency = editorDependencyRecords().some((dependency) => dependency.anchor.blockIndex === index
    && dependency.anchor.start < offset && dependency.anchor.end > offset);
  if (crossesDependency) {
    toast('Move the caret outside the linked phrase before splitting this paragraph', 'error');
    return;
  }
  recordEditorHistory('paragraph', true);
  for (const dependency of editorDependencyRecords()) {
    if (dependency.anchor.blockIndex > index) dependency.anchor.blockIndex += 1;
    else if (dependency.anchor.blockIndex === index && dependency.anchor.start >= offset) {
      dependency.anchor.blockIndex += 1;
      dependency.anchor.start -= offset;
      dependency.anchor.end -= offset;
    }
  }
  const before = text.slice(0, offset);
  const after = text.slice(offset);
  block.textContent = before;
  const nextType = block.dataset.blockType === 'list' ? 'list' : 'paragraph';
  const next = createEditorBlockElement(nextType, after, { listStyle: block.dataset.listStyle });
  block.after(next);
  reindexEditorBlocks();
  renderLocalDependencies(block);
  renderLocalDependencies(next);
  focusEditorBlock(next, 0);
  markEditorDirty();
}

function mergeEditorBlockWithPrevious(block) {
  const previous = block.previousElementSibling?.classList.contains('manuscript-block') ? block.previousElementSibling : null;
  if (!previous) return false;
  recordEditorHistory('paragraph', true);
  const index = Number(block.dataset.blockIndex);
  const previousLength = previous.textContent.length;
  for (const dependency of editorDependencyRecords()) {
    if (dependency.anchor.blockIndex === index) {
      dependency.anchor.blockIndex -= 1;
      dependency.anchor.start += previousLength;
      dependency.anchor.end += previousLength;
    } else if (dependency.anchor.blockIndex > index) dependency.anchor.blockIndex -= 1;
  }
  previous.textContent = `${previous.textContent}${block.textContent}`;
  block.remove();
  reindexEditorBlocks();
  renderLocalDependencies(previous);
  focusEditorBlock(previous, previousLength);
  markEditorDirty();
  return true;
}

export function focusDocumentEnd() {
  let last = document.querySelector('.manuscript-block:last-of-type');
  if (!last || last.textContent.trim()) {
    last = createEditorBlockElement();
    document.getElementById('document-body').append(last);
    reindexEditorBlocks();
  }
  focusEditorBlock(last);
}

export function handleEditorShortcuts(event) {
  if (projectIsOffline()) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) redoEditor(); else undoEditor();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'l') {
    event.preventDefault(); openManualPickerFromSelection(); return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key === '.') {
    event.preventDefault(); openManualPickerFromSelection(); return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault(); saveDocument(); return;
  }
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key === 'Enter') {
    event.preventDefault(); endSourceContext(); return;
  }
  if (state.editor.prediction && (event.key === 'Tab' || (event.altKey && event.key === 'Enter'))) {
    event.preventDefault(); acceptPrediction();
    return;
  }
  if (state.editor.prediction && event.key === 'ArrowDown') {
    event.preventDefault();
    state.editor.predictionIndex = (state.editor.predictionIndex + 1) % state.editor.prediction.claim.candidates.length;
    showPredictionCompletion();
    return;
  }
  if (state.editor.prediction && event.key === 'ArrowUp') {
    event.preventDefault();
    const completionCount = state.editor.prediction.claim.candidates.length;
    state.editor.predictionIndex = (state.editor.predictionIndex - 1 + completionCount) % completionCount;
    showPredictionCompletion();
    return;
  }
  if (state.editor.prediction && event.key === 'Escape') { event.preventDefault(); clearPrediction(); return; }
  const block = editorBlockFromSelection(event.target);
  if (!block || event.isComposing) return;
  if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    clearPrediction();
    if (block.dataset.blockType === 'code') {
      document.execCommand('insertText', false, '\n');
      markEditorDirty();
    } else splitEditorBlock(block);
    return;
  }
  if (event.key === 'Backspace' && window.getSelection()?.isCollapsed && caretOffsetWithin(block) === 0) {
    if (block.previousElementSibling?.classList.contains('manuscript-block')) {
      event.preventDefault();
      clearPrediction();
      mergeEditorBlockWithPrevious(block);
    }
  }
  if (event.key === 'Delete' && window.getSelection()?.isCollapsed
    && caretOffsetWithin(block) === block.textContent.length) {
    const next = block.nextElementSibling?.classList.contains('manuscript-block') ? block.nextElementSibling : null;
    if (next) {
      event.preventDefault();
      clearPrediction();
      mergeEditorBlockWithPrevious(next);
    }
  }
}

export function formatActiveBlock(format) {
  const block = editorBlockFromSelection() ?? state.editor.activeBlock;
  if (!block) return;
  recordEditorHistory('format', true);
  if (format === 'heading') {
    block.dataset.blockType = 'heading';
    block.dataset.headingLevel = block.dataset.headingLevel || '2';
  } else if (format === 'list' || format === 'numbered') {
    block.dataset.blockType = 'list';
    block.dataset.listStyle = format === 'numbered' ? 'ordered' : 'unordered';
  } else block.dataset.blockType = 'paragraph';
  block.className = `manuscript-block ${block.dataset.blockType}`;
  markEditorDirty(); focusEditorBlock(block);
}

export function runEditorCommand(command) {
  if (command === 'undo') undoEditor();
  else if (command === 'redo') redoEditor();
  else if (['bold', 'italic', 'underline'].includes(command)) {
    document.execCommand(command, false);
    markEditorDirty();
  }
}
