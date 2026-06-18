'use client'

import { useMemo, useState } from 'react'
import JSZip from 'jszip'

type Phase = 'idle' | 'confirming' | 'running' | 'done'
type ItemStatus = 'fila' | 'processando' | 'ok' | 'erro'

/** Um campo de entrada: a URL e se gera capítulos por tópico (IA) para ela. */
type UrlField = { url: string; topics: boolean }

type Item = {
  url: string
  topics: boolean
  status: ItemStatus
  title?: string
  source?: string
  error?: string
  base?: string
  txt?: string
  srt?: string
  chapters?: string
  cost?: string
  costUsd?: number | null
  topicsError?: string
  savedTo?: string
  backupError?: string
}

/** Formata US$ (6 casas, valores pequenos); 'desconhecido' quando o preço é null. */
function fmtUsd(value: number | null): string {
  return value === null ? 'desconhecido' : `US$ ${value.toFixed(6)}`
}

/** Garante nomes-base únicos no ZIP, anexando " (2)", " (3)"... em colisões. */
function uniqueBase(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let n = 2
  while (used.has(`${base} (${n})`)) n++
  const result = `${base} (${n})`
  used.add(result)
  return result
}

export default function Page() {
  const [fields, setFields] = useState<UrlField[]>([{ url: '', topics: false }])
  const [phase, setPhase] = useState<Phase>('idle')
  const [items, setItems] = useState<Item[]>([])

  const active = useMemo(() => fields.filter((f) => f.url.trim().length > 0), [fields])
  const topicsCount = active.filter((f) => f.topics).length

  const total = items.length
  const doneCount = items.filter((i) => i.status === 'ok' || i.status === 'erro').length
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0

  // Custo total do batch (só itens que rodaram capítulos têm costUsd definido).
  const costItems = items.filter((i) => i.status === 'ok' && i.costUsd !== undefined)
  const knownCost = costItems.reduce((s, i) => s + (typeof i.costUsd === 'number' ? i.costUsd : 0), 0)
  const hasUnknownCost = costItems.some((i) => i.costUsd === null)

  // Backup no servidor (pasta do projeto).
  const savedDir = items.find((i) => i.status === 'ok' && i.savedTo)?.savedTo
  const backupFailed = items.some((i) => i.status === 'ok' && i.backupError)

  function setUrl(index: number, value: string) {
    setFields((prev) => prev.map((f, i) => (i === index ? { ...f, url: value } : f)))
  }
  function toggleTopics(index: number) {
    setFields((prev) => prev.map((f, i) => (i === index ? { ...f, topics: !f.topics } : f)))
  }
  function addField() {
    setFields((prev) => [...prev, { url: '', topics: false }])
  }
  function removeField(index: number) {
    // Mantém sempre ao menos um campo (vazio) na tela.
    setFields((prev) =>
      prev.length === 1 ? [{ url: '', topics: false }] : prev.filter((_, i) => i !== index),
    )
  }

  function openConfirm() {
    setItems(active.map((f) => ({ url: f.url.trim(), topics: f.topics, status: 'fila' })))
    setPhase('confirming')
  }

  function cancel() {
    setPhase('idle')
    setItems([])
  }

  async function run() {
    setPhase('running')
    const collected: Item[] = items.map((i) => ({ ...i }))

    for (let i = 0; i < collected.length; i++) {
      collected[i] = { ...collected[i], status: 'processando' }
      setItems([...collected])
      try {
        const res = await fetch('/api/transcript', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: collected[i].url, topics: collected[i].topics }),
        })
        const json = await res.json()
        if (json.ok) {
          collected[i] = {
            ...collected[i],
            status: 'ok',
            title: json.title,
            source: json.source,
            base: json.base,
            txt: json.txt,
            srt: json.srt,
            chapters: json.chapters,
            cost: json.cost,
            costUsd: json.costUsd,
            topicsError: json.topicsError,
            savedTo: json.savedTo,
            backupError: json.backupError,
          }
        } else {
          collected[i] = { ...collected[i], status: 'erro', error: json.error ?? 'erro desconhecido' }
        }
      } catch (err) {
        collected[i] = {
          ...collected[i],
          status: 'erro',
          error: err instanceof Error ? err.message : String(err),
        }
      }
      setItems([...collected])
    }

    await buildAndDownloadZip(collected)
    setPhase('done')
  }

  async function buildAndDownloadZip(finished: Item[]) {
    const ok = finished.filter((i) => i.status === 'ok')
    if (ok.length === 0) return
    const zip = new JSZip()
    const used = new Set<string>()
    for (const it of ok) {
      const base = uniqueBase(it.base || 'transcript', used)
      zip.file(`${base}.txt`, (it.txt ?? '') + '\n')
      zip.file(`${base}.srt`, (it.srt ?? '') + '\n')
      if (it.chapters) zip.file(`${base}.chapters.txt`, it.chapters + '\n')
      if (it.cost) zip.file(`${base}.cost.txt`, it.cost + '\n')
    }
    const blob = await zip.generateAsync({ type: 'blob' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'transcripts.zip'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(a.href)
  }

  return (
    <main className="container">
      <h1>YouTube Transcript</h1>
      <p className="muted">
        Adicione uma ou mais URLs. Gera .txt (texto) + .srt (legenda) por vídeo. Marque{' '}
        <strong>capítulos</strong> num vídeo para também gerar capítulos por tópico (IA, com custo).
      </p>

      <div className="url-list">
        {fields.map((f, idx) => (
          <div className="url-row" key={idx}>
            <input
              type="url"
              className="url-input"
              value={f.url}
              onChange={(e) => setUrl(idx, e.target.value)}
              placeholder="https://www.youtube.com/watch?v=..."
            />
            <label
              className="chip"
              title="Divide o vídeo em capítulos por tema (estilo dos capítulos da descrição do YouTube), usando IA (gpt-4o-mini). Adiciona .chapters.txt + .cost.txt ao ZIP. Tem custo por vídeo."
            >
              <input type="checkbox" checked={f.topics} onChange={() => toggleTopics(idx)} />
              <span>capítulos</span>
            </label>
            <button
              type="button"
              className="icon-btn"
              onClick={() => removeField(idx)}
              disabled={fields.length === 1 && f.url.trim() === ''}
              aria-label="Remover esta URL"
              title="Remover"
            >
              −
            </button>
          </div>
        ))}
        <button type="button" className="secondary add-btn" onClick={addField}>
          + Adicionar URL
        </button>
      </div>

      <div>
        <button onClick={openConfirm} disabled={active.length === 0}>
          Baixar transcripts{active.length > 0 ? ` (${active.length})` : ''}
        </button>
      </div>

      {phase === 'confirming' && (
        <div className="overlay">
          <div className="modal">
            <h2>Confirmar execução</h2>
            <p>
              Vou processar <strong>{active.length}</strong> vídeo(s) em fila. As legendas saem na
              hora; vídeos sem legenda tentam Whisper (local).
            </p>
            {topicsCount > 0 && (
              <p className="muted">
                <strong>{topicsCount}</strong> com capítulos por tópico: cada um faz uma chamada paga
                ao gpt-4o-mini.
              </p>
            )}
            <div className="actions">
              <button className="secondary" onClick={cancel}>
                Cancelar
              </button>
              <button onClick={run}>Confirmar</button>
            </div>
          </div>
        </div>
      )}

      {(phase === 'running' || phase === 'done') && (
        <div className="overlay">
          <div className="modal">
            <h2>
              {phase === 'running' ? 'Processando' : 'Concluído'} ({doneCount}/{total})
            </h2>

            <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>

            {items.map((it, idx) => (
              <div className="row" key={idx}>
                <div className="row-main">
                  <StatusBadge item={it} />
                  <span className="row-title">{it.title || it.url}</span>
                  {it.topics && <span className="row-tag">capítulos</span>}
                </div>
                {it.status === 'processando' && <div className="bar-indeterminate" />}
                {it.status === 'erro' && it.error && <ErrorPanel raw={it.error} />}
                {it.status === 'ok' && it.topicsError && (
                  <ErrorPanel raw={it.topicsError} label="Capítulos não gerados" />
                )}
              </div>
            ))}

            {phase === 'done' && (
              <>
                {costItems.length > 0 && (
                  <p className="muted">
                    💲 Custo total (IA): {fmtUsd(knownCost)}
                    {hasUnknownCost ? ' + parte desconhecida' : ''}
                  </p>
                )}
                <p className="muted">
                  O ZIP com os sucessos foi baixado automaticamente. Falhas não entram no ZIP.
                </p>
                {savedDir && (
                  <p className="muted">
                    📁 Backup salvo na pasta <strong>{savedDir}/</strong> do projeto.
                  </p>
                )}
                {backupFailed && (
                  <p className="status-erro">
                    ⚠ O backup no servidor falhou em algum vídeo (o download não foi afetado).
                  </p>
                )}
                <div className="actions">
                  <button className="secondary" onClick={cancel}>
                    Fechar
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </main>
  )
}

function StatusBadge({ item }: { item: Item }) {
  if (item.status === 'fila') return <span className="status-fila">• na fila</span>
  if (item.status === 'processando') return <span className="status-proc">⟳ processando…</span>
  if (item.status === 'ok')
    return (
      <span className="status-ok" title={item.source}>
        ✓ {item.source}
      </span>
    )
  return (
    <span className="status-erro" title={item.error}>
      ✗ falhou
    </span>
  )
}

/**
 * Traduz o erro técnico da API numa mensagem clara e acionável, preservando o texto cru
 * em `detail` (mostrado num "ver detalhe"). A ordem importa: casos específicos primeiro.
 */
function friendlyError(raw?: string): { title: string; hint?: string; detail: string } {
  const detail = (raw ?? '').trim()
  const low = detail.toLowerCase()
  if (!detail) return { title: 'Erro desconhecido.', detail: '' }

  if (low.includes('openai_api_key') || low.includes('chave da openai') || low.includes('api key não')) {
    return {
      title: 'Chave da OpenAI ausente.',
      hint: 'Crie um arquivo .env na raiz com OPENAI_API_KEY=sk-... (veja .env.example) e rode o app de novo.',
      detail,
    }
  }
  if (
    low.includes('incorrect api key') ||
    low.includes('invalid_api_key') ||
    (low.includes('api key') && low.includes('invalid')) ||
    low.includes('401')
  ) {
    return {
      title: 'Chave da OpenAI inválida.',
      hint: 'Confira o valor de OPENAI_API_KEY no .env (deve começar com sk-).',
      detail,
    }
  }
  if (
    low.includes('insufficient_quota') ||
    low.includes('quota') ||
    low.includes('429') ||
    low.includes('rate limit') ||
    low.includes('billing') ||
    low.includes('exceeded')
  ) {
    return {
      title: 'Limite ou saldo da OpenAI excedido.',
      hint: 'Verifique saldo, billing e limites de uso na plataforma da OpenAI.',
      detail,
    }
  }
  if (low.includes('url inválida')) {
    return { title: 'URL inválida.', hint: 'Cole o link de um vídeo do YouTube.', detail }
  }
  if (low.includes('yt-dlp') || low.includes('ffmpeg')) {
    return {
      title: 'Falta yt-dlp/ffmpeg para processar o áudio.',
      hint: 'Rode o setup (setup.sh / setup.ps1) ou instale yt-dlp e ffmpeg para transcrever vídeos sem legenda.',
      detail,
    }
  }
  if (
    low.includes('no valid url to decipher') ||
    low.includes('nenhum formato de áudio') ||
    low.includes('failed to get player') ||
    low.includes('youtubei.js')
  ) {
    return {
      title: 'O YouTube bloqueou o acesso ao vídeo/áudio.',
      hint: 'Comum em servidores (IP de data center). Rode localmente ou configure YOUTUBE_COOKIE.',
      detail,
    }
  }
  if (low.includes('legenda:') && low.includes('whisper:')) {
    return {
      title: 'Sem legenda e o Whisper falhou.',
      hint: 'O vídeo não tem legenda e a transcrição por áudio não foi possível — veja o detalhe.',
      detail,
    }
  }
  if (low.includes('transcrição vazia') || low.includes('legenda vazia')) {
    return { title: 'A transcrição veio vazia.', detail }
  }
  return { title: 'Falha ao processar este vídeo.', detail }
}

/** Painel de erro legível: mensagem clara + dica + detalhe técnico recolhível. */
function ErrorPanel({ raw, label }: { raw: string; label?: string }) {
  const { title, hint, detail } = friendlyError(raw)
  return (
    <div className="error-panel" role="alert">
      <div className="error-title">
        ⚠ {label ? `${label}: ` : ''}
        {title}
      </div>
      {hint && <div className="error-hint">{hint}</div>}
      {detail && detail !== title && (
        <details className="error-detail">
          <summary>Ver detalhe técnico</summary>
          <code>{detail}</code>
        </details>
      )}
    </div>
  )
}
