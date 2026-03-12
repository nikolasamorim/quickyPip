/**
 * QuickyPip — background.js (Service Worker, Manifest V3)
 */

// ─── Tab Registry ─────────────────────────────────────────────────────────────
// Tracks all tabs that have the persistent content script connected via port.

const tabRegistry = new Map(); // tabId → { port, videoState }

// Pending port request-response (for SKIP_INTRO replies, etc.)
let _portReqId = 0;
const _pendingPortReplies = new Map(); // id → { resolve, timer }

function portRequest(port, msg, timeoutMs = 2000) {
  return new Promise(resolve => {
    const id = ++_portReqId;
    const timer = setTimeout(() => {
      _pendingPortReplies.delete(id);
      resolve(null);
    }, timeoutMs);
    _pendingPortReplies.set(id, { resolve, timer });
    try { port.postMessage({ ...msg, id }); } catch (_) {
      clearTimeout(timer);
      _pendingPortReplies.delete(id);
      resolve(null);
    }
  });
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'quickpip-tab') return;
  const tabId = port.sender?.tab?.id;
  if (!tabId) return;

  const entry = { port, videoState: null };
  tabRegistry.set(tabId, entry);

  port.onDisconnect.addListener(() => {
    tabRegistry.delete(tabId);
  });

  port.onMessage.addListener(msg => {
    // Push: content script reports current video state
    if (msg.type === 'VIDEO_STATE_UPDATE') {
      entry.videoState = msg.state;
      return;
    }
    // Reply to a pending request
    if (msg.id && _pendingPortReplies.has(msg.id)) {
      const { resolve, timer } = _pendingPortReplies.get(msg.id);
      clearTimeout(timer);
      _pendingPortReplies.delete(msg.id);
      resolve(msg.state ?? msg);
      return;
    }
  });
});

// ─── Tab Group management ─────────────────────────────────────────────────────

async function addToPipGroup(tabId) {
  try {
    const groupId = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(groupId, { title: 'QuickyPip ▶', color: 'blue' });
    return groupId;
  } catch (_) {
    // tabGroups API may not be available in all environments; fail silently
    return null;
  }
}

async function removeFromPipGroup(tabId) {
  try {
    await chrome.tabs.ungroup([tabId]);
  } catch (_) {}
}

// ─── executePipToggle (for keyboard shortcut — toggles) ───────────────────────

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
      await removeFromPipGroup(tabId);
      await chrome.storage.local.set({ pipActive: false, pipTabId: null, lastError: null });
    } else if (!res.ok) {
      await chrome.storage.local.set({ lastError: res.error || 'Erro desconhecido.' });
    }
  } catch (e) {
    await chrome.storage.local.set({ lastError: e.message });
  }
}

// ─── executePipActivate (activate-only, never exits PiP) ─────────────────────

