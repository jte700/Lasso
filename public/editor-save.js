// Saving the document, and turning accepted suggestions into linked sources.
import { RECOMMENDATION_SESSION_ID, state } from './state.js?v=1';
import { toast } from './utilities.js?v=1';
import { api, recordRecommendationUsage } from './api.js?v=1';
import { projectIsOffline, hasUnsavedEditorChanges, syncOfflineEditor } from './workspace-projects.js?v=1';
import { scheduleEditorAutosave, markPendingDependency } from './editor-surface.js?v=1';
import { editorAssistStatus } from './editor-predictions.js?v=1';
import { resolveDependencyAnchor, renderLocalDependencies } from './linked-claims.js?v=1';
import { hideDependencyPicker } from './dependency-picker.js?v=1';

function storedTextForEditorBlock(block) {
  const text = block.textContent.replace(/\u00a0/g, ' ');
  if (block.dataset.blockType === 'heading') {
    const level = Math.min(6, Math.max(1, Number(block.dataset.headingLevel) || 2));
    return `${'#'.repeat(level)} ${text}`;
  }
  if (block.dataset.blockType === 'list') {
    const ordered = block.dataset.listStyle === 'ordered';
    return text.split('\n').map((line, index) => `${ordered ? `${index + 1}. ` : '- '}${line}`).join('\n');
  }
  if (block.dataset.blockType === 'code') {
    const fence = block.dataset.codeFence || '```';
    return `${fence}\n${text}\n${fence.startsWith('~~~') ? '~~~' : '```'}`;
  }
  return text;
}

function serializeManuscript() {
  const blocks = [...document.querySelectorAll('.manuscript-block')];
  let content = '';
  blocks.forEach((block, index) => {
    const code = block.dataset.blockType === 'code';
    // Blank lines inside a code block are its content and are kept. Between
    // other blocks, runs of blank lines collapse to one, and empty blocks
    // add nothing.
    const stored = storedTextForEditorBlock(block);
    const text = code ? stored : stored.replace(/^\n+|\n+$/g, '').replace(/\n{3,}/g, '\n\n');
    if (!text && !code) return;
    const previous = blocks[index - 1];
    const separator = !content ? ''
      : previous?.dataset.blockType === 'list' && block.dataset.blockType === 'list' ? '\n' : '\n\n';
    content += `${separator}${text}`;
  });
  return `${content}\n`;
}

function editorOffsetToStored(block, offset) {
  if (block.dataset.blockType === 'heading') {
    const level = Math.min(6, Math.max(1, Number(block.dataset.headingLevel) || 2));
    return offset + level + 1;
  }
  if (block.dataset.blockType === 'code') return offset + (block.dataset.codeFence || '```').length + 1;
  if (block.dataset.blockType !== 'list') return offset;
  const before = block.textContent.slice(0, offset);
  const lines = before.split('\n');
  const ordered = block.dataset.listStyle === 'ordered';
  return offset + lines.reduce((total, _line, index) => total + (ordered ? String(index + 1).length + 2 : 2), 0);
}

function pendingLinkPayload(dependency) {
  const block = document.querySelector(`.manuscript-block[data-block-index="${dependency.anchor.blockIndex}"]`);
  if (!block) return null;
  const anchor = resolveDependencyAnchor(dependency, block.textContent, dependency.anchor.blockIndex);
  if (!anchor) return null;
  dependency.anchor = anchor;
  const storedAnchor = {
    ...anchor,
    start: editorOffsetToStored(block, anchor.start),
    end: editorOffsetToStored(block, anchor.end),
  };
  return {
    localId: dependency.id,
    documentPath: state.editor.document.path,
    anchor: createClaimAnchor({ ...storedAnchor, blockType: block.dataset.blockType }, storedTextForEditorBlock(block)),
    spanText: dependency.spanText,
    sourceObjectId: dependency.source.id,
    sourceSnapshotId: dependency.source.snapshotId,
    selectionMethod: dependency.selectionMethod,
    confidence: dependency.confidence,
  };
}

export function updateEditorVersion(snapshot) {
  if (!snapshot) return;
  state.project = {
    ...state.project,
    currentSnapshotId: snapshot.id ?? state.project.currentSnapshotId,
    currentVersion: snapshot.version ?? state.project.currentVersion,
  };
  state.editor.document.snapshotId = snapshot.id ?? state.editor.document.snapshotId;
  state.editor.document.version = snapshot.version ?? state.editor.document.version;
  const version = document.querySelector('.editor-header .eyebrow');
  if (version) version.textContent = `Version ${state.editor.document.version}`;
}

