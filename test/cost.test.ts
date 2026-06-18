import { describe, it, expect } from 'vitest'
import {
  chatCostUsd,
  whisperCostUsd,
  videoDurationMs,
  formatUsd,
  totalCostUsd,
  buildCostReport,
} from '../scripts/cost'
import { type Segment } from '../lib/transcript-utils'

describe('chatCostUsd', () => {
  it('calcula custo do gpt-4o-mini por token', () => {
    // 1000 in * 0.15/1M + 500 out * 0.60/1M = 0.00015 + 0.0003 = 0.00045
    expect(chatCostUsd({ model: 'gpt-4o-mini', promptTokens: 1000, completionTokens: 500 })).toBeCloseTo(
      0.00045,
      10,
    )
  })

  it('calcula custo do gpt-4o por token', () => {
    // 1000 in * 2.5/1M + 500 out * 10/1M = 0.0025 + 0.005 = 0.0075
    expect(chatCostUsd({ model: 'gpt-4o', promptTokens: 1000, completionTokens: 500 })).toBeCloseTo(
      0.0075,
      10,
    )
  })

  it('retorna null para modelo sem preço cadastrado', () => {
    expect(chatCostUsd({ model: 'modelo-novo-xyz', promptTokens: 1000, completionTokens: 500 })).toBeNull()
  })
})

describe('whisperCostUsd', () => {
  it('cobra US$0.006 por minuto', () => {
    expect(whisperCostUsd(600_000)).toBeCloseTo(0.06, 10) // 10 min
  })

  it('é proporcional à duração', () => {
    expect(whisperCostUsd(60_000)).toBeCloseTo(0.006, 10) // 1 min
  })
})

describe('videoDurationMs', () => {
  it('usa o fim do último segmento', () => {
    const segs: Segment[] = [
      { text: 'a', offset: 0, duration: 2000 },
      { text: 'b', offset: 2000, duration: 3000 },
    ]
    expect(videoDurationMs(segs)).toBe(5000)
  })

  it('retorna 0 para lista vazia', () => {
    expect(videoDurationMs([])).toBe(0)
  })
})

describe('formatUsd', () => {
  it('formata com 6 casas', () => {
    expect(formatUsd(0.00045)).toBe('US$ 0.000450')
  })

  it('mostra "desconhecido" para null', () => {
    expect(formatUsd(null)).toBe('desconhecido')
  })
})

describe('totalCostUsd', () => {
  const usage = { model: 'gpt-4o-mini', promptTokens: 1000, completionTokens: 500 }

  it('legendas grátis: total = só os capítulos', () => {
    expect(
      totalCostUsd({ title: 't', url: 'u', source: 'YouTube Captions', durationMs: 600_000, usage }),
    ).toBeCloseTo(0.00045, 10)
  })

  it('whisper: soma transcrição + capítulos', () => {
    expect(
      totalCostUsd({ title: 't', url: 'u', source: 'OpenAI Whisper', durationMs: 600_000, usage }),
    ).toBeCloseTo(0.06 + 0.00045, 10)
  })

  it('sem capítulos: total = só transcrição', () => {
    expect(
      totalCostUsd({ title: 't', url: 'u', source: 'OpenAI Whisper', durationMs: 600_000, usage: null }),
    ).toBeCloseTo(0.06, 10)
  })

  it('modelo sem preço → total desconhecido (null)', () => {
    expect(
      totalCostUsd({
        title: 't',
        url: 'u',
        source: 'YouTube Captions',
        durationMs: 600_000,
        usage: { model: 'xyz', promptTokens: 1, completionTokens: 1 },
      }),
    ).toBeNull()
  })
})

describe('buildCostReport', () => {
  it('relatório de legendas (grátis) + capítulos', () => {
    const report = buildCostReport({
      title: 'Meu Vídeo',
      url: 'https://youtu.be/abc',
      source: 'YouTube Captions',
      durationMs: 154_000, // 2m 34s
      usage: { model: 'gpt-4o-mini', promptTokens: 2000, completionTokens: 200 },
    })
    expect(report).toContain('Título: Meu Vídeo')
    expect(report).toContain('Duração aprox.: 2m 34s')
    expect(report).toContain('Transcrição (YouTube Captions): grátis')
    expect(report).toContain('Tokens de entrada: 2000')
    expect(report).toContain('TOTAL: US$ 0.000420') // 2000*0.15/1M + 200*0.6/1M = 0.00042
  })

  it('relatório com Whisper inclui o custo do áudio', () => {
    const report = buildCostReport({
      title: null,
      url: 'https://youtu.be/abc',
      source: 'OpenAI Whisper',
      durationMs: 600_000,
      usage: { model: 'gpt-4o-mini', promptTokens: 0, completionTokens: 0 },
    })
    expect(report).toContain('Título: (desconhecido)')
    expect(report).toContain('Transcrição (OpenAI Whisper): US$ 0.060000')
  })
})
