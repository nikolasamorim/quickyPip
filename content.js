/**
 * QuickyPip — content.js
 * Thin message receiver for direct video control from popup.
 */

(function () {
  if (window.__quickyPipContentActive) return;
  window.__quickyPipContentActive = true;

  function findBestVideo() {
    const all = Array.from(document.querySelectorAll('video'));
    if (!all.length) return null;
    const visible = all.filter(v => {
      const s = window.getComputedStyle(v);
      if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
      const r = v.getBoundingClientRect();
      return r.width > 100 && r.height > 100;
    });
    const pool = visible.length ? visible : all;
    const scored = pool.map(v => {
      const r = v.getBoundingClientRect();
      let score = r.width * r.height;
      if (v.duration > 30 && v.duration !== Infinity) score += 1e7;
      if (!v.defaultMuted) score += 1e6;
      if (!v.paused) score += 1e5;
      return { v, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0].v;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const v = findBestVideo() || document.pictureInPictureElement;

    if (msg.type === 'GET_VIDEO_STATE') {
      if (!v) { sendResponse(null); return true; }
      const skipSelectors = [
        '[data-uia="player-skip-intro"]', '[data-uia="skip-outro"]',
        'button[class*="skip"]', 'button[class*="Skip"]',
        '[class*="skip-intro"]', '[class*="skipIntro"]',
        '[aria-label*="skip" i]', '[aria-label*="pular" i]',
      ];
      const hasSkipBtn = skipSelectors.some(s => !!document.querySelector(s));
      sendResponse({
        currentTime: v.currentTime,
        duration: v.duration,
        paused: v.paused,
        volume: v.volume,
        muted: v.muted,
        playbackRate: v.playbackRate,
        hasPip: !!document.pictureInPictureElement,
        tabOrigin: location.hostname,
        tabTitle: document.title,
        hasSkipBtn,
        pipElementActive: !!document.pictureInPictureElement,
      });
      return true;
    }

    if (msg.type === 'SKIP_INTRO') {
      // Try common skip button selectors (Netflix, Disney+, Prime Video, etc.)
      const selectors = [
        '[data-uia="player-skip-intro"]',           // Netflix "Pular abertura"
        '[data-uia="skip-outro"]',                  // Netflix "Próximo episódio"
        'button[class*="skip"]',
        'button[class*="Skip"]',
        '[class*="skip-intro"]',
        '[class*="skipIntro"]',
        '[aria-label*="skip" i]',
        '[aria-label*="pular" i]',
      ];
      for (const sel of selectors) {
        const btn = document.querySelector(sel);
        if (btn) { btn.click(); sendResponse({ ok: true, selector: sel }); return true; }
      }
      sendResponse({ ok: false });
      return true;
    }

    if (!v) { sendResponse({ ok: false }); return true; }

    if (msg.type === 'SEEK') { v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + msg.delta)); }
    else if (msg.type === 'SET_TIME') { v.currentTime = msg.value; }
    else if (msg.type === 'TOGGLE_PLAY') { v.paused ? v.play() : v.pause(); }
    else if (msg.type === 'SET_VOLUME') { v.volume = msg.value; }
    else if (msg.type === 'SET_MUTED') { v.muted = msg.value; }
    else if (msg.type === 'SET_RATE') { v.playbackRate = msg.value; }

    sendResponse({ ok: true });
    return true;
  });
})();
