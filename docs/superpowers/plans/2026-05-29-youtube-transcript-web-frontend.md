# YouTube Transcript Web Frontend (Fase 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir um front-end Next.js (Vercel-ready) que recebe várias URLs do YouTube, processa em fila com modal de status por URL, e baixa um ZIP com `Titulo.txt` + `Titulo.srt` por vídeo — montado no navegador.

**Architecture:** Núcleo de extração compartilhado em `lib/` (utils puros + `extractTranscript`), usado tanto pelo CLI quanto por uma rota Next `POST /api/transcript` (uma URL por request, runtime Node). O front (client component) chama a rota em fila sequencial, acumula os arquivos e monta o ZIP com JSZip. Whisper roda local; na Vercel degrada com erro claro.

**Tech Stack:** TypeScript, Next.js (App Router), React, JSZip, Vitest, tsx; libs existentes `youtube-transcript` + `openai`.

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `lib/transcript-utils.ts` | **Movido** de `scripts/`. Utils puros (parsing, sanitize, builders txt/srt). |
| `lib/extractor.ts` | **Novo.** `extractTranscript(url, {lang})`: título + legendas + fallback Whisper. Extraído do CLI. |
| `scripts/youtube-transcript.ts` | **Modificado.** Casca fina do CLI: usa `lib/extractor` + escreve arquivos. |
| `test/transcript-utils.test.ts` | **Modificado.** Só o caminho do import muda. |
| `test/api-transcript.test.ts` | **Novo.** Testa a rota (caminhos de erro determinísticos). |
| `app/layout.tsx` | **Novo.** Root layout Next. |
| `app/globals.css` | **Novo.** CSS mínimo. |
| `app/page.tsx` | **Novo.** Front: fila, modais, ZIP. |
| `app/api/transcript/route.ts` | **Novo.** `POST` uma URL → `{ ok, title, base, txt, srt, source }`. |
| `next.config.mjs`, `tsconfig.json`, `package.json`, `.gitignore` | **Config.** |

---

## Task 1: Inicializar git + baseline

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Ignorar artefatos de build e saídas**

Editar `.gitignore` para o conteúdo completo:

```
node_modules/
.next/
*.txt
*.srt
.env
*.mp3
```

- [ ] **Step 2: Inicializar o repositório e commitar o estado atual**

Run:
```bash
cd "D:/youtube transcripts" && git init && git add -A && git commit -m "chore: baseline — CLI transcript extractor (txt+srt)"
```
Expected: cria `.git/`, commit inicial. `git status` limpo (sem `node_modules/`, `*.txt`, `*.srt`).

- [ ] **Step 3: Confirmar que os outputs não foram commitados**

Run: `git ls-files | grep -E "\.(txt|srt)$" || echo "ok: nenhum txt/srt rastreado"`
Expected: `ok: nenhum txt/srt rastreado`

---

## Task 2: Mover utils para `lib/` e atualizar imports

> NOTA: o projeto ganhou uma feature de capítulos (`scripts/topic-segmenter.ts` +
> `buildChaptersText`/`normalizeChapters`/`formatChapterTimestamp`/`Topic` em
> transcript-utils + flag `--topics` no CLI). **Preservar tudo isso.** O `git mv`
> move o arquivo inteiro (mantém as funções de capítulo); só precisamos consertar
> o import do `topic-segmenter.ts` também.

**Files:**
- Create: `lib/transcript-utils.ts` (conteúdo movido de `scripts/transcript-utils.ts`)
- Modify: `scripts/youtube-transcript.ts` (import path)
- Modify: `scripts/topic-segmenter.ts` (import path)
- Modify: `test/transcript-utils.test.ts` (import path)

- [ ] **Step 1: Mover o arquivo preservando histórico**

Run:
```bash
cd "D:/youtube transcripts" && mkdir -p lib && git mv scripts/transcript-utils.ts lib/transcript-utils.ts
```
Expected: `lib/transcript-utils.ts` existe; `scripts/transcript-utils.ts` some.

- [ ] **Step 2: Atualizar o import no teste**

Em `test/transcript-utils.test.ts`, trocar `from '../scripts/transcript-utils'` por
`from '../lib/transcript-utils'` (manter todos os nomes importados, inclusive os de capítulo).

- [ ] **Step 3: Atualizar o import no CLI**

Em `scripts/youtube-transcript.ts`, na linha de import dos utils, trocar
`from './transcript-utils.ts'` por `from '../lib/transcript-utils'` (manter os nomes, inclusive
`buildChaptersText`). O import `from './topic-segmenter.ts'` NÃO muda.

- [ ] **Step 4: Atualizar o import no topic-segmenter**

Em `scripts/topic-segmenter.ts`, trocar `from './transcript-utils.ts'` por
`from '../lib/transcript-utils'`.

- [ ] **Step 5: Rodar os testes — devem continuar verdes**

