/**
 * Segmentação de vídeo por temas (capítulos via IA).
 *
 * Recebe os segmentos da transcrição e usa um modelo de chat da OpenAI para
 * identificar os temas/seções do vídeo. O modelo devolve, por capítulo, as
 * primeiras palavras verbatim (`quote`) + um `title`; o TEMPO é resolvido por
 * `resolveChaptersByQuote`, que localiza o quote nos segmentos cronometrados —
 * assim o tempo vem do dado (preciso), não de um número chutado pelo modelo.
 *
 * Requer OPENAI_API_KEY (a mesma usada pelo fallback Whisper). Acionado pela
 * flag --topics do CLI.
 */

import {
  buildPlainText,
  resolveChaptersByQuote,
  type Segment,
  type Topic,
} from '../lib/transcript-utils'
import { type ChatUsage } from './cost'

type RawChapter = { quote: string; title: string }

/** Resultado da segmentação: capítulos + uso real de tokens (para o custo). */
export type SegmentTopicsResult = { chapters: Topic[]; usage: ChatUsage }

const SYSTEM_PROMPT = [
  'Você é um editor que divide vídeos em capítulos por tema, no estilo dos',
  '"capítulos" da descrição do YouTube.',
  'A entrada é a transcrição COMPLETA do vídeo em texto corrido (sem marcas de tempo).',
  'Leia a transcrição INTEIRA, do começo ao fim, e identifique os temas/seções DISTINTOS em ordem cronológica.',
  'Produza entre 8 e 15 capítulos COBRINDO O VÍDEO INTEIRO de forma equilibrada — distribuídos do',
  'início ao fim, SEM deixar grandes trechos no meio sem capítulo e SEM amontoar capítulos só no começo ou no fim.',
  'Para cada capítulo devolva:',
  '- `quote`: as PRIMEIRAS 4 a 8 PALAVRAS, copiadas LITERALMENTE da transcrição, exatamente do ponto onde aquele tema começa. Copie igualzinho ao texto (mesmas palavras, mesma ordem, como aparece na transcrição); NÃO reescreva, NÃO resuma, NÃO traduza, NÃO inclua tempo. O quote PRECISA existir literalmente no texto.',
  '- `title`: título curto e descritivo (3 a 6 palavras), no MESMO idioma da transcrição.',
  'Regras: ordem cronológica sem sobreposição; o primeiro capítulo é a abertura do vídeo;',
  'evite micro-capítulos (não gere dezenas de seções minúsculas).',
].join('\n')

const CHAPTERS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          quote: { type: 'string' },
          title: { type: 'string' },
        },
        required: ['quote', 'title'],
      },
    },
  },
  required: ['chapters'],
} as const

/**
 * Gera capítulos por tema para um conjunto de segmentos.
 * Lança Error (mensagem clara) se faltar a chave ou se a resposta for inválida.
 */
export async function segmentTopics(
  segments: Segment[],
  opts: { lang?: string; videoTitle?: string | null; model?: string } = {},
): Promise<SegmentTopicsResult> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY não definida. A flag --topics usa a API da OpenAI; configure a chave (.env) — veja .env.example.',
    )
  }
  const model = opts.model || process.env.OPENAI_TOPICS_MODEL || 'gpt-4o-mini'
  if (segments.length === 0) {
    return { chapters: [], usage: { model, promptTokens: 0, completionTokens: 0 } }
  }

  const { default: OpenAI } = await import('openai')
  const client = new OpenAI({ apiKey })

  const transcript = buildPlainText(segments)
  const header = opts.videoTitle ? `Título do vídeo: ${opts.videoTitle}\n\n` : ''
  const userPrompt = `${header}Transcrição (texto corrido):\n\n${transcript}`

  const resp = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'chapters', strict: true, schema: CHAPTERS_SCHEMA },
    },
  })

  const content = resp.choices[0]?.message?.content
  if (!content) throw new Error('Resposta vazia do modelo ao gerar capítulos')

  let parsed: { chapters?: RawChapter[] }
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error('Não foi possível interpretar a resposta do modelo (JSON inválido)')
  }

  const usage: ChatUsage = {
    model,
    promptTokens: resp.usage?.prompt_tokens ?? 0,
    completionTokens: resp.usage?.completion_tokens ?? 0,
  }
  return { chapters: resolveChaptersByQuote(parsed.chapters ?? [], segments), usage }
}
