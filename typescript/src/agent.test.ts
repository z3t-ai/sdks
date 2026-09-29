import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Agent } from './agent'

const noop = () => {}
const silentLogger = { info: noop, warn: noop, error: noop }

// Frames are no longer addressed to the socket a call arrived on — the Agent picks a live
// connection at send time — so tests observe a stand-in connection rather than a per-call sink.
const started: Agent[] = []

function makeAgent(overrides = {}) {
  const agent = new Agent({
    apiKey: 'test-key',
    relayUrls: [],
    logger: silentLogger,
    timeout: 5_000,
    maxConcurrentCalls: 10,
    ...overrides,
  })
  started.push(agent)

  const sent: any[] = []
  const connection = {
    isOpen: () => true,
    send: (payload: unknown) => { sent.push(payload); return true },
    stop: () => {},
  }
  // @ts-expect-error access private
  agent.connections.push(connection)

  const frameFor = (callId: string) => sent.filter((f) => f.callId === callId)
  return { agent, sent, connection, frameFor }
}

function makeCall(overrides: Partial<{ callId: string; schemaVersion: number; input: unknown }> = {}) {
  return {
    callId: overrides.callId ?? 'call-1',
    schemaVersion: overrides.schemaVersion ?? 1,
    input: overrides.input ?? { foo: 'bar' },
  }
}

// stop() clears the unacknowledged-result retry timers; without it each test leaves one behind.
afterEach(() => {
  for (const agent of started) agent.stop()
  started.length = 0
})

describe('Agent handler registration', () => {
  it('registers a default handler and routes all versions to it', async () => {
    const { agent, sent } = makeAgent()
    const handler = vi.fn().mockResolvedValue({ ok: true })
    agent.handle(handler)

    // @ts-expect-error access private
    agent.processCall(makeCall({ schemaVersion: 99 }))
    await vi.waitUntil(() => sent.length > 0)

    expect(handler).toHaveBeenCalledOnce()
    expect(sent[0]).toMatchObject({ type: 'result', callId: 'call-1', output: { ok: true } })
  })

  it('registers versioned handlers and routes by schemaVersion', async () => {
    const { agent, frameFor } = makeAgent()
    const v1 = vi.fn().mockResolvedValue('v1-output')
    const v2 = vi.fn().mockResolvedValue('v2-output')
    agent.handle(1, v1).handle(2, v2)

    const callV1 = makeCall({ callId: 'c1', schemaVersion: 1 })
    const callV2 = makeCall({ callId: 'c2', schemaVersion: 2 })
    // @ts-expect-error access private
    agent.processCall(callV1)
    // @ts-expect-error access private
    agent.processCall(callV2)

    await vi.waitUntil(() => frameFor('c1').length > 0 && frameFor('c2').length > 0)

    expect(frameFor('c1')[0]).toMatchObject({ type: 'result', output: 'v1-output' })
    expect(frameFor('c2')[0]).toMatchObject({ type: 'result', output: 'v2-output' })
    expect(v1).toHaveBeenCalledOnce()
    expect(v2).toHaveBeenCalledOnce()
  })

  it('sends error when no handler is registered for a schemaVersion', () => {
    const { agent, sent } = makeAgent()
    // No handlers registered

    // @ts-expect-error access private
    agent.processCall(makeCall({ schemaVersion: 5 }))

    expect(sent[0]).toMatchObject({
      type: 'error',
      callId: 'call-1',
      message: 'No handler for schema version 5',
    })
  })

  it('handler error is caught and sent as error frame', async () => {
    const { agent, sent } = makeAgent()
    agent.handle(async () => { throw new Error('something broke') })

    // @ts-expect-error access private
    agent.processCall(makeCall())
    await vi.waitUntil(() => sent.length > 0)

    expect(sent[0]).toMatchObject({ type: 'error', message: 'something broke' })
  })

  it('times out and sends error frame when handler exceeds timeout', async () => {
    const { agent, sent } = makeAgent({ timeout: 50 })
    agent.handle(() => new Promise(() => {})) // never resolves

    // @ts-expect-error access private
    agent.processCall(makeCall())
    await vi.waitUntil(() => sent.length > 0, { timeout: 500 })

    expect(sent[0]).toMatchObject({ type: 'error', message: 'Handler timeout' })
  })
})

