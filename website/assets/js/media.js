/* The clips in the feature cards: each has a light and a dark version, chosen to match the page,
   and plays only while it is on screen. With reduced motion a clip stays on its poster. A small
   button over the card pauses it; phones have none. A clip is only a picture that moves: it never
   takes a tap, shows the system's player controls, goes full screen or leaves the page. */
(() => {
  'use strict';
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const theme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

  function mount(video) {
    const box = video.closest('.ag-media');
    let visible = false, userPaused = reducedMotion;
    const choose = () => {
      const t = theme();
      const src = video.dataset[t];
      video.poster = video.dataset[`${t}Poster`] || '';
      if (video.dataset.current === src) return;
      const wasPlaying = !video.paused;
      video.dataset.current = src;
      video.src = src;
      if (wasPlaying || (visible && !userPaused)) video.play().catch(() => {});
    };
    const sync = () => {
      const run = visible && !userPaused && !document.hidden;
      if (run) { if (!video.dataset.current) choose(); video.play().catch(() => {}); } else video.pause();
      box?.toggleAttribute('data-paused', userPaused);
      const button = box?.querySelector('.ag-pause');
      if (button) { button.setAttribute('aria-pressed', String(userPaused)); button.setAttribute('aria-label', userPaused ? 'Play the clip' : 'Pause the clip'); }
    };
    keepInline(video);
    video.poster = video.dataset[`${theme()}Poster`] || '';
    new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); }, { rootMargin: '120px 0px' }).observe(video);
    document.addEventListener('visibilitychange', sync);
    document.addEventListener('lasso:theme', () => { if (video.dataset.current) choose(); else video.poster = video.dataset[`${theme()}Poster`] || ''; });
    box?.querySelector('.ag-pause')?.addEventListener('click', () => { userPaused = !userPaused; sync(); });
    sync();
  }

  function keepInline(video) {
    video.muted = true;
    video.playsInline = true;
    video.controls = false;
    video.disablePictureInPicture = true;
    video.disableRemotePlayback = true;
    ['playsinline', 'webkit-playsinline', 'disablepictureinpicture', 'disableremoteplayback'].forEach((name) => video.setAttribute(name, ''));
    video.setAttribute('x-webkit-airplay', 'deny');
    video.setAttribute('controlslist', 'nofullscreen nodownload noremoteplayback noplaybackrate');
    video.setAttribute('tabindex', '-1');
    // iOS can still take a clip full screen (Low Power Mode, older Safari): hand it straight back.
    const leave = () => {
      if (video.webkitDisplayingFullscreen) video.webkitExitFullscreen?.();
      if (document.fullscreenElement === video) document.exitFullscreen?.().catch(() => {});
    };
    video.addEventListener('webkitbeginfullscreen', leave);
    video.addEventListener('fullscreenchange', leave);
    video.addEventListener('webkitendfullscreen', () => video.play().catch(() => {}));
  }

  const init = () => document.querySelectorAll('video[data-light][data-dark]').forEach(mount);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
