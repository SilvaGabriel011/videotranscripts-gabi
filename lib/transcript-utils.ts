export type Segment = {
  /** Texto do trecho (já decodificado). */
  text: string
  /** Início do trecho em milissegundos. */
  offset: number
  /** Duração do trecho em milissegundos. */
  duration: number
}

const VIDEO_ID = /[A-Za-z0-9_-]{11}/
const URL_PATTERNS = [
  /[?&]v=([A-Za-z0-9_-]{11})/, // watch?v=ID
  /youtu\.be\/([A-Za-z0-9_-]{11})/, // youtu.be/ID
  /\/embed\/([A-Za-z0-9_-]{11})/, // /embed/ID
  /\/shorts\/([A-Za-z0-9_-]{11})/, // /shorts/ID
]

export function extractVideoId(url: string): string | null {
  if (!url) return null
  for (const pattern of URL_PATTERNS) {
    const m = url.match(pattern)
    if (m) return m[1]
  }
  // ID cru de 11 caracteres (sem ser parte de uma URL maior).
  if (VIDEO_ID.test(url) && /^[A-Za-z0-9_-]{11}$/.test(url)) return url
  return null
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (whole, name) => NAMED_ENTITIES[name] ?? whole)
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export function formatTimestamp(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `[${h}:${pad2(m)}:${pad2(s)}]` : `[${pad2(m)}:${pad2(s)}]`
}

function pad3(n: number): string {
  return String(n).padStart(3, '0')
}