describe('Agent concurrency', () => {
  it('queues calls beyond maxConcurrentCalls', async () => {
    const { agent, frameFor } = makeAgent({ maxConcurrentCalls: 1, timeout: 500 })

    // Each handler invocation pushes its resolver so we can unblock them in order
    const resolvers: Array<() => void> = []
    agent.handle(async () => {
      await new Promise<void>((res) => resolvers.push(res))
      return 'done'
    })

    const call1 = makeCall({ callId: 'c1' })
    const call2 = makeCall({ callId: 'c2' })

    // @ts-expect-error access private
    agent.enqueue(call1)
    // @ts-expect-error access private
    agent.enqueue(call2)

    // call2 is queued; nothing sent yet
    expect(frameFor('c2')).toHaveLength(0)
    // @ts-expect-error access private
    expect(agent.queue).toHaveLength(1)

    // Unblock call1 → it finishes and call2 is dequeued and starts
    await vi.waitUntil(() => resolvers.length >= 1, { timeout: 500 })
    resolvers[0]()
    await vi.waitUntil(() => frameFor('c1').length > 0, { timeout: 500 })

    // call2 is now running; unblock it too
    await vi.waitUntil(() => resolvers.length >= 2, { timeout: 500 })
    resolvers[1]()
    await vi.waitUntil(() => frameFor('c2').length > 0, { timeout: 500 })

    expect(frameFor('c1')[0]).toMatchObject({ type: 'result' })
    expect(frameFor('c2')[0]).toMatchObject({ type: 'result' })
  })

  it('rejects the oldest queued call when queue depth exceeds maxConcurrentCalls × 2', () => {
    const { agent, frameFor } = makeAgent({ maxConcurrentCalls: 1 })
    agent.handle(() => new Promise(() => {})) // blocks forever

    const calls = Array.from({ length: 4 }, (_, i) => makeCall({ callId: `c${i}` }))

    // Enqueue all — first runs immediately, next 3 go to queue (max 2)
    for (const c of calls) {
      // @ts-expect-error access private
      agent.enqueue(c)
    }

    // The oldest queued call (c1) should have been rejected
    expect(frameFor('c1')[0]).toMatchObject({ type: 'error', message: 'Queue depth exceeded' })
    // @ts-expect-error access private
    expect(agent.queue).toHaveLength(2)
  })
})

// ─── Delivery reliability ───────────────────────────────────────────────────
//
// The failure these cover, seen in production: a run works for ten minutes, the socket it
// arrived on dies somewhere in the middle, the handler finishes successfully — and the result
// is written to a closed socket and silently lost. The call then sits in 'processing' until the
// platform reaps it, so the user is told the run timed out on work that actually completed.

function fakeConn(open = true) {
  return {
    open,
    sent: [] as any[],
    isOpen() { return this.open },
    send(payload: unknown) {
      if (!this.open) return false
      this.sent.push(payload)
      return true
    },
    stop() {},
  }
}

function agentWith(conns: ReturnType<typeof fakeConn>[], overrides = {}) {
  const agent = new Agent({
    apiKey: 'test-key', relayUrls: [], logger: silentLogger,
    timeout: 5_000, maxConcurrentCalls: 10, ...overrides,
  })
  started.push(agent)
  // @ts-expect-error access private
  agent.connections.push(...conns)
  return agent
}

describe('Agent delivery', () => {
  it('delivers the result on a live connection when the one the call arrived on is dead', async () => {
    const dead = fakeConn(false)
    const live = fakeConn(true)
    const agent = agentWith([dead, live])
    agent.handle(async () => 'finished')

    // @ts-expect-error access private
    agent.processCall(makeCall())
    await vi.waitUntil(() => live.sent.length > 0)

    expect(live.sent[0]).toMatchObject({ type: 'result', callId: 'call-1', output: 'finished' })
    expect(dead.sent).toHaveLength(0)
  })

  it('holds the result when every connection is down and sends it once one comes back', async () => {
    const conn = fakeConn(false)
    const agent = agentWith([conn])
    agent.handle(async () => 'finished')

    // @ts-expect-error access private
    agent.processCall(makeCall())
    // @ts-expect-error access private
    await vi.waitUntil(() => agent.pending.has('call-1'))
    expect(conn.sent).toHaveLength(0)

    // The reconnect authenticates — everything still unacknowledged goes out immediately rather
    // than waiting out the retry interval.
    conn.open = true
    // @ts-expect-error access private
    agent.onConnectionReady()

    expect(conn.sent[0]).toMatchObject({ type: 'result', callId: 'call-1', output: 'finished' })
  })

  it('drops progress rather than replaying a stale backlog after an outage', async () => {
    const conn = fakeConn(false)
    const agent = agentWith([conn])
    agent.handle(async (_input, ctx) => {
      await ctx.progress('extracting', 'page 1')
      return 'finished'
    })

    // @ts-expect-error access private
    agent.processCall(makeCall())
    // @ts-expect-error access private
    await vi.waitUntil(() => agent.pending.has('call-1'))

    conn.open = true
    // @ts-expect-error access private
    agent.onConnectionReady()

    // The queued progress frame is best-effort and flushes first, but it is never retried —
    // only the result carries a delivery guarantee.
    const results = conn.sent.filter((f) => f.type === 'result')
    expect(results).toHaveLength(1)
  })
})

