# Quick PiP — Chrome Extension (Manifest V3)

Extensão Chrome simples para ativar e desativar o modo **Picture-in-Picture (PiP)** no vídeo principal da aba atual, sem tentar contornar bloqueios de sites.

---

## Estrutura de arquivos

```
quickPip/
├── manifest.json       # Manifest V3
├── background.js       # Service Worker (atalho de teclado)
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

## Comportamento e lógica

| Situação | Resultado |
|---|---|
| Vídeo visível encontrado, PiP inativo | Ativa PiP no maior vídeo visível |
| PiP já ativo | Desativa PiP |
| Nenhum vídeo na página | Mensagem: "Nenhum vídeo detectado na página." |
| Site bloqueou PiP (`disablePictureInPicture`) | Mensagem de aviso amigável |
| PiP bloqueado pelo player (exceção JS) | Mensagem de erro com detalhe |
| Página interna do Chrome (`chrome://`) | Mensagem explicativa |

---

## Limitações

- **Bloqueios do site/DRM**: Alguns sites (ex.: Netflix, Disney+) desabilitam PiP via atributo `disablePictureInPicture` ou através de DRM. A extensão **não tenta contornar** esses bloqueios — ela apenas reporta que PiP não está disponível.
- **Páginas internas do Chrome**: `chrome://`, `about:blank`, etc. não permitem injeção de scripts.
- **Iframes**: Vídeos carregados em iframes de origem cruzada podem não ser acessíveis.

---

## Permissões utilizadas

| Permissão | Motivo |
|---|---|
| `activeTab` | Acessar a aba atual ao clicar no ícone |
| `scripting` | Injetar o script de toggle PiP na página |

Nenhuma permissão de host genérica (`<all_urls>`) é utilizada.

---

## Desenvolvimento

Não há build necessário. Todos os arquivos são plain HTML/CSS/JS.

Para recarregar após mudanças:
1. Acesse `chrome://extensions/`
2. Clique no botão **↺ Recarregar** da extensão Quick PiP.
