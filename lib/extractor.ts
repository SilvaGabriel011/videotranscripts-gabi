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
 * Lança Error com mensagem clara em qualquer falha. Não escreve arquivos.
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
