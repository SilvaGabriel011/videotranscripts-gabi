import { describe, it, expect } from 'vitest'
import { POST } from '../app/api/transcript/route'

function req(body: unknown): Request {
  return new Request('http://localhost/api/transcript', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

describe('POST /api/transcript', () => {
  it('400 quando falta a url', async () => {
    const res = await POST(req({}))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, error: 'URL ausente' })
  })

  it('422 com erro claro para URL não-YouTube (sem rede)', async () => {
    const res = await POST(req({ url: 'https://example.com/video' }))
    const json = await res.json()
    expect(res.status).toBe(422)
    expect(json.ok).toBe(false)
    expect(String(json.error)).toContain('URL inválida')
  })
})
