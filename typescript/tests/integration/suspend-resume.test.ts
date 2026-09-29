import { describe, it, expect, afterEach, vi } from 'vitest'
import { Agent } from '../../src/agent'
import { s } from '../../src/schema'
import { createMockRelay, type MockRelay } from '../helpers/mock-relay'

const noop = () => {}
const silentLogger = { info: noop, warn: noop, error: noop }
type Frame = Record<string, any>

// The whole round trip over a real WebSocket: one agent process asks and exits the turn; the relay
// hands the journal to a DIFFERENT agent process (a restart, another replica), which picks up where
// the first left off without redoing the paid-for work.

describe('suspend → resume across agent processes', () => {
  let relay: MockRelay
  const agents: Agent[] = []

  afterEach(async () => {
    for (const a of agents) a.stop()
    agents.length = 0
    await relay?.close()
  })

  function startAgent(extract: () => Promise<unknown>) {
    const agent = new Agent({ apiKey: 'k', relayUrls: [`ws://localhost:${relay.port}`], logger: silentLogger, timeout: 2_000 })
    agent.handle(async (_input, ctx) => {
      await ctx.progress('reading', 'Reading your documents')
      const facts = await ctx.step('extract', extract)
      const answer = await ctx.ask<{ contractNumber?: string }>('contract', {
        message: 'Invoice 3 names contract **CX-12**, which was not uploaded. What is its number?',
        schema: s.object({ contractNumber: s.string().optional() }),
      })
      await ctx.progress('drafting', 'Drafting the notice')
      return { facts, contract: answer.action === 'answered' ? answer.answers.contractNumber : null, turn: ctx.turn }
    })
    agent.start()
    agents.push(agent)
    return agent
  }

  const frames = (type: string) => relay.received.filter((m) => (m as Frame).type === type) as Frame[]
  const authCount = () => frames('auth').length

  it('pays for the work once and resumes with the answer on another process', async () => {
    relay = createMockRelay()

    // Turn 0 — the first process asks.
    const firstExtract = vi.fn().mockResolvedValue({ invoices: 3 })
    const first = startAgent(firstExtract)
    await vi.waitUntil(() => authCount() === 1, { timeout: 1000 })
    relay.sendFrame({ type: 'call', callId: 'c1', schemaVersion: 1, input: {}, turn: 0, capabilities: ['progress', 'input'], canAsk: true })

    await vi.waitUntil(() => frames('suspend').length === 1, { timeout: 2000 })
    const suspend = frames('suspend')[0]
    expect(suspend).toMatchObject({
      callId: 'c1', turn: 0,
      request: { key: 'contract', schema: { type: 'object', properties: { contractNumber: { type: 'string' } } } },
    })
    expect(firstExtract).toHaveBeenCalledOnce()
    relay.sendFrame({ type: 'ack', callId: 'c1', turn: 0 })

    // The first process goes away (deploy, crash) — nothing about the call lived in it.
    first.stop()
    agents.length = 0

    // Turn 1 — a fresh process gets the journal back with the consumer's answer.
    const secondExtract = vi.fn().mockResolvedValue({ invoices: 999 })
    startAgent(secondExtract)
    await vi.waitUntil(() => authCount() === 2, { timeout: 2000 })
    const progressBefore = frames('progress').length
    relay.sendFrame({
      type: 'call', callId: 'c1', schemaVersion: 1, input: {}, turn: 1, capabilities: ['progress', 'input'], canAsk: true,
      resume: {
        checkpoint: suspend.checkpoint,
        response: { key: 'contract', action: 'answered', answers: { contractNumber: 'CX-12' }, respondedAt: '2026-09-29T10:00:00Z' },
      },
    })

    await vi.waitUntil(() => frames('result').length === 1, { timeout: 2000 })
    expect(frames('result')[0]).toMatchObject({
      callId: 'c1', turn: 1, output: { facts: { invoices: 3 }, contract: 'CX-12', turn: 1 },
    })
    // The step ran on the first process only — its result came back from the journal.
    expect(secondExtract).not.toHaveBeenCalled()
    // 'reading' was replayed silently; only the new milestone went out.
    expect(frames('progress').slice(progressBefore).map((f) => f.step)).toEqual(['drafting'])
  })

  it('carries on without suspending when the caller cannot answer', async () => {
    relay = createMockRelay()
    startAgent(async () => ({ invoices: 3 }))
    await vi.waitUntil(() => authCount() === 1, { timeout: 1000 })

    relay.sendFrame({ type: 'call', callId: 'c2', schemaVersion: 1, input: {}, turn: 0, capabilities: [], canAsk: false })

    await vi.waitUntil(() => frames('result').length === 1, { timeout: 2000 })
    expect(frames('suspend')).toHaveLength(0)
    expect(frames('result')[0]).toMatchObject({ output: { contract: null } })
  })
})
