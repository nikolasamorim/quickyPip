/**
 * Quick PiP — popup.js
 *
 * Gerencia o popup: ao clicar no botão, injeta a lógica PiP na aba ativa
 * usando a mesma função definida em background.js (evita duplicação).
 */

/** Função idêntica à do background.js — injetada na página via executeScript. */
function pipToggleScript() {
    try {
        if (document.pictureInPictureElement) {
            return document.exitPictureInPicture()
                .then(() => ({ ok: true, status: "desativado", reason: "Picture-in-Picture desativado com sucesso." }))
                .catch((err) => ({ ok: false, status: "erro", reason: "Erro ao sair do PiP: " + err.message }));
        }

        const allVideos = Array.from(document.querySelectorAll("video"));

        if (allVideos.length === 0) {
            return Promise.resolve({ ok: false, status: "nenhum", reason: "Nenhum vídeo detectado na página." });
        }

        const visibleVideos = allVideos.filter((v) => {
            const style = window.getComputedStyle(v);
            if (style.display === "none") return false;
            if (style.visibility === "hidden") return false;
            if (parseFloat(style.opacity) === 0) return false;
            const rect = v.getBoundingClientRect();
            return rect.width > 200 && rect.height > 200;
        });

        const candidates = visibleVideos.length > 0 ? visibleVideos : allVideos;

        if (candidates.length === 0) {
            return Promise.resolve({ ok: false, status: "nenhum", reason: "Nenhum vídeo visível encontrado na página." });
        }

        const bestVideo = candidates.reduce((best, v) => {
            const rect = v.getBoundingClientRect();
            const area = rect.width * rect.height;
            const bestRect = best.getBoundingClientRect();
            const bestArea = bestRect.width * bestRect.height;
            return area > bestArea ? v : best;
        });

        if (!document.pictureInPictureEnabled) {
            return Promise.resolve({ ok: false, status: "bloqueado", reason: "PiP não está disponível neste navegador ou está desabilitado globalmente." });
        }

        // Se o player bloqueou PiP via atributo, remove antes de ativar
        if (bestVideo.disablePictureInPicture) {
            bestVideo.disablePictureInPicture = false;
            bestVideo.removeAttribute("disablepictureinpicture");
        }

        return bestVideo.requestPictureInPicture()
            .then(() => ({ ok: true, status: "ativado", reason: "Picture-in-Picture ativado com sucesso." }))
            .catch((err) => ({
                ok: false,
                status: "erro",
                reason: "PiP não está disponível neste player/página (pode estar bloqueado). Detalhe: " + err.message,
            }));
    } catch (err) {
        return Promise.resolve({ ok: false, status: "erro", reason: "Erro inesperado: " + err.message });
    }
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

const btnToggle = document.getElementById("btn-toggle");
const statusIcon = document.getElementById("status-icon");
const statusMsg = document.getElementById("status-msg");
const statusArea = document.getElementById("status-area");

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

    // Remover classes anteriores
    statusArea.className = "status-area " + css;
}

function setLoading(isLoading) {
    btnToggle.disabled = isLoading;
    if (isLoading) {
        renderStatus("carregando", "Processando…");
    }
}

// ─── Ação principal ───────────────────────────────────────────────────────────

async function togglePiP() {
    setLoading(true);

    let tabs;
    try {
        tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch (_) {
        renderStatus("erro", "Não foi possível acessar a aba ativa.");
        setLoading(false);
        return;
    }

    if (!tabs || tabs.length === 0) {
        renderStatus("erro", "Nenhuma aba ativa encontrada.");
        setLoading(false);
        return;
    }

    const tab = tabs[0];

    if (
        !tab.url ||
        tab.url.startsWith("chrome://") ||
        tab.url.startsWith("about:") ||
        tab.url.startsWith("chrome-extension://")
    ) {
        renderStatus("erro", "Não é possível usar PiP em páginas internas do navegador.");
        setLoading(false);
        return;
    }

    let results;
    try {
        results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: pipToggleScript,
        });
    } catch (err) {
        renderStatus("erro", "Não foi possível injetar o script na página. Detalhe: " + err.message);
        setLoading(false);
        return;
    }

    const result = results?.[0]?.result;

    if (!result) {
        renderStatus("erro", "Sem resposta do script injetado.");
        setLoading(false);
        return;
    }

    renderStatus(result.status, result.reason);
    setLoading(false);
}

btnToggle.addEventListener("click", togglePiP);
