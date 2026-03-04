/**
 * Quick PiP — background.js (Service Worker, Manifest V3)
 *
 * Responsável por:
 * - Escutar o atalho de teclado Alt+P (comando "toggle-pip")
 * - Executar a ação de toggle PiP na aba ativa via chrome.scripting
 */

/**
 * Função injetada na página para localizar e alternar PiP.
 * Retorna um objeto { ok, status, reason }.
 */
function pipToggleScript() {
  try {
    // Se já há um elemento em PiP, sair do modo PiP
    if (document.pictureInPictureElement) {
      return document.exitPictureInPicture().then(() => ({
        ok: true,
        status: "desativado",
        reason: "Picture-in-Picture desativado com sucesso.",
      })).catch((err) => ({
        ok: false,
        status: "erro",
        reason: "Erro ao sair do PiP: " + err.message,
      }));
    }

    // Coletar todos os vídeos da página
    const allVideos = Array.from(document.querySelectorAll("video"));

    if (allVideos.length === 0) {
      return Promise.resolve({
        ok: false,
        status: "nenhum",
        reason: "Nenhum vídeo detectado na página.",
      });
    }

    // Filtrar vídeos visíveis com tamanho mínimo
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
        ok: false,
        status: "nenhum",
        reason: "Nenhum vídeo visível encontrado na página.",
      });
    }

    // Escolher o maior vídeo pela área do bounding rect
    const bestVideo = candidates.reduce((best, v) => {
      const rect = v.getBoundingClientRect();
      const area = rect.width * rect.height;
      const bestRect = best.getBoundingClientRect();
      const bestArea = bestRect.width * bestRect.height;
      return area > bestArea ? v : best;
    });

    // Verificar suporte a PiP
    if (!document.pictureInPictureEnabled) {
      return Promise.resolve({
        ok: false,
        status: "bloqueado",
        reason:
          "PiP não está disponível neste navegador ou está desabilitado globalmente.",
      });
    }

    // Se o player bloqueou PiP via atributo, remove antes de ativar
    if (bestVideo.disablePictureInPicture) {
      bestVideo.disablePictureInPicture = false;
      bestVideo.removeAttribute("disablepictureinpicture");
    }

    // Solicitar PiP
    return bestVideo
      .requestPictureInPicture()
      .then(() => ({
        ok: true,
        status: "ativado",
        reason: "Picture-in-Picture ativado com sucesso.",
      }))
      .catch((err) => ({
        ok: false,
        status: "erro",
        reason:
          "PiP não está disponível neste player/página (pode estar bloqueado). Detalhe: " +
          err.message,
      }));
  } catch (err) {
    return Promise.resolve({
      ok: false,
      status: "erro",
      reason: "Erro inesperado: " + err.message,
    });
  }
}

/**
 * Executa o toggle PiP na aba ativa e retorna o resultado.
 * @returns {Promise<{ok: boolean, status: string, reason: string}>}
 */
async function togglePiPOnActiveTab() {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (err) {
    return { ok: false, status: "erro", reason: "Não foi possível acessar a aba ativa." };
  }

  if (!tabs || tabs.length === 0) {
    return { ok: false, status: "erro", reason: "Nenhuma aba ativa encontrada." };
  }

  const tab = tabs[0];

  // Páginas internas do Chrome (chrome://, about:, etc.) não suportam scripting
  if (!tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("about:") || tab.url.startsWith("chrome-extension://")) {
    return {
      ok: false,
      status: "erro",
      reason: "Não é possível usar PiP em páginas internas do navegador.",
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
      ok: false,
      status: "erro",
      reason: "Não foi possível injetar o script na página. Detalhe: " + err.message,
    };
  }

  if (!results || results.length === 0 || results[0].result === undefined) {
    return { ok: false, status: "erro", reason: "Sem resposta do script injetado." };
  }

  return results[0].result;
}

// ─── Comando de teclado Alt+P ─────────────────────────────────────────────────
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-pip") return;
  await togglePiPOnActiveTab();
  // O resultado do atalho de teclado não é surfaceado em lugar nenhum
  // (o popup pode estar fechado). Silencia silenciosamente em caso de sucesso.
});
