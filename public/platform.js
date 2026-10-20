// Runs before styles so Windows never flashes the Mac appearance.
// A visual preview (?platform=windows) does not grant desktop capabilities.
(() => {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('platform');
  const detected = /Windows|Win32|Win64/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? navigator.userAgent)
    ? 'windows' : 'macos';
  const platform = ['windows', 'macos'].includes(requested) ? requested : detected;
  const native = params.get('app') === '1';
  const windowsBridge = native && platform === 'windows' ? window.chrome?.webview : null;
  const macBridge = native ? window.webkit?.messageHandlers?.lasso : null;
  const bridge = windowsBridge ?? macBridge;
  document.documentElement.dataset.platform = platform;
  if (native) document.documentElement.classList.add('native-app');
  window.lassoPlatform = Object.freeze({
    name: platform,
    isWindows: platform === 'windows',
    isNative: Boolean(bridge),
    canChooseFolder: Boolean(windowsBridge),
    shortcut: (key, shift = false) => platform === 'windows'
      ? `Ctrl+${shift ? 'Shift+' : ''}${key}` : `${shift ? '⇧' : ''}⌘${key}`,
    postMessage(payload) {
      if (!bridge) return false;
      bridge.postMessage(payload);
      return true;
    },
  });
  windowsBridge?.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'assist-state' && typeof message.enabled === 'boolean') {
      window.dispatchEvent(new CustomEvent('lasso-assist-state', { detail: { enabled: message.enabled } }));
    } else if (message.type === 'folder-selected' && (message.path === null || typeof message.path === 'string')) {
      window.dispatchEvent(new CustomEvent('lasso-folder-selected', { detail: { path: message.path } }));
    } else if (message.type === 'open-source' && typeof message.sourceId === 'string') {
      window.dispatchEvent(new CustomEvent('lasso-open-source', { detail: message }));
    } else if (message.type === 'share-inserted' && typeof message.targetId === 'string') {
      window.dispatchEvent(new CustomEvent('lasso-share-inserted', { detail: message }));

    } else if (message.type === 'host-error' && typeof message.message === 'string') {
      window.dispatchEvent(new CustomEvent('lasso-host-error', { detail: { message: message.message } }));
    }
  });
})();
