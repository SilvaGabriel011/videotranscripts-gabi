'use client'

import { useMemo, useState } from 'react'
import JSZip from 'jszip'

type Phase = 'idle' | 'confirming' | 'running' | 'done'
type ItemStatus = 'fila' | 'processando' | 'ok' | 'erro'
type Item = {
  url: string
  status: ItemStatus
  title?: string
  source?: string
  error?: string
  base?: string
  txt?: string
  srt?: string
}

/** Remove espaços e descarta campos vazios, preservando a ordem. */
function cleanUrls(inputs: string[]): string[] {
  return inputs.map((u) => u.trim()).filter((u) => u.length > 0)
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
  const [urlInputs, setUrlInputs] = useState<string[]>([''])
  const [phase, setPhase] = useState<Phase>('idle')
  const [items, setItems] = useState<Item[]>([])

  const urls = useMemo(() => cleanUrls(urlInputs), [urlInputs])
  const doneCount = items.filter((i) => i.status === 'ok' || i.status === 'erro').length

  function setInput(index: number, value: string) {
    setUrlInputs((prev) => prev.map((u, i) => (i === index ? value : u)))
  }
  function addInput() {
    setUrlInputs((prev) => [...prev, ''])
  }
  function removeInput(index: number) {
    // Mantém sempre ao menos um campo (vazio) na tela.
    setUrlInputs((prev) => (prev.length === 1 ? [''] : prev.filter((_, i) => i !== index)))
  }

  function openConfirm() {
    setItems(urls.map((url) => ({ url, status: 'fila' })))
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
          body: JSON.stringify({ url: collected[i].url }),
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
      <p className="muted">Adicione uma ou mais URLs do YouTube. Gera .txt (texto) + .srt (legenda) por vídeo.</p>

      <div className="url-list">
        {urlInputs.map((value, idx) => (
          <div className="url-row" key={idx}>
            <input
              type="url"
              className="url-input"
              value={value}
              onChange={(e) => setInput(idx, e.target.value)}
              placeholder="https://www.youtube.com/watch?v=..."
            />
            <button
              type="button"
              className="icon-btn"
              onClick={() => removeInput(idx)}
              disabled={urlInputs.length === 1 && value.trim() === ''}
              aria-label="Remover esta URL"
              title="Remover"
            >
              −
            </button>
          </div>
        ))}
        <button type="button" className="secondary add-btn" onClick={addInput}>
          + Adicionar URL
        </button>
      </div>

      <div>
        <button onClick={openConfirm} disabled={urls.length === 0}>
          Baixar transcripts{urls.length > 0 ? ` (${urls.length})` : ''}
        </button>
      </div>

      {phase === 'confirming' && (
        <div className="overlay">
          <div className="modal">
            <h2>Confirmar execução</h2>
            <p>
              Vou processar <strong>{items.length}</strong> vídeo(s) em fila. As legendas saem na
              hora; vídeos sem legenda tentam Whisper (local).
            </p>
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
              {phase === 'running' ? 'Processando' : 'Concluído'} ({doneCount}/{items.length})
            </h2>
            {items.map((it, idx) => (
              <div className="row" key={idx}>
                <StatusBadge item={it} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {it.title || it.url}
                </span>
              </div>
            ))}
            {phase === 'done' && (
              <>
                <p className="muted">
                  O ZIP com os sucessos foi baixado automaticamente. Falhas não entram no ZIP.
                </p>
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
    return <span className="status-ok" title={item.source}>✓ {item.source}</span>
  return (
    <span className="status-erro" title={item.error}>
      ✗ {item.error}
    </span>
  )
}
