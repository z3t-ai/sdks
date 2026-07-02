import { describe, it, expect, afterEach, vi } from 'vitest'
import { Agent } from '../../src/agent'
import { s } from '../../src/schema'
import { createMockRelay, type MockRelay } from '../helpers/mock-relay'

const noop = () => {}
const silentLogger = { info: noop, warn: noop, error: noop }

function makeAgent(port: number, overrides = {}) {
  return new Agent({
    apiKey: 'test-key',
    relayUrls: [`ws://localhost:${port}`],
    logger: silentLogger,
    timeout: 2_000,
    ...overrides,
  })
}

describe('Agent lifecycle', () => {
  let relay: MockRelay
  let agent: Agent

  afterEach(async () => {
    agent?.stop()
    await relay?.close()
  })

  it('connects to relay and sends auth message', async () => {
    relay = createMockRelay()
    agent = makeAgent(relay.port)
    agent.start()

    await vi.waitUntil(() => relay.received.some((m: unknown) => (m as Record<string, string>).type === 'auth'), { timeout: 1000 })
    expect(relay.received).toContainEqual(expect.objectContaining({ type: 'auth', apiKey: 'test-key' }))
  })

  it('dispatches call to handler and sends result back', async () => {
    relay = createMockRelay()
    agent = makeAgent(relay.port)
    agent.handle(async (input) => ({ echoed: (input as Record<string, unknown>).value }))
    agent.start()

    // Wait for auth
    await vi.waitUntil(
      () => relay.received.some((m: unknown) => (m as Record<string, string>).type === 'auth'),
      { timeout: 1000 },
    )

    relay.dispatch('call-1', { value: 42 })

    await vi.waitUntil(
      () => relay.received.some((m: unknown) => (m as Record<string, string>).type === 'result'),
      { timeout: 2000 },
    )

    const result = relay.received.find((m: unknown) => (m as Record<string, string>).type === 'result')
    expect(result).toMatchObject({ type: 'result', callId: 'call-1', output: { echoed: 42 } })
  })

  it('sends error frame when handler throws', async () => {
    relay = createMockRelay()
    agent = makeAgent(relay.port)
    agent.handle(async () => { throw new Error('handler blew up') })
    agent.start()

    await vi.waitUntil(
      () => relay.received.some((m: unknown) => (m as Record<string, string>).type === 'auth'),
      { timeout: 1000 },
    )

    relay.dispatch('call-err', {})

    await vi.waitUntil(
      () => relay.received.some((m: unknown) => (m as Record<string, string>).type === 'error'),
      { timeout: 2000 },
    )

    const err = relay.received.find((m: unknown) => (m as Record<string, string>).type === 'error')
    expect(err).toMatchObject({ type: 'error', callId: 'call-err', message: 'handler blew up' })
  })

  it('sends error frame on handler timeout', async () => {
    relay = createMockRelay()
    agent = makeAgent(relay.port, { timeout: 100 })
    agent.handle(() => new Promise(() => {})) // never resolves
    agent.start()

    await vi.waitUntil(
      () => relay.received.some((m: unknown) => (m as Record<string, string>).type === 'auth'),
      { timeout: 1000 },
    )

    relay.dispatch('call-timeout', {})

    await vi.waitUntil(
      () => relay.received.some((m: unknown) => (m as Record<string, string>).type === 'error'),
      { timeout: 1000 },
    )

    const err = relay.received.find((m: unknown) => (m as Record<string, string>).type === 'error')
    expect(err).toMatchObject({ type: 'error', callId: 'call-timeout', message: 'Handler timeout' })
  })

  it('reconnects after relay closes', async () => {
    relay = createMockRelay()
    agent = makeAgent(relay.port, { reconnectDelay: 50 })
    agent.start()

    // Wait for first auth
    await vi.waitUntil(
      () => relay.received.some((m: unknown) => (m as Record<string, string>).type === 'auth'),
      { timeout: 1000 },
    )

    const authsBefore = relay.received.filter((m: unknown) => (m as Record<string, string>).type === 'auth').length

    // Force disconnect all connected clients — triggers agent reconnect
    relay.closeConnections()

    // Wait for re-auth
    await vi.waitUntil(
      () => relay.received.filter((m: unknown) => (m as Record<string, string>).type === 'auth').length > authsBefore,
      { timeout: 2000 },
    )
    expect(relay.received.filter((m: unknown) => (m as Record<string, string>).type === 'auth').length).toBeGreaterThan(authsBefore)
  })

  it('handles maxConcurrentCalls: queues third call when two are in-flight', async () => {
    relay = createMockRelay()
    agent = makeAgent(relay.port, { maxConcurrentCalls: 2, timeout: 2000 })

    const resolvers: Array<() => void> = []
    agent.handle(async () => {
      await new Promise<void>((res) => resolvers.push(res))
      return 'done'
    })
    agent.start()

    await vi.waitUntil(
      () => relay.received.some((m: unknown) => (m as Record<string, string>).type === 'auth'),
      { timeout: 1000 },
    )

    relay.dispatch('c1', {})
    relay.dispatch('c2', {})
    relay.dispatch('c3', {})

    // Give it time to process
    await new Promise((res) => setTimeout(res, 100))

    // Only 2 in-flight; c3 is queued — no result for c3 yet
    const results = relay.received.filter((m: unknown) => (m as Record<string, string>).type === 'result')
    expect(results).toHaveLength(0) // none resolved yet

    // Resolve both in-flight calls
    resolvers[0]()
    resolvers[1]()

    await vi.waitUntil(
      () => relay.received.filter((m: unknown) => (m as Record<string, string>).type === 'result').length >= 2,
      { timeout: 2000 },
    )

    // c3 now runs
    resolvers[2]?.()

    await vi.waitUntil(
      () => relay.received.filter((m: unknown) => (m as Record<string, string>).type === 'result').length >= 3,
      { timeout: 2000 },
    )

    const resultIds = relay.received
      .filter((m: unknown) => (m as Record<string, string>).type === 'result')
      .map((m: unknown) => (m as Record<string, string>).callId)
    expect(resultIds).toContain('c1')
    expect(resultIds).toContain('c2')
    expect(resultIds).toContain('c3')
  })

  it('syncs declared schemas to /schema-sync, defaulting status to draft', async () => {
    relay = createMockRelay()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, syncedVersions: [1], deprecatedVersions: [], versions: [{ version: 1, status: 'draft' }] }),
    } as Response)

    agent = makeAgent(relay.port)
    agent.handle(1, {
      input: s.object({ q: s.string() }),
      output: s.object({ a: s.string() }),
    }, async () => ({ a: 'ok' }))
    agent.start()

    await vi.waitUntil(() => fetchSpy.mock.calls.length > 0, { timeout: 1000 })

    const [url, opts] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain('/schema-sync')
    const body = JSON.parse((opts as RequestInit).body as string)
    expect(body.versions).toEqual([
      expect.objectContaining({ version: 1, status: 'draft' }),
    ])

    await vi.waitUntil(() => relay.received.some((m: unknown) => (m as Record<string, string>).type === 'auth'), { timeout: 1000 })
  })

  it('syncs an explicit status: active schema', async () => {
    relay = createMockRelay()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, syncedVersions: [1], deprecatedVersions: [], versions: [{ version: 1, status: 'active' }] }),
    } as Response)

    agent = makeAgent(relay.port)
    agent.handle(1, {
      input: s.object({ q: s.string() }),
      output: s.object({ a: s.string() }),
      status: 'active',
    }, async () => ({ a: 'ok' }))
    agent.start()

    await vi.waitUntil(() => fetchSpy.mock.calls.length > 0, { timeout: 1000 })

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)
    expect(body.versions).toEqual([
      expect.objectContaining({ version: 1, status: 'active' }),
    ])
  })
})
