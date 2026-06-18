/**
 * Custo por URL.
 *
 * Calcula e formata o custo de processar um vídeo, combinando:
 *  - transcrição: grátis (legendas do YouTube) ou paga (Whisper, por minuto);
 *  - capítulos por tema (--topics): chat da OpenAI, cobrado por token (usa o
 *    `usage` REAL devolvido pela API — não é estimativa).
 *
 * As funções são puras (sem rede/disco) para serem fáceis de testar; o CLI só
 * monta a entrada e grava o `.cost.txt`.
 */

import { type Segment } from '../lib/transcript-utils'

/** Preço dos modelos de chat em US$ por TOKEN (tabela pública da OpenAI). */
const CHAT_PRICING_USD_PER_TOKEN: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15 / 1_000_000, output: 0.6 / 1_000_000 },
  'gpt-4o': { input: 2.5 / 1_000_000, output: 10 / 1_000_000 },
}

/** Preço do Whisper em US$ por minuto de áudio. */
const WHISPER_USD_PER_MINUTE = 0.006

/** Tokens usados numa chamada de chat (subconjunto do `usage` da OpenAI) + modelo. */
export type ChatUsage = {
  model: string
  promptTokens: number
  completionTokens: number
}

/** Custo do chat em US$, ou `null` se o modelo não tiver preço cadastrado. */
export function chatCostUsd(usage: ChatUsage): number | null {
  const price = CHAT_PRICING_USD_PER_TOKEN[usage.model]
  if (!price) return null
  return usage.promptTokens * price.input + usage.completionTokens * price.output
}

/** Custo estimado do Whisper em US$ para uma duração de áudio em ms. */
export function whisperCostUsd(durationMs: number): number {
  return (durationMs / 60_000) * WHISPER_USD_PER_MINUTE
}

/** Duração aproximada do vídeo (ms) a partir do fim do último segmento. */
export function videoDurationMs(segments: Segment[]): number {
  return segments.reduce((max, s) => Math.max(max, s.offset + s.duration), 0)
}

/** Formata US$ com 6 casas (valores são pequenos), ou "desconhecido" se null. */
export function formatUsd(value: number | null): string {
  return value === null ? 'desconhecido' : `US$ ${value.toFixed(6)}`
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}m ${String(s).padStart(2, '0')}s`
}

export type CostReportInput = {
  title: string | null
  url: string
  source: 'YouTube Captions' | 'OpenAI Whisper'
  durationMs: number
  /** `usage` do chat de capítulos; `null` quando os capítulos não foram gerados. */
  usage: ChatUsage | null
}

/** Custo total da URL em US$, ou `null` se algum componente tiver preço desconhecido. */
export function totalCostUsd(input: CostReportInput): number | null {
  const transcription = input.source === 'OpenAI Whisper' ? whisperCostUsd(input.durationMs) : 0
  if (!input.usage) return transcription
  const chapters = chatCostUsd(input.usage)
  return chapters === null ? null : transcription + chapters
}

/** Monta o conteúdo do `.cost.txt` (texto simples e legível). */
export function buildCostReport(input: CostReportInput): string {
  const isWhisper = input.source === 'OpenAI Whisper'
  const transcription = isWhisper ? whisperCostUsd(input.durationMs) : 0
  const chapters = input.usage ? chatCostUsd(input.usage) : 0

  const lines: string[] = [
    'Custo desta URL',
    '===============',
    `Título: ${input.title ?? '(desconhecido)'}`,
    `URL: ${input.url}`,
    `Duração aprox.: ${formatDuration(input.durationMs)}`,
    `Fonte da transcrição: ${input.source}`,
    '',
    isWhisper
      ? `Transcrição (OpenAI Whisper): ${formatUsd(transcription)} (~${(input.durationMs / 60_000).toFixed(1)} min de áudio)`
      : 'Transcrição (YouTube Captions): grátis',
  ]

  if (input.usage) {
    lines.push(
      `Capítulos por tema (${input.usage.model}):`,
      `  Tokens de entrada: ${input.usage.promptTokens}`,
      `  Tokens de saída:   ${input.usage.completionTokens}`,
      `  Custo:             ${formatUsd(chapters)}`,
    )
  } else {
    lines.push('Capítulos por tema: não gerados')
  }

  lines.push('', `TOTAL: ${formatUsd(totalCostUsd(input))}`)
  return lines.join('\n')
}
