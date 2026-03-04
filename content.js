/**
 * Quick PiP — content.js
 *
 * Watcher de Auto PiP injetado dinamicamente via chrome.scripting.
 * Monitora mutações no DOM, eventos de vídeo e navegação SPA para
 * re-ativar PiP automaticamente quando o usuário "armou" o modo automático.
 *
 * Comandos recebidos via chrome.runtime.onMessage:
 *   START_AUTO_PIP  — inicia monitoramento
 *   STOP_AUTO_PIP   — para monitoramento e limpa recursos
 *   STATUS          — retorna estado atual
 */

(function () {
    // ─── Evitar registro duplo ──────────────────────────────────────────────────
    if (window.__quickPipWatcherActive) return;
    window.__quickPipWatcherActive = true;

    // ─── Estado interno ─────────────────────────────────────────────────────────
    const state = {
        observing: false,
        lastAttempt: null,      // timestamp da última tentativa
        lastError: null,        // último erro capturado
        attemptsThisMinute: 0, // contador anti-loop
        cooldownUntil: 0,       // timestamp epoch; não tentar antes disso
        debounceTimer: null,
        observer: null,
    };

    const CONFIG = {
        DEBOUNCE_MS: 500,
        MAX_ATTEMPTS_PER_MINUTE: 6,
        COOLDOWN_MS: 8000,       // 8 s após erro
        MINUTE_MS: 60000,
        MINUTE_RESET_INTERVAL: null,
    };

    // ─── Heurística: melhor vídeo ───────────────────────────────────────────────
    function findBestVideo() {
        const allVideos = Array.from(document.querySelectorAll("video"));
        if (allVideos.length === 0) return null;

        const visibleVideos = allVideos.filter((v) => {
            const style = window.getComputedStyle(v);
            if (style.display === "none") return false;
            if (style.visibility === "hidden") return false;
            if (parseFloat(style.opacity) === 0) return false;
            const rect = v.getBoundingClientRect();
            return rect.width > 200 && rect.height > 200;
        });

        const candidates = visibleVideos.length > 0 ? visibleVideos : allVideos;
        if (candidates.length === 0) return null;

        return candidates.reduce((best, v) => {
            const rect = v.getBoundingClientRect();
            const area = rect.width * rect.height;
            const bestRect = best.getBoundingClientRect();
            const bestArea = bestRect.width * bestRect.height;
            return area > bestArea ? v : best;
        });
    }

    // ─── Lógica principal: garantir PiP ────────────────────────────────────────
    async function tryEnsurePiP() {
        // Parar se não está mais armado
        const { autoPipArmed } = await chrome.storage.local.get("autoPipArmed");
        if (!autoPipArmed) {
            stopWatcher();
            return;
        }

        // Já em PiP → nada a fazer
        if (document.pictureInPictureElement) return;

        // Cooldown após erro
        const now = Date.now();
        if (now < state.cooldownUntil) {
            state.lastError = `Em cooldown até ${new Date(state.cooldownUntil).toLocaleTimeString()}.`;
            return;
        }

        // Anti-loop: limite por minuto
        if (state.attemptsThisMinute >= CONFIG.MAX_ATTEMPTS_PER_MINUTE) {
            state.lastError = "Limite de tentativas por minuto atingido. Aguardando reset.";
            return;
        }

        const bestVideo = findBestVideo();
        if (!bestVideo) return;

        state.attemptsThisMinute++;
        state.lastAttempt = new Date().toISOString();

        // Remove bloqueio do atributo se presente
        if (bestVideo.disablePictureInPicture) {
            bestVideo.disablePictureInPicture = false;
            bestVideo.removeAttribute("disablepictureinpicture");
        }

        try {
            await bestVideo.requestPictureInPicture();
            state.lastError = null;
        } catch (err) {
            state.lastError = err.message;
            state.cooldownUntil = Date.now() + CONFIG.COOLDOWN_MS;
        }
    }

    // ─── Debounce ───────────────────────────────────────────────────────────────
    function scheduleCheck() {
        if (!state.observing) return;
        clearTimeout(state.debounceTimer);
        state.debounceTimer = setTimeout(tryEnsurePiP, CONFIG.DEBOUNCE_MS);
    }

    // ─── MutationObserver (DOM) ─────────────────────────────────────────────────
    function startMutationObserver() {
        state.observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                // Novo vídeo adicionado ou atributos de vídeo mudaram
                const hasVideoChange = [...(m.addedNodes || [])].some(
                    (n) => n.nodeName === "VIDEO" || (n.querySelectorAll && n.querySelectorAll("video").length > 0)
                );
                const isVideoAttr = m.target && m.target.nodeName === "VIDEO";
                if (hasVideoChange || isVideoAttr) {
                    scheduleCheck();
                    break;
                }
            }
        });

        state.observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["src", "currentSrc"],
        });
    }

    // ─── Hook de eventos no vídeo candidato ────────────────────────────────────
    let trackedVideo = null;
    const videoEventHandler = () => scheduleCheck();

    function trackBestVideo() {
        const v = findBestVideo();
        if (v && v !== trackedVideo) {
            if (trackedVideo) {
                ["loadedmetadata", "emptied", "ended", "play"].forEach((ev) =>
                    trackedVideo.removeEventListener(ev, videoEventHandler)
                );
            }
            trackedVideo = v;
            ["loadedmetadata", "emptied", "ended"].forEach((ev) =>
                v.addEventListener(ev, videoEventHandler)
            );
        }
    }

    // ─── Monitoramento de URL (SPA) ─────────────────────────────────────────────
    const originalPushState = history.pushState.bind(history);
    const originalReplaceState = history.replaceState.bind(history);
    let lastUrl = location.href;

    function onUrlChange() {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            scheduleCheck();
        }
    }

    function hookHistory() {
        history.pushState = function (...args) {
            originalPushState(...args);
            onUrlChange();
        };
        history.replaceState = function (...args) {
            originalReplaceState(...args);
            onUrlChange();
        };
        window.addEventListener("popstate", onUrlChange);
    }

    function unhookHistory() {
        history.pushState = originalPushState;
        history.replaceState = originalReplaceState;
        window.removeEventListener("popstate", onUrlChange);
    }

    // ─── Listener: quando PiP é encerrado externamente ─────────────────────────
    function onPiPLeave() {
        scheduleCheck();
    }

    // ─── Iniciar watcher ────────────────────────────────────────────────────────
    function startWatcher() {
        if (state.observing) return;
        state.observing = true;
        state.attemptsThisMinute = 0;
        state.cooldownUntil = 0;
        state.lastError = null;

        startMutationObserver();
        hookHistory();
        trackBestVideo();

        // Reset do contador por minuto
        CONFIG.MINUTE_RESET_INTERVAL = setInterval(() => {
            state.attemptsThisMinute = 0;
        }, CONFIG.MINUTE_MS);

        // Monitorar video tracking periodicamente (para SPAs que recria o vídeo)
        state.trackingInterval = setInterval(trackBestVideo, 2000);

        // Ouvir quando PiP é encerrado pelo navegador
        document.addEventListener("leavepictureinpicture", onPiPLeave);

        // Tentativa inicial imediata
        scheduleCheck();
    }

    // ─── Parar watcher ──────────────────────────────────────────────────────────
    function stopWatcher() {
        if (!state.observing) return;
        state.observing = false;

        clearTimeout(state.debounceTimer);
        clearInterval(CONFIG.MINUTE_RESET_INTERVAL);
        clearInterval(state.trackingInterval);

        if (state.observer) {
            state.observer.disconnect();
            state.observer = null;
        }

        if (trackedVideo) {
            ["loadedmetadata", "emptied", "ended"].forEach((ev) =>
                trackedVideo.removeEventListener(ev, videoEventHandler)
            );
            trackedVideo = null;
        }

        unhookHistory();
        document.removeEventListener("leavepictureinpicture", onPiPLeave);

        window.__quickPipWatcherActive = false;
    }

    // ─── Listener de mensagens ──────────────────────────────────────────────────
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg.type === "START_AUTO_PIP") {
            startWatcher();
            sendResponse({ ok: true, observing: state.observing });
        } else if (msg.type === "STOP_AUTO_PIP") {
            stopWatcher();
            sendResponse({ ok: true, observing: false });
        } else if (msg.type === "STATUS") {
            sendResponse({
                observing: state.observing,
                lastAttempt: state.lastAttempt,
                lastError: state.lastError,
                attemptsThisMinute: state.attemptsThisMinute,
                cooldownUntil: state.cooldownUntil,
            });
        }
        return true; // manter canal aberto para sendResponse assíncrono
    });
})();
