/**
 * QuickyPip — content.js
 * Persistent content script. Declares a long-lived port connection to background.
 * Handles video commands via port and reports video state as push updates.
 */

(function () {
  // Guard: already running in this document
  if (window.__quickyPipContent) return;
  window.__quickyPipContent = true;

  // ── Video utilities ──────────────────────────────────────────────────────────

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

  const SKIP_SELECTORS = [
    '[data-uia="player-skip-intro"]', '[data-uia="skip-outro"]',
    'button[class*="skip"]', 'button[class*="Skip"]',
    '[class*="skip-intro"]', '[class*="skipIntro"]',
    '[aria-label*="skip" i]', '[aria-label*="pular" i]',
  ];

  function getVideoState() {
    const v = findBestVideo() || document.pictureInPictureElement;
    if (!v || !(v instanceof HTMLVideoElement)) return null;
    return {
      currentTime: v.currentTime,
      duration: v.duration,
      paused: v.paused,
      volume: v.volume,
      muted: v.muted,
      playbackRate: v.playbackRate,
      hasPip: !!document.pictureInPictureElement,
      pipElementActive: !!document.pictureInPictureElement,
      tabOrigin: location.hostname,
      tabTitle: document.title,
      hasSkipBtn: SKIP_SELECTORS.some(s => !!document.querySelector(s)),
    };
  }

  // ── Port connection ──────────────────────────────────────────────────────────

  let port = null;
  let pushTimer = null;

  function connect() {
    try {
      port = chrome.runtime.connect({ name: 'quickpip-tab' });
    } catch (_) {
      return; // extension context invalidated (page reload)
    }

    port.onDisconnect.addListener(() => {
      port = null;
      clearInterval(pushTimer);
      pushTimer = null;
      // Service worker restarted — reconnect after a short delay
      setTimeout(connect, 1000);
    });

    port.onMessage.addListener(handlePortMessage);

    // Start periodic state push (100ms when PiP active, 500ms otherwise)
    startPush();
  }

  function startPush() {
    clearInterval(pushTimer);
    pushTimer = setInterval(() => {
      if (!port) return;
      const state = getVideoState();
      if (state) {
        try { port.postMessage({ type: 'VIDEO_STATE_UPDATE', state }); } catch (_) {}
      }
    }, 300);
  }

  // ── Port message handler ─────────────────────────────────────────────────────

  function handlePortMessage(msg) {
    const v = findBestVideo() || document.pictureInPictureElement;

    if (msg.type === 'GET_VIDEO_STATE') {
      const state = getVideoState();
      try { port.postMessage({ type: 'VIDEO_STATE_REPLY', id: msg.id, state }); } catch (_) {}
      return;
    }

    if (msg.type === 'SKIP_INTRO') {
      for (const sel of SKIP_SELECTORS) {
        const btn = document.querySelector(sel);
        if (btn) {
          btn.click();
          try { port.postMessage({ type: 'SKIP_INTRO_REPLY', id: msg.id, ok: true, selector: sel }); } catch (_) {}
          return;
        }
      }
      try { port.postMessage({ type: 'SKIP_INTRO_REPLY', id: msg.id, ok: false }); } catch (_) {}
      return;
    }

    if (msg.type === 'REMOVE_DISABLE_PIP_ATTR') {
      const videos = Array.from(document.querySelectorAll('video'));
      let count = 0;
      videos.forEach(vid => {
        if (vid.hasAttribute('disablepictureinpicture')) { vid.removeAttribute('disablepictureinpicture'); count++; }
        try { vid.disablePictureInPicture = false; } catch (_) {}
      });
      try { port.postMessage({ type: 'REMOVE_DISABLE_PIP_ATTR_REPLY', id: msg.id, ok: true, count }); } catch (_) {}
      return;
    }

    // Video commands — no user gesture required
    if (!v || !(v instanceof HTMLVideoElement)) return;

    if (msg.type === 'SEEK')        { v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + msg.delta)); }
    else if (msg.type === 'SET_TIME')   { v.currentTime = msg.value; }
    else if (msg.type === 'TOGGLE_PLAY') { v.paused ? v.play() : v.pause(); }
    else if (msg.type === 'SET_VOLUME') { v.volume = msg.value; }
    else if (msg.type === 'SET_MUTED')  { v.muted = msg.value; }
    else if (msg.type === 'SET_RATE')   { v.playbackRate = msg.value; }
  }

  // ── Legacy chrome.runtime.onMessage (for Auto PiP watcher backward compat) ──

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const v = findBestVideo() || document.pictureInPictureElement;

    if (msg.type === 'GET_VIDEO_STATE') {
      sendResponse(getVideoState());
      return true;
    }

    if (msg.type === 'SKIP_INTRO') {
      for (const sel of SKIP_SELECTORS) {
        const btn = document.querySelector(sel);
        if (btn) { btn.click(); sendResponse({ ok: true, selector: sel }); return true; }
      }
      sendResponse({ ok: false });
      return true;
    }

    if (msg.type === 'STOP_AUTO_PIP_WATCHER') {
      // handled by the watcher script itself; nothing to do here
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'REARM_AUTO_PIP') {
      sendResponse({ ok: true });
      return true;
    }

    if (!v || !(v instanceof HTMLVideoElement)) { sendResponse({ ok: false }); return true; }

    if (msg.type === 'SEEK')         { v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + msg.delta)); }
    else if (msg.type === 'SET_TIME')    { v.currentTime = msg.value; }
    else if (msg.type === 'TOGGLE_PLAY') { v.paused ? v.play() : v.pause(); }
    else if (msg.type === 'SET_VOLUME')  { v.volume = msg.value; }
    else if (msg.type === 'SET_MUTED')   { v.muted = msg.value; }
    else if (msg.type === 'SET_RATE')    { v.playbackRate = msg.value; }

    sendResponse({ ok: true });
    return true;
  });

  // ── Init ─────────────────────────────────────────────────────────────────────

  connect();
})();