Run: `npx vitest run`
Expected: PASS, **53 testes** (nada quebra; só mudou a localização).

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: 0 erros.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "refactor: mover transcript-utils para lib/"
```

---

## Task 3: Extrair `lib/extractor.ts` e enxugar o CLI

> **NOTA — PRESERVAR CAPÍTULOS.** O `youtube-transcript.ts` atual tem a feature
> `--topics` (gera `<Título>.chapters.txt` via `segmentTopics` + `buildChaptersText`).
> Esta task é um **refactor cirúrgico**, NÃO um rewrite que apague capítulos:
> mover só os helpers de extração para `lib/extractor.ts` e fazer o `processOne`
> chamar `extractTranscript`. O bloco de capítulos, `parseArgs` com `topics`,
> `printUsage`, `resolveOutputStem`, `writeOutputs` e o type `ProcessResult`
> **permanecem**. O esqueleto no Step 2 abaixo omite os capítulos por brevidade —
> use o `processOne`/imports corrigidos do Step 2b como autoridade.

**Files:**
- Create: `lib/extractor.ts`
- Modify: `scripts/youtube-transcript.ts` (remove só os helpers de extração; `processOne` usa `extractTranscript`; mantém capítulos)

- [ ] **Step 1: Criar `lib/extractor.ts`**

Mover do CLI os helpers de ambiente, metadados e extração. Conteúdo completo:

```ts
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { spawnSync } from 'node:child_process'
import { extractVideoId, decodeHtmlEntities, type Segment } from './transcript-utils'

const WHISPER_SIZE_LIMIT = 24 * 1024 * 1024 // 24MB (limite real da API: 25MB)
const CHUNK_SECONDS = 600 // 10 min por pedaço no chunking

export type TranscriptSource = 'YouTube Captions' | 'OpenAI Whisper'
export type ExtractResult = {
  videoId: string
  title: string | null
  source: TranscriptSource
  segments: Segment[]
}

/** Carrega .env (se existir) sem quebrar caso o arquivo não esteja presente. */
function loadEnv(): void {
  try {
    process.loadEnvFile(path.resolve(process.cwd(), '.env'))
  } catch {
    // sem .env — as variáveis podem vir do ambiente externo
  }
}

/** Verifica se um comando externo existe rodando `<cmd> <versionFlag>`. */
function hasCommand(cmd: string, versionFlag = '--version'): boolean {
  const res = spawnSync(cmd, [versionFlag], { stdio: 'ignore', shell: process.platform === 'win32' })
  return res.status === 0
}

/** Busca o título do vídeo via oEmbed (sem API key). Retorna null em falha. */
async function getVideoTitle(videoId: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://youtu.be/${videoId}&format=json`,
    )
    if (!res.ok) return null
    const data = (await res.json()) as { title?: string }
    return data.title ?? null
  } catch {
    return null
  }
}

/** Busca legendas via `youtube-transcript` (offset/duration em ms). Lança erro se não houver. */
async function fetchYoutubeCaptions(videoId: string, lang?: string): Promise<Segment[]> {
  const { YoutubeTranscript } = await import('youtube-transcript')
  const raw = await YoutubeTranscript.fetchTranscript(videoId, lang ? { lang } : undefined)
  if (!raw || raw.length === 0) {
    throw new Error('Nenhuma legenda retornada')
  }
  return raw.map((r) => ({
    text: decodeHtmlEntities(String(r.text).trim()),
    offset: Math.round(Number(r.offset)),
    duration: Math.round(Number(r.duration)),
  }))
}

/** Baixa o áudio do vídeo como mp3 em tmpDir e retorna o caminho do arquivo. */
function downloadAudio(url: string, videoId: string, tmpDir: string): string {
  const outTemplate = path.join(tmpDir, `${videoId}.%(ext)s`)
  const res = spawnSync(
    'yt-dlp',
    ['-x', '--audio-format', 'mp3', '--audio-quality', '9', '-o', outTemplate, url],
    { stdio: 'inherit', shell: process.platform === 'win32' },
  )
  if (res.status !== 0) {
    throw new Error('yt-dlp falhou ao baixar o áudio')
  }
  const audioPath = path.join(tmpDir, `${videoId}.mp3`)
  if (!fs.existsSync(audioPath)) {
    throw new Error('Áudio baixado não encontrado (esperado .mp3)')
  }
  return audioPath
}

