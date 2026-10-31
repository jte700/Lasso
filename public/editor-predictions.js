// Suggestions while typing: asking the server, drawing the box and accepting one.
import { contextualCompletionCase } from './editor-acceptance.js';
import { renderAssistBox } from './assist-box.js?v=2';
import { shortcut, AUTOMATIC_SUGGESTION_LIMIT, state } from './state.js?v=1';
import { toast } from './utilities.js?v=1';
import { api } from './api.js?v=1';
import { applyWorkspace, renderProjectContext } from './workspace-projects.js?v=1';
import { dependencyShell } from './terminal-panel.js?v=1';
import { focusEditorBlock, recordEditorHistory, markEditorDirty, caretOffsetWithin } from './editor-surface.js?v=1';
import { linkCandidate } from './editor-save.js?v=1';
import { pendingDependenciesForPrediction } from './linked-claims.js?v=1';
import { showDependencyPicker } from './dependency-picker.js?v=1';

export async function predictForBlock(block) {
  if (!block?.isConnected || !block.textContent.trim()) return;
  const requestedText = block.textContent;
  const requestedDocument = state.editor.document;
  const controller = new AbortController();
  state.editor.predictionController?.abort();
  state.editor.predictionController = controller;
  try {
    const cursor = caretOffsetWithin(block);
    const blocks = [...document.querySelectorAll('.manuscript-block')];
    const blockIndex = Number(block.dataset.blockIndex);
    const section = blocks.slice(0, blockIndex + 1).reverse()
      .find((item) => item.dataset.blockType === 'heading')?.textContent ?? '';
    const { prediction } = await api('/api/workspace/dependencies/predict', {
      method: 'POST', body: JSON.stringify({
        text: requestedText,
        context: blocks.slice(Math.max(0, blockIndex - 1), blockIndex + 2).map((item) => item.textContent).join(' '),
        cursor,
        blockIndex,
        section,
        documentPath: state.editor.document.path,
        documentProjectId: state.editor.document.projectId,
        sourceScopeBoundary: Number.isInteger(Number(block.dataset.sourceScopeBoundary))
          ? Number(block.dataset.sourceScopeBoundary) : undefined,
        pendingDependencies: pendingDependenciesForPrediction(),
      }), signal: controller.signal,
    });
    if (controller.signal.aborted || state.editor.predictionController !== controller
      || !block.isConnected || block.textContent !== requestedText) return;
    if (prediction.workspaceRevision != null && prediction.workspaceRevision !== state.workspace.revision) {
      clearPrediction();
      const refreshController = new AbortController();
      state.editor.predictionController = refreshController;
      try {
        const workspace = await api('/api/workspace', { signal: refreshController.signal });
        if (refreshController.signal.aborted || state.editor.predictionController !== refreshController) return;
        if (applyWorkspace(workspace)) {
          renderProjectContext();
          dependencyShell.reset();
        }
        if (block.isConnected && block.textContent === requestedText
          && state.editor.document === requestedDocument && state.editor.activeBlock === block) {
          state.editor.predictionTimer = setTimeout(() => predictForBlock(block), 45);
        }
      } finally {
        if (state.editor.predictionController === refreshController) state.editor.predictionController = null;
      }
      return;
    }
    if (prediction.sourceCompletions?.length && prediction.sourceContext?.source) {
      const findings = prediction.sourceCompletions.slice(0, AUTOMATIC_SUGGESTION_LIMIT)
        .map((finding) => ({ ...finding, block, requestedText }));
      const first = findings[0];
      state.editor.prediction = {
        mode: 'SOURCE_FINDINGS',
        completion: { kind: 'SOURCE_FINDING', block, requestedText },
        findings,
        sourceContext: prediction.sourceContext,
        blockIndex, blockType: block.dataset.blockType, block,
        claim: {
          start: first.claimStart, end: first.claimEnd, type: 'SOURCE_FINDING',
          text: requestedText.slice(first.claimStart, first.claimEnd),
          candidates: findings.map((finding) => finding.dependencyCandidate),
        },
      };
      state.editor.predictionIndex = 0;
      showPredictionCompletion();
      return;
    }
    if (prediction.workspaceCompletions?.length) {
      const workspaceSuggestions = prediction.workspaceCompletions
        .slice(0, AUTOMATIC_SUGGESTION_LIMIT)
        .map((suggestion) => ({ ...suggestion, block, requestedText }));
      const first = workspaceSuggestions[0];
      state.editor.prediction = {
        mode: 'WORKSPACE_SUGGESTIONS',
        completion: { kind: 'WORKSPACE', block, requestedText },
        workspaceSuggestions,
        workspaceHeading: prediction.workspaceHeading,
        sourceContext: prediction.sourceContext,
        blockIndex, blockType: block.dataset.blockType, block,
        claim: {
          start: first.claimStart, end: first.claimEnd, type: 'WORKSPACE',
          text: requestedText.slice(first.claimStart, first.claimEnd),
          candidates: workspaceSuggestions.map((suggestion) => suggestion.dependencyCandidate),
        },
      };
      state.editor.predictionIndex = 0;
      showPredictionCompletion();
      return;
    }
    if (prediction.completion?.insertText && prediction.completion.dependencyCandidate) {
      const completion = { ...prediction.completion, kind: 'SENTENCE', block, requestedText };
      const start = completion.claimStart;
      state.editor.prediction = {
        mode: 'COMPLETE_AND_LINK', completion, blockIndex, blockType: block.dataset.blockType, block,
        claim: {
          start, end: requestedText.length, type: 'PROJECT_SENTENCE',
          text: `${requestedText.slice(start)}${completion.insertText}`,
          candidates: [completion.dependencyCandidate],
        },
      };
      state.editor.predictionIndex = 0;
      showPredictionCompletion();
      return;
    }
    const claim = prediction.claims.find((candidate) => candidate.candidates.length);
    if (claim) {
      claim.candidates = claim.candidates.slice(0, AUTOMATIC_SUGGESTION_LIMIT);
      const completesCitation = claim.type === 'LITERATURE' && claim.partial
        && claim.candidates.some((candidate) => candidate.citationText);
      const completesStudyVariable = claim.type === 'STUDY_VARIABLE' && claim.partial
        && claim.candidates.some((candidate) => candidate.completionText);
      const completesReferenceComponent = ['TABLE_REFERENCE', 'FIGURE'].includes(claim.type) && claim.partial
        && claim.candidates.some((candidate) => candidate.componentText);
      // Any whole file named while typing: drawings, datasets, documents and PDFs.
      const completesDrawingReference = claim.type === 'ENTITY' && claim.partial
        && claim.candidates.some((candidate) => namesWholeFile(candidate) && candidate.label);
      state.editor.prediction = {
        mode: completesCitation || completesStudyVariable || completesReferenceComponent || completesDrawingReference
          ? 'COMPLETE_AND_LINK' : 'LINK',
        completion: completesCitation
          ? { kind: 'CITATION', block, requestedText }
          : completesStudyVariable ? { kind: 'STUDY_VARIABLE', block, requestedText }
            : completesReferenceComponent ? { kind: 'REFERENCE_COMPONENT', block, requestedText }
              : completesDrawingReference ? { kind: 'DRAWING_REFERENCE', block, requestedText } : null,
        claim, sourceContext: prediction.sourceContext,
        blockIndex, blockType: block.dataset.blockType, block,
      };
      state.editor.predictionIndex = 0;
      showPredictionCompletion();
      return;
    }
    if (prediction.notice) editorAssistStatus(prediction.notice);
  } catch (error) {
    if (error.name !== 'AbortError') toast(error.message, 'error');
  } finally {
    if (state.editor.predictionController === controller) state.editor.predictionController = null;
  }
}

