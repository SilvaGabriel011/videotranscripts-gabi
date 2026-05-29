# Frontend web do YouTube Transcript Extractor — Design (Fase 1)

**Data:** 2026-05-29

## Contexto

O extractor hoje é um CLI Node (`scripts/youtube-transcript.ts`) que recebe URLs do YouTube,
processa em fila e gera `Titulo.txt` (texto corrido) + `Titulo.srt` (legenda sincronizada) por
vídeo. O usuário quer um **front-end simples**: colar uma ou mais URLs, confirmar, ver o **status
de cada URL** numa fila sequencial, e receber um **ZIP** com os arquivos nomeados pelo título do
vídeo.

O destino futuro é hospedar na Vercel. Vercel é serverless: o caminho de **legendas do YouTube**
(só HTTP) roda bem, mas o **fallback Whisper** usa `yt-dlp`/`ffmpeg` (binários de sistema) +
filesystem e **não roda em serverless**. Por isso o trabalho é fatiado:

- **Fase 1 (este spec):** app Next.js completo. Roda local 100% (incluindo Whisper, pois o Next
  local invoca `yt-dlp`/`ffmpeg` como o CLI) e já deploya na Vercel funcionando para vídeos com
  legenda. Vídeo sem legenda na Vercel falha com mensagem clara.
- **Fase 2 (spec futuro):** subsistema worker (fila + container com `yt-dlp`/`ffmpeg` + storage)
  para Whisper hospedado. Fora de escopo aqui.

**Resultado pretendido:** página local (`npm run web`) onde o usuário cola URLs, acompanha a fila
num modal e baixa um ZIP — sem nada gravado no servidor.

## Arquitetura

Next.js (App Router, TypeScript) no mesmo repositório. Núcleo de extração compartilhado entre CLI
e web para não duplicar lógica.

### Módulos compartilhados (`lib/`)

- **`lib/transcript-utils.ts`** — utils puros, **movidos** de `scripts/transcript-utils.ts`:
  `extractVideoId`, `decodeHtmlEntities`, `formatTimestamp`, `formatSrtTimestamp`,
  `sanitizeFilename`, `buildPlainText`, `buildTimestampedText`, `buildSrt`, `type Segment`.
  Sem mudança de comportamento — só localização. Imports do CLI e dos testes passam a apontar
  para `../lib/transcript-utils`.

- **`lib/extractor.ts`** — lógica de extração extraída do CLI (hoje inline em
  `scripts/youtube-transcript.ts`): `getVideoTitle` (oEmbed), `fetchYoutubeCaptions`,
  `whisperFallback` (e helpers `hasCommand`/`downloadAudio`/`splitIfNeeded`/`transcribeChunks`).
  API pública:
  ```ts
  type TranscriptSource = 'YouTube Captions' | 'OpenAI Whisper'
  type ExtractResult = { videoId: string; title: string | null; source: TranscriptSource; segments: Segment[] }
  async function extractTranscript(url: string, opts?: { lang?: string }): Promise<ExtractResult>
  ```
  Lança `Error` com mensagem clara quando não há legenda e o Whisper está indisponível (chave/
  binários ausentes) — comportamento já existente, só centralizado. Os checks de `yt-dlp`/`ffmpeg`
  falham naturalmente na Vercel, produzindo a mensagem de host sem Whisper.

### CLI (`scripts/youtube-transcript.ts`)

Vira casca fina: importa `extractTranscript` de `lib/extractor` e os builders de
`lib/transcript-utils`; mantém o fluxo de fila, a escrita de `Titulo.txt`/`Titulo.srt` via
`resolveOutputStem`/`writeOutputs` e o resumo. Sem mudança de comportamento observável.

### API route (`app/api/transcript/route.ts`)

- `export const runtime = 'nodejs'` (precisa de `child_process`/rede; não pode ser Edge).
- **POST** `{ url: string, lang?: string }` → **uma URL por request** (curto, cabe no timeout
  serverless; status por URL fica natural no cliente).
- Sucesso: `{ ok: true, title, base, txt, srt, source }`, onde `base = sanitizeFilename(title) || videoId`,
  `txt = buildPlainText(segments)`, `srt = buildSrt(segments)`.
