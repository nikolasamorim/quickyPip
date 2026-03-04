/**
 * Quick PiP — background.js (Service Worker, Manifest V3)
 *
 * Responsável por:
 * - Escutar o atalho de teclado Alt+P (comando "toggle-pip")
 * - Executar a ação de toggle PiP na aba ativa via chrome.scripting
 * - Gerenciar o estado do Auto PiP (armar/desarmar, injetar watcher)
 */

// ─── Função injetada na página para toggle PiP ─────────────────────────────
/**
 * Injetada via executeScript. Retorna Promise<{ ok, status, reason, wasActive }>.
 * wasActive = true  → PiP estava ativo antes (ação foi desativar)
 * wasActive = false → PiP estava inativo antes (ação foi ativar)
 */
function pipToggleScript() {
  try {
    if (document.pictureInPictureElement) {
      return document.exitPictureInPicture()
        .then(() => ({
          ok: true, status: "desativado",
          reason: "Picture-in-Picture desativado com sucesso.",
          wasActive: true,
        }))
        .catch((err) => ({
          ok: false, status: "erro",
          reason: "Erro ao sair do PiP: " + err.message,
          wasActive: true,
        }));
    }

    const allVideos = Array.from(document.querySelectorAll("video"));
    if (allVideos.length === 0) {
      return Promise.resolve({
        ok: false, status: "nenhum",
        reason: "Nenhum vídeo detectado na página.",
        wasActive: false,
      });
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
      return Promise.resolve({
        ok: false, status: "nenhum",
        reason: "Nenhum vídeo visível encontrado na página.",
        wasActive: false,
      });
    }

    const bestVideo = candidates.reduce((best, v) => {
      const rect = v.getBoundingClientRect();
      const area = rect.width * rect.height;
      const bestRect = best.getBoundingClientRect();
      const bestArea = bestRect.width * bestRect.height;
      return area > bestArea ? v : best;
    });

    if (!document.pictureInPictureEnabled) {
      return Promise.resolve({
        ok: false, status: "bloqueado",
        reason: "PiP não está disponível neste navegador ou está desabilitado globalmente.",
        wasActive: false,
      });
    }

    if (bestVideo.disablePictureInPicture) {
      bestVideo.disablePictureInPicture = false;
      bestVideo.removeAttribute("disablepictureinpicture");
    }

    return bestVideo.requestPictureInPicture()
      .then(() => ({
        ok: true, status: "ativado",
        reason: "Picture-in-Picture ativado com sucesso.",
        wasActive: false,
      }))
      .catch((err) => ({
        ok: false, status: "erro",
        reason: "PiP não está disponível neste player/página (pode estar bloqueado). Detalhe: " + err.message,
        wasActive: false,
      }));
  } catch (err) {
    return Promise.resolve({
      ok: false, status: "erro",
      reason: "Erro inesperado: " + err.message,
      wasActive: false,
    });
  }
}

// ─── Helpers de scripting ──────────────────────────────────────────────────

/**
 * Retorna a aba ativa ou null se não for possível.
 */
async function getActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || tabs.length === 0) return null;
    const tab = tabs[0];
    if (
      !tab.url ||
      tab.url.startsWith("chrome://") ||
      tab.url.startsWith("about:") ||
      tab.url.startsWith("chrome-extension://")
    ) return null;
    return tab;
  } catch {
    return null;
  }
}

/**
 * Injeta o content.js na aba (idempotente — o script verifica window.__quickPipWatcherActive).
 */
async function ensureContentScriptInjected(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  } catch (_) {
    // Pode falhar se o script já estiver registrado; ignorar.
  }
}

/**
 * Envia mensagem ao content script da aba.
 */
async function sendToTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    return null;
  }
}

// ─── Armar Auto PiP na aba ────────────────────────────────────────────────

async function armAutoPip(tab) {
  await chrome.storage.local.set({ autoPipArmed: true });
  await ensureContentScriptInjected(tab.id);
  await sendToTab(tab.id, { type: "START_AUTO_PIP" });
}

async function disarmAutoPip(tab) {
  await chrome.storage.local.set({ autoPipArmed: false });
  if (tab) {
    await sendToTab(tab.id, { type: "STOP_AUTO_PIP" });
  }
}

// ─── Toggle PiP principal ─────────────────────────────────────────────────

/**
 * Executa o toggle PiP na aba ativa e lida com a lógica de Auto PiP.
 * @returns {Promise<{ok: boolean, status: string, reason: string}>}
 */
async function togglePiPOnActiveTab() {
  const tab = await getActiveTab();
  if (!tab) {
    return {
      ok: false, status: "erro",
      reason: "Não foi possível acessar a aba ativa ou ela é uma página interna.",
    };
  }

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pipToggleScript,
    });
  } catch (err) {
    return {
      ok: false, status: "erro",
      reason: "Não foi possível injetar o script na página. Detalhe: " + err.message,
    };
  }

  if (!results || results.length === 0 || results[0].result === undefined) {
    return { ok: false, status: "erro", reason: "Sem resposta do script injetado." };
  }

  const result = results[0].result;

  // ─── Integração com Auto PiP ────────────────────────────────────────────
  const { autoPipEnabled } = await chrome.storage.local.get("autoPipEnabled");

  if (autoPipEnabled) {
    if (result.ok && result.status === "ativado") {
      // Usuário ativou PiP manualmente com Auto PiP ligado → armar
      await armAutoPip(tab);
    } else if (result.wasActive && result.status === "desativado") {
      // Usuário desativou PiP manualmente → desarmar
      await disarmAutoPip(tab);
    }
  }

  return result;
}

// ─── Comando de teclado Alt+P ──────────────────────────────────────────────
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-pip") return;
  await togglePiPOnActiveTab();
});

// ─── Mensagens do popup ────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "TOGGLE_PIP") {
    togglePiPOnActiveTab().then(sendResponse);
    return true; // async
  }

  if (msg.type === "DISABLE_AUTO_PIP") {
    // Popup desligou o toggle → desarmar a aba ativa
    getActiveTab().then((tab) => disarmAutoPip(tab).then(() => sendResponse({ ok: true })));
    return true;
  }

  if (msg.type === "GET_AUTO_PIP_STATUS") {
    getActiveTab().then(async (tab) => {
      let watcherStatus = null;
      if (tab) {
        await ensureContentScriptInjected(tab.id).catch(() => { });
        watcherStatus = await sendToTab(tab.id, { type: "STATUS" });
      }
      const stored = await chrome.storage.local.get(["autoPipEnabled", "autoPipArmed"]);
      sendResponse({ ...stored, watcherStatus });
    });
    return true;
  }
});
