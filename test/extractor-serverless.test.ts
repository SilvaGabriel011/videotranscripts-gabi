import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mocka o ytdl-core ANTES de importar o módulo sob teste. A factory é auto-contida
// (sem referenciar variáveis externas) por causa do hoisting do vi.mock.
vi.mock('@distube/ytdl-core', () => ({
  default: {
    getInfo: vi.fn(),
    chooseFormat: vi.fn(),
    downloadFromInfo: vi.fn(),
    createAgent: vi.fn((cookies: unknown) => ({ agent: true, cookies })),
  },
}))

import * as os from 'node:os'
import ytdl from '@distube/ytdl-core'
import { buildYtdlAgent, downloadAudioServerless } from '../lib/extractor'

const MB = 1024 * 1024

describe('buildYtdlAgent', () => {
  const original = process.env.YOUTUBE_COOKIE
  // ytdl mockado só pra capturar a chamada de createAgent.
  const fakeYtdl = { createAgent: vi.fn((c: unknown) => ({ ok: true, c })) }

  beforeEach(() => {
    fakeYtdl.createAgent.mockClear()
    delete process.env.YOUTUBE_COOKIE
  })
  afterEach(() => {
    if (original === undefined) delete process.env.YOUTUBE_COOKIE
    else process.env.YOUTUBE_COOKIE = original
  })

  it('retorna undefined quando YOUTUBE_COOKIE não está definido', () => {
    expect(buildYtdlAgent(fakeYtdl as never)).toBeUndefined()
    expect(fakeYtdl.createAgent).not.toHaveBeenCalled()
  })

  it('retorna undefined (sem lançar) quando o cookie é JSON inválido', () => {
    process.env.YOUTUBE_COOKIE = 'isto não é json'
    expect(buildYtdlAgent(fakeYtdl as never)).toBeUndefined()
    expect(fakeYtdl.createAgent).not.toHaveBeenCalled()
  })

  it('cria o agent a partir do array JSON de cookies', () => {
    const cookies = [{ name: 'SID', value: 'abc', domain: '.youtube.com' }]
    process.env.YOUTUBE_COOKIE = JSON.stringify(cookies)
    const agent = buildYtdlAgent(fakeYtdl as never)
    expect(fakeYtdl.createAgent).toHaveBeenCalledWith(cookies)
    expect(agent).toEqual({ ok: true, c: cookies })
  })
})

describe('downloadAudioServerless', () => {
  beforeEach(() => {
    vi.mocked(ytdl.getInfo).mockReset()
    vi.mocked(ytdl.chooseFormat).mockReset()
    vi.mocked(ytdl.downloadFromInfo).mockReset()
    delete process.env.YOUTUBE_COOKIE
  })

  it('embrulha falha do getInfo com dica de bloqueio de IP / YOUTUBE_COOKIE', async () => {
    vi.mocked(ytdl.getInfo).mockRejectedValue(new Error("Sign in to confirm you're not a bot"))
    await expect(downloadAudioServerless('https://youtu.be/x', 'x', os.tmpdir())).rejects.toThrow(
      /YOUTUBE_COOKIE/,
    )
    await expect(
      downloadAudioServerless('https://youtu.be/x', 'x', os.tmpdir()),
    ).rejects.toThrow(/ytdl-core/)
  })

  it('mensagem clara quando não há formato de áudio (chooseFormat lança)', async () => {
    vi.mocked(ytdl.getInfo).mockResolvedValue({ formats: [] } as never)
    vi.mocked(ytdl.chooseFormat).mockImplementation(() => {
      throw new Error('No such format found: lowestaudio')
    })
    await expect(
      downloadAudioServerless('https://youtu.be/x', 'x', os.tmpdir()),
    ).rejects.toThrow(/Nenhum formato de áudio/)
  })

  it('falha rápida (sem baixar) quando o contentLength já passa de 25MB', async () => {
    vi.mocked(ytdl.getInfo).mockResolvedValue({ formats: [{}] } as never)
    vi.mocked(ytdl.chooseFormat).mockReturnValue({
      container: 'webm',
      contentLength: String(30 * MB),
    } as never)

    await expect(
      downloadAudioServerless('https://youtu.be/x', 'x', os.tmpdir()),
    ).rejects.toThrow(/excede o limite de 25MB/)
    // Não deve nem tentar baixar.
    expect(ytdl.downloadFromInfo).not.toHaveBeenCalled()
  })
})
