/**
 * YouTube Transcript Extractor
 *
 * Recebe uma ou mais URLs do YouTube e gera um .txt por vídeo, nomeado pelo
 * título do vídeo. Dois modos por vídeo:
 *   1. Legendas do YouTube (sem API key) via `youtubei.js` (API InnerTube)
 *   2. Fallback: baixa o áudio e transcreve via OpenAI Whisper. Local usa yt-dlp +
 *      ffmpeg (suporta vídeos longos); sem eles, baixa via youtubei.js (requer OPENAI_API_KEY)
 *
 * Uso:
 *   npx tsx scripts/youtube-transcript.ts "https://youtu.be/ID1" "https://youtu.be/ID2"
 *   npx tsx scripts/youtube-transcript.ts --lang pt "https://youtu.be/ID"
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  sanitizeFilename,
  buildPlainText,
  buildSrt,
  buildChaptersText,
  type Segment,
} from '../lib/transcript-utils'
import { extractTranscript } from '../lib/extractor'
import { segmentTopics } from './topic-segmenter'
import {
  buildCostReport,
  totalCostUsd,
  videoDurationMs,
  formatUsd,
  type CostReportInput,
} from './cost'

type ProcessResult =
  | { url: string; status: 'ok'; file: string; source: string; costUsd?: number | null }
  | { url: string; status: 'erro'; reason: string }

// ---------------------------------------------------------------------------
// Metadados / nome de arquivo
// ---------------------------------------------------------------------------

/** Diretório-base onde cada vídeo ganha sua própria subpasta. */
const OUTPUT_BASE = path.join(process.cwd(), 'output')

/**
 * Cria (se preciso) uma subpasta dedicada ao vídeo dentro de `output/` e
 * retorna o "stem" (caminho sem extensão) dos artefatos dentro dela.
 *
 * A unicidade é por PASTA: se `output/<título>/` já existir, usa
 * `output/<título> (2)/`, `(3)`... Os arquivos dentro mantêm o nome do vídeo,
 * então o set fica auto-descritivo mesmo se a pasta for movida/compartilhada.
 */
function resolveOutputStem(baseDir: string, baseName: string): string {
  const safeBase = baseName || 'transcript'
  const free = (folder: string) => !fs.existsSync(path.join(baseDir, folder))
  let folderName = safeBase
  if (!free(folderName)) {
    let n = 2
    while (!free(`${safeBase} (${n})`)) n++
    folderName = `${safeBase} (${n})`
  }
  const dir = path.join(baseDir, folderName)
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, safeBase)
}

// ---------------------------------------------------------------------------
// Saída
// ---------------------------------------------------------------------------

/**
 * Escreve os dois artefatos do vídeo:
 *   - `<stem>.txt` — texto corrido limpo (leitura/cópia)
 *   - `<stem>.srt` — legenda sincronizada linha-a-linha (abre em qualquer player)
 * Retorna os nomes dos arquivos gerados.
 */
function writeOutputs(stem: string, segments: Segment[]): { txt: string; srt: string } {
  const txtPath = `${stem}.txt`
  const srtPath = `${stem}.srt`
  fs.writeFileSync(txtPath, buildPlainText(segments) + '\n', 'utf-8')
  fs.writeFileSync(srtPath, buildSrt(segments) + '\n', 'utf-8')
  return { txt: path.basename(txtPath), srt: path.basename(srtPath) }
}

// ---------------------------------------------------------------------------
// Processamento de uma URL
// ---------------------------------------------------------------------------

