import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// ── helpers ──────────────────────────────────────────────────────────────────

const TMP = join(tmpdir(), 'gbrain-keepalive-test-' + Date.now())
const LOG_FILE = join(TMP, 'keepalive.log')

beforeEach(() => {
  mkdirSync(TMP, { recursive: true })
  if (existsSync(LOG_FILE)) rmSync(LOG_FILE)
})

// We test the pingHealth function by importing the module and injecting
// a mock fetch. The module exports pingHealth(baseUrl, logFile).

async function runPing(fetchImpl: typeof fetch, warm = true, status = 200): Promise<import('../scripts/keepalive.ts').KeepaliveLog> {
  // Temporarily replace global fetch
  const orig = globalThis.fetch
  globalThis.fetch = mock(async (url: string) => {
    if (String(url).includes('/search')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 }) as Response
    }
    return new Response(
      JSON.stringify({ ok: true, warm, status: 'ok' }),
      { status }
    ) as Response
  }) as unknown as typeof fetch

  try {
    const { pingHealth } = await import('../scripts/keepalive.ts')
    return await pingHealth('http://localhost:4242', LOG_FILE)
  } finally {
    globalThis.fetch = orig
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('keepalive pingHealth', () => {
  it('returns correct KeepaliveLog shape on success', async () => {
    const log = await runPing(fetch, true, 200)

    expect(log.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(log.status).toBe(200)
    expect(typeof log.latency_ms).toBe('number')
    expect(log.latency_ms).toBeGreaterThanOrEqual(0)
    expect(log.warm).toBe(true)
    expect(log.error).toBeUndefined()
  })

  it('warm=false triggers warmed_up flag (extra /search ping)', async () => {
    const calls: string[] = []
    const orig = globalThis.fetch
    globalThis.fetch = mock(async (url: string) => {
      calls.push(String(url))
      return new Response(JSON.stringify({ ok: true, warm: false }), { status: 200 }) as Response
    }) as unknown as typeof fetch

    try {
      const { pingHealth } = await import('../scripts/keepalive.ts')
      const log = await pingHealth('http://localhost:4242', LOG_FILE)
      expect(log.warmed_up).toBe(true)
      expect(calls.some(u => u.includes('/search'))).toBe(true)
    } finally {
      globalThis.fetch = orig
    }
  })

  it('records error field on fetch failure', async () => {
    const orig = globalThis.fetch
    globalThis.fetch = mock(async () => { throw new Error('network error') }) as unknown as typeof fetch

    try {
      const { pingHealth } = await import('../scripts/keepalive.ts')
      const log = await pingHealth('http://localhost:4242', LOG_FILE)
      expect(log.error).toContain('network error')
      expect(log.status).toBe(0)
    } finally {
      globalThis.fetch = orig
    }
  })

  it('writes JSONL log to file', async () => {
    await runPing(fetch, true, 200)
    expect(existsSync(LOG_FILE)).toBe(true)
    const lines = readFileSync(LOG_FILE, 'utf8').trim().split('\n')
    expect(lines.length).toBeGreaterThanOrEqual(1)
    const entry = JSON.parse(lines[0])
    expect(entry).toHaveProperty('timestamp')
    expect(entry).toHaveProperty('latency_ms')
    expect(entry).toHaveProperty('status')
  })
})
