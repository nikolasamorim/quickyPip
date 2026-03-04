# Quick PiP — Chrome Extension (Manifest V3)

Extensão Chrome para ativar e desativar o modo **Picture-in-Picture (PiP)** no vídeo principal da aba atual. Inclui a funcionalidade **Auto PiP**, que monitora a página e re-ativa o PiP automaticamente após trocas de episódio, navegação SPA ou recriação do elemento de vídeo.

---

## Estrutura de arquivos

```
quickPip/
├── manifest.json       # Manifest V3 (v1.1.0)
├── background.js       # Service Worker — toggle PiP + gerência do Auto PiP
├── content.js          # Watcher do Auto PiP (injetado dinamicamente)
├── popup.html          # Interface do popup
├── popup.js            # Lógica do popup
├── popup.css           # Estilos do popup
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

---

## Como instalar (Load unpacked)

1. Abra o Chrome e acesse: `chrome://extensions/`
2. Ative o **Modo do desenvolvedor** (toggle no canto superior direito).
3. Clique em **"Carregar sem compactação" (Load unpacked)**.
4. Selecione a pasta `quickPip/` (a pasta raiz deste projeto).
5. A extensão aparecerá na lista com o ícone Quick PiP.

---

## Como usar

### Via ícone (popup)
1. Navegue até uma página com vídeo (YouTube, Twitch, etc.).
2. Clique no ícone da extensão na barra de ferramentas.
3. Clique no botão **"Ativar / Desativar PiP"**.
4. O vídeo principal visível entrará em modo Picture-in-Picture.
5. Clique novamente para desativar.

### Via atalho de teclado
- **`Alt+P`** — Alterna PiP no vídeo principal da aba ativa (funciona mesmo com o popup fechado).

> **Dica:** Você pode personalizar o atalho em `chrome://extensions/shortcuts`.

---

## O que é Auto PiP?

O **Auto PiP** é uma funcionalidade que — quando ativada — mantém o modo Picture-in-Picture ativo automaticamente, mesmo que o vídeo seja substituído.

### Como funciona

1. Ligue o toggle **"Auto PiP"** no popup.
2. Ative o PiP manualmente (botão ou `Alt+P`). O modo fica **Armado**.
3. A extensão injeta um watcher discreto na página que monitora:
   - **Mutações no DOM**: detecta quando um novo elemento `<video>` é adicionado ou o `src` muda (troca de episódio, novo player, etc.).
   - **Eventos do vídeo**: `loadedmetadata`, `emptied`, `ended` — que indicam mudança de mídia.
   - **Navegação SPA**: intercepta `history.pushState`, `replaceState` e o evento `popstate` para detectar mudanças de URL sem recarregamento de página.
   - **Saída do PiP**: se o navegador encerrar o PiP (ex.: troca de aba, clique no vídeo), a extensão tenta re-ativá-lo.

### Estado visível no popup

| Indicador | Significado |
|---|---|
| **● Armado** | O usuário ativou PiP manualmente; o watcher está pronto para agir |
| **○ Desarmado** | Auto PiP ligado, mas o usuário ainda não ativou PiP |
| **👁 Monitorando** | O watcher está ativo e observando a página |
| **◌ Inativo** | Watcher parado (Auto PiP desligado ou desarmado) |
| Última tentativa | Horário da última ativação automática |
| ⚠ Erro | Último erro capturado (ex.: player bloqueou PiP) |

### Proteções anti-loop

- **Máx. 6 tentativas por minuto** — evita spam.
- **Cooldown de 8 s após erro** — pausa antes de tentar novamente.
- **Debounce de 500 ms** — agrupa eventos rápidos em uma única tentativa.

### Como desligar o Auto PiP

- Basta desligar o toggle **"Auto PiP"** no popup. O watcher é removido imediatamente.
- Ou desativar o PiP manualmente (botão/atalho): isso "desarma" o modo automático.

---

## Comportamento e lógica

| Situação | Resultado |
|---|---|
| Vídeo visível encontrado, PiP inativo | Ativa PiP no maior vídeo visível |
| PiP já ativo | Desativa PiP |
| Nenhum vídeo na página | Mensagem: "Nenhum vídeo detectado na página." |
| Site bloqueou PiP (`disablePictureInPicture`) | Tenta remover o atributo; se falhar, reporta |
| PiP bloqueado pelo player (exceção JS) | Mensagem de erro com detalhe + cooldown |
| Página interna do Chrome (`chrome://`) | Mensagem explicativa |

---

## Limitações

- **Auto PiP pode não funcionar** em players que bloqueiam o PiP via DRM ou via rejeição da Promise de `requestPictureInPicture()`. Nesses casos, a extensão entra em cooldown e exibe o erro no popup.
- **Iframes cross-origin**: vídeos em iframes de origem cruzada não são acessíveis ao watcher.
- **Páginas internas do Chrome**: `chrome://`, `about:blank`, etc. não permitem injeção de scripts.
- **Serviços de streaming com DRM** (Netflix, Disney+): normalmente bloqueiam PiP, e o Auto PiP não consegue contornar esse bloqueio.

---

## Permissões utilizadas

| Permissão | Motivo |
|---|---|
| `activeTab` | Acessar a aba atual ao clicar no ícone |
| `scripting` | Injetar o script de toggle PiP e o watcher na página |
| `storage` | Persistir configurações (`autoPipEnabled`, `autoPipArmed`) |
| `tabs` | Enviar mensagens ao content script da aba ativa |

Nenhuma permissão de host genérica (`<all_urls>`) é utilizada.

---

## Desenvolvimento

Não há build necessário. Todos os arquivos são plain HTML/CSS/JS.

Para recarregar após mudanças:
1. Acesse `chrome://extensions/`
2. Clique no botão **↺ Recarregar** da extensão Quick PiP.