async function processOne(
  url: string,
  lang: string | undefined,
  topics: boolean,
): Promise<ProcessResult> {
  let result
  try {
    result = await extractTranscript(url, { lang })
  } catch (err) {
    return { url, status: 'erro', reason: err instanceof Error ? err.message : String(err) }
  }

  const baseName = result.title ? sanitizeFilename(result.title) : ''
  const stem = resolveOutputStem(OUTPUT_BASE, baseName || result.videoId)
  const out = writeOutputs(stem, result.segments)

  const preview = buildPlainText(result.segments).slice(0, 200)
  console.log(
    `   ✓ ${out.txt} + ${out.srt} (${result.segments.length} segmentos, fonte: ${result.source})`,
  )
  console.log(`     "${preview}${preview.length >= 200 ? '...' : ''}"`)

  let chaptersFile: string | undefined
  let costFile: string | undefined
  let costUsd: number | null | undefined
  if (topics) {
    try {
      const { chapters, usage } = await segmentTopics(result.segments, {
        lang,
        videoTitle: result.title,
      })
      if (chapters.length > 0) {
        const chaptersPath = `${stem}.chapters.txt`
        fs.writeFileSync(chaptersPath, buildChaptersText(chapters) + '\n', 'utf-8')
        chaptersFile = path.basename(chaptersPath)
        console.log(`   ✓ ${chaptersFile} (${chapters.length} capítulos por tema)`)
      } else {
        console.log('   ⚠ temas: nenhum capítulo gerado')
      }

      // Relatório de custo desta URL (custo REAL via `usage` da OpenAI).
      const costInput: CostReportInput = {
        title: result.title,
        url,
        source: result.source,
        durationMs: videoDurationMs(result.segments),
        usage,
      }
      const costPath = `${stem}.cost.txt`
      fs.writeFileSync(costPath, buildCostReport(costInput) + '\n', 'utf-8')
      costFile = path.basename(costPath)
      costUsd = totalCostUsd(costInput)
      console.log(`   ✓ ${costFile} (custo: ${formatUsd(costUsd)})`)
    } catch (topicErr) {
      console.log(`   ⚠ temas: ${topicErr instanceof Error ? topicErr.message : String(topicErr)}`)
    }
  }

  const names = [out.txt, out.srt, chaptersFile, costFile].filter(Boolean).join(' + ')
  return { url, status: 'ok', file: names, source: result.source, costUsd }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { lang?: string; topics: boolean; urls: string[] } {
  let lang: string | undefined
  let topics = false
  const urls: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--lang') {
      lang = argv[++i]
    } else if (arg.startsWith('--lang=')) {
      lang = arg.slice('--lang='.length)
    } else if (arg === '--topics') {
      topics = true
    } else if (arg.startsWith('--')) {
      console.warn(`Flag desconhecida ignorada: ${arg}`)
    } else {
      urls.push(arg)
    }
  }
  return { lang, topics, urls }
}

function printUsage(): void {
  console.log(
    [
      'Uso: tsx scripts/youtube-transcript.ts [--lang <código>] [--topics] <url> [url2 ...]',
      '',
      'Exemplos:',
      '  tsx scripts/youtube-transcript.ts "https://youtu.be/dQw4w9WgXcQ"',
      '  tsx scripts/youtube-transcript.ts --lang pt "https://youtu.be/ID1" "https://youtu.be/ID2"',
      '  tsx scripts/youtube-transcript.ts --topics "https://youtu.be/ID"',
      '',
      '--topics gera também <Título>.chapters.txt (capítulos por tema via IA) e requer OPENAI_API_KEY.',
      'O fallback Whisper (vídeos sem legenda) requer OPENAI_API_KEY, yt-dlp e ffmpeg.',
    ].join('\n'),
  )
}

async function main(): Promise<void> {
  const { lang, topics, urls } = parseArgs(process.argv.slice(2))

  if (urls.length === 0) {
    printUsage()
    process.exitCode = 1
    return
  }

  const results: ProcessResult[] = []
  for (let i = 0; i < urls.length; i++) {
    console.log(`\n[${i + 1}/${urls.length}] Processando ${urls[i]}`)
    try {
      results.push(await processOne(urls[i], lang, topics))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({ url: urls[i], status: 'erro', reason: msg })
      console.log(`   ✗ Erro: ${msg}`)
    }
  }

  // Resumo final
  const ok = results.filter((r): r is Extract<ProcessResult, { status: 'ok' }> => r.status === 'ok')
  const fail = results.filter(
    (r): r is Extract<ProcessResult, { status: 'erro' }> => r.status === 'erro',
  )

  console.log('\n' + '='.repeat(60))
  console.log(`RESUMO: ${ok.length} ok, ${fail.length} falha(s)`)
  if (ok.length > 0) {
    console.log('\n✓ Transcritos:')
    for (const r of ok) console.log(`   ${r.file}  (${r.source})`)

    const withCost = ok.filter((r) => r.costUsd !== undefined)
    if (withCost.length > 0) {
      const known = withCost.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)
      const hasUnknown = withCost.some((r) => r.costUsd === null)
      console.log(
        `\n💲 Custo total (IA): ${formatUsd(known)}${hasUnknown ? ' + parte desconhecida' : ''}`,
      )
    }
  }
  if (fail.length > 0) {
    console.log('\n✗ Falhas:')
    for (const r of fail) console.log(`   ${r.url}\n      ${r.reason}`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('Erro fatal:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
