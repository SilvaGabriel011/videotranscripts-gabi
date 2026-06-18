# YouTube Transcript Extractor

Extrai a transcrição de vídeos do YouTube e gera `.txt` (texto corrido) + `.srt` (legenda
com tempos). Opcionalmente gera **capítulos por tema** (via OpenAI) e um relatório de **custo**.
Tem duas formas de usar: um **app web** (cola URLs, baixa um ZIP) e uma **CLI**.

---

## O que cada recurso precisa

| Recurso | Precisa de quê |
|---|---|
| Baixar legenda de vídeo **com legenda** | **Nada** — só Node. Funciona offline de API. |
| Capítulos por tema (`--topics`) | Sua **própria** chave OpenAI no `.env` |
| Vídeo **sem legenda** (fallback Whisper) | Chave OpenAI + `yt-dlp` + `ffmpeg` |

> Os scripts de setup instalam `yt-dlp` e `ffmpeg` para você. A chave OpenAI é **sua** —
> veja a seção de Segurança abaixo.

---

## Como rodar — Mac

1. **Duplo-clique em `start.command`.**
   - Na 1ª vez ele instala tudo (Node via Homebrew se faltar, dependências, `yt-dlp`, `ffmpeg`)
     e cria o `.env`.
   - Depois sobe o servidor e abre o navegador em http://localhost:3000.
2. Se quiser os recursos de IA, abra o arquivo `.env` e preencha `OPENAI_API_KEY=sk-...`
   (a sua chave). Salve e rode de novo.

**Se o duplo-clique não funcionar** (a pasta veio de um zip feito no Windows, que apaga a
permissão de execução), abra o Terminal **uma vez** na pasta do projeto e rode:
```bash
chmod +x setup.sh start.command
xattr -dr com.apple.quarantine .
```
Depois disso o duplo-clique funciona normalmente.

**Se o macOS bloquear** ("não foi possível verificar o desenvolvedor"):
clique com o **botão direito** em `start.command` → **Abrir** → **Abrir**.

**Alternativa manual (Terminal):**
```bash
chmod +x setup.sh start.command   # só na 1ª vez
./setup.sh                         # instala dependências + cria .env
npm run web                        # http://localhost:3000
```

---

## Como rodar — Windows

1. **Duplo-clique em `start.cmd`** (instala na 1ª vez, sobe o app e abre o navegador).

**Alternativa manual (PowerShell):**
```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1
npm run web
```

---

## Linha de comando (Mac e Windows)

```bash
npx tsx scripts/youtube-transcript.ts "https://www.youtube.com/watch?v=ID"
npx tsx scripts/youtube-transcript.ts --lang pt --topics "https://youtu.be/ID1" "https://youtu.be/ID2"
```
- `--lang pt` — idioma preferido da legenda.
- `--topics` — também gera `<título>.chapters.txt` (capítulos) e `<título>.cost.txt` (custo). Requer `OPENAI_API_KEY`.

A saída da CLI vai para `output/<título-do-vídeo>/` (uma pasta por vídeo).

---

## Deploy na Vercel

O app web é Next.js, então a Vercel hospeda com configuração zero.

1. Suba o repositório no GitHub e, em **vercel.com → Add New → Project**, importe-o.
   A Vercel detecta o Next.js automaticamente (não precisa configurar build).
2. Em **Settings → Environment Variables**, adicione (para os recursos de IA):
   - `OPENAI_API_KEY` — sua chave (necessária para `--topics` e para o fallback Whisper).
   - opcional: `OPENAI_TRANSCRIBE_MODEL`, `OPENAI_TOPICS_MODEL`.
   - opcional: `YOUTUBE_COOKIE` — veja abaixo.
3. Deploy.

**O que funciona no serverless:**
- Extração de legendas (a maioria dos vídeos) — sem dependências externas.
- Capítulos por tema + custo (`--topics`) — só usa a API da OpenAI.
- Fallback Whisper (vídeos **sem** legenda) — funciona via `@distube/ytdl-core` (JS puro),
  sem precisar de `yt-dlp`/`ffmpeg`. **Localmente**, se você tiver `yt-dlp` + `ffmpeg`
  instalados, o app usa esse caminho (suporta vídeos longos com chunking).

**Limitações na Vercel:**
- **Bloqueio de IP (afeta TUDO):** o YouTube costuma barrar IPs de data center ("confirme
  que você não é um robô"). Isso atinge tanto o fallback Whisper quanto a própria extração
  de legenda (a lib `youtube-transcript` faz scraping e **não** aceita cookie). Em produção,
  espere que parte dos vídeos falhe; rodar localmente é mais confiável.
- **Cookie do Whisper:** se o download de áudio falhar por bot-check, defina `YOUTUBE_COOKIE`
  (array JSON de cookies exportado por uma extensão do navegador) para autenticar o ytdl-core.
  ⚠️ O cookie dá acesso à conta Google — trate como senha, use conta descartável e configure-o
  **só** no painel de variáveis da Vercel (nunca faça commit).
- **Vídeos longos:** sem `ffmpeg` para dividir o áudio, vídeos cujo áudio passe de ~25MB
  (≈ 30–45 min) excedem o limite do Whisper e retornam erro. Para esses, use a CLI local.
- **Timeout:** a transcrição pode demorar. A rota usa `maxDuration = 60` (funciona em
  todos os planos; valores acima do limite do plano **fazem o deploy falhar**). Extração
  de legenda é rápida. No **Pro/Enterprise** você pode subir para até 300 para vídeos longos.
- O backup em `output/` não funciona (filesystem read-only), mas isso é best-effort e
  **não** atrapalha o download — o ZIP é gerado normalmente.

## Segurança — leia antes de compartilhar a pasta

- **Cada pessoa usa a PRÓPRIA chave OpenAI.** Não compartilhe a sua.
- O arquivo `.env` contém sua chave. **NÃO** envie o `.env` para ninguém.
- Antes de zipar a pasta para mandar, **exclua** `node_modules/`, `.next/`, `output/`,
  `.env`, `*.mp3` e `.git/` (o setup recria tudo na outra máquina).

**Gerar o zip para enviar:**

Mac/Linux:
```bash
zip -r yt-transcript.zip . \
  -x "node_modules/*" ".next/*" "output/*" ".git/*" ".env" "*.mp3"
```

Windows (PowerShell):
```powershell
$ex = 'node_modules','.next','output','.git'
Get-ChildItem -Force | Where-Object { $_.Name -notin $ex -and $_.Name -ne '.env' } |
  Compress-Archive -DestinationPath yt-transcript.zip -Force
```

---

## Requisitos

- **Node 20.12+** (a app usa `process.loadEnvFile()`). O setup instala via Homebrew no Mac
  se faltar; no Windows, baixe em https://nodejs.org.
- Para IA: `yt-dlp` + `ffmpeg` (instalados pelo setup) e uma chave OpenAI.