- Falha: `{ ok: false, error }` com mensagem amigável.

### Frontend (`app/page.tsx`, client component)

Máquina de estados: `idle → confirming → running → done`. Monta o ZIP no navegador com **JSZip**;
nada é persistido no servidor.

## Fluxo (UX)

1. **idle:** textarea ("uma URL por linha") + botão **Baixar transcripts**.
2. Clique → parse das linhas em URLs (ignora linhas vazias) → estado `confirming`.
3. **Modal de confirmação:** "Vou processar N vídeos" + **Confirmar** / **Cancelar**.
4. **Confirmar** → estado `running`: o mesmo modal vira **painel de status**, uma linha por URL,
   processadas **em fila sequencial** (um `fetch` POST por vez):
   - estados por linha: `Na fila` → `Processando…` → `✓ {título} ({fonte})` | `✗ {motivo}`.
   - contador `x/N` e barra de progresso simples.
5. **done:** ao terminar a fila, monta `transcripts.zip` com `base.txt` + `base.srt` de cada
   sucesso e **dispara o download automaticamente**. Falhas ficam listadas no modal, fora do ZIP.
   Colisão de `base` repetido → sufixo ` (2)`, ` (3)`... aplicado no cliente.

## Tratamento de erros

- URL inválida ou vídeo sem legenda (e sem Whisper) → linha marcada `✗` com o motivo; a fila
  **continua** nas demais (igual ao CLI).
- Erro de rede no `fetch` da rota → `✗ {motivo}` na linha, fila continua.
- Fila inteira falha → ZIP não baixa; modal mostra as falhas. Botão "Fechar".
- Textarea vazia → botão desabilitado (sem modal).

## Dependências & scripts

- **Adicionar:** `next`, `react`, `react-dom`, `@types/react`, `@types/react-dom`, `jszip`.
- **CSS mínimo** (CSS Module ou global enxuto; sem Tailwind, pra manter simples).
- **`package.json` scripts:** `"web": "next dev"`, `"build": "next build"`, `"start": "next start"`.
  Mantém `transcript:youtube` (CLI), `test`, `test:watch`.
- **tsconfig:** ajustar para Next (`"jsx": "preserve"`, plugin `next`, incluir `app/`/`lib/`),
  preservando a compilação de `scripts/` e `test/`.
- `.gitignore`: adicionar `.next/`.

## Forward-compatibilidade (Fase 2)

O modelo "1 job por URL + painel de status" é o mesmo de um worker assíncrono: na Fase 2 o front
troca o `fetch` síncrono por polling de um job, sem reescrever UI nem montagem de ZIP.
`lib/extractor.ts` é reusado pelo worker. Nenhuma decisão da Fase 1 precisa ser desfeita.

## Verificação

1. **Unit:** os 42 testes puros seguem verdes após o move de import (`test/` → `../lib/transcript-utils`).
   `npx vitest run`.
2. **Type-check:** `npx tsc --noEmit` limpo (CLI + lib + app).
3. **Rota:** POST com a URL real `https://www.youtube.com/watch?v=7nN4ayK79oc` → JSON com
   `txt`, `srt` não vazios, `title`, `source: 'YouTube Captions'`.
4. **CLI não regrediu:** rodar `npx tsx scripts/youtube-transcript.ts "<url>"` e confirmar que
   ainda gera `.txt` + `.srt` idênticos ao atual.
5. **E2E web (local):** `npm run web` → colar 1-2 URLs → Confirmar → acompanhar status →
   `transcripts.zip` baixa com `Titulo.txt` + `Titulo.srt` por vídeo. Dirigir o navegador via
   Playwright MCP para automatizar a confirmação.

## Fora de escopo

- Worker/fila/container/storage para Whisper hospedado (Fase 2).
- Autenticação, rate limit, multiusuário.
- Seleção de idioma na UI: a interface da Fase 1 **não expõe** campo de idioma (legendas
  auto-detectadas). A rota mantém um parâmetro `lang` opcional apenas por paridade com o CLI e uso
  futuro; o front não o envia.
- Persistência de histórico de jobs.
