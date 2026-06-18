import * as fs from 'node:fs'
import * as path from 'node:path'

export type OutputFiles = {
  txt: string
  srt: string
  /** Capítulos por tópico (.chapters.txt), só quando gerados. */
  chapters?: string
  /** Relatório de custo (.cost.txt), só quando capítulos rodaram. */
  cost?: string
}

/**
 * Salva os arquivos de um vídeo em `dir` (criando a pasta se preciso), resolvendo
 * um nome-base único — anexa " (2)", " (3)"... se já existir um `.txt`/`.srt` com
 * o mesmo nome. Retorna os nomes de arquivo gravados.
 *
 * É a "cópia de backup" no projeto; o chamador decide se trata falhas como fatais
 * (no nosso caso, não são — o download no navegador é a entrega principal).
 */
export function saveOutputs(dir: string, base: string, files: OutputFiles): string[] {
  fs.mkdirSync(dir, { recursive: true })

  const safeBase = base || 'transcript'
  const free = (stem: string) =>
    !fs.existsSync(path.join(dir, `${stem}.txt`)) && !fs.existsSync(path.join(dir, `${stem}.srt`))

  let stem = safeBase
  if (!free(stem)) {
    let n = 2
    while (!free(`${safeBase} (${n})`)) n++
    stem = `${safeBase} (${n})`
  }

  const written: string[] = []
  const writeFile = (name: string, content: string) => {
    fs.writeFileSync(path.join(dir, name), content + '\n', 'utf-8')
    written.push(name)
  }

  writeFile(`${stem}.txt`, files.txt)
  writeFile(`${stem}.srt`, files.srt)
  if (files.chapters) writeFile(`${stem}.chapters.txt`, files.chapters)
  if (files.cost) writeFile(`${stem}.cost.txt`, files.cost)

  return written
}
