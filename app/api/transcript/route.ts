import { extractTranscript } from '@/lib/extractor'
import { buildPlainText, buildSrt, sanitizeFilename } from '@/lib/transcript-utils'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  let body: { url?: string; lang?: string }
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
    return Response.json({
      ok: true,
      title: r.title ?? r.videoId,
      base,
      source: r.source,
      txt: buildPlainText(r.segments),
      srt: buildSrt(r.segments),
    })
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 422 },
    )
  }
}
