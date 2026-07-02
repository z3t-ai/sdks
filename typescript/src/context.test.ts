import { describe, it, expect, vi, afterEach } from 'vitest'
import { extractId, createCallContext } from './context'
import type { ResolvedConfig, WsSend } from './types'

const noop = () => { }
const silentLogger = { info: noop, warn: noop, error: noop }

const mockLlm = {
  openai: {} as never,
  anthropic: {} as never,
  google: {} as never,
}

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    apiKey: 'agent-key',
    relayUrls: [],
    baseUrl: 'https://relay.z3t.ai/v1',
    timeout: 25_000,
    maxConcurrentCalls: 10,
    reconnectDelay: 1_000,
    maxReconnectDelay: 60_000,
    logger: silentLogger,
    ...overrides,
  }
}

describe('extractId', () => {
  it('extracts ID from z3t://files/{id}', () => {
    expect(extractId('z3t://files/abc123')).toBe('abc123')
  })

  it('extracts ID from z3t://taxonomies/{id}', () => {
    expect(extractId('z3t://taxonomies/xyz789')).toBe('xyz789')
  })

  it('extracts ID from z3t://integrations/{id}', () => {
    expect(extractId('z3t://integrations/int-42')).toBe('int-42')
  })

  it('throws on invalid URI', () => {
    expect(() => extractId('not-a-z3t-uri')).toThrow('Invalid z3t URI')
  })
})

describe('ctx.progress', () => {
  it('sends correct WS frame with progress value', async () => {
    const sent: unknown[] = []
    const send: WsSend = (msg) => sent.push(msg)
    const ctx = createCallContext('call-1', 1, send, makeConfig(), mockLlm)

    await ctx.progress('extracting_text', 'Extracting text...', 0.35)

    expect(sent[0]).toEqual({
      type: 'progress',
      callId: 'call-1',
      step: 'extracting_text',
      message: 'Extracting text...',
      progress: 0.35,
    })
  })

  it('omits progress field when not provided', async () => {
    const sent: unknown[] = []
    const ctx = createCallContext('call-1', 1, (m) => sent.push(m), makeConfig(), mockLlm)

    await ctx.progress('step', 'message')

    expect(sent[0]).not.toHaveProperty('progress')
  })
})

describe('ctx.files.download', () => {
  afterEach(() => vi.restoreAllMocks())

  it('fetches agent-url then downloads from signed URL', async () => {
    const fileContent = Buffer.from('hello world')

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/files/abc/agent-url')) {
        return new Response(JSON.stringify({
          signedUrl: 'https://spaces.example.com/file',
          filename: 'hello.txt',
          mimeType: 'text/plain',
        }))
      }
      return new Response(fileContent)
    })

    const ctx = createCallContext('call-1', 1, noop, makeConfig(), mockLlm)
    const result = await ctx.files.download('z3t://files/abc')

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/files/abc/agent-url')
    expect(String(fetchSpy.mock.calls[1][0])).toBe('https://spaces.example.com/file')
    expect(result.buffer).toEqual(fileContent)
    expect(result.filename).toBe('hello.txt')
    expect(result.mimeType).toBe('text/plain')
  })
})

describe('ctx.files.upload', () => {
  afterEach(() => vi.restoreAllMocks())

  it('calls prepare → PUT signedUrl → confirm and returns internalUri', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts) => {
      const urlStr = String(url)
      if (urlStr.includes('/files/agent-output/prepare')) {
        return new Response(JSON.stringify({
          fileId: 'file-id-1',
          uploadUrl: 'https://spaces.example.com/upload',
          internalUri: 'z3t://files/file-id-1',
        }))
      }
      if (urlStr.includes('spaces.example.com') && (opts?.method === 'PUT')) {
        return new Response('', { status: 200 })
      }
      if (urlStr.includes('/files/agent-output/confirm')) {
        return new Response(JSON.stringify({ internalUri: 'z3t://files/file-id-1' }))
      }
      throw new Error(`Unexpected URL: ${urlStr}`)
    })

    const ctx = createCallContext('call-1', 1, noop, makeConfig(), mockLlm)
    const result = await ctx.files.upload(Buffer.from('data'), 'test.pdf', 'application/pdf')

    expect(result).toBe('z3t://files/file-id-1')
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })
})

describe('ctx.taxonomies', () => {
  afterEach(() => vi.restoreAllMocks())

  it('entries fetches GET /taxonomies/{id}/entries', async () => {
    const entries = [{ key: 'k1', value: 'v1' }, { key: 'k2', value: 'v2' }]
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ entries })),
    )

    const ctx = createCallContext('call-1', 1, noop, makeConfig(), mockLlm)
    const result = await ctx.taxonomies.entries('z3t://taxonomies/tax-1')

    expect(result).toEqual(entries)
  })

  it('lookup returns null on 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('not found', { status: 404 }),
    )

    const ctx = createCallContext('call-1', 1, noop, makeConfig(), mockLlm)
    const result = await ctx.taxonomies.lookup('z3t://taxonomies/tax-1', 'missing-key')

    expect(result).toBeNull()
  })
})

describe('ctx.integrations.credentials', () => {
  afterEach(() => vi.restoreAllMocks())

  it('fetches GET /integrations/{id}/credentials', async () => {
    const creds = { apiKey: 'secret-key' }
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(creds)),
    )

    const ctx = createCallContext('call-1', 1, noop, makeConfig(), mockLlm)
    const result = await ctx.integrations.credentials('z3t://integrations/int-1')

    expect(result).toEqual(creds)
  })
})

describe('ctx.agents.call', () => {
  afterEach(() => vi.restoreAllMocks())

  it('posts to /agents/call with capabilities: [] and returns output', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ output: { status: 'done' } })),
    )

    const ctx = createCallContext('call-1', 1, noop, makeConfig(), mockLlm)
    const result = await ctx.agents.call('agent-abc', 'plan-1', { x: 1 })

    const fetchCall = vi.mocked(fetch).mock.calls[0]
    const body = JSON.parse(fetchCall[1]?.body as string)
    expect(body.capabilities).toEqual([])
    expect(body.agentId).toBe('agent-abc')
    expect(result).toEqual({ status: 'done' })
  })

  it('never includes progress in capabilities', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ output: {} })),
    )

    const ctx = createCallContext('call-1', 1, noop, makeConfig(), mockLlm)
    await ctx.agents.call('agent-x', 'plan-x', {})

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)
    expect(body.capabilities).not.toContain('progress')
  })
})
