// Dismiss transient UI without invoking accept, copy, unlink or revoke actions.
export function dismissLassoOverlays({ document, palette, closeProjectPicker, cancelPending }) {
  const nodes = ['dependency-completion', 'dependency-picker', 'source-peek', 'dependency-inspector'];
  const open = nodes.some(id => { const node = document.getElementById(id); return node && !node.hidden; })
    || palette?.isOpen || Boolean(document.getElementById('project-popover') && !document.getElementById('project-popover').hidden)
    || document.querySelectorAll('dialog[open]').length > 0
    || Boolean(document.getElementById('dependency-sharing')?.childElementCount);
  cancelPending();
  palette?.close();
  closeProjectPicker?.();
  for (const id of nodes) {
    const node = document.getElementById(id);
    if (node) node.hidden = true;
  }
  document.getElementById('dependency-sharing')?.replaceChildren();
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  return Boolean(open);
}
