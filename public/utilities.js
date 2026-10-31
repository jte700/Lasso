// Small helpers every part of the workbench uses: escaping, dates, toasts and dialogs.
import { state, elements } from './state.js?v=1';

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

/** For actions started from a click: show a failure instead of doing nothing. */
export function reportError(error) {
  toast(error?.message || 'Something went wrong. Try again.', 'error');
}

export function toast(message, type = '') {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  elements['toast-region'].append(node);
  setTimeout(() => node.remove(), 4200);
  if (elements['status-message']) {
    clearTimeout(state.statusTimer);
    elements['status-message'].textContent = message;
    state.statusTimer = setTimeout(() => { elements['status-message'].textContent = 'Ready'; }, 4200);
  }
}

export function formatDateTime(value) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export function textOffset(root, target, offset) {
  const range = document.createRange();
  range.setStart(root, 0);
  range.setEnd(target, offset);
  return range.toString().length;
}

export function openDialog(dialog) {
  dialog.querySelectorAll('[data-dialog-error]').forEach((node) => { node.textContent = ''; });
  dialog.showModal();
}