export async function saveDocument(options = {}) {
  if (projectIsOffline()) {
    syncOfflineEditor();
    if (!options.automatic && hasUnsavedEditorChanges()) toast('Reconnect the drive to save. Your unsaved changes are still open.', 'error');
    return state.editor.document;
  }
  if (state.editor.savePromise) return state.editor.savePromise;
  if (!state.editor.document || (!state.editor.dirty && !state.editor.pendingLinks.length)) return state.editor.document;
  clearTimeout(state.editor.autosaveTimer);
  state.editor.autosaveTimer = null;
  const automatic = options.automatic === true;
  const button = document.getElementById('save-document');
  const saveState = document.getElementById('editor-save-state');
  const revisionAtStart = state.editor.editRevision;
  const contentAtStart = serializeManuscript();
  const contentWasDirty = state.editor.dirty;
  const pendingAtStart = state.editor.pendingLinks.map(pendingLinkPayload).filter(Boolean);
  const pendingIds = new Set(pendingAtStart.map((link) => link.localId));
  if (saveState) saveState.textContent = automatic ? 'Autosaving…' : 'Saving…';
  button?.classList.add('loading');

  state.editor.savePromise = (async () => {
    try {
      if (contentWasDirty) {
        const result = await api(`/api/projects/${state.project.id}/documents/save`, {
          method: 'POST', body: JSON.stringify({
            path: state.editor.document.path,
            content: contentAtStart,
            baseSnapshotId: state.editor.document.snapshotId,
            actor: state.identity,
          }),
        });
        state.project = result.project;
        state.editor.document.content = contentAtStart;
        state.editor.document.snapshotId = result.project.currentSnapshotId;
        state.editor.document.version = result.project.currentVersion;
      } else {
        const { project } = await api(`/api/projects/${state.project.id}`);
        state.project = project;
        state.editor.document.snapshotId = project.currentSnapshotId;
        state.editor.document.version = project.currentVersion;
      }

      if (pendingAtStart.length) {
        const linked = await api(`/api/projects/${state.project.id}/dependencies/batch`, {
          method: 'POST', body: JSON.stringify({
            links: pendingAtStart.map(({ localId, ...link }) => link),
            expectedSnapshotId: state.project.currentSnapshotId,
            actor: state.identity,
            sessionId: RECOMMENDATION_SESSION_ID,
          }),
        });
        updateEditorVersion(linked.snapshot);
        linked.dependencies.forEach((dependency, index) => {
          const pending = pendingAtStart[index];
          state.editor.document.dependencies.push(dependency);
          const node = document.querySelector(`[data-pending-link-id="${CSS.escape(pending.localId)}"]`);
          if (node) {
            node.classList.remove('pending');
            delete node.dataset.pendingLinkId;
            node.dataset.dependencyId = dependency.id;
            node.title = 'Linked source';
          }
        });
        state.editor.pendingLinks = state.editor.pendingLinks.filter((dependency) => !pendingIds.has(dependency.id));
      }

      const changedDuringSave = state.editor.editRevision !== revisionAtStart || serializeManuscript() !== contentAtStart;
      state.editor.dirty = changedDuringSave;
      const stillPending = state.editor.pendingLinks.length > 0;
      if (button) button.disabled = !changedDuringSave && !stillPending;
      if (saveState) {
        saveState.textContent = changedDuringSave || stillPending
          ? 'Autosave pending'
          : automatic ? `Autosaved ${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date())}` : 'Saved';
      }
      if (!automatic) toast(pendingAtStart.length ? 'Manuscript and sources saved' : 'Manuscript saved');
      return state.editor.document;
    } catch (error) {
      if (saveState) saveState.textContent = 'Autosave could not complete';
      toast(error.message, 'error');
      return state.editor.document;
    } finally {
      button?.classList.remove('loading');
      state.editor.savePromise = null;
      if (state.editor.dirty || state.editor.pendingLinks.length) scheduleEditorAutosave();
    }
  })();
  return state.editor.savePromise;
}

function createClaimAnchor(claim, textOverride = null) {
  const block = document.querySelector(`.manuscript-block[data-block-index="${claim.blockIndex}"]`);
  const text = textOverride ?? block?.textContent ?? '';
  return {
    kind: 'manuscript-span', blockIndex: claim.blockIndex, blockType: claim.blockType,
    start: claim.start, end: claim.end,
    prefix: text.slice(Math.max(0, claim.start - 32), claim.start),
    suffix: text.slice(claim.end, Math.min(text.length, claim.end + 32)),
  };
}

export async function linkCandidate(claim, candidate, selectionMethod, dependencyToChange = null, options = {}) {
  try {
    if (dependencyToChange) {
      const usageContext = { projectId: candidate.projectId ?? state.project?.id, documentPath: state.editor.document?.path };
      const project = (await api(`/api/projects/${state.project.id}`)).project;
      const result = await api(`/api/dependencies/${dependencyToChange.id}/revise`, {
        method: 'POST', body: JSON.stringify({
          sourceObjectId: candidate.id,
          sourceSnapshotId: candidate.snapshotId,
          confidence: candidate.score ?? null,
          expectedSnapshotId: project.currentSnapshotId,
          actor: state.identity,
        }),
      });
      updateEditorVersion(result.snapshot);
      state.editor.document.dependencies = state.editor.document.dependencies
        .map((dependency) => dependency.id === dependencyToChange.id ? result.dependency : dependency);
      recordRecommendationUsage({ objectId: candidate.id, projectId: candidate.projectId }, 'accept', usageContext);
      toast('Linked source changed');
      hideDependencyPicker();
      return;
    }

    const localId = `pending:${crypto.randomUUID()}`;
    const dependency = {
      id: localId,
      pending: true,
      anchor: createClaimAnchor(claim),
      spanText: claim.text,
      source: candidate,
      selectionMethod,
      confidence: candidate.score ?? null,
      status: 'PENDING',
    };
    state.editor.pendingLinks.push(dependency);
    const revealAcceptedText = options.revealAcceptedText !== false;
    state.editor.revealDependencyId = revealAcceptedText ? localId : null;
    const block = document.querySelector(`.manuscript-block[data-block-index="${claim.blockIndex}"]`);
    const focusPosition = Number.isInteger(options.caretOffset)
      ? options.caretOffset : revealAcceptedText;
    renderLocalDependencies(block, focusPosition);
    markPendingDependency();
    editorAssistStatus(`Source selected · autosaves within five minutes`);
    hideDependencyPicker();
  } catch (error) { toast(error.message, 'error'); }
}
