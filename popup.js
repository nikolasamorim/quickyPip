/**
 * QuickyPip — popup.js
 * UI logic only. All video control via chrome.scripting / messages to background.
 */

// ── DOM refs ─────────────────────────────────────────────────────────────────
const statusPill    = document.getElementById('status-pill');
const statusDot     = document.getElementById('status-dot');
const statusText    = document.getElementById('status-text');
const miniplayer    = document.getElementById('miniplayer');
const miniOrigin    = document.getElementById('mini-origin');
const miniLive      = document.getElementById('mini-live');
const miniPlayBtn   = document.getElementById('mini-playpause');
const miniPlayIcon  = document.getElementById('mini-play-icon');
const miniPauseIcon = document.getElementById('mini-pause-icon');
const miniTime      = document.getElementById('mini-time');
const miniProgWrap  = document.getElementById('mini-progress-wrap');
const miniProgBar   = document.getElementById('mini-progress-bar');
const ctrlMute      = document.getElementById('ctrl-mute');
const ctrlBack      = document.getElementById('ctrl-back');
const ctrlPlay      = document.getElementById('ctrl-play');
const ctrlPlayIcon  = document.getElementById('ctrl-play-icon');
const ctrlPauseIcon = document.getElementById('ctrl-pause-icon');
const ctrlFwd       = document.getElementById('ctrl-fwd');
const ctrlGoto      = document.getElementById('ctrl-goto');
const volumeSlider  = document.getElementById('volume-slider');
const speedDown     = document.getElementById('speed-down');
const speedDisplay  = document.getElementById('speed-display');
const speedUp       = document.getElementById('speed-up');
const btnSkipIntro  = document.getElementById('btn-skip-intro');
const btnActivate   = document.getElementById('btn-activate');
const btnDeactivate = document.getElementById('btn-deactivate');
const autopipCard   = document.getElementById('autopip-card');
const autopipToggle = document.getElementById('autopip-toggle');
const autopipStateLine = document.getElementById('autopip-state-line');
const autopipStateDot  = document.getElementById('autopip-state-dot');
const autopipStateText = document.getElementById('autopip-state-text');

// ── State ─────────────────────────────────────────────────────────────────────
let pipActive     = false;
let pipTabId      = null;
let autoPipEnabled = false;
let autoPipState  = 'disarmed'; // 'monitoring' | 'suspended' | 'disarmed'
let pollTimer     = null;