/** Divide o áudio em pedaços de CHUNK_SECONDS se exceder o limite. Retorna os caminhos. */
function splitIfNeeded(audioPath: string, videoId: string, tmpDir: string): string[] {
  const size = fs.statSync(audioPath).size
  if (size <= WHISPER_SIZE_LIMIT) return [audioPath]

  console.log(
    `   Áudio com ${(size / 1024 / 1024).toFixed(1)}MB > 24MB — dividindo em pedaços de ${CHUNK_SECONDS / 60}min...`,
  )
  const pattern = path.join(tmpDir, `${videoId}-chunk-%03d.mp3`)
  const res = spawnSync(
    'ffmpeg',
    ['-i', audioPath, '-f', 'segment', '-segment_time', String(CHUNK_SECONDS), '-c', 'copy', pattern],
    { stdio: 'inherit', shell: process.platform === 'win32' },
  )
  if (res.status !== 0) {
    throw new Error('ffmpeg falhou ao dividir o áudio')
  }
  const chunks = fs
    .readdirSync(tmpDir)
    .filter((f) => f.startsWith(`${videoId}-chunk-`) && f.endsWith('.mp3'))
    .sort()
    .map((f) => path.join(tmpDir, f))
  if (chunks.length === 0) throw new Error('Nenhum pedaço gerado pelo ffmpeg')
  return chunks
}

/** Transcreve os pedaços via Whisper, deslocando os timestamps para uma timeline contínua. */
async function transcribeChunks(chunkPaths: string[], lang: string | undefined): Promise<Segment[]> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY não definida. Crie um arquivo .env (veja .env.example) ou exporte a variável.',
    )
  }
  const { default: OpenAI } = await import('openai')
  const client = new OpenAI({ apiKey })
  const model = process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1'

  const segments: Segment[] = []
  for (let i = 0; i < chunkPaths.length; i++) {
    const chunkPath = chunkPaths[i]
    const baseOffsetMs = i * CHUNK_SECONDS * 1000
    console.log(`   Transcrevendo pedaço ${i + 1}/${chunkPaths.length} via ${model}...`)

    const resp = await client.audio.transcriptions.create({
      file: fs.createReadStream(chunkPath),
      model,
      response_format: 'verbose_json',
      language: lang,
    })

    const verbose = resp as unknown as {
      text?: string
      segments?: Array<{ start: number; end: number; text: string }>
    }
    if (verbose.segments && verbose.segments.length > 0) {
      for (const s of verbose.segments) {
        segments.push({
          text: s.text.trim(),
          offset: baseOffsetMs + Math.round(s.start * 1000),
          duration: Math.round((s.end - s.start) * 1000),
        })
      }
    } else if (verbose.text) {
      segments.push({ text: verbose.text.trim(), offset: baseOffsetMs, duration: 0 })
    }
  }
  return segments
}