export function editorAssistStatus(message = 'Predictive dependencies on') {
  const status = document.getElementById('editor-assist-status');
  if (status) status.textContent = message;
}

// A whole file named while typing; the server's label is the text to insert.
function namesWholeFile(candidate) {
  return Boolean(candidate?.fileReference || candidate?.objectType === 'DRAWING');
}

function predictionEdit(prediction, candidate, selectedIndex = 0) {
  const completion = prediction?.completion;
  if (!completion) return null;
  if (completion.kind === 'SOURCE_FINDING' || completion.kind === 'WORKSPACE') {
    const suggestion = completion.kind === 'SOURCE_FINDING'
      ? prediction.findings?.[selectedIndex] : prediction.workspaceSuggestions?.[selectedIndex];
    if (!suggestion?.replacementText) return null;
    const start = suggestion.claimStart;
    const end = suggestion.claimEnd;
    const typed = completion.requestedText.slice(start, end);
    const before = completion.requestedText.slice(0, start);
    const joiner = start === end && before && !/\s$/.test(before)
      && !/^\s/.test(suggestion.replacementText) && !/[([{“"]$/.test(before)
      && !/^[,.;:!?)}\]]/.test(suggestion.replacementText) ? ' ' : '';
    const labelCompletion = ['Column', 'Row', 'Variable'].includes(suggestion.category);
    const replacement = contextualCompletionCase(
      suggestion.replacementText,
      typed,
      before,
      labelCompletion ? 'label' : 'phrase',
    );
    const sharesPrefix = replacement.toLocaleLowerCase().startsWith(typed.toLocaleLowerCase());
    const blockText = `${before}${joiner}${replacement}${completion.requestedText.slice(end)}`;
    const claimStart = start + joiner.length;
    return {
      blockText,
      claimStart,
      claimEnd: claimStart + replacement.length,
      claimText: replacement,
      ghostText: end === completion.requestedText.length && sharesPrefix
        ? `${joiner}${replacement.slice(typed.length)}` : '',
    };
  }
  if (['CITATION', 'STUDY_VARIABLE', 'REFERENCE_COMPONENT', 'DRAWING_REFERENCE'].includes(completion.kind)) {
    const typed = completion.requestedText.slice(prediction.claim.start, prediction.claim.end);
    const before = completion.requestedText.slice(0, prediction.claim.start);
    const rawReplacement = completion.kind === 'CITATION' ? candidate?.citationText
      : completion.kind === 'REFERENCE_COMPONENT' ? candidate?.componentText
        : completion.kind === 'DRAWING_REFERENCE' ? namesWholeFile(candidate) ? candidate.label : null
          : candidate?.completionText;
    const replacement = contextualCompletionCase(
      rawReplacement,
      typed,
      before,
      ['CITATION', 'REFERENCE_COMPONENT', 'DRAWING_REFERENCE'].includes(completion.kind) ? 'proper-name' : 'label',
    );
    if (!replacement) return null;
    const sharesPrefix = replacement.toLocaleLowerCase().startsWith(typed.toLocaleLowerCase());
    const blockText = `${completion.requestedText.slice(0, prediction.claim.start)}${replacement}${completion.requestedText.slice(prediction.claim.end)}`;
    return {
      blockText,
      claimStart: prediction.claim.start,
      claimEnd: prediction.claim.start + replacement.length,
      claimText: replacement,
      ghostText: prediction.claim.end === completion.requestedText.length && sharesPrefix
        ? replacement.slice(typed.length) : '',
    };
  }
  const insertText = contextualCompletionCase(
    completion.insertText,
    '',
    completion.requestedText,
    'phrase',
  );
  const blockText = `${completion.requestedText}${insertText}`;
  return {
    blockText,
    claimStart: prediction.claim.start,
    claimEnd: blockText.length,
    claimText: blockText.slice(prediction.claim.start),
    ghostText: insertText,
  };
}

export function showPredictionCompletion() {
  const prediction = state.editor.prediction;
  const overlay = document.getElementById('dependency-completion');
  if (!prediction || !overlay) return;
  const candidates = prediction.claim.candidates;
  const selectedIndex = Math.min(state.editor.predictionIndex, candidates.length - 1);
  const selectedCandidate = candidates[selectedIndex];
  const edit = predictionEdit(prediction, selectedCandidate, selectedIndex);
  const block = prediction.block;
  block.classList.add('has-prediction');
  if (edit?.ghostText) {
    block.dataset.completion = edit.ghostText;
    block.classList.add('has-text-completion');
  } else {
    block.classList.remove('has-text-completion');
    delete block.dataset.completion;
  }
  highlightPredictedSpan(block, prediction.claim.start, prediction.claim.end);
  overlay.hidden = false;
  overlay.className = 'dependency-completion';
  positionCompletion(overlay, block, prediction.claim.start, prediction.claim.end);
  const findingMode = prediction.mode === 'SOURCE_FINDINGS';
  const workspaceMode = prediction.mode === 'WORKSPACE_SUGGESTIONS';
  const linkedSourceMode = prediction.sourceContext?.kind === 'LINKED_SOURCE';
  const scopedWorkspace = workspaceMode && prediction.sourceContext?.kind === 'PROJECT_OBJECT';
  const rowWorkspace = scopedWorkspace && prediction.workspaceSuggestions?.some((suggestion) => suggestion.category === 'Row');
  const columnWorkspace = scopedWorkspace && prediction.workspaceSuggestions?.some((suggestion) => suggestion.category === 'Column');
  const completing = (prediction.mode === 'COMPLETE_AND_LINK' || findingMode || workspaceMode) && Boolean(edit);
  const heading = findingMode
    ? `findings · ${prediction.sourceContext.source.label}`
    : linkedSourceMode ? `components · ${prediction.sourceContext.source.label}`
    : workspaceMode ? 'project' : 'dependency';

  // The three prediction modes carry different objects; the box shows one
  // shape, so each is reduced to the same three columns the native overlay
  // draws: what would be inserted, its value, and the file it came from.
  const rows = findingMode
    ? prediction.findings.map((finding) => ({
      label: finding.replacementText,
      detail: 'finding',
      path: prediction.sourceContext.source.path,
      reason: finding.dependencyCandidate?.ranking?.reason,
    }))
    : workspaceMode
      ? prediction.workspaceSuggestions.map((suggestion) => ({
        label: suggestion.replacementText,
        detail: suggestion.dependencyCandidate?.valueText ?? suggestion.category ?? '',
        path: suggestion.dependencyCandidate?.path ?? '',
        reason: suggestion.dependencyCandidate?.ranking?.reason,
      }))
      : candidates.map((candidate) => ({
        label: candidate.label,
        detail: candidate.displayValue ?? candidate.valueText ?? candidate.objectType ?? '',
        path: candidate.path,
        reason: candidate.ranking?.reason,
      }));

  const canPick = !(completing || prediction.sourceContext?.exclusive);
  if (canPick) {
    rows.push({
      label: 'More sources',
      detail: `${candidates.length}`,
      path: '',
      attributes: 'id="choose-dependency"',
    });
  }

  const scoped = findingMode || linkedSourceMode || scopedWorkspace;
  const hints = [
    'Tab accept',
    scoped ? `${shortcut('Enter')} end source` : null,
    rows.length > 1 ? '↑↓ select' : null,
    'Esc close',
  ].filter(Boolean).join('   ');

  overlay.innerHTML = renderAssistBox({ title: heading, rows, selected: selectedIndex, hints });
  overlay.querySelectorAll('[data-completion-index]').forEach((button) => button.addEventListener('mousedown', (event) => {
    event.preventDefault();
    state.editor.predictionIndex = Number(button.dataset.completionIndex);
    acceptPrediction();
  }));
  document.getElementById('choose-dependency')?.addEventListener('mousedown', (event) => {
    event.preventDefault(); openPredictionPicker();
  });
  document.getElementById('end-source-scope')?.addEventListener('mousedown', (event) => {
    event.preventDefault(); endSourceContext();
  });
  overlay.querySelector('.ab-row.selected')?.scrollIntoView({ block: 'nearest' });
  const sourceName = (prediction.completion?.source?.path ?? selectedCandidate.path)?.split('/').pop();
  editorAssistStatus(findingMode
    ? `Suggestions locked to ${prediction.sourceContext.source.label}`
    : linkedSourceMode
    ? `Components locked to ${prediction.sourceContext.source.label}`
    : rowWorkspace
    ? `Rows matching ${prediction.sourceContext.variable}`
    : columnWorkspace
    ? `Columns from ${prediction.sourceContext.source.path}`
    : scopedWorkspace
    ? `Values locked to ${prediction.sourceContext.variable}`
    : workspaceMode
    ? 'Suggestions from project data and files'
    : completing
    ? `Tab completes and links${sourceName ? ` · ${sourceName}` : ''}`
    : 'Tab links the suggested source');
}

function rangeForTextSpan(block, start, end) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let node; let offset = 0; let startNode; let endNode; let startOffset = 0; let endOffset = 0;
  while ((node = walker.nextNode())) {
    const next = offset + node.textContent.length;
    if (!startNode && start >= offset && start <= next) { startNode = node; startOffset = start - offset; }
    if (end >= offset && end <= next) { endNode = node; endOffset = end - offset; break; }
    offset = next;
  }
  if (!startNode || !endNode) return null;
  const range = new Range(); range.setStart(startNode, startOffset); range.setEnd(endNode, endOffset);
  return range;
}

