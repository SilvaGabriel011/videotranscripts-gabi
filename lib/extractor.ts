import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Innertube, type YT } from 'youtubei.js'
import { extractVideoId, decodeHtmlEntities, type Segment } from './transcript-utils'

/** Info de vídeo da youtubei.js (namespace YT). */
type VideoInfo = YT.VideoInfo

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

/** Mensagem de erro legível a partir de um valor desconhecido. */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Lança erro claro se o áudio passa do limite do Whisper (sem ffmpeg p/ dividir aqui). */
function assertWithinWhisperLimit(sizeBytes: number): void {
  if (Number.isFinite(sizeBytes) && sizeBytes > WHISPER_SIZE_LIMIT) {
    throw new Error(
      `Áudio com ${(sizeBytes / 1024 / 1024).toFixed(1)}MB excede o limite de 25MB do Whisper e ` +
        'não há ffmpeg neste ambiente para dividir. Use a CLI local para vídeos longos.',
    )
  }
}

// ---------------------------------------------------------------------------
// Sessão da youtubei.js (InnerTube) — usada para legenda E áudio
// ---------------------------------------------------------------------------

export type YoutubeSessionOptions = {
  cookie?: string
  visitor_data?: string
  po_token?: string
}

/**
 * Lê a config de sessão do ambiente. IPs de data center (Vercel etc.) costumam ser
 * bloqueados pelo YouTube ("confirme que você não é um robô"); `YOUTUBE_COOKIE` (string de
 * cookies do navegador) autentica TODAS as requisições — tanto a legenda quanto o áudio.
 * `YOUTUBE_VISITOR_DATA`/`YOUTUBE_PO_TOKEN` são opções avançadas anti-bot (opcionais).
 */
export function youtubeSessionOptions(): YoutubeSessionOptions {
  const opts: YoutubeSessionOptions = {}
  const cookie = process.env.YOUTUBE_COOKIE?.trim()
  const visitorData = process.env.YOUTUBE_VISITOR_DATA?.trim()
  const poToken = process.env.YOUTUBE_PO_TOKEN?.trim()
  if (cookie) opts.cookie = cookie
  if (visitorData) opts.visitor_data = visitorData
  if (poToken) opts.po_token = poToken
  return opts
}

async function createYoutube(): Promise<Innertube> {
  return Innertube.create(youtubeSessionOptions())
}

// ---------------------------------------------------------------------------
// Legendas (via InnerTube)
// ---------------------------------------------------------------------------

/** Forma mínima de um segmento cru de transcrição da youtubei.js. */
export type RawTranscriptSegment = {
  start_ms?: string | number
  end_ms?: string | number
  snippet?: { text?: string } | null
}

/**
 * Converte os segmentos crus da youtubei.js em `Segment[]`. Pula cabeçalhos de seção
 * (que não têm `start_ms`/`snippet`) e trechos vazios. Lança se sobrar nada. Exportada p/ teste.
 */
export function transcriptToSegments(rawSegments: ReadonlyArray<RawTranscriptSegment>): Segment[] {
  const out: Segment[] = []
  for (const s of rawSegments) {
    if (!s || s.start_ms == null || !s.snippet) continue // ignora cabeçalhos de seção
    const text = decodeHtmlEntities(String(s.snippet.text ?? '').trim())
    if (!text) continue
    const offset = Math.round(Number(s.start_ms))
    const end = Math.round(Number(s.end_ms))
    const duration = Number.isFinite(end) ? Math.max(0, end - offset) : 0
    out.push({ text, offset, duration })
  }
  if (out.length === 0) throw new Error('Nenhuma legenda retornada')
  return out
}

/** Forma mínima de uma faixa de legenda do player (caption_tracks). */
export type CaptionTrackLite = {
  base_url: string
  language_code?: string
  kind?: string
}

/**
 * Escolhe a faixa de legenda: idioma pedido (igual e depois prefixo, ex.: 'pt' casa 'pt-BR')
 * e prefere legenda MANUAL sobre a automática (`kind === 'asr'`). Sem match, usa a primeira.
 * Exportada p/ teste.
 */
