/**
 * Quick PiP — popup.js
 *
 * Gerencia o popup: toggle PiP manual e Auto PiP.
 */

// ─── UI helpers ───────────────────────────────────────────────────────────────

const btnToggle = document.getElementById("btn-toggle");
const statusIcon = document.getElementById("status-icon");
const statusMsg = document.getElementById("status-msg");
const statusArea = document.getElementById("status-area");
const autoPipToggle = document.getElementById("auto-pip-toggle");
const autoPipStatus = document.getElementById("auto-pip-status");
const badgeArmed = document.getElementById("badge-armed");
const badgeWatching = document.getElementById("badge-watching");
const autoPipLastStatus = document.getElementById("auto-pip-last-status");

/** Mapa status → [emoji, classe CSS] */
const STATUS_MAP = {
    ativado: ["▶︎", "status--success"],
    desativado: ["⏹", "status--info"],
    bloqueado: ["🚫", "status--warn"],
    nenhum: ["🔍", "status--warn"],
    erro: ["⚠️", "status--error"],
    carregando: ["⏳", "status--loading"],
};

function renderStatus(status, message) {
    const [icon, css] = STATUS_MAP[status] || ["ℹ️", ""];
    statusIcon.textContent = icon;
    statusMsg.textContent = message;
    statusArea.className = "status-area " + css;
}

function setLoading(isLoading) {
    btnToggle.disabled = isLoading;
    if (isLoading) renderStatus("carregando", "Processando…");
}

// ─── Auto PiP UI ──────────────────────────────────────────────────────────────

function renderAutoPipStatus({ autoPipEnabled, autoPipArmed, watcherStatus }) {
    autoPipToggle.checked = !!autoPipEnabled;

    if (!autoPipEnabled) {
        autoPipStatus.classList.add("hidden");
        return;
    }

    autoPipStatus.classList.remove("hidden");

    // Badge "Armado"
    if (autoPipArmed) {
        badgeArmed.classList.add("badge--active");
        badgeArmed.classList.remove("badge--inactive");
        badgeArmed.textContent = "● Armado";
    } else {
        badgeArmed.classList.remove("badge--active");
        badgeArmed.classList.add("badge--inactive");
        badgeArmed.textContent = "○ Desarmado";
    }

    // Badge "Monitorando"
    const isObserving = watcherStatus?.observing;
    if (isObserving) {
        badgeWatching.classList.add("badge--active");
        badgeWatching.classList.remove("badge--inactive");
        badgeWatching.textContent = "👁 Monitorando";
    } else {
        badgeWatching.classList.remove("badge--active");
        badgeWatching.classList.add("badge--inactive");
        badgeWatching.textContent = "◌ Inativo";
    }

    // Último status / erro
    if (watcherStatus?.lastError) {
        autoPipLastStatus.textContent = "⚠ " + watcherStatus.lastError;
        autoPipLastStatus.className = "auto-pip-last-status auto-pip-last-status--error";
    } else if (watcherStatus?.lastAttempt) {
        const time = new Date(watcherStatus.lastAttempt).toLocaleTimeString();
        autoPipLastStatus.textContent = `✓ Última tentativa: ${time}`;
        autoPipLastStatus.className = "auto-pip-last-status auto-pip-last-status--ok";
    } else {
        autoPipLastStatus.textContent = "";
        autoPipLastStatus.className = "auto-pip-last-status";
    }
}

async function refreshAutoPipStatus() {
    try {
        const data = await chrome.runtime.sendMessage({ type: "GET_AUTO_PIP_STATUS" });
        renderAutoPipStatus(data || {});
    } catch {
        // popup pode abrir antes do service worker estar pronto
    }
}

// ─── Toggle Auto PiP ─────────────────────────────────────────────────────────

autoPipToggle.addEventListener("change", async () => {
    const enabled = autoPipToggle.checked;
    await chrome.storage.local.set({ autoPipEnabled: enabled });

    if (!enabled) {
        // Desligar → desarmar e parar watcher
        try {
            await chrome.runtime.sendMessage({ type: "DISABLE_AUTO_PIP" });
        } catch { /* service worker pode não estar respondendo */ }
        await chrome.storage.local.set({ autoPipArmed: false });
    }

    await refreshAutoPipStatus();
});

// ─── Toggle PiP manual ───────────────────────────────────────────────────────

async function togglePiP() {
    setLoading(true);

    let result;
    try {
        result = await chrome.runtime.sendMessage({ type: "TOGGLE_PIP" });
    } catch (err) {
        renderStatus("erro", "Erro ao comunicar com o service worker: " + err.message);
        setLoading(false);
        return;
    }

    if (!result) {
        renderStatus("erro", "Sem resposta do service worker.");
        setLoading(false);
        return;
    }

    renderStatus(result.status, result.reason);
    setLoading(false);

    // Atualizar estado do Auto PiP após toggle manual
    await refreshAutoPipStatus();
}

btnToggle.addEventListener("click", togglePiP);

// ─── Inicialização ────────────────────────────────────────────────────────────

(async () => {
    await refreshAutoPipStatus();

    // Polling leve enquanto popup está aberto (a cada 2s) para refletir mudanças externas
    setInterval(refreshAutoPipStatus, 2000);
})();