const SPEED_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
let currentSpeedIdx = 3; // 1x

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(s) {
  if (!isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${ss}`;
}

async function sendBg(msg) {
  try { return await chrome.runtime.sendMessage(msg); } catch (_) { return null; }
}

async function videoCmd(type, extra = {}) {
  return sendBg({ type: 'VIDEO_CMD', cmd: { type, ...extra } });
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderPipState(active) {
  pipActive = active;
  if (active) {
    statusPill.classList.add('pip-active');
    statusText.textContent = 'PiP ativo nesta aba';
    miniplayer.classList.remove('hidden');
    btnActivate.disabled = true;
    btnDeactivate.disabled = false;
    btnActivate.classList.remove('pulse');
  } else {
    statusPill.classList.remove('pip-active');
    statusText.textContent = 'Nenhum vídeo em PiP';
    miniplayer.classList.add('hidden');
    btnActivate.disabled = false;
    btnDeactivate.disabled = true;
  }
  renderAutoPipUI();
}

function renderVideoState(state) {
  if (!state) return;

  // Origin
  const origin = state.tabOrigin || '—';
  miniOrigin.textContent = `Aba · ${origin.replace('www.', '')}`;

  // Live badge (Infinity duration)
  if (state.duration === Infinity) {
    miniLive.classList.remove('hidden');
  } else {
    miniLive.classList.add('hidden');
  }

  // Play/pause icons in thumb
  miniPlayIcon.classList.toggle('hidden', !state.paused);
  miniPauseIcon.classList.toggle('hidden', state.paused);

  // Play/pause icon in controls
  ctrlPlayIcon.classList.toggle('hidden', !state.paused);
  ctrlPauseIcon.classList.toggle('hidden', state.paused);

  // Time
  miniTime.textContent = `${fmtTime(state.currentTime)} / ${fmtTime(state.duration)}`;

  // Progress
  if (isFinite(state.duration) && state.duration > 0) {
    miniProgBar.style.width = `${(state.currentTime / state.duration) * 100}%`;
  }

  // Skip intro button visibility
  btnSkipIntro.classList.toggle('hidden', !state.hasSkipBtn);

  // Volume
  if (!volumeSlider.matches(':active')) {
    volumeSlider.value = state.muted ? 0 : state.volume;
  }

  // Speed
  const idx = SPEED_STEPS.findIndex(s => Math.abs(s - state.playbackRate) < 0.01);
  if (idx >= 0) currentSpeedIdx = idx;
  speedDisplay.textContent = `${SPEED_STEPS[currentSpeedIdx]}×`;
}

function renderAutoPipUI() {
  autopipToggle.checked = autoPipEnabled;

  if (autoPipEnabled) {
    autopipCard.classList.add('active');
  } else {
    autopipCard.classList.remove('active');
  }

  if (!autoPipEnabled) {
    autopipStateDot.classList.add('hidden');
    autopipStateText.textContent = '';
    return;
  }

  if (!pipActive) {
    // No PiP — prompt user
    autopipStateDot.classList.add('hidden');
    autopipStateText.textContent = 'ative o PiP primeiro';
    btnActivate.classList.add('pulse');
  } else if (autoPipState === 'monitoring') {
    autopipStateDot.classList.remove('hidden');
    autopipStateDot.className = 'autopip-state-dot green';
    autopipStateText.textContent = 'monitorando';
    btnActivate.classList.remove('pulse');
  } else if (autoPipState === 'suspended') {
    autopipStateDot.classList.remove('hidden');
    autopipStateDot.className = 'autopip-state-dot amber';
    autopipStateText.textContent = 'suspenso — reativa no próximo';
    btnActivate.classList.remove('pulse');
  } else {
    autopipStateDot.classList.add('hidden');
    autopipStateText.textContent = 'ative o PiP primeiro';
    btnActivate.classList.add('pulse');
  }
}

// ── Polling ───────────────────────────────────────────────────────────────────

async function poll() {
  if (!pipActive) return;
  const state = await sendBg({ type: 'GET_VIDEO_STATE' });
  if (state) renderVideoState(state);

  // Also sync storage for autoPipState
  const stored = await chrome.storage.local.get(['pipActive', 'autoPipState', 'autoPipEnabled', 'pipTabId']);
  if (!stored.pipActive && pipActive) { renderPipState(false); }
  if (stored.autoPipState && stored.autoPipState !== autoPipState) {
    autoPipState = stored.autoPipState;
    renderAutoPipUI();
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(poll, 500);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ── Button handlers ───────────────────────────────────────────────────────────

btnActivate.addEventListener('click', async () => {
  btnActivate.disabled = true;
  await sendBg({ type: 'TOGGLE_PIP' });
  const stored = await chrome.storage.local.get(['pipActive', 'pipTabId', 'autoPipState', 'autoPipEnabled']);
  pipTabId      = stored.pipTabId;
  autoPipState  = stored.autoPipState || 'disarmed';
  autoPipEnabled = !!stored.autoPipEnabled;
  renderPipState(!!stored.pipActive);
  if (stored.pipActive) startPolling(); else stopPolling();
});

btnDeactivate.addEventListener('click', async () => {
  btnDeactivate.disabled = true;
  await sendBg({ type: 'EXIT_PIP' });
  renderPipState(false);
  stopPolling();
});

miniPlayBtn.addEventListener('click', () => videoCmd('TOGGLE_PLAY'));
ctrlPlay.addEventListener('click', () => videoCmd('TOGGLE_PLAY'));
ctrlBack.addEventListener('click', () => videoCmd('SEEK', { delta: -10 }));
ctrlFwd.addEventListener('click', () => videoCmd('SEEK', { delta: 10 }));
ctrlMute.addEventListener('click', async () => {
  const state = await sendBg({ type: 'GET_VIDEO_STATE' });
  if (state) videoCmd('SET_MUTED', { value: !state.muted });
});
ctrlGoto.addEventListener('click', () => sendBg({ type: 'GO_TO_PIP_TAB' }));
btnSkipIntro.addEventListener('click', async () => {
  const res = await sendBg({ type: 'SKIP_INTRO' });
  if (res?.ok) btnSkipIntro.classList.add('hidden');
});

volumeSlider.addEventListener('input', () => {
  videoCmd('SET_VOLUME', { value: parseFloat(volumeSlider.value) });
  if (parseFloat(volumeSlider.value) === 0) {
    videoCmd('SET_MUTED', { value: true });
  } else {
    videoCmd('SET_MUTED', { value: false });
  }
});

speedDown.addEventListener('click', () => {
  if (currentSpeedIdx > 0) {
    currentSpeedIdx--;
    const rate = SPEED_STEPS[currentSpeedIdx];
    speedDisplay.textContent = `${rate}×`;
    videoCmd('SET_RATE', { value: rate });
  }
});

speedUp.addEventListener('click', () => {
  if (currentSpeedIdx < SPEED_STEPS.length - 1) {
    currentSpeedIdx++;
    const rate = SPEED_STEPS[currentSpeedIdx];
    speedDisplay.textContent = `${rate}×`;
    videoCmd('SET_RATE', { value: rate });
  }
});

miniProgWrap.addEventListener('click', (e) => {
  const rect = miniProgWrap.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  sendBg({ type: 'GET_VIDEO_STATE' }).then(state => {
    if (state && isFinite(state.duration) && state.duration > 0) {
      videoCmd('SET_TIME', { value: pct * state.duration });
    }
  });
});

// ── Auto PiP toggle ───────────────────────────────────────────────────────────

autopipToggle.addEventListener('change', async () => {
  autoPipEnabled = autopipToggle.checked;
  await sendBg({ type: 'SET_AUTO_PIP', enabled: autoPipEnabled });
  await chrome.storage.local.set({ autoPipEnabled });
  const stored = await chrome.storage.local.get(['autoPipState']);
  autoPipState = stored.autoPipState || 'disarmed';
  renderAutoPipUI();
});

// ── Init ──────────────────────────────────────────────────────────────────────

(async () => {
  const stored = await chrome.storage.local.get([
    'pipActive', 'pipTabId', 'autoPipEnabled', 'autoPipState',
  ]);

  pipActive      = !!stored.pipActive;
  pipTabId       = stored.pipTabId || null;
  autoPipEnabled = !!stored.autoPipEnabled;
  autoPipState   = stored.autoPipState || 'disarmed';

  // Sync speed idx from video if pip active
  if (pipActive) {
    const state = await sendBg({ type: 'GET_VIDEO_STATE' });
    if (state) {
      renderVideoState(state);
      const idx = SPEED_STEPS.findIndex(s => Math.abs(s - state.playbackRate) < 0.01);
      if (idx >= 0) currentSpeedIdx = idx;
    }
  }

  renderPipState(pipActive);
  renderAutoPipUI();

  if (pipActive) startPolling();
})();
