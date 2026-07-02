import { describe, it, expect, afterEach, vi } from 'vitest'
import { Agent } from '../../src/agent'
import { createMockRelay, type MockRelay } from '../helpers/mock-relay'

const noop = () => {}
const silentLogger = { info: noop, warn: noop, error: noop }

describe('ctx.agents.call()', () => {
  let relay: MockRelay
  let agent: Agent

  afterEach(async () => {
    agent?.stop()
    await relay?.close()
    vi.restoreAllMocks()
  })

  it('sends capabilities: [] (never includes progress)', async () => {
    relay = createMockRelay()
    agent = new Agent({
      apiKey: 'test-key',
      relayUrls: [`ws://localhost:${relay.port}`],
      logger: silentLogger,
      timeout: 2_000,
    })

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ output: { status: 'ok' } })),
    )

    agent.handle(async (_, ctx) => {
      return ctx.agents.call('other-agent', 'plan-1', { x: 1 })
    })
    agent.start()

    await vi.waitUntil(
      () => relay.received.some((m: unknown) => (m as Record<string, string>).type === 'auth'),
      { timeout: 1000 },
    )

    relay.dispatch('call-agent', {})

    await vi.waitUntil(
      () => relay.received.some((m: unknown) => (m as Record<string, string>).type === 'result'),
      { timeout: 2000 },
    )

    // Verify the HTTP body sent to /agents/call
    const fetchCall = vi.mocked(fetch).mock.calls[0]
    const body = JSON.parse(fetchCall[1]?.body as string)
    expect(body.capabilities).toEqual([])
    expect(body.capabilities).not.toContain('progress')
    expect(body.agentId).toBe('other-agent')
    expect(body.planId).toBe('plan-1')
  })

  it('passes schemaVersion and consumerOrgId when provided', async () => {
    relay = createMockRelay()
    agent = new Agent({
      apiKey: 'test-key',
      relayUrls: [`ws://localhost:${relay.port}`],
      logger: silentLogger,
      timeout: 2_000,
    })

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ output: {} })),
    )

    agent.handle(async (_, ctx) => {
      return ctx.agents.call('agent-x', 'plan-x', {}, {
        schemaVersion: 3,
        consumerOrgId: 'org-abc',
      })
    })
    agent.start()

    await vi.waitUntil(
      () => relay.received.some((m: unknown) => (m as Record<string, string>).type === 'auth'),
      { timeout: 1000 },
    )

    relay.dispatch('call-agent2', {})

    await vi.waitUntil(
      () => relay.received.some((m: unknown) => (m as Record<string, string>).type === 'result'),
      { timeout: 2000 },
    )

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)
    expect(body.schemaVersion).toBe(3)
    expect(body.consumerOrgId).toBe('org-abc')
  })
})