/** Converte milissegundos no timestamp SRT `HH:MM:SS,mmm` (mantém os ms, não trunca). */
export function formatSrtTimestamp(ms: number): string {
  const total = Math.floor(ms / 1000)
  const millis = ms % 1000
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(millis)}`
}

/**
 * Monta uma legenda SubRip (.srt) com uma cue por segmento.
 * - `start` = offset (preciso).
 * - `end` = offset + min(duration, próximo.offset - offset); último = offset + duration.
 *   A duração é corrigida para não estourar o próximo segmento (janela rolante das
 *   legendas auto). Numa pausa real a legenda some antes da próxima aparecer.
 * - Garante cue com ao menos 1ms para ser um SRT válido mesmo com offsets coincidentes.
 */
export function buildSrt(segments: Segment[]): string {
  return segments
    .map((seg, i) => {
      const next = segments[i + 1]
      const realDur = next ? Math.max(0, Math.min(seg.duration, next.offset - seg.offset)) : seg.duration
      const start = seg.offset
      const end = Math.max(start + 1, seg.offset + realDur)
      return `${i + 1}\n${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}\n${seg.text}`
    })
    .join('\n\n')
}

export function sanitizeFilename(title: string): string {
  let s = title.replace(/[/\\:*?"<>|]/g, '') // remove inválidos de nome de arquivo
  s = s.replace(/\s+/g, '-') // espaços → hífen
  s = s.replace(/-+/g, '-') // colapsa hífens
  s = s.replace(/^-+|-+$/g, '') // apara hífens das pontas
  if (s.length > 120) s = s.slice(0, 120).replace(/-+$/, '')
  return s
}

function normalizeSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function buildPlainText(segments: Segment[]): string {
  return normalizeSpaces(segments.map((s) => s.text).join(' '))
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/**
 * Quebra o transcript em parágrafos com timestamp, adaptando-se à fonte:
 *
 * 1. Corrige a `duration` inflada das legendas auto do YouTube (janela rolante)
 *    para `min(duration, próximo.offset - offset)` — a duration estoura o início
 *    do próximo segmento, então o silêncio aparente fica negativo.
 * 2. Se a fonte tem silêncios reais (legenda manual / Whisper) → agrupa por
 *    silêncio: novo parágrafo quando o gap corrigido passa de `gapMs`.
 * 3. Senão (auto-caption contínua, gaps ~0) → usa o intervalo start-to-start
 *    com limiar adaptativo `max(2500, 2× mediana)`, indicando pausa/seção.
 *
 * Em qualquer caso, `maxParagraphMs` garante uma âncora de navegação ao forçar
 * uma quebra em monólogos longos sem nenhuma pausa detectável.
 */
export function buildTimestampedText(
  segments: Segment[],
  gapMs = 1500,
  maxParagraphMs = 45000,
): string {
  if (segments.length === 0) return ''

  // Duração corrigida (nunca estoura o início do próximo segmento).
  const realDur = segments.map((seg, i) => {
    const next = segments[i + 1]
    return next ? Math.max(0, Math.min(seg.duration, next.offset - seg.offset)) : seg.duration
  })

  // Gaps de silêncio e deltas start-to-start (entre segmentos consecutivos).
  const gaps: number[] = []
  const deltas: number[] = []
  for (let i = 0; i < segments.length - 1; i++) {
    gaps.push(segments[i + 1].offset - (segments[i].offset + realDur[i]))
    deltas.push(segments[i + 1].offset - segments[i].offset)
  }

  const hasSilence = gaps.some((g) => g > gapMs)
  const deltaThreshold = Math.max(2500, 2 * median(deltas))

  const paragraphs: { offset: number; parts: string[] }[] = []
  let current = { offset: segments[0].offset, parts: [] as string[] }

  for (let i = 0; i < segments.length; i++) {
    current.parts.push(segments[i].text)
    const next = segments[i + 1]
    if (!next) break

    const naturalBreak = hasSilence ? gaps[i] > gapMs : deltas[i] > deltaThreshold
    const capBreak = next.offset - current.offset > maxParagraphMs
    if (naturalBreak || capBreak) {
      paragraphs.push(current)
      current = { offset: next.offset, parts: [] }
    }
  }
  paragraphs.push(current)

  return paragraphs
    .map((p) => `${formatTimestamp(p.offset)} ${normalizeSpaces(p.parts.join(' '))}`)
    .join('\n')
}

/**
 * Transcript com âncoras de tempo FINAS — um `[MM:SS]` a cada ~`stepMs` (≈5/min com
 * o padrão de 12s), ancorado no offset do primeiro segmento de cada bloco.
 *
 * Diferente de `buildTimestampedText` (que agrupa por silêncio/seção, ~45s), aqui o
 * objetivo é dar ao modelo de capítulos âncoras densas e regulares, para ele escolher
 * o início de cada tema com precisão de tempo — sem depender de detectar pausas.
 */
export function buildAnchoredTranscript(segments: Segment[], stepMs = 12000): string {
  if (segments.length === 0) return ''

  const lines: string[] = []
  let anchorOffset = segments[0].offset
  let current: string[] = []

  for (const seg of segments) {
    if (current.length > 0 && seg.offset - anchorOffset >= stepMs) {
      lines.push(`${formatTimestamp(anchorOffset)} ${normalizeSpaces(current.join(' '))}`)
      current = []
      anchorOffset = seg.offset
    }
    current.push(seg.text)
  }
  lines.push(`${formatTimestamp(anchorOffset)} ${normalizeSpaces(current.join(' '))}`)

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Capítulos por tema (flag --topics)
// ---------------------------------------------------------------------------

export type Topic = {
  /** Início do capítulo em milissegundos (ancorado a um segmento real). */
  offsetMs: number
  /** Título curto do tema, no idioma da transcrição. */
  title: string
}

/**
 * Formata milissegundos no estilo de capítulos do YouTube — SEM colchetes:
 * `0:00`, `2:34`, `1:02:03`. (O `formatTimestamp` com colchetes é para os
 * parágrafos do .txt; a descrição do YouTube precisa do formato cru.)
 */
export function formatChapterTimestamp(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`
}

/**
 * Converte os capítulos crus da IA num `Topic[]` confiável:
 *  1. `startSeconds`→ms e ancora cada um ao `offset` do segmento mais próximo
 *     (precisão + anti-alucinação de tempo);
 *  2. ordena por offset, descarta títulos vazios e offsets duplicados (mantém o
 *     primeiro);
 *  3. força o primeiro capítulo a 0 (o YouTube exige o 1º capítulo em 00:00).
 */
