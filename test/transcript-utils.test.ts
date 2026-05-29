import { describe, it, expect } from 'vitest'
import {
  extractVideoId,
  decodeHtmlEntities,
  formatTimestamp,
  formatSrtTimestamp,
  sanitizeFilename,
  buildPlainText,
  buildTimestampedText,
  buildSrt,
  formatChapterTimestamp,
  normalizeChapters,
  buildChaptersText,
  type Segment,
} from '../lib/transcript-utils'

describe('extractVideoId', () => {
  it('extrai de URL watch?v=', () => {
    expect(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })

  it('extrai de URL curta youtu.be', () => {
    expect(extractVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })

  it('extrai de URL embed', () => {
    expect(extractVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })

  it('extrai de URL shorts', () => {
    expect(extractVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })

  it('ignora parâmetros extras (timestamp, playlist)', () => {
    expect(extractVideoId('https://youtu.be/dQw4w9WgXcQ?t=30')).toBe('dQw4w9WgXcQ')
    expect(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123')).toBe(
      'dQw4w9WgXcQ',
    )
  })

  it('aceita um ID de 11 caracteres direto', () => {
    expect(extractVideoId('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })

  it('retorna null para URL não-YouTube', () => {
    expect(extractVideoId('https://example.com/video')).toBeNull()
  })

  it('retorna null para string vazia', () => {
    expect(extractVideoId('')).toBeNull()
  })
})

describe('decodeHtmlEntities', () => {
  it('decodifica entidades nomeadas comuns', () => {
    expect(decodeHtmlEntities('it&#39;s a &quot;test&quot; &amp; more')).toBe(
      'it\'s a "test" & more',
    )
  })

  it('decodifica &lt; e &gt;', () => {
    expect(decodeHtmlEntities('a &lt;tag&gt; here')).toBe('a <tag> here')
  })

  it('decodifica entidade numérica decimal', () => {
    expect(decodeHtmlEntities('caf&#233;')).toBe('café')
  })

  it('decodifica entidade numérica hexadecimal', () => {
    expect(decodeHtmlEntities('it&#x27;s')).toBe('it\'s')
  })

  it('deixa texto sem entidades intacto', () => {
    expect(decodeHtmlEntities('texto normal')).toBe('texto normal')
  })
})

describe('formatTimestamp', () => {
  it('formata zero', () => {
    expect(formatTimestamp(0)).toBe('[00:00]')
  })

  it('formata segundos', () => {
    expect(formatTimestamp(32000)).toBe('[00:32]')
  })

  it('formata minutos e segundos', () => {
    expect(formatTimestamp(95000)).toBe('[01:35]')
  })

  it('inclui horas quando passa de 1h', () => {
    expect(formatTimestamp(3661000)).toBe('[1:01:01]')
  })

  it('arredonda para baixo (trunca milissegundos)', () => {
    expect(formatTimestamp(32999)).toBe('[00:32]')
  })
})

describe('sanitizeFilename', () => {
  it('troca espaços por hífens', () => {
    expect(sanitizeFilename('Nunca Vou Te Dar Up')).toBe('Nunca-Vou-Te-Dar-Up')
  })

  it('remove caracteres inválidos de nome de arquivo', () => {
    expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('abcdefghij')
  })

  it('colapsa múltiplos espaços/hífens em um só', () => {
    expect(sanitizeFilename('a   b---c')).toBe('a-b-c')
  })

  it('remove hífens nas pontas', () => {
    expect(sanitizeFilename('  título  ')).toBe('título')
  })

  it('limita o tamanho a 120 caracteres', () => {
    const longo = 'a'.repeat(200)
    expect(sanitizeFilename(longo).length).toBeLessThanOrEqual(120)
  })

  it('retorna string vazia quando só há caracteres inválidos', () => {
    expect(sanitizeFilename('////')).toBe('')
  })
})

describe('buildPlainText', () => {
  it('junta segmentos com espaço', () => {
    const segs: Segment[] = [
      { text: 'Olá pessoal', offset: 0, duration: 1000 },
      { text: 'bem vindo', offset: 1000, duration: 1000 },
    ]
    expect(buildPlainText(segs)).toBe('Olá pessoal bem vindo')
  })

  it('colapsa espaços internos e apara as pontas', () => {
    const segs: Segment[] = [
      { text: '  Olá   ', offset: 0, duration: 1000 },
      { text: ' mundo ', offset: 1000, duration: 1000 },
    ]
    expect(buildPlainText(segs)).toBe('Olá mundo')
  })

  it('retorna string vazia para lista vazia', () => {
    expect(buildPlainText([])).toBe('')
  })
})

describe('buildTimestampedText', () => {
  it('agrupa segmentos contíguos num parágrafo só', () => {
    const segs: Segment[] = [
      { text: 'Olá pessoal', offset: 0, duration: 2000 },
      { text: 'bem vindo', offset: 2000, duration: 2000 },
    ]
    expect(buildTimestampedText(segs)).toBe('[00:00] Olá pessoal bem vindo')
  })

  it('abre novo parágrafo quando o silêncio passa de 1.5s', () => {
    const segs: Segment[] = [
      { text: 'Olá pessoal', offset: 0, duration: 2000 },
      { text: 'bem vindo', offset: 2000, duration: 2000 },
      { text: 'Mas antes', offset: 32000, duration: 1000 },
    ]
    expect(buildTimestampedText(segs)).toBe(
      '[00:00] Olá pessoal bem vindo\n[00:32] Mas antes',
    )
  })

  it('respeita um limiar de gap customizado', () => {
    const segs: Segment[] = [
      { text: 'um', offset: 0, duration: 1000 },
      { text: 'dois', offset: 3000, duration: 1000 },
    ]
    // gap = 2000ms; com limiar 2500 não quebra
    expect(buildTimestampedText(segs, 2500)).toBe('[00:00] um dois')
    // com limiar 1500 quebra
    expect(buildTimestampedText(segs, 1500)).toBe('[00:00] um\n[00:03] dois')
  })

  it('retorna string vazia para lista vazia', () => {
    expect(buildTimestampedText([])).toBe('')
  })
})

describe('buildTimestampedText — legendas auto do YouTube (durações sobrepostas)', () => {
  // Legendas auto têm "janela rolante": a duration estoura o início do próximo
  // segmento, então o gap ingênuo (offset+duration) fica sempre negativo e o
  // texto inteiro colapsa num parágrafo só. Aqui a duração é corrigida para
  // min(duration, próximo.offset - offset) e, quando não há silêncio real,
  // a quebra usa o intervalo start-to-start adaptativo + um teto de parágrafo.

  it('divide por pausa start-to-start quando as durações se sobrepõem (sem silêncio real)', () => {
    const segs: Segment[] = [
      { text: 'a', offset: 0, duration: 3000 }, // dura além do próximo → sobreposição
      { text: 'b', offset: 1500, duration: 3000 },
      { text: 'c', offset: 3000, duration: 9000 }, // fala longa; pausa real começa após
      { text: 'd', offset: 9000, duration: 3000 }, // start-to-start c→d = 6000ms = pausa
      { text: 'e', offset: 10500, duration: 1500 },
    ]
    // Gap ingênuo é negativo em todos → o código antigo daria um parágrafo só.
    // O novo cai no fallback: mediana dos deltas = 1500ms, limiar = max(2500, 2×) = 3000ms;
    // só o delta de 6000ms (c→d) quebra.
    expect(buildTimestampedText(segs)).toBe('[00:00] a b c\n[00:09] d e')
  })

  it('não super-divide quando há sobreposição mas nenhuma pausa grande', () => {
    const segs: Segment[] = [
      { text: 'a', offset: 0, duration: 3000 },
      { text: 'b', offset: 1500, duration: 3000 },
      { text: 'c', offset: 3000, duration: 1500 },
    ]
    expect(buildTimestampedText(segs)).toBe('[00:00] a b c')
  })

  it('o teto de parágrafo força uma quebra num monólogo contínuo sem pausas', () => {
    const segs: Segment[] = [
      { text: 'a', offset: 0, duration: 20000 },
      { text: 'b', offset: 10000, duration: 20000 },
      { text: 'c', offset: 20000, duration: 20000 },
      { text: 'd', offset: 30000, duration: 10000 },
    ]
    // Deltas uniformes (10s) → nenhuma pausa dispara. Com teto de 25s, o 'd'
    // (offset 30000, 30s desde o início do parágrafo) força um novo parágrafo.
    expect(buildTimestampedText(segs, 1500, 25000)).toBe('[00:00] a b c\n[00:30] d')
  })
})

describe('formatSrtTimestamp', () => {
  it('formata zero', () => {
    expect(formatSrtTimestamp(0)).toBe('00:00:00,000')
  })

  it('zero-pad de 3 dígitos nos milissegundos', () => {
    expect(formatSrtTimestamp(80)).toBe('00:00:00,080')
  })

  it('mantém os milissegundos (não trunca como o formatTimestamp)', () => {
    expect(formatSrtTimestamp(1500)).toBe('00:00:01,500')
    expect(formatSrtTimestamp(2240)).toBe('00:00:02,240')
  })

  it('formata minutos e segundos', () => {
    expect(formatSrtTimestamp(95000)).toBe('00:01:35,000')
  })

  it('formata horas com 2 dígitos', () => {
    expect(formatSrtTimestamp(3661123)).toBe('01:01:01,123')
  })
})

describe('buildSrt', () => {
  it('gera cues numerados com início preciso e fim corrigido (legenda rolante)', () => {
    const segs: Segment[] = [
      { text: 'Vamos lá', offset: 80, duration: 4120 },
      { text: 'em 2026', offset: 2240, duration: 3160 },
      { text: 'software', offset: 4200, duration: 2960 },
    ]
    // end_i = offset + min(duration, próximo.offset - offset); último = offset + duration
    expect(buildSrt(segs)).toBe(
      '1\n00:00:00,080 --> 00:00:02,240\nVamos lá\n\n' +
        '2\n00:00:02,240 --> 00:00:04,200\nem 2026\n\n' +
        '3\n00:00:04,200 --> 00:00:07,160\nsoftware',
    )
  })

  it('retorna string vazia para lista vazia', () => {
    expect(buildSrt([])).toBe('')
  })

  it('garante duração mínima de 1ms quando offsets coincidem (cue SRT válido)', () => {
    const segs: Segment[] = [
      { text: 'a', offset: 1000, duration: 5000 },
      { text: 'b', offset: 1000, duration: 2000 },
    ]
    expect(buildSrt(segs)).toBe(
      '1\n00:00:01,000 --> 00:00:01,001\na\n\n' + '2\n00:00:01,000 --> 00:00:03,000\nb',
    )
  })
})

describe('formatChapterTimestamp', () => {
  it('formata zero como 0:00 (sem colchetes)', () => {
    expect(formatChapterTimestamp(0)).toBe('0:00')
  })

  it('formata minutos sem padding no grupo inicial', () => {
    expect(formatChapterTimestamp(154000)).toBe('2:34')
  })

  it('inclui hora quando passa de 1h', () => {
    expect(formatChapterTimestamp(3723000)).toBe('1:02:03')
  })

  it('trunca milissegundos para o segundo cheio', () => {
    expect(formatChapterTimestamp(2999)).toBe('0:02')
  })
})

describe('normalizeChapters', () => {
  const segs: Segment[] = [
    { text: 'a', offset: 80, duration: 2000 },
    { text: 'b', offset: 30000, duration: 2000 },
    { text: 'c', offset: 65000, duration: 2000 },
  ]

  it('ancora cada startSeconds ao offset de segmento mais próximo', () => {
    const raw = [
      { startSeconds: 0, title: 'Intro' },
      { startSeconds: 31, title: 'Meio' }, // 31000ms → mais próximo de 30000
      { startSeconds: 64, title: 'Fim' }, // 64000ms → mais próximo de 65000
    ]
    expect(normalizeChapters(raw, segs)).toEqual([
      { offsetMs: 0, title: 'Intro' },
      { offsetMs: 30000, title: 'Meio' },
      { offsetMs: 65000, title: 'Fim' },
    ])
  })

  it('força o primeiro capítulo a 0 mesmo se a IA não começar do início', () => {
    const raw = [{ startSeconds: 30, title: 'Meio' }]
    expect(normalizeChapters(raw, segs)).toEqual([{ offsetMs: 0, title: 'Meio' }])
  })

  it('ordena por tempo e remove offsets duplicados (mantém o primeiro)', () => {
    const raw = [
      { startSeconds: 65, title: 'Fim' },
      { startSeconds: 30, title: 'Meio' },
      { startSeconds: 31, title: 'Duplicado de Meio' }, // ancora no mesmo 30000
    ]
    expect(normalizeChapters(raw, segs)).toEqual([
      { offsetMs: 0, title: 'Meio' },
      { offsetMs: 65000, title: 'Fim' },
    ])
  })

  it('descarta capítulos com título vazio', () => {
    const raw = [
      { startSeconds: 0, title: '  ' },
      { startSeconds: 30, title: 'Meio' },
    ]
    expect(normalizeChapters(raw, segs)).toEqual([{ offsetMs: 0, title: 'Meio' }])
  })

  it('retorna lista vazia quando não há segmentos', () => {
    expect(normalizeChapters([{ startSeconds: 0, title: 'x' }], [])).toEqual([])
  })
})

describe('buildChaptersText', () => {
  it('monta uma linha "M:SS Título" por capítulo', () => {
    const text = buildChaptersText([
      { offsetMs: 0, title: 'Introdução' },
      { offsetMs: 154000, title: 'Ferramentas de IA' },
      { offsetMs: 3723000, title: 'Conclusão' },
    ])
    expect(text).toBe('0:00 Introdução\n2:34 Ferramentas de IA\n1:02:03 Conclusão')
  })

  it('retorna string vazia para lista vazia', () => {
    expect(buildChaptersText([])).toBe('')
  })
})