/** Orquestra o fallback completo: checagens → download → chunk → transcrição → limpeza. */
async function whisperFallback(url: string, videoId: string, lang?: string): Promise<Segment[]> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      'Vídeo sem legenda e OPENAI_API_KEY não definida. Configure a chave (.env) para usar o Whisper.',
    )
  }
  if (!hasCommand('yt-dlp')) {
    throw new Error('yt-dlp não encontrado no PATH. Instale com: pip install yt-dlp')
  }
  if (!hasCommand('ffmpeg', '-version')) {
    throw new Error('ffmpeg não encontrado no PATH. Instale o ffmpeg e tente novamente.')
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-transcript-'))
  try {
    console.log('   Sem legenda — baixando áudio para transcrever via Whisper...')
    const audioPath = downloadAudio(url, videoId, tmpDir)
    const chunks = splitIfNeeded(audioPath, videoId, tmpDir)
    console.log(`   Custo estimado do Whisper: ~US$0,006/min de áudio.`)
    return await transcribeChunks(chunks, lang)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

/**
 * Extrai o transcript de uma URL: tenta legendas do YouTube; se não houver, cai pro Whisper.
 * Lança Error com mensagem clara em qualquer falha. Não escreve arquivos (responsabilidade do chamador).
 */
export async function extractTranscript(
  url: string,
  opts: { lang?: string } = {},
): Promise<ExtractResult> {
  loadEnv()
  const videoId = extractVideoId(url)
  if (!videoId) {
    throw new Error('URL inválida (não foi possível extrair o video ID)')
  }
  const title = await getVideoTitle(videoId)

  let segments: Segment[]
  let source: TranscriptSource
  try {
    segments = await fetchYoutubeCaptions(videoId, opts.lang)
    source = 'YouTube Captions'
  } catch (captionErr) {
    try {
      segments = await whisperFallback(url, videoId, opts.lang)
      source = 'OpenAI Whisper'
    } catch (whisperErr) {
      const c = captionErr instanceof Error ? captionErr.message : String(captionErr)
      const w = whisperErr instanceof Error ? whisperErr.message : String(whisperErr)
      throw new Error(`legenda: ${c} | whisper: ${w}`)
    }
  }
  if (segments.length === 0) {
    throw new Error('Transcrição vazia')
  }
  return { videoId, title, source, segments }
}
```

- [ ] **Step 2: Reescrever `scripts/youtube-transcript.ts` como casca fina**

Conteúdo completo do arquivo:

```ts
/**
 * YouTube Transcript Extractor (CLI)
 *
 * Recebe uma ou mais URLs e gera Titulo.txt (texto corrido) + Titulo.srt (legenda)
 * por vídeo. A extração mora em lib/extractor; aqui fica só a fila e a escrita.
 *
 * Uso:
 *   npx tsx scripts/youtube-transcript.ts "https://youtu.be/ID1" "https://youtu.be/ID2"
 *   npx tsx scripts/youtube-transcript.ts --lang pt "https://youtu.be/ID"
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { buildPlainText, buildSrt, sanitizeFilename, type Segment } from '../lib/transcript-utils'
import { extractTranscript } from '../lib/extractor'

type ProcessResult =
  | { url: string; status: 'ok'; file: string; source: string }
  | { url: string; status: 'erro'; reason: string }

/**
 * Resolve um nome-base único (sem extensão) onde nem `.txt` nem `.srt` existam,
 * anexando " (2)", " (3)"... se preciso — assim os dois arquivos compartilham o nome.
 */
function resolveOutputStem(dir: string, baseName: string): string {
  const safeBase = baseName || 'transcript'
  const free = (stem: string) =>
    !fs.existsSync(path.join(dir, `${stem}.txt`)) && !fs.existsSync(path.join(dir, `${stem}.srt`))
  if (free(safeBase)) return path.join(dir, safeBase)
  let n = 2
  while (!free(`${safeBase} (${n})`)) n++
  return path.join(dir, `${safeBase} (${n})`)
}

/** Escreve <stem>.txt (corrido) e <stem>.srt (legenda). Retorna os nomes gerados. */
function writeOutputs(stem: string, segments: Segment[]): { txt: string; srt: string } {
  const txtPath = `${stem}.txt`
  const srtPath = `${stem}.srt`
  fs.writeFileSync(txtPath, buildPlainText(segments) + '\n', 'utf-8')
  fs.writeFileSync(srtPath, buildSrt(segments) + '\n', 'utf-8')
  return { txt: path.basename(txtPath), srt: path.basename(srtPath) }
}

async function processOne(url: string, lang: string | undefined): Promise<ProcessResult> {
  let result
  try {
    result = await extractTranscript(url, { lang })
  } catch (err) {
    return { url, status: 'erro', reason: err instanceof Error ? err.message : String(err) }
  }

  const base = result.title ? sanitizeFilename(result.title) : ''
  const stem = resolveOutputStem(process.cwd(), base || result.videoId)
  const out = writeOutputs(stem, result.segments)

  const preview = buildPlainText(result.segments).slice(0, 200)
  console.log(
    `   ✓ ${out.txt} + ${out.srt} (${result.segments.length} segmentos, fonte: ${result.source})`,
  )
  console.log(`     "${preview}${preview.length >= 200 ? '...' : ''}"`)
  return { url, status: 'ok', file: `${out.txt} + ${out.srt}`, source: result.source }
}

function parseArgs(argv: string[]): { lang?: string; urls: string[] } {
  let lang: string | undefined
  const urls: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--lang') {
      lang = argv[++i]
    } else if (arg.startsWith('--lang=')) {
      lang = arg.slice('--lang='.length)
    } else if (arg.startsWith('--')) {
      console.warn(`Flag desconhecida ignorada: ${arg}`)
    } else {
      urls.push(arg)
    }
  }
  return { lang, urls }
}

function printUsage(): void {
  console.log(
    [
      'Uso: tsx scripts/youtube-transcript.ts [--lang <código>] <url> [url2 ...]',
      '',
      'Exemplos:',
      '  tsx scripts/youtube-transcript.ts "https://youtu.be/dQw4w9WgXcQ"',
      '  tsx scripts/youtube-transcript.ts --lang pt "https://youtu.be/ID1" "https://youtu.be/ID2"',
      '',
      'O fallback Whisper (vídeos sem legenda) requer OPENAI_API_KEY, yt-dlp e ffmpeg.',
    ].join('\n'),
  )
}

