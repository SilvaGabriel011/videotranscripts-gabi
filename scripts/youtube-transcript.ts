/**
 * YouTube Transcript Extractor
 *
 * Recebe uma ou mais URLs do YouTube e gera um .txt por vídeo, nomeado pelo
 * título do vídeo. Dois modos por vídeo:
 *   1. Legendas do YouTube (sem API key) via `youtube-transcript`
 *   2. Fallback: baixa o áudio com yt-dlp e transcreve via OpenAI Whisper
 *      (requer OPENAI_API_KEY + yt-dlp + ffmpeg instalados)
 *
 * Uso:
 *   npx tsx scripts/youtube-transcript.ts "https://youtu.be/ID1" "https://youtu.be/ID2"
 *   npx tsx scripts/youtube-transcript.ts --lang pt "https://youtu.be/ID"
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { spawnSync } from 'node:child_process'
import {
  extractVideoId,
  decodeHtmlEntities,
  sanitizeFilename,
  buildPlainText,
  buildSrt,
  type Segment,
} from './transcript-utils.ts'

const WHISPER_SIZE_LIMIT = 24 * 1024 * 1024 // 24MB (limite real da API: 25MB)
const CHUNK_SECONDS = 600 // 10 min por pedaço no chunking

type ProcessResult =
  | { url: string; status: 'ok'; file: string; source: string }
  | { url: string; status: 'erro'; reason: string }

// ---------------------------------------------------------------------------
// Ambiente
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Metadados / nome de arquivo
// ---------------------------------------------------------------------------

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

/**
 * Resolve um nome-base único (sem extensão) onde nem `.txt` nem `.srt` existam,
 * anexando " (2)", " (3)"... se preciso — assim os dois arquivos do mesmo vídeo
 * compartilham o mesmo nome.
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

// ---------------------------------------------------------------------------
// Modo 1 — Legendas do YouTube
// ---------------------------------------------------------------------------

/**
 * Busca legendas via `youtube-transcript`. A lib retorna { text, offset, duration }
 * com offset/duration em MILISSEGUNDOS. Lança erro se não houver legenda.
 */
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

// ---------------------------------------------------------------------------
// Modo 2 — Fallback Whisper (yt-dlp + ffmpeg + OpenAI)
// ---------------------------------------------------------------------------

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
async function transcribeChunks(
  chunkPaths: string[],
  lang: string | undefined,
): Promise<Segment[]> {
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

    // verbose_json traz `segments` com start/end em SEGUNDOS.
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
      // Sem segmentação: cai num único bloco para este pedaço.
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

// ---------------------------------------------------------------------------
// Saída
// ---------------------------------------------------------------------------

/**
 * Escreve os dois artefatos do vídeo:
 *   - `<stem>.txt` — texto corrido limpo (leitura/cópia)
 *   - `<stem>.srt` — legenda sincronizada linha-a-linha (abre em qualquer player)
 * Retorna os nomes dos arquivos gerados.
 */
function writeOutputs(stem: string, segments: Segment[]): { txt: string; srt: string } {
  const txtPath = `${stem}.txt`
  const srtPath = `${stem}.srt`
  fs.writeFileSync(txtPath, buildPlainText(segments) + '\n', 'utf-8')
  fs.writeFileSync(srtPath, buildSrt(segments) + '\n', 'utf-8')
  return { txt: path.basename(txtPath), srt: path.basename(srtPath) }
}

// ---------------------------------------------------------------------------
// Processamento de uma URL
// ---------------------------------------------------------------------------

async function processOne(url: string, lang: string | undefined): Promise<ProcessResult> {
  const videoId = extractVideoId(url)
  if (!videoId) {
    return { url, status: 'erro', reason: 'URL inválida (não foi possível extrair o video ID)' }
  }

  const title = await getVideoTitle(videoId)
  const baseName = title ? sanitizeFilename(title) : ''
  const stem = resolveOutputStem(process.cwd(), baseName || videoId)

  let segments: Segment[]
  let source: string
  try {
    segments = await fetchYoutubeCaptions(videoId, lang)
    source = 'YouTube Captions'
  } catch (captionErr) {
    // Sem legenda (ou idioma indisponível) → tenta Whisper.
    try {
      segments = await whisperFallback(url, videoId, lang)
      source = 'OpenAI Whisper'
    } catch (whisperErr) {
      const cMsg = captionErr instanceof Error ? captionErr.message : String(captionErr)
      const wMsg = whisperErr instanceof Error ? whisperErr.message : String(whisperErr)
      return { url, status: 'erro', reason: `legenda: ${cMsg} | whisper: ${wMsg}` }
    }
  }

  if (segments.length === 0) {
    return { url, status: 'erro', reason: 'Transcrição vazia' }
  }

  const out = writeOutputs(stem, segments)

  const preview = buildPlainText(segments).slice(0, 200)
  console.log(`   ✓ ${out.txt} + ${out.srt} (${segments.length} segmentos, fonte: ${source})`)
  console.log(`     "${preview}${preview.length >= 200 ? '...' : ''}"`)
  return { url, status: 'ok', file: `${out.txt} + ${out.srt}`, source }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

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
  loadEnv()
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

  // Resumo final
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