describe('Agent delivery — acknowledgement', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('re-sends the result until the relay acknowledges it', async () => {
    const conn = fakeConn(true)
    const agent = agentWith([conn])
    agent.handle(async () => 'finished')

    // @ts-expect-error access private
    agent.processCall(makeCall())
    await vi.advanceTimersByTimeAsync(0)
    expect(conn.sent).toHaveLength(1)

    // A socket that accepted the bytes is not proof the relay recorded the call — only the ack is.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(conn.sent).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(conn.sent).toHaveLength(3)

    // @ts-expect-error access private
    agent.settle('call-1')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(conn.sent).toHaveLength(3)
  })

  it('gives up and reports after ten minutes with no acknowledgement', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const conn = fakeConn(true)
    const agent = agentWith([conn], { logger })
    agent.handle(async () => 'finished')

    // @ts-expect-error access private
    agent.processCall(makeCall())
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(11 * 60_000)

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Gave up delivering the result for call call-1'))
    // @ts-expect-error access private
    expect(agent.pending.has('call-1')).toBe(false)
  })
})

// ─── Interactive calls: suspend and resume ────────────────────────────────────────────────────

describe('Agent — asking the consumer (suspend)', () => {
  const question = { message: 'Invoice 3 names contract CX-12, which was not uploaded.', schema: { _def: { type: 'object', properties: { contract: { type: 'string', format: 'z3t-file-uri' } } } } as any }

  it('ends the turn with a suspend frame carrying the question and the journal', async () => {
    const { agent, sent } = makeAgent()
    const expensive = vi.fn().mockResolvedValue({ gaps: 1 })
    agent.handle(async (_input, ctx) => {
      await ctx.step('case-file', expensive)
      await ctx.ask('gaps', question)
      return 'never reached'
    })

    // @ts-expect-error access private
    agent.processCall({ ...makeCall(), canAsk: true })
    await vi.waitUntil(() => sent.some((f) => f.type === 'suspend'))

    const frame = sent.find((f) => f.type === 'suspend')
    expect(frame).toMatchObject({
      callId: 'call-1', turn: 0,
      request: { key: 'gaps', message: question.message, schema: question.schema._def },
      checkpoint: { v: 1, steps: { 'case-file': { value: { gaps: 1 } } }, answers: {} },
    })
    expect(sent.some((f) => f.type === 'result' || f.type === 'error')).toBe(false)
  })

  it('suspends even when the handler swallows the signal, and says so', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const { agent, sent } = makeAgent({ logger })
    agent.handle(async (_input, ctx) => {
      try {
        await ctx.ask('gaps', question)
      } catch {
        // a well-meaning catch-all
      }
      return 'a result the consumer never asked for'
    })

    // @ts-expect-error access private
    agent.processCall({ ...makeCall(), canAsk: true })
    await vi.waitUntil(() => sent.length > 0)

    expect(sent[0].type).toBe('suspend')
    expect(sent.some((f) => f.type === 'result')).toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('caught the suspend signal'))
  })

  it('accepts a plain JSON Schema object, as the Python SDK does', async () => {
    const { agent, sent } = makeAgent()
    const raw = { type: 'object', properties: { n: { type: 'string' } } }
    agent.handle(async (_input, ctx) => {
      await ctx.ask('gaps', { message: 'Which contract?', schema: raw as any })
    })

    // @ts-expect-error access private
    agent.processCall({ ...makeCall(), canAsk: true })
    await vi.waitUntil(() => sent.length > 0)

    expect(sent[0]).toMatchObject({ type: 'suspend', request: { key: 'gaps', schema: raw } })
  })

  it('carries on with `unavailable` when the run cannot ask — no suspend', async () => {
    const { agent, sent } = makeAgent()
    agent.handle(async (_input, ctx) => {
      const r = await ctx.ask('gaps', question)
      return r.action
    })

    // @ts-expect-error access private
    agent.processCall(makeCall()) // canAsk absent → false
    await vi.waitUntil(() => sent.length > 0)

    expect(sent[0]).toMatchObject({ type: 'result', turn: 0, output: 'unavailable' })
  })

  it('fails the call with a clear message when the journal is too big to suspend with', async () => {
    const { agent, sent } = makeAgent()
    agent.handle(async (_input, ctx) => {
      await ctx.step('huge', () => 'x'.repeat(3 * 1024 * 1024))
      await ctx.ask('gaps', question)
    })

    // @ts-expect-error access private
    agent.processCall({ ...makeCall(), canAsk: true })
    await vi.waitUntil(() => sent.length > 0)

    expect(sent[0]).toMatchObject({ type: 'error', message: expect.stringMatching(/over the .* limit/) })
  })
})