async function main(): Promise<void> {
  const { lang, urls } = parseArgs(process.argv.slice(2))

  if (urls.length === 0) {
    printUsage()
    process.exitCode = 1
    return
  }

  const results: ProcessResult[] = []
  for (let i = 0; i < urls.length; i++) {
    console.log(`\n[${i + 1}/${urls.length}] Processando ${urls[i]}`)
    try {
      results.push(await processOne(urls[i], lang))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({ url: urls[i], status: 'erro', reason: msg })
      console.log(`   ✗ Erro: ${msg}`)
    }
  }

  const ok = results.filter((r): r is Extract<ProcessResult, { status: 'ok' }> => r.status === 'ok')
  const fail = results.filter(
    (r): r is Extract<ProcessResult, { status: 'erro' }> => r.status === 'erro',
  )

  console.log('\n' + '='.repeat(60))
  console.log(`RESUMO: ${ok.length} ok, ${fail.length} falha(s)`)
  if (ok.length > 0) {
    console.log('\n✓ Transcritos:')
    for (const r of ok) console.log(`   ${r.file}  (${r.source})`)
  }
  if (fail.length > 0) {
    console.log('\n✗ Falhas:')
    for (const r of fail) console.log(`   ${r.url}\n      ${r.reason}`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('Erro fatal:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
```

- [ ] **Step 2b: Imports e `processOne` corrigidos (AUTORIDADE — preservam capítulos)**

Imports do topo do `scripts/youtube-transcript.ts`:
```ts
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  sanitizeFilename,
  buildPlainText,
  buildSrt,
  buildChaptersText,
  type Segment,
} from '../lib/transcript-utils'
import { extractTranscript } from '../lib/extractor'
import { segmentTopics } from './topic-segmenter'
```

`processOne` (delega extração ao `extractTranscript`, mantém .txt/.srt e o bloco de capítulos):
```ts
async function processOne(
  url: string,
  lang: string | undefined,
  topics: boolean,
): Promise<ProcessResult> {
  let result
  try {
    result = await extractTranscript(url, { lang })
  } catch (err) {
    return { url, status: 'erro', reason: err instanceof Error ? err.message : String(err) }
  }

  const baseName = result.title ? sanitizeFilename(result.title) : ''
  const stem = resolveOutputStem(process.cwd(), baseName || result.videoId)
  const out = writeOutputs(stem, result.segments)

  const preview = buildPlainText(result.segments).slice(0, 200)
  console.log(
    `   ✓ ${out.txt} + ${out.srt} (${result.segments.length} segmentos, fonte: ${result.source})`,
  )
  console.log(`     "${preview}${preview.length >= 200 ? '...' : ''}"`)

  let chaptersFile: string | undefined
  if (topics) {
    try {
      const chapters = await segmentTopics(result.segments, { lang, videoTitle: result.title })
      if (chapters.length > 0) {
        const chaptersPath = `${stem}.chapters.txt`
        fs.writeFileSync(chaptersPath, buildChaptersText(chapters) + '\n', 'utf-8')
        chaptersFile = path.basename(chaptersPath)
        console.log(`   ✓ ${chaptersFile} (${chapters.length} capítulos por tema)`)
      } else {
        console.log('   ⚠ temas: nenhum capítulo gerado')
      }
    } catch (topicErr) {
      console.log(`   ⚠ temas: ${topicErr instanceof Error ? topicErr.message : String(topicErr)}`)
    }
  }

  const files = chaptersFile
    ? `${out.txt} + ${out.srt} + ${chaptersFile}`
    : `${out.txt} + ${out.srt}`
  return { url, status: 'ok', file: files, source: result.source }
}
```
`parseArgs` (mantém `topics`), `printUsage` (mantém linha `--topics`), `resolveOutputStem`,
`writeOutputs`, type `ProcessResult` e `main` (segue passando `topics` ao `processOne`) ficam como
no arquivo atual. Remover a chamada `loadEnv()` do início da `main` (o `extractTranscript` já o faz)
e os imports não mais usados (`os`, `spawnSync`, `extractVideoId`, `decodeHtmlEntities`).

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: 0 erros.

- [ ] **Step 4: Testes ainda verdes**

Run: `npx vitest run`
Expected: PASS, 53 testes.

- [ ] **Step 5: Regressão e2e do CLI (caminho de legendas)**

Run:
```bash
cd "D:/youtube transcripts" && rm -f "Como-eu-uso-IA-pra-programar-em-2026.txt" "Como-eu-uso-IA-pra-programar-em-2026.srt" && npx tsx scripts/youtube-transcript.ts "https://www.youtube.com/watch?v=7nN4ayK79oc"
```
Expected: `✓ Como-eu-uso-IA-pra-programar-em-2026.txt + Como-eu-uso-IA-pra-programar-em-2026.srt (647 segmentos, fonte: YouTube Captions)` e `RESUMO: 1 ok, 0 falha(s)`.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor: extrair extractTranscript para lib/extractor; CLI vira casca fina"
```

---

## Task 4: Scaffolding do Next.js

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Create: `next.config.mjs`, `app/layout.tsx`, `app/globals.css`, `app/page.tsx` (placeholder)

- [ ] **Step 1: Instalar dependências**

Run:
```bash
cd "D:/youtube transcripts" && npm install next react react-dom jszip && npm install -D @types/react @types/react-dom
```
Expected: instala sem erro; `package.json` ganha as deps.

- [ ] **Step 2: Adicionar scripts ao `package.json`**

No bloco `"scripts"`, adicionar (mantendo os existentes):
```json
    "web": "next dev",
    "build": "next build",
    "start": "next start",
```

- [ ] **Step 3: Criar `next.config.mjs`**

```js
/** @type {import('next').NextConfig} */
const nextConfig = {}

export default nextConfig
```

- [ ] **Step 4: Ajustar `tsconfig.json`**

Conteúdo completo:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "allowImportingTsExtensions": true,
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "preserve",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "incremental": true,
    "noEmit": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["scripts/**/*.ts", "test/**/*.ts", "lib/**/*.ts", "app/**/*.ts", "app/**/*.tsx", "next-env.d.ts", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 5: Criar `app/globals.css`**

```css
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  background: #0f1115;
  color: #e7e9ee;
}
.container { max-width: 720px; margin: 0 auto; padding: 40px 20px; }
h1 { font-size: 1.4rem; }
textarea {
  width: 100%; min-height: 140px; padding: 12px; border-radius: 8px;
  border: 1px solid #2a2f3a; background: #161922; color: #e7e9ee; font: inherit; resize: vertical;
}
button {
  margin-top: 12px; padding: 10px 18px; border-radius: 8px; border: 0;
  background: #3b82f6; color: white; font-weight: 600; cursor: pointer;
}
button:disabled { background: #2a2f3a; color: #6b7280; cursor: not-allowed; }
.secondary { background: #2a2f3a; color: #e7e9ee; }
.overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,.6);
  display: flex; align-items: center; justify-content: center;
}
.modal {
  background: #161922; border: 1px solid #2a2f3a; border-radius: 12px;
  padding: 24px; width: min(520px, 92vw); max-height: 80vh; overflow: auto;
}
.row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid #20242e; font-size: .9rem; }
.status-fila { color: #9aa3b2; }
.status-proc { color: #f59e0b; }
.status-ok { color: #22c55e; }
.status-erro { color: #ef4444; }
.muted { color: #9aa3b2; font-size: .85rem; }
.actions { margin-top: 16px; display: flex; gap: 8px; justify-content: flex-end; }
```

- [ ] **Step 6: Criar `app/layout.tsx`**

```tsx
import './globals.css'
import type { ReactNode } from 'react'

export const metadata = {
  title: 'YouTube Transcript',
  description: 'Extrai transcripts e legendas (.txt + .srt) de vídeos do YouTube',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  )
}
```

- [ ] **Step 7: Criar `app/page.tsx` placeholder**

```tsx
export default function Page() {
  return (
    <main className="container">
      <h1>YouTube Transcript</h1>
      <p className="muted">Em construção.</p>
    </main>
  )
}
```

- [ ] **Step 8: Type-check + build**

Run: `npx tsc --noEmit && npx next build`
Expected: tsc 0 erros; `next build` conclui com sucesso (gera `.next/`). Se o build reclamar de `next-env.d.ts`, rode `npx next build` de novo (ele cria o arquivo na 1ª vez).

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat: scaffolding Next.js (App Router) + deps"
```

---

## Task 5: Rota `POST /api/transcript` (TDD)

**Files:**
- Create: `app/api/transcript/route.ts`
- Test: `test/api-transcript.test.ts`

- [ ] **Step 1: Escrever o teste falho (caminhos de erro determinísticos, sem rede)**

`test/api-transcript.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { POST } from '../app/api/transcript/route'

function req(body: unknown): Request {
  return new Request('http://localhost/api/transcript', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

describe('POST /api/transcript', () => {
  it('400 quando falta a url', async () => {
    const res = await POST(req({}))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, error: 'URL ausente' })
  })

  it('422 com erro claro para URL não-YouTube (sem rede)', async () => {
    const res = await POST(req({ url: 'https://example.com/video' }))
    const json = await res.json()
    expect(res.status).toBe(422)
    expect(json.ok).toBe(false)
    expect(String(json.error)).toContain('URL inválida')
  })
})
```

- [ ] **Step 2: Rodar o teste — deve falhar**

Run: `npx vitest run test/api-transcript.test.ts`
Expected: FAIL — não consegue resolver `../app/api/transcript/route` (módulo ainda não existe).

- [ ] **Step 3: Implementar a rota**

`app/api/transcript/route.ts`:
```ts
import { extractTranscript } from '@/lib/extractor'
import { buildPlainText, buildSrt, sanitizeFilename } from '@/lib/transcript-utils'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  let body: { url?: string; lang?: string }
  try {
    body = await request.json()
  } catch {
    return Response.json({ ok: false, error: 'JSON inválido' }, { status: 400 })
  }

  const url = (body.url ?? '').trim()
  if (!url) {
    return Response.json({ ok: false, error: 'URL ausente' }, { status: 400 })
  }

  try {
    const r = await extractTranscript(url, { lang: body.lang })
    const base = (r.title ? sanitizeFilename(r.title) : '') || r.videoId
    return Response.json({
      ok: true,
      title: r.title ?? r.videoId,
      base,
      source: r.source,
      txt: buildPlainText(r.segments),
      srt: buildSrt(r.segments),
    })
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 422 },
    )
  }
}
```

- [ ] **Step 4: Rodar o teste — deve passar**

Run: `npx vitest run test/api-transcript.test.ts`
Expected: PASS, 2 testes.

- [ ] **Step 5: Suite completa + type-check**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS 55 testes (53 + 2 da rota); tsc 0 erros.

- [ ] **Step 6: Verificação e2e da rota (caminho feliz, com rede)**

Run (em dois passos):
```bash
cd "D:/youtube transcripts" && npx next dev &
```
Aguardar "Ready", então:
```bash
curl -s -X POST http://localhost:3000/api/transcript -H "content-type: application/json" -d "{\"url\":\"https://www.youtube.com/watch?v=7nN4ayK79oc\"}" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('ok:',j.ok,'| source:',j.source,'| title:',j.title,'| txt len:',j.txt?.length,'| srt cues ~:',(j.srt.match(/-->/g)||[]).length)})"
```
Expected: `ok: true | source: YouTube Captions | title: Como eu uso IA... | txt len: >0 | srt cues ~: 647`. Encerrar o dev server depois.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: rota POST /api/transcript (1 url -> txt+srt)"
```

---

## Task 6: Front-end (fila + modais + ZIP)

**Files:**
- Modify: `app/page.tsx` (substitui o placeholder)

- [ ] **Step 1: Implementar a página completa**

`app/page.tsx` (substituir todo o conteúdo):
```tsx
'use client'

import { useMemo, useState } from 'react'
import JSZip from 'jszip'

type Phase = 'idle' | 'confirming' | 'running' | 'done'
type ItemStatus = 'fila' | 'processando' | 'ok' | 'erro'
type Item = {
  url: string
  status: ItemStatus
  title?: string
  source?: string
  error?: string
  base?: string
  txt?: string
  srt?: string
}

function parseUrls(raw: string): string[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

/** Garante nomes-base únicos no ZIP, anexando " (2)", " (3)"... em colisões. */
function uniqueBase(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let n = 2
  while (used.has(`${base} (${n})`)) n++
  const result = `${base} (${n})`
  used.add(result)
  return result
}

export default function Page() {
  const [raw, setRaw] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [items, setItems] = useState<Item[]>([])

  const urls = useMemo(() => parseUrls(raw), [raw])
  const doneCount = items.filter((i) => i.status === 'ok' || i.status === 'erro').length

  function openConfirm() {
    setItems(urls.map((url) => ({ url, status: 'fila' })))
    setPhase('confirming')
  }

  function cancel() {
    setPhase('idle')
    setItems([])
  }

  async function run() {
    setPhase('running')
    const collected: Item[] = items.map((i) => ({ ...i }))

    for (let i = 0; i < collected.length; i++) {
      collected[i] = { ...collected[i], status: 'processando' }
      setItems([...collected])
      try {
        const res = await fetch('/api/transcript', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: collected[i].url }),
        })
        const json = await res.json()
        if (json.ok) {
          collected[i] = {
            ...collected[i],
            status: 'ok',
            title: json.title,
            source: json.source,
            base: json.base,
            txt: json.txt,
            srt: json.srt,
          }
        } else {
          collected[i] = { ...collected[i], status: 'erro', error: json.error ?? 'erro desconhecido' }
        }
      } catch (err) {
        collected[i] = {
          ...collected[i],
          status: 'erro',
          error: err instanceof Error ? err.message : String(err),
        }
      }
      setItems([...collected])
    }

    await buildAndDownloadZip(collected)
    setPhase('done')
  }

  async function buildAndDownloadZip(finished: Item[]) {
    const ok = finished.filter((i) => i.status === 'ok')
    if (ok.length === 0) return
    const zip = new JSZip()
    const used = new Set<string>()
    for (const it of ok) {
      const base = uniqueBase(it.base || 'transcript', used)
      zip.file(`${base}.txt`, (it.txt ?? '') + '\n')
      zip.file(`${base}.srt`, (it.srt ?? '') + '\n')
    }
    const blob = await zip.generateAsync({ type: 'blob' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'transcripts.zip'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(a.href)
  }

  return (
    <main className="container">
      <h1>YouTube Transcript</h1>
      <p className="muted">Cole uma URL por linha. Gera .txt (texto) + .srt (legenda) por vídeo.</p>

      <textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        placeholder="https://www.youtube.com/watch?v=...&#10;https://youtu.be/..."
      />
      <div>
        <button onClick={openConfirm} disabled={urls.length === 0}>
          Baixar transcripts{urls.length > 0 ? ` (${urls.length})` : ''}
        </button>
      </div>

      {phase === 'confirming' && (
        <div className="overlay">
          <div className="modal">
            <h2>Confirmar execução</h2>
            <p>
              Vou processar <strong>{items.length}</strong> vídeo(s) em fila. As legendas saem na
              hora; vídeos sem legenda tentam Whisper (local).
            </p>
            <div className="actions">
              <button className="secondary" onClick={cancel}>
                Cancelar
              </button>
              <button onClick={run}>Confirmar</button>
            </div>
          </div>
        </div>
      )}

      {(phase === 'running' || phase === 'done') && (
        <div className="overlay">
          <div className="modal">
            <h2>
              {phase === 'running' ? 'Processando' : 'Concluído'} ({doneCount}/{items.length})
            </h2>
            {items.map((it, idx) => (
              <div className="row" key={idx}>
                <StatusBadge item={it} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {it.title || it.url}
                </span>
              </div>
            ))}
            {phase === 'done' && (
              <>
                <p className="muted">
                  O ZIP com os sucessos foi baixado automaticamente. Falhas não entram no ZIP.
                </p>
                <div className="actions">
                  <button className="secondary" onClick={cancel}>
                    Fechar
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </main>
  )
}

function StatusBadge({ item }: { item: Item }) {
  if (item.status === 'fila') return <span className="status-fila">• na fila</span>
  if (item.status === 'processando') return <span className="status-proc">⟳ processando…</span>
  if (item.status === 'ok')
    return <span className="status-ok" title={item.source}>✓ {item.source}</span>
  return (
    <span className="status-erro" title={item.error}>
      ✗ {item.error}
    </span>
  )
}
```

- [ ] **Step 2: Type-check + build**

Run: `npx tsc --noEmit && npx next build`
Expected: tsc 0 erros; build conclui.

- [ ] **Step 3: Verificação e2e no navegador (Playwright MCP)**

Subir o dev server:
```bash
cd "D:/youtube transcripts" && npx next dev &
```
Aguardar "Ready". Então, via Playwright MCP:
1. `browser_navigate` → `http://localhost:3000`
2. `browser_type` no textarea → `https://www.youtube.com/watch?v=7nN4ayK79oc`
3. `browser_click` no botão "Baixar transcripts (1)"
4. `browser_snapshot` → confirmar modal "Confirmar execução" com "1 vídeo(s)"
5. `browser_click` em "Confirmar"
6. `browser_wait_for` texto "Concluído (1/1)"
7. `browser_snapshot` → confirmar linha `✓ YouTube Captions` com o título do vídeo

Expected: modal de confirmação → status → "Concluído (1/1)" com ✓; o download de `transcripts.zip` dispara (verificável via `browser_network_requests` ou pela mudança de fase para "done"). Encerrar o dev server.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: front-end de fila com modal de status e ZIP no navegador"
```

---

## Task 7: Verificação final + README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Suite completa + type-check + regressão do CLI**

Run:
```bash
cd "D:/youtube transcripts" && npx vitest run && npx tsc --noEmit
```
Expected: 55 testes PASS; tsc 0 erros.

- [ ] **Step 2: Escrever `README.md`**

```markdown
# YouTube Transcript Extractor

Extrai transcript de vídeos do YouTube como `.txt` (texto corrido) + `.srt` (legenda
sincronizada). Usa as legendas do YouTube (grátis) e cai para OpenAI Whisper quando o
vídeo não tem legenda (requer `OPENAI_API_KEY` + `yt-dlp` + `ffmpeg`, local).

## CLI

```bash
npm install
npx tsx scripts/youtube-transcript.ts "https://youtu.be/ID1" "https://youtu.be/ID2"
npx tsx scripts/youtube-transcript.ts --lang pt "https://youtu.be/ID"
```

Gera `Titulo.txt` + `Titulo.srt` por vídeo no diretório atual.

## Web (local)

```bash
npm run web   # http://localhost:3000
```

Cole uma URL por linha, confirme, acompanhe a fila e baixe o ZIP.

> **Vercel:** o app deploya direto. Em serverless só o caminho de legendas funciona;
> vídeos sem legenda falham com mensagem clara (Whisper exige binários de sistema —
> ver Fase 2 no spec).

## Testes

```bash
npm test
```
```

- [ ] **Step 3: Commit final**

```bash
git add -A && git commit -m "docs: README com uso do CLI e do app web"
```

---

## Self-review notes (resolvidos)

- **Cobertura do spec:** arquitetura (Tasks 2-6), fluxo UX (Task 6), ZIP .txt+.srt com auto-download (Task 6 Step 1 `buildAndDownloadZip`), erros por URL sem parar a fila (Task 6 `run` try/catch), Whisper local/degrada na Vercel (Task 3 `whisperFallback` checks), verificação (Task 7). UI sem campo de idioma — confirmado (front nunca envia `lang`).
- **Consistência de tipos:** `{ ok, title, base, txt, srt, source }` é o mesmo contrato na rota (Task 5) e no consumo do front (Task 6). `base` usado como nome de arquivo nos dois lados.
- **Sem placeholders:** todo passo de código tem código completo.
```
