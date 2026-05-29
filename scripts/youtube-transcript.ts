/**
 * YouTube Transcript Extractor
 *
 * Recebe uma ou mais URLs do YouTube e gera um .txt por vídeo, nomeado pelo
 * título do vídeo. Dois modos por vídeo:
 *   1. Legendas do YouTube (sem API key) via `youtube-transcript`
 *   2. Fallback: baixa o áudio com yt-dlp e transcreve via OpenAI Whisper
 *      (requer OPENAI_API_KEY + yt-dlp + ffmpeg instalados)
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

type ProcessResult =
  | { url: string; status: 'ok'; file: string; source: string }
  | { url: string; status: 'erro'; reason: string }

// ---------------------------------------------------------------------------
// Metadados / nome de arquivo
// ---------------------------------------------------------------------------

/**
 * Resolve um nome-base único (sem extensão) onde nem `.txt` nem `.srt` existam,
 * anexando " (2)", " (3)"... se preciso — assim os dois arquivos do mesmo vídeo
 * compartilham o mesmo nome.
 */
function resolveOutputStem(dir: string, baseName: string): string {
  const safeBase = baseName || 'transcript'
  const free = (stem: string) =>
    !fs.existsSync(path.join(dir, `${stem}.txt`)) && !fs.existsSync(path.join(dir, `${stem}.srt`))
  if (free(safeBase)) return path.join(dir, safeBase)
  let n = 2
  while (!free(`${safeBase} (${n})`)) n++
  return path.join(dir, `${safeBase} (${n})`)
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
  const stem = resolveOutputStem(process.cwd(), baseName || result.videoId)
  const out = writeOutputs(stem, result.segments)

  const preview = buildPlainText(result.segments).slice(0, 200)
  console.log(
    `   ✓ ${out.txt} + ${out.srt} (${result.segments.length} segmentos, fonte: ${result.source})`,
  )
  console.log(`     "${preview}${preview.length >= 200 ? '...' : ''}"`)

  let chaptersFile: string | undefined
  if (topics) {
    try {
      const chapters = await segmentTopics(result.segments, { lang, videoTitle: result.title })
      if (chapters.length > 0) {
        const chaptersPath = `${stem}.chapters.txt`
        fs.writeFileSync(chaptersPath, buildChaptersText(chapters) + '\n', 'utf-8')
        chaptersFile = path.basename(chaptersPath)
        console.log(`   ✓ ${chaptersFile} (${chapters.length} capítulos por tema)`)
      } else {
        console.log('   ⚠ temas: nenhum capítulo gerado')
      }
    } catch (topicErr) {
      console.log(`   ⚠ temas: ${topicErr instanceof Error ? topicErr.message : String(topicErr)}`)
    }
  }

  const names = chaptersFile
    ? `${out.txt} + ${out.srt} + ${chaptersFile}`
    : `${out.txt} + ${out.srt}`
  return { url, status: 'ok', file: names, source: result.source }
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