function positionCompletion(overlay, block, start, end) {
  const page = document.getElementById('manuscript-page');
  const range = rangeForTextSpan(block, start, end);
  const pageRect = page?.getBoundingClientRect();
  const textRect = range?.getBoundingClientRect();
  if (!pageRect || !textRect) {
    overlay.style.top = `${block.offsetTop + block.offsetHeight + 5}px`;
    overlay.style.left = '72px';
    return;
  }
  overlay.style.top = `${Math.max(8, textRect.bottom - pageRect.top + 7)}px`;
  overlay.style.left = `${Math.max(12, Math.min(textRect.left - pageRect.left, page.clientWidth - 440))}px`;
}

export function clearPrediction() {
  clearTimeout(state.editor.predictionTimer);
  state.editor.predictionController?.abort();
  state.editor.predictionController = null;
  const block = state.editor.prediction?.block;
  block?.classList.remove('has-prediction', 'has-text-completion');
  if (block) delete block.dataset.completion;
  globalThis.CSS?.highlights?.delete('predicted-dependency');
  state.editor.prediction = null;
  editorAssistStatus();
  const overlay = document.getElementById('dependency-completion');
  if (overlay) { overlay.hidden = true; overlay.replaceChildren(); }
}

export function endSourceContext() {
  const selection = window.getSelection();
  const selectedBlock = selection?.focusNode?.parentElement?.closest?.('.manuscript-block')
    ?? selection?.focusNode?.closest?.('.manuscript-block');
  const block = selectedBlock ?? state.editor.activeBlock ?? state.editor.prediction?.block;
  if (!block?.isConnected) {
    editorAssistStatus('Place the caret in the document to end a source');
    return;
  }
  const boundary = caretOffsetWithin(block);
  block.dataset.sourceScopeBoundary = String(boundary);
  clearPrediction();
  editorAssistStatus('Source context ended · new suggestions use the project workspace');
}

