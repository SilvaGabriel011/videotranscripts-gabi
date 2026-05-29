/**
 * Segmentação de vídeo por temas (capítulos via IA).
 *
 * Recebe os segmentos da transcrição e usa um modelo de chat da OpenAI para
 * identificar os temas/seções do vídeo, devolvendo capítulos com timestamp
 * (estilo "capítulos" da descrição do YouTube). Os timestamps retornados pela IA
 * são ancorados a segmentos reais por `normalizeChapters`, então o resultado não
 * depende da precisão temporal do modelo — só do bom senso editorial dele.
 *
 * Requer OPENAI_API_KEY (a mesma usada pelo fallback Whisper). Acionado pela
 * flag --topics do CLI.
 */

import {
  buildTimestampedText,
  normalizeChapters,
  type Segment,
  type Topic,
} from './transcript-utils.ts'

type RawChapter = { startSeconds: number; title: string }

const SYSTEM_PROMPT = [
  'Você é um editor que divide vídeos em capítulos por tema, no estilo dos',
  '"capítulos" da descrição do YouTube.',
  'A entrada é a transcrição do vídeo com âncoras de tempo no formato [MM:SS] ou [H:MM:SS].',
  'Identifique os temas/seções DISTINTOS do vídeo e produza um capítulo por tema.',
  'Regras:',
  '- Capítulos em ordem cronológica, sem sobreposição.',
  '- `startSeconds` é o início do tema em SEGUNDOS, derivado das âncoras de tempo da transcrição.',
  '- O primeiro capítulo começa em 0.',
  '- Títulos curtos e descritivos (3 a 6 palavras), no MESMO idioma da transcrição.',
  '- Evite granularidade excessiva: prefira seções de tamanho razoável a dezenas de micro-capítulos.',
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
          startSeconds: { type: 'integer', minimum: 0 },
          title: { type: 'string' },
        },
        required: ['startSeconds', 'title'],
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
): Promise<Topic[]> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY não definida. A flag --topics usa a API da OpenAI; configure a chave (.env) — veja .env.example.',
    )
  }
  if (segments.length === 0) return []

  const { default: OpenAI } = await import('openai')
  const client = new OpenAI({ apiKey })
  const model = opts.model || process.env.OPENAI_TOPICS_MODEL || 'gpt-4o-mini'

  const transcript = buildTimestampedText(segments)
  const header = opts.videoTitle ? `Título do vídeo: ${opts.videoTitle}\n\n` : ''
  const userPrompt = `${header}Transcrição com âncoras de tempo:\n\n${transcript}`

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

  return normalizeChapters(parsed.chapters ?? [], segments)
}
