/**
 * QuickyPip — background.js (Service Worker, Manifest V3)
 */

// ─── findBestVideo inline (used in injected funcs) ────────────────────────────
// NOTE: This function is duplicated into every injected script since MV3 service
// workers cannot share modules with content scripts at runtime.

function _findBestVideoSrc() {
  // Returned as string to be eval'd — not used directly.
}

// ─── executePipToggle ─────────────────────────────────────────────────────────

async function executePipToggle(tab) {
  if (!tab?.id) return;
  const tabId = tab.id;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: function () {
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
        if (document.pictureInPictureElement) {
          return document.exitPictureInPicture()
            .then(() => ({ ok: true, action: 'deactivated' }))
            .catch(e => ({ ok: false, action: 'deactivated', error: e.message }));
        }
        const video = findBestVideo();
        if (!video) return Promise.resolve({ ok: false, action: 'none', error: 'Nenhum vídeo encontrado.' });
        video.removeAttribute('disablepictureinpicture');
        try { video.disablePictureInPicture = false; } catch (_) {}
        return video.requestPictureInPicture()
          .then(() => ({ ok: true, action: 'activated' }))
          .catch(e => ({ ok: false, action: 'activated', error: e.message }));
      },
    });

    const res = results?.[0]?.result;
    if (!res) { await chrome.storage.local.set({ lastError: 'Sem resposta do script.' }); return; }

    if (res.action === 'activated' && res.ok) {
      await chrome.storage.local.set({ pipActive: true, pipTabId: tabId, lastError: null });
    } else if (res.action === 'deactivated' && res.ok) {
      await chrome.storage.local.set({ pipActive: false, pipTabId: null, lastError: null });
    } else if (!res.ok) {
      await chrome.storage.local.set({ lastError: res.error || 'Erro desconhecido.' });
    }
  } catch (e) {
    await chrome.storage.local.set({ lastError: e.message });
  }
}

// ─── Auto PiP watcher injection ──────────────────────────────────────────────

async function injectAutoPipWatcher(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: autoPipWatcherScript });
  } catch (e) {
    await chrome.storage.local.set({ lastError: 'AutoPip inject: ' + e.message });
  }
}