async function executePipActivate(tab) {
  if (!tab?.id) return;
  const tabId = tab.id;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: function () {
        if (document.pictureInPictureElement) {
          return Promise.resolve({ ok: false, action: 'already_active' });
        }
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
    } else if (!res.ok && res.action !== 'already_active') {
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

  function chromeAlive() {
    try { return !!chrome.runtime?.id; } catch (_) { return false; }
  }

  async function isArmed() {
    if (!chromeAlive()) { cleanup(); return false; }
    try {
      const { autoPipArmed } = await chrome.storage.local.get('autoPipArmed');
      return !!autoPipArmed;
    } catch (_) { cleanup(); return false; }
  }

  async function tryActivate(video, force = false) {
    if (!(await isArmed())) return;
    if (document.pictureInPictureElement) { attemptCount = 0; return; }
    if (!video || video.duration <= 30 || video.duration === Infinity) return;
    if (!force && document.visibilityState !== 'hidden') return;

    video.removeAttribute('disablepictureinpicture');
    try { video.disablePictureInPicture = false; } catch (_) {}

    try {
      await video.requestPictureInPicture();
      attemptCount = 0;
      if (chromeAlive()) await chrome.storage.local.set({ pipActive: true, autoPipState: 'monitoring', lastError: null });
    } catch (e) {
      if (!chromeAlive()) { cleanup(); return; }
      if (attemptCount >= BACKOFF.length) {
        try { await chrome.storage.local.set({ lastError: 'AutoPip falhou: ' + e.message }); } catch (_) {}
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
    if (video.readyState >= 1) tryActivate(video, force);
    cleanupFns.push(() => {
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('canplay', onPlay);
    });
  }

  function watchSrcChanges(video) {
    const srcObs = new MutationObserver(() => { lastSrcChangeTime = Date.now(); armVideo(video); });
    srcObs.observe(video, { attributes: true, attributeFilter: ['src', 'poster'] });
    cleanupFns.push(() => srcObs.disconnect());

    let prevTime = 0;
    function onTimeUpdate() {
      const ct = video.currentTime;
      if (prevTime > 10 && ct < 3) { lastEpisodeChangeTime = Date.now(); armVideo(video, true); }
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

  function onLeavePip() {
    if (!chromeAlive()) { cleanup(); return; }
    const now = Date.now();
    const recentChange = (now - lastSrcChangeTime < 3000) || (now - lastUrlChangeTime < 3000) || (now - lastEpisodeChangeTime < 5000);
    chrome.storage.local.get('autoPipArmed').then(({ autoPipArmed }) => {
      if (!autoPipArmed) return;
      if (recentChange) {
        const v = findBestVideo();
        if (v) armVideo(v, true);
      } else {
        if (chromeAlive()) chrome.storage.local.set({ autoPipState: 'suspended' });
      }
    }).catch(() => cleanup());
  }
  document.addEventListener('leavepictureinpicture', onLeavePip);
  cleanupFns.push(() => document.removeEventListener('leavepictureinpicture', onLeavePip));

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

  document.querySelectorAll('video').forEach(v => watchSrcChanges(v));
  const best = findBestVideo();
  if (best) armVideo(best);
}

// ─── Command: toggle-pip (keyboard shortcut) ──────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-pip') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('about:')) return;
  await executePipToggle(tab);
});

// ─── Tab close cleanup ────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener(async (tabId) => {
  tabRegistry.delete(tabId);
  const { pipTabId } = await chrome.storage.local.get('pipTabId');
  if (pipTabId === tabId) {
    await chrome.storage.local.set({ pipActive: false, pipTabId: null });
  }
});

// ─── Storage change: arm/disarm Auto PiP + tab group management ───────────────

chrome.storage.onChanged.addListener(async (changes) => {
  if (changes.pipActive?.newValue === true) {
    const { autoPipEnabled, pipTabId } = await chrome.storage.local.get(['autoPipEnabled', 'pipTabId']);
    if (autoPipEnabled && pipTabId) {
      await chrome.storage.local.set({ autoPipArmed: true, autoPipState: 'monitoring' });
      await injectAutoPipWatcher(pipTabId);
    }
    if (pipTabId) await addToPipGroup(pipTabId);
  }
  if (changes.pipActive?.newValue === false) {
    await chrome.storage.local.set({ autoPipArmed: false, autoPipState: 'disarmed' });
    // Tab group removal is handled directly in EXIT_PIP / executePipToggle,
    // before pipTabId is cleared from storage.
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

  if (msg.type === 'ACTIVATE_PIP') {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('about:')) {
        sendResponse({ ok: false, error: 'Aba inválida.' }); return;
      }
      await executePipActivate(tab);
      const state = await chrome.storage.local.get(['pipActive', 'pipTabId', 'lastError']);
      sendResponse(state);
    })();
    return true;
  }

  if (msg.type === 'EXIT_PIP') {
    (async () => {
      const { pipTabId } = await chrome.storage.local.get('pipTabId');
      if (!pipTabId) { sendResponse({ ok: false }); return; }
      // Prefer port (no user gesture needed for exit)
      const entry = tabRegistry.get(pipTabId);
      if (entry?.port) {
        try { entry.port.postMessage({ type: 'EXIT_PIP_CMD' }); } catch (_) {}
      }
      try {
        await chrome.scripting.executeScript({
          target: { tabId: pipTabId },
          func: () => document.pictureInPictureElement ? document.exitPictureInPicture() : Promise.resolve(),
        });
        await chrome.storage.local.set({ pipActive: false, pipTabId: null });
        await removeFromPipGroup(pipTabId);
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
      // Use cached state from port push (zero latency, no injection needed)
      const entry = tabRegistry.get(pipTabId);
      if (entry?.videoState) {
        sendResponse(entry.videoState);
        return;
      }
      // Fallback: request via port
      if (entry?.port) {
        const state = await portRequest(entry.port, { type: 'GET_VIDEO_STATE' });
        sendResponse(state || null);
        return;
      }
      // Last resort fallback: legacy sendMessage (content script always present now)
      try {
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
      // Send via port (no injection, no user gesture needed)
      const entry = tabRegistry.get(pipTabId);
      if (entry?.port) {
        try { entry.port.postMessage(msg.cmd); sendResponse({ ok: true }); } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        return;
      }
      // Fallback: legacy sendMessage
      try {
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
      // Request via port
      const entry = tabRegistry.get(pipTabId);
      if (entry?.port) {
        const res = await portRequest(entry.port, { type: 'SKIP_INTRO' });
        sendResponse(res || { ok: false });
        return;
      }
      // Fallback: legacy sendMessage
      try {
        const res = await chrome.tabs.sendMessage(pipTabId, { type: 'SKIP_INTRO' });
        sendResponse(res || { ok: false });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === 'REMOVE_DISABLE_PIP_ATTR') {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('about:')) {
        sendResponse({ ok: false, error: 'Aba inválida.' }); return;
      }
      // Try via port first
      const entry = tabRegistry.get(tab.id);
      if (entry?.port) {
        const res = await portRequest(entry.port, { type: 'REMOVE_DISABLE_PIP_ATTR' });
        if (res) { sendResponse(res); return; }
      }
      // Fallback: executeScript (still needed for pages that block sendMessage)
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: function () {
            const videos = Array.from(document.querySelectorAll('video'));
            let count = 0;
            videos.forEach(v => {
              if (v.hasAttribute('disablepictureinpicture')) { v.removeAttribute('disablepictureinpicture'); count++; }
              try { v.disablePictureInPicture = false; } catch (_) {}
            });
            return { ok: true, count };
          },
        });
        sendResponse(results?.[0]?.result || { ok: false });
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