export function normalizeChapters(
  raw: { startSeconds: number; title: string }[],
  segments: Segment[],
): Topic[] {
  if (segments.length === 0) return []
  const offsets = segments.map((s) => s.offset)
  const minOffset = offsets[0]
  const maxOffset = offsets[offsets.length - 1]

  // Ancora um tempo (ms) ao offset de segmento mais próximo, dentro da faixa do vídeo.
  const snap = (ms: number): number => {
    const clamped = Math.min(Math.max(ms, minOffset), maxOffset)
    let best = offsets[0]
    let bestDist = Math.abs(offsets[0] - clamped)
    for (const off of offsets) {
      const d = Math.abs(off - clamped)
      if (d < bestDist) {
        best = off
        bestDist = d
      }
    }
    return best
  }

  const topics: Topic[] = []
  for (const c of raw) {
    const title = (c?.title ?? '').trim()
    if (!title) continue
    const startMs = Math.round((Number(c?.startSeconds) || 0) * 1000)
    topics.push({ offsetMs: snap(startMs), title })
  }

  topics.sort((a, b) => a.offsetMs - b.offsetMs)

  // Dedupe por offset (mantém o primeiro título daquele instante).
  const deduped: Topic[] = []
  for (const t of topics) {
    if (deduped.length > 0 && deduped[deduped.length - 1].offsetMs === t.offsetMs) continue
    deduped.push(t)
  }

  // Primeiro capítulo precisa começar em 0 (requisito do YouTube).
  if (deduped.length > 0) deduped[0] = { ...deduped[0], offsetMs: 0 }

  return deduped
}

/** Quebra um texto em palavras normalizadas (minúsculas, sem pontuação, mantém acentos). */
function normWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Ancora capítulos pelo CONTEÚDO em vez de um tempo chutado pelo modelo:
 * o modelo devolve `{ quote, title }` (as primeiras palavras verbatim do trecho),
 * e aqui localizamos esse `quote` na sequência de palavras dos segmentos
 * cronometrados — o tempo sai do dado (precisão de segmento), não da aritmética da IA.
 *
 *  - Busca com cursor pra frente (respeita ordem e desambigua frases repetidas).
 *  - Tolera paráfrase leve tentando o quote inteiro (≤8 palavras) e depois prefixos de 5 e 3.
 *  - Quote não encontrado → capítulo descartado. 1º capítulo forçado a 0 (requisito YouTube).
 */
export function resolveChaptersByQuote(
  raw: { quote: string; title: string }[],
  segments: Segment[],
  minGapMs = 10000,
): Topic[] {
  if (segments.length === 0) return []

  const words: { w: string; offset: number }[] = []
  for (const seg of segments) {
    for (const w of normWords(seg.text)) words.push({ w, offset: seg.offset })
  }
  const hay = words.map((x) => x.w)

  const indexOfSeq = (seq: string[], from: number): number => {
    if (seq.length === 0) return -1
    for (let i = from; i + seq.length <= hay.length; i++) {
      let ok = true
      for (let k = 0; k < seq.length; k++) {
        if (hay[i + k] !== seq[k]) {
          ok = false
          break
        }
      }
      if (ok) return i
    }
    return -1
  }

  const topics: Topic[] = []
  let cursor = 0
  for (const c of raw) {
    const title = (c?.title ?? '').trim()
    const needle = normWords(c?.quote ?? '')
    if (!title || needle.length === 0) continue

    // tenta o quote inteiro (≤8) e, se falhar, prefixos cada vez menores
    const lens = [...new Set([Math.min(needle.length, 8), 5, 3])].filter((n) => n <= needle.length)
    let foundAt = -1
    for (const len of lens) {
      foundAt = indexOfSeq(needle.slice(0, len), cursor)
      if (foundAt >= 0) break
    }
    if (foundAt < 0) continue

    topics.push({ offsetMs: words[foundAt].offset, title })
    cursor = foundAt + 1
  }

  // dedup de offsets iguais (offsets são não-decrescentes pelo cursor)
  const deduped: Topic[] = []
  for (const t of topics) {
    if (deduped.length > 0 && deduped[deduped.length - 1].offsetMs === t.offsetMs) continue
    deduped.push(t)
  }
  // 1º capítulo começa em 0 (requisito do YouTube; a distância é medida a partir daqui)
  if (deduped.length > 0) deduped[0] = { ...deduped[0], offsetMs: 0 }

  // near-dedup: capítulos a menos de `minGapMs` do anterior MANTIDO são fundidos
  // (mantém o primeiro do cluster). Default 10s = mínimo de capítulo do YouTube.
  const spaced: Topic[] = []
  for (const t of deduped) {
    if (spaced.length === 0 || t.offsetMs - spaced[spaced.length - 1].offsetMs >= minGapMs) {
      spaced.push(t)
    }
  }

  return spaced
}

/** Monta o arquivo de capítulos: uma linha `M:SS Título` por tema. */
export function buildChaptersText(topics: Topic[]): string {
  return topics.map((t) => `${formatChapterTimestamp(t.offsetMs)} ${t.title}`).join('\n')
}
