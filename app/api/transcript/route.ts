import * as path from 'node:path'
import { extractTranscript } from '@/lib/extractor'
import { buildPlainText, buildSrt, sanitizeFilename, buildChaptersText } from '@/lib/transcript-utils'
import { saveOutputs } from '@/lib/save-outputs'
import { segmentTopics } from '@/scripts/topic-segmenter'
import { buildCostReport, totalCostUsd, videoDurationMs, type CostReportInput } from '@/scripts/cost'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Teto de execução da função. 60s funciona em TODOS os planos da Vercel (inclusive Hobby);
// definir acima do limite do plano FAZ O DEPLOY FALHAR. A extração de legenda (caso comum)
// é rápida; no Pro/Enterprise dá pra subir até 300 para vídeos longos via Whisper.
export const maxDuration = 60

/** Pasta de backup no projeto (gitignored). */
const OUTPUT_DIR = 'output'

type SuccessPayload = {
  ok: true
  title: string
  base: string
  source: string
  txt: string
  srt: string
  /** Capítulos por tópico (gpt-4o-mini), só quando `topics` foi pedido e gerou capítulos. */
  chapters?: string
  /** Relatório de custo da URL, quando `topics` rodou. */
  cost?: string
  /** Custo total da URL em US$ (ou null se algum componente tiver preço desconhecido). */
  costUsd?: number | null
  /** Mensagem de erro se a geração de capítulos/custo falhar (não derruba txt/srt). */
  topicsError?: string
  /** Pasta onde a cópia de backup foi salva no servidor (relativa ao projeto). */
  savedTo?: string
  /** Mensagem se o backup no servidor falhar (não derruba o download). */
  backupError?: string
}

export async function POST(request: Request): Promise<Response> {
  let body: { url?: string; lang?: string; topics?: boolean }
  try {
    body = await request.json()
  } catch {
    return Response.json({ ok: false, error: 'JSON inválido' }, { status: 400 })
  }

  const url = (body.url ?? '').trim()
  if (!url) {
    return Response.json({ ok: false, error: 'URL ausente' }, { status: 400 })
  }

  try {
    const r = await extractTranscript(url, { lang: body.lang })
    const base = (r.title ? sanitizeFilename(r.title) : '') || r.videoId

    const payload: SuccessPayload = {
      ok: true,
      title: r.title ?? r.videoId,
      base,
      source: r.source,
      txt: buildPlainText(r.segments),
      srt: buildSrt(r.segments),
    }

    // Capítulos por tópico (opt-in). Falha aqui não derruba txt/srt.
    if (body.topics) {
      try {
        const { chapters, usage } = await segmentTopics(r.segments, {
          lang: body.lang,
          videoTitle: r.title,
        })
        if (chapters.length > 0) payload.chapters = buildChaptersText(chapters)

        const costInput: CostReportInput = {
          title: r.title,
          url,
          source: r.source,
          durationMs: videoDurationMs(r.segments),
          usage,
        }
        payload.cost = buildCostReport(costInput)
        payload.costUsd = totalCostUsd(costInput)
      } catch (topicErr) {
        payload.topicsError = topicErr instanceof Error ? topicErr.message : String(topicErr)
      }
    }

    // Backup no projeto (best-effort): além do download, grava os arquivos em output/.
    // Falha aqui (ex.: FS read-only em serverless) não derruba o download.
    try {
      saveOutputs(path.join(process.cwd(), OUTPUT_DIR), base, {
        txt: payload.txt,
        srt: payload.srt,
        chapters: payload.chapters,
        cost: payload.cost,
      })
      payload.savedTo = OUTPUT_DIR
    } catch (saveErr) {
      payload.backupError = saveErr instanceof Error ? saveErr.message : String(saveErr)
    }

    return Response.json(payload)
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 422 },
    )
  }
}
