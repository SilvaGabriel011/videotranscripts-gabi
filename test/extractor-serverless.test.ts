import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import type { YT } from 'youtubei.js'
import {
  youtubeSessionOptions,
  transcriptToSegments,
  downloadAudioServerless,
  type RawTranscriptSegment,
} from '../lib/extractor'

const MB = 1024 * 1024

describe('youtubeSessionOptions', () => {
  const KEYS = ['YOUTUBE_COOKIE', 'YOUTUBE_VISITOR_DATA', 'YOUTUBE_PO_TOKEN'] as const
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('retorna objeto vazio quando nenhuma variável está definida', () => {
    expect(youtubeSessionOptions()).toEqual({})
  })

  it('inclui apenas o cookie quando só ele está definido (com trim)', () => {
    process.env.YOUTUBE_COOKIE = '  SID=abc; HSID=def  '
    expect(youtubeSessionOptions()).toEqual({ cookie: 'SID=abc; HSID=def' })
  })

  it('ignora valores vazios/em branco', () => {
    process.env.YOUTUBE_COOKIE = '   '
    expect(youtubeSessionOptions()).toEqual({})
  })

  it('inclui visitor_data e po_token quando definidos', () => {
    process.env.YOUTUBE_COOKIE = 'SID=abc'
    process.env.YOUTUBE_VISITOR_DATA = 'visitor123'
    process.env.YOUTUBE_PO_TOKEN = 'po123'
    expect(youtubeSessionOptions()).toEqual({
      cookie: 'SID=abc',
      visitor_data: 'visitor123',
      po_token: 'po123',
    })
  })
})

describe('transcriptToSegments', () => {
  it('mapeia segmentos, decodifica entidades e calcula a duração', () => {
    const raw: RawTranscriptSegment[] = [
      { snippet: { text: 'Olá &amp; bem-vindo' }, start_ms: '0', end_ms: '1500' },
      { snippet: { text: '  segundo trecho  ' }, start_ms: '1500', end_ms: '4000' },
    ]
    expect(transcriptToSegments(raw)).toEqual([
      { text: 'Olá & bem-vindo', offset: 0, duration: 1500 },
      { text: 'segundo trecho', offset: 1500, duration: 2500 },
    ])
  })

  it('ignora cabeçalhos de seção (sem start_ms) e trechos vazios', () => {
    const raw: RawTranscriptSegment[] = [
      { snippet: { text: 'Capítulo 1' } }, // cabeçalho de seção -> ignorado
      { snippet: { text: 'conteúdo' }, start_ms: '2000', end_ms: '3000' },
      { snippet: { text: '   ' }, start_ms: '3000', end_ms: '4000' }, // vazio -> ignorado
    ]
    expect(transcriptToSegments(raw)).toEqual([
      { text: 'conteúdo', offset: 2000, duration: 1000 },
    ])
  })

  it('lança quando não sobra nenhum segmento', () => {
    expect(() => transcriptToSegments([])).toThrow(/Nenhuma legenda/)
    expect(() => transcriptToSegments([{ snippet: { text: 'header' } }])).toThrow(/Nenhuma legenda/)
  })
})

describe('downloadAudioServerless', () => {
  // Fake mínimo de VideoInfo: só chooseFormat + download.
  function fakeInfo(over: {
    format?: { content_length?: number; mime_type?: string }
    chooseThrows?: boolean
  }) {
    return {
      chooseFormat: vi.fn(() => {
        if (over.chooseThrows) throw new Error('No matching formats found')
        return over.format ?? { content_length: 1 * MB, mime_type: 'audio/webm' }
      }),
      download: vi.fn(),
    } as unknown as Pick<YT.VideoInfo, 'chooseFormat' | 'download'> & {
      chooseFormat: ReturnType<typeof vi.fn>
      download: ReturnType<typeof vi.fn>
    }
  }

  it('mensagem clara quando não há formato de áudio (chooseFormat lança)', async () => {
    const info = fakeInfo({ chooseThrows: true })
    await expect(downloadAudioServerless(info, 'x', os.tmpdir())).rejects.toThrow(
      /Nenhum formato de áudio/,
    )
    expect(info.download).not.toHaveBeenCalled()
  })

  it('falha rápida (sem baixar) quando o content_length já passa de 25MB', async () => {
    const info = fakeInfo({ format: { content_length: 30 * MB, mime_type: 'audio/webm' } })
    await expect(downloadAudioServerless(info, 'x', os.tmpdir())).rejects.toThrow(
      /excede o limite de 25MB/,
    )
    expect(info.download).not.toHaveBeenCalled()
  })
})