function autoPipWatcherScript() {
  if (window.__quickyPipWatcher) return;
  window.__quickyPipWatcher = true;

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

  let attemptCount = 0;
  let lastSrcChangeTime = 0;
  let lastUrlChangeTime = 0;
  let lastEpisodeChangeTime = 0;
  let retryTimer = null;
  let cleanupFns = [];
  const BACKOFF = [1000, 2000, 4000, 8000];

  async function isArmed() {
    const { autoPipArmed } = await chrome.storage.local.get('autoPipArmed');
    return !!autoPipArmed;
  }

  async function tryActivate(video, force = false) {
    if (!(await isArmed())) return;
    if (document.pictureInPictureElement) { attemptCount = 0; return; }
    if (!video || video.duration <= 30 || video.duration === Infinity) return;
    // Allow activation if page is hidden OR if forced (episode change re-arm)
    if (!force && document.visibilityState !== 'hidden') return;

    video.removeAttribute('disablepictureinpicture');
    try { video.disablePictureInPicture = false; } catch (_) {}

    try {
      await video.requestPictureInPicture();
      attemptCount = 0;
      await chrome.storage.local.set({ pipActive: true, autoPipState: 'monitoring', lastError: null });
    } catch (e) {
      if (attemptCount >= BACKOFF.length) {
        await chrome.storage.local.set({ lastError: 'AutoPip falhou: ' + e.message });
        return;
      }
      const delay = BACKOFF[attemptCount++];
      retryTimer = setTimeout(() => armVideo(video), delay);
    }
  }

  function armVideo(video, force = false) {
    if (!video) return;
    const onMeta = () => tryActivate(video, force);
    const onPlay = () => { if (!document.pictureInPictureElement) tryActivate(video, force); };
    video.addEventListener('loadedmetadata', onMeta, { once: true });
    video.addEventListener('canplay', onPlay, { once: true });
    // Also try immediately if video already has metadata
    if (video.readyState >= 1) tryActivate(video, force);
    cleanupFns.push(() => {
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('canplay', onPlay);
    });
  }

  function watchSrcChanges(video) {
    // Watch src attribute (standard players)
    const srcObs = new MutationObserver(() => { lastSrcChangeTime = Date.now(); armVideo(video); });
    srcObs.observe(video, { attributes: true, attributeFilter: ['src', 'poster'] });
    cleanupFns.push(() => srcObs.disconnect());

    // Detect episode change via time reset (MSE players like Netflix)
    // If currentTime drops near 0 while video had been playing past 10s → new episode
    let prevTime = 0;
    function onTimeUpdate() {
      const ct = video.currentTime;
      if (prevTime > 10 && ct < 3) {
        lastEpisodeChangeTime = Date.now();
        armVideo(video, true);
      }
      prevTime = ct;
    }
    video.addEventListener('timeupdate', onTimeUpdate);
    cleanupFns.push(() => video.removeEventListener('timeupdate', onTimeUpdate));
  }

  function onUrlChange() {
    lastUrlChangeTime = Date.now();
    const t = setTimeout(() => { const v = findBestVideo(); if (v) armVideo(v); }, 800);
    cleanupFns.push(() => clearTimeout(t));
  }

  // Hook history
  const _push = history.pushState.bind(history);
  const _replace = history.replaceState.bind(history);
  let _lastUrl = location.href;
  history.pushState = function (...a) { _push(...a); if (location.href !== _lastUrl) { _lastUrl = location.href; onUrlChange(); } };
  history.replaceState = function (...a) { _replace(...a); if (location.href !== _lastUrl) { _lastUrl = location.href; onUrlChange(); } };
  window.addEventListener('popstate', onUrlChange);
  cleanupFns.push(() => {
    history.pushState = _push;
    history.replaceState = _replace;
    window.removeEventListener('popstate', onUrlChange);
  });

  // DOM observer for new video nodes
  const domObs = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeName === 'VIDEO') { watchSrcChanges(node); armVideo(node); }
        else if (node.querySelectorAll) {
          node.querySelectorAll('video').forEach(v => { watchSrcChanges(v); armVideo(v); });
        }
      }
    }
  });
  domObs.observe(document.documentElement, { childList: true, subtree: true });
  cleanupFns.push(() => domObs.disconnect());

  // leavepictureinpicture
  function onLeavePip() {
    const now = Date.now();
    const recentChange = (now - lastSrcChangeTime < 3000) || (now - lastUrlChangeTime < 3000) || (now - lastEpisodeChangeTime < 5000);
    chrome.storage.local.get('autoPipArmed').then(({ autoPipArmed }) => {
      if (!autoPipArmed) return;
      if (recentChange) {
        const v = findBestVideo();
        if (v) armVideo(v, true);
      } else {
        chrome.storage.local.set({ autoPipState: 'suspended' });
      }
    });
  }
  document.addEventListener('leavepictureinpicture', onLeavePip);
  cleanupFns.push(() => document.removeEventListener('leavepictureinpicture', onLeavePip));

  // Message handler
  function onMsg(msg, _s, sendResponse) {
    if (msg.type === 'STOP_AUTO_PIP_WATCHER') { cleanup(); sendResponse({ ok: true }); }
    else if (msg.type === 'REARM_AUTO_PIP') {
      isArmed().then(a => { if (a) { const v = findBestVideo(); if (v) armVideo(v); } sendResponse({ ok: true }); });
      return true;
    }
    return true;
  }
  chrome.runtime.onMessage.addListener(onMsg);
  cleanupFns.push(() => chrome.runtime.onMessage.removeListener(onMsg));

  function cleanup() {
    clearTimeout(retryTimer);
    cleanupFns.forEach(fn => { try { fn(); } catch (_) {} });
    cleanupFns = [];
    window.__quickyPipWatcher = false;
  }

  // Arm existing videos
  document.querySelectorAll('video').forEach(v => watchSrcChanges(v));
  const best = findBestVideo();
  if (best) armVideo(best);
}

// ─── Command: toggle-pip ──────────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-pip') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('about:')) return;
  await executePipToggle(tab);
});

// ─── Tab close cleanup ────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { pipTabId } = await chrome.storage.local.get('pipTabId');
  if (pipTabId === tabId) {
    await chrome.storage.local.set({ pipActive: false, pipTabId: null });
  }
});

// ─── Storage change: arm/disarm Auto PiP on pipActive change ─────────────────