describe('Agent — resuming', () => {
  const question = { message: 'Which contract?', schema: { _def: { type: 'object', properties: { n: { type: 'string' } } } } as any }

  it('replays recorded steps without re-running them, returns the answer, and finishes the turn', async () => {
    const { agent, sent } = makeAgent()
    const extract = vi.fn().mockResolvedValue('facts')
    const draft = vi.fn().mockResolvedValue('letter')
    agent.handle(async (_input, ctx) => {
      await ctx.progress('extracting', 'Reading documents')
      const facts = await ctx.step('extract', extract)
      const r = await ctx.ask<{ n: string }>('gaps', question)
      await ctx.progress('drafting', 'Writing the letter')
      const letter = await ctx.step('draft', draft)
      return { facts, letter, answer: r.action === 'answered' ? r.answers.n : null }
    })

    // @ts-expect-error access private
    agent.processCall({
      ...makeCall(), turn: 1, canAsk: true,
      resume: {
        checkpoint: { v: 1, steps: { extract: { value: 'facts' } }, answers: {} },
        response: { key: 'gaps', action: 'answered', answers: { n: 'CX-12' } },
      },
    })
    await vi.waitUntil(() => sent.some((f) => f.type === 'result'))

    expect(extract).not.toHaveBeenCalled()
    expect(draft).toHaveBeenCalledOnce()
    expect(sent.find((f) => f.type === 'result')).toMatchObject({
      turn: 1, output: { facts: 'facts', letter: 'letter', answer: 'CX-12' },
    })
    // The replayed milestone is already in the activity log; only the new one is sent.
    const steps = sent.filter((f) => f.type === 'progress').map((f) => f.step)
    expect(steps).toEqual(['drafting'])
  })
})

describe('Agent delivery — per-turn acknowledgement', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('does not let the ack of an earlier turn settle a later one', async () => {
    const conn = fakeConn(true)
    const agent = agentWith([conn])
    agent.handle(async () => 'finished')

    // @ts-expect-error access private
    agent.processCall({ ...makeCall(), turn: 1 })
    await vi.advanceTimersByTimeAsync(0)

    // @ts-expect-error access private
    agent.settle('call-1', 0)
    // @ts-expect-error access private
    expect(agent.pending.has('call-1#1')).toBe(true)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(conn.sent.filter((f) => f.type === 'result')).toHaveLength(2) // still retrying

    // @ts-expect-error access private
    agent.settle('call-1', 1)
    // @ts-expect-error access private
    expect(agent.pending.size).toBe(0)
  })

  it('leaves no handler-timeout timer behind once the call is settled', async () => {
    const conn = fakeConn(true)
    const agent = agentWith([conn])
    agent.handle(async () => 'finished')

    // @ts-expect-error access private
    agent.processCall(makeCall())
    await vi.advanceTimersByTimeAsync(0)
    // @ts-expect-error access private
    agent.settle('call-1', 0)

    expect(vi.getTimerCount()).toBe(0)
  })

  it('treats an ack without a turn (an older relay) as settling every turn of the call', async () => {
    const conn = fakeConn(true)
    const agent = agentWith([conn])
    agent.handle(async () => 'finished')

    // @ts-expect-error access private
    agent.processCall({ ...makeCall(), turn: 2 })
    await vi.advanceTimersByTimeAsync(0)
    // @ts-expect-error access private
    agent.settle('call-1')

    // @ts-expect-error access private
    expect(agent.pending.size).toBe(0)
  })
})