export function pickCaptionTrack<T extends CaptionTrackLite>(
  tracks: ReadonlyArray<T>,
  lang?: string,
): T | null {
  if (!tracks || tracks.length === 0) return null
  if (lang) {
    const exact = tracks.find((t) => t.language_code === lang)
    if (exact) return exact
    const prefix = tracks.find((t) => t.language_code?.startsWith(lang))
    if (prefix) return prefix
  }
  const manual = tracks.find((t) => t.kind !== 'asr')
  return manual ?? tracks[0]
}

/** Um evento do formato `json3` do timedtext do YouTube. */
export type Json3Event = {
  tStartMs?: number
  dDurationMs?: number
  segs?: Array<{ utf8?: string }>
}

/**
 * Converte os eventos `json3` do timedtext em `Segment[]`: junta os `segs` de cada evento,
 * normaliza espaços e pula eventos sem texto (posicionamento). Lança se não sobrar nada.
 * Exportada p/ teste.
 */
export function timedTextToSegments(events: ReadonlyArray<Json3Event>): Segment[] {
  const out: Segment[] = []
  for (const ev of events) {
    if (!ev?.segs) continue
    const text = decodeHtmlEntities(
      ev.segs
        .map((s) => s.utf8 ?? '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    if (!text) continue
    out.push({
      text,
      offset: Math.round(Number(ev.tStartMs ?? 0)),
      duration: Math.max(0, Math.round(Number(ev.dDurationMs ?? 0))),
    })
  }
  if (out.length === 0) throw new Error('Legenda vazia (timedtext)')
  return out
}

/** Baixa e parseia a legenda de uma faixa via timedtext `json3`. */
async function fetchTimedText(track: CaptionTrackLite): Promise<Segment[]> {
  const sep = track.base_url.includes('?') ? '&' : '?'
  const res = await fetch(`${track.base_url}${sep}fmt=json3`)
  if (!res.ok) throw new Error(`timedtext HTTP ${res.status}`)
  const data = (await res.json()) as { events?: Json3Event[] }
  return timedTextToSegments(data.events ?? [])
}

/**
 * Busca a legenda do vídeo. Tenta primeiro as `caption_tracks` do player (timedtext json3) —
 * mais confiável que o endpoint `get_transcript`, que costuma retornar 400 — e cai para o
 * `get_transcript` se não houver faixa ou o timedtext falhar.
 */
async function fetchYoutubeCaptions(info: VideoInfo, lang?: string): Promise<Segment[]> {
  // 1) Faixas de legenda do player (timedtext).
  const track = pickCaptionTrack(info.captions?.caption_tracks ?? [], lang)
  if (track?.base_url) {
    try {
      return await fetchTimedText(track)
    } catch {
      // timedtext falhou — tenta o get_transcript abaixo
    }
  }

  // 2) Fallback: endpoint get_transcript.
  let tInfo = await info.getTranscript()
  if (lang) {
    try {
      if (tInfo.languages?.includes(lang) && tInfo.selectedLanguage !== lang) {
        tInfo = await tInfo.selectLanguage(lang)
      }
    } catch {
      // idioma indisponível — mantém o padrão
    }
  }
  const initial = tInfo.transcript.content?.body?.initial_segments ?? []
  return transcriptToSegments(initial as unknown as RawTranscriptSegment[])
}

// ---------------------------------------------------------------------------
// Fallback Whisper — áudio
// ---------------------------------------------------------------------------

/** Deriva a extensão de arquivo a partir do mime do formato de áudio. */
function audioExtFromMime(mime: string | undefined): string {
  if (mime?.includes('webm')) return 'webm'
  return 'm4a'
}

/**
 * Caminho serverless (Vercel etc.): baixa o áudio em JS puro com a youtubei.js, sem depender
 * de `yt-dlp`/`ffmpeg`. Escolhe o menor formato só-áudio e grava em tmpDir. Sem ffmpeg não há
 * como dividir: se passar do limite do Whisper, lança erro claro. Exportada p/ teste.
 */
export async function downloadAudioServerless(
  info: Pick<VideoInfo, 'chooseFormat' | 'download'>,
  videoId: string,
  tmpDir: string,
): Promise<string> {
  // chooseFormat LANÇA quando não acha formato compatível (inclusive quando o YouTube
  // devolve a resposta sem `streaming_data`, típico de bloqueio anti-bot).
  let format: ReturnType<VideoInfo['chooseFormat']>
  try {
    format = info.chooseFormat({ type: 'audio', quality: 'bestefficiency' })
  } catch {
    throw new Error(
      'Nenhum formato de áudio disponível (o YouTube não retornou os streams). Costuma ser ' +
        'bloqueio anti-bot em IP de data center — defina YOUTUBE_COOKIE (ou YOUTUBE_PO_TOKEN ' +
        '+ YOUTUBE_VISITOR_DATA) para autenticar.',
    )
  }

  // Falha rápida: se o tamanho já vem no metadata e passa do limite, nem baixa.
  assertWithinWhisperLimit(Number(format.content_length))

  const out = path.join(tmpDir, `${videoId}.${audioExtFromMime(format.mime_type)}`)
  console.log('   Sem legenda — baixando áudio (youtubei.js) para transcrever via Whisper...')

  const stream = await info.download({ type: 'audio', quality: 'bestefficiency' })
  await pipeline(
    Readable.fromWeb(stream as unknown as import('node:stream/web').ReadableStream),
    fs.createWriteStream(out),
  )

  // Confirmação após o download (content_length pode não vir no metadata).
  assertWithinWhisperLimit(fs.statSync(out).size)
  return out
}

/** Baixa o áudio do vídeo como mp3 em tmpDir e retorna o caminho do arquivo (via yt-dlp). */
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
async function whisperFallback(
  info: VideoInfo,
  url: string,
  videoId: string,
  lang?: string,
): Promise<Segment[]> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      'Vídeo sem legenda e OPENAI_API_KEY não definida. Configure a chave (.env) para usar o Whisper.',
    )
  }

  // Quando `yt-dlp` + `ffmpeg` existem (uso local), usa o caminho completo com chunking
  // de vídeos longos. Sem eles (ex.: serverless na Vercel), cai no download em JS puro.
  const haveBinaries = hasCommand('yt-dlp') && hasCommand('ffmpeg', '-version')

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-transcript-'))
  try {
    let chunks: string[]
    if (haveBinaries) {
      console.log('   Sem legenda — baixando áudio (yt-dlp) para transcrever via Whisper...')
      const audioPath = downloadAudio(url, videoId, tmpDir)
      chunks = splitIfNeeded(audioPath, videoId, tmpDir)
    } else {
      chunks = [await downloadAudioServerless(info, videoId, tmpDir)]
    }
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

  const yt = await createYoutube()
  let info: VideoInfo
  try {
    info = await yt.getInfo(videoId)
  } catch (e) {
    throw new Error(
      `Falha ao obter o vídeo (youtubei.js): ${errMsg(e)}. ` +
        'IPs de data center (como os da Vercel) podem ser bloqueados pelo YouTube; ' +
        'defina YOUTUBE_COOKIE para autenticar.',
    )
  }
  const title = info.basic_info.title ?? null

  let segments: Segment[]
  let source: TranscriptSource
  try {
    segments = await fetchYoutubeCaptions(info, opts.lang)
    source = 'YouTube Captions'
  } catch (captionErr) {
    try {
      segments = await whisperFallback(info, url, videoId, opts.lang)
      source = 'OpenAI Whisper'
    } catch (whisperErr) {
      throw new Error(`legenda: ${errMsg(captionErr)} | whisper: ${errMsg(whisperErr)}`)
    }
  }
  if (segments.length === 0) {
    throw new Error('Transcrição vazia')
  }
  return { videoId, title, source, segments }
}