chrome.storage.onChanged.addListener(async (changes) => {
  if (changes.pipActive?.newValue === true) {
    const { autoPipEnabled, pipTabId } = await chrome.storage.local.get(['autoPipEnabled', 'pipTabId']);
    if (autoPipEnabled && pipTabId) {
      await chrome.storage.local.set({ autoPipArmed: true, autoPipState: 'monitoring' });
      await injectAutoPipWatcher(pipTabId);
    }
  }
  if (changes.pipActive?.newValue === false) {
    await chrome.storage.local.set({ autoPipArmed: false, autoPipState: 'disarmed' });
  }
});

// ─── Message handler (popup) ──────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  if (msg.type === 'TOGGLE_PIP') {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('about:')) {
        sendResponse({ ok: false, error: 'Aba inválida.' }); return;
      }
      await executePipToggle(tab);
      const state = await chrome.storage.local.get(['pipActive', 'pipTabId', 'lastError']);
      sendResponse(state);
    })();
    return true;
  }

  if (msg.type === 'EXIT_PIP') {
    (async () => {
      const { pipTabId } = await chrome.storage.local.get('pipTabId');
      if (!pipTabId) { sendResponse({ ok: false }); return; }
      try {
        await chrome.scripting.executeScript({
          target: { tabId: pipTabId },
          func: () => document.pictureInPictureElement ? document.exitPictureInPicture() : Promise.resolve(),
        });
        await chrome.storage.local.set({ pipActive: false, pipTabId: null });
        sendResponse({ ok: true });
      } catch (e) {
        await chrome.storage.local.set({ lastError: e.message });
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === 'GET_VIDEO_STATE') {
    (async () => {
      const { pipTabId } = await chrome.storage.local.get('pipTabId');
      if (!pipTabId) { sendResponse(null); return; }
      try {
        await chrome.scripting.executeScript({ target: { tabId: pipTabId }, files: ['content.js'] });
        const state = await chrome.tabs.sendMessage(pipTabId, { type: 'GET_VIDEO_STATE' });
        sendResponse(state || null);
      } catch (e) {
        sendResponse(null);
      }
    })();
    return true;
  }

  if (msg.type === 'VIDEO_CMD') {
    (async () => {
      const { pipTabId } = await chrome.storage.local.get('pipTabId');
      if (!pipTabId) { sendResponse({ ok: false }); return; }
      try {
        // Ensure content script is injected, then forward the command via tabs.sendMessage
        // (avoids CSP issues with executeScript on sites like Netflix)
        await chrome.scripting.executeScript({
          target: { tabId: pipTabId },
          files: ['content.js'],
        });
        const res = await chrome.tabs.sendMessage(pipTabId, msg.cmd);
        sendResponse(res || { ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === 'SKIP_INTRO') {
    (async () => {
      const { pipTabId } = await chrome.storage.local.get('pipTabId');
      if (!pipTabId) { sendResponse({ ok: false }); return; }
      try {
        await chrome.scripting.executeScript({
          target: { tabId: pipTabId },
          files: ['content.js'],
        });
        const res = await chrome.tabs.sendMessage(pipTabId, { type: 'SKIP_INTRO' });
        sendResponse(res || { ok: false });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === 'SET_AUTO_PIP') {
    (async () => {
      const { enabled } = msg;
      await chrome.storage.local.set({ autoPipEnabled: enabled });
      if (!enabled) {
        await chrome.storage.local.set({ autoPipArmed: false, autoPipState: 'disarmed' });
        const { pipTabId } = await chrome.storage.local.get('pipTabId');
        if (pipTabId) {
          try { await chrome.tabs.sendMessage(pipTabId, { type: 'STOP_AUTO_PIP_WATCHER' }); } catch (_) {}
        }
      } else {
        const { pipActive, pipTabId } = await chrome.storage.local.get(['pipActive', 'pipTabId']);
        if (pipActive && pipTabId) {
          await chrome.storage.local.set({ autoPipArmed: true, autoPipState: 'monitoring' });
          await injectAutoPipWatcher(pipTabId);
        } else {
          await chrome.storage.local.set({ autoPipArmed: false, autoPipState: 'disarmed' });
        }
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'GO_TO_PIP_TAB') {
    (async () => {
      const { pipTabId } = await chrome.storage.local.get('pipTabId');
      if (pipTabId) await chrome.tabs.update(pipTabId, { active: true });
      sendResponse({ ok: !!pipTabId });
    })();
    return true;
  }
});