function highlightPredictedSpan(block, start, end) {
  if (!globalThis.CSS?.highlights || !globalThis.Highlight) return;
  const range = rangeForTextSpan(block, start, end);
  if (!range) return;
  CSS.highlights.set('predicted-dependency', new Highlight(range));
}

function openPredictionPicker() {
  const prediction = state.editor.prediction;
  if (!prediction || prediction.mode === 'COMPLETE_AND_LINK') return;
  showDependencyPicker({
    ...prediction.claim,
    blockIndex: prediction.blockIndex,
    blockType: prediction.blockType,
    searchText: prediction.block.textContent,
  }, 'link');
}

export async function acceptPrediction() {
  const prediction = state.editor.prediction;
  if (!prediction) return;
  const candidate = prediction.claim.candidates[state.editor.predictionIndex];
  let claim = { ...prediction.claim, blockIndex: prediction.blockIndex, blockType: prediction.blockType };
  const edit = predictionEdit(prediction, candidate, state.editor.predictionIndex);
  const editsAcceptedText = ['COMPLETE_AND_LINK', 'SOURCE_FINDINGS', 'WORKSPACE_SUGGESTIONS'].includes(prediction.mode) && Boolean(edit);
  if (editsAcceptedText) {
    const { block, completion } = prediction;
    if (!block?.isConnected || block.textContent !== completion.requestedText) {
      clearPrediction();
      return;
    }
    recordEditorHistory('prediction', true);
    claim = { ...claim, start: edit.claimStart, end: edit.claimEnd, text: edit.claimText };
    clearPrediction();
    block.textContent = edit.blockText;
    focusEditorBlock(block, edit.claimEnd);
    markEditorDirty();
  } else {
    clearPrediction();
  }
  await linkCandidate(claim, candidate, 'AUTOCOMPLETE', null, {
    revealAcceptedText: true,
    caretOffset: editsAcceptedText ? edit.claimEnd : null,
  });
}
