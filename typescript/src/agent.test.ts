import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Agent } from './agent'
import type { WsSend } from './types'

const noop = () => {}
const silentLogger = { info: noop, warn: noop, error: noop }

function makeAgent(overrides = {}) {
  return new Agent({
    apiKey: 'test-key',
    relayUrls: [],
    logger: silentLogger,
    timeout: 5_000,
    maxConcurrentCalls: 10,
    ...overrides,
  })
}

function makeCall(overrides: Partial<{ callId: string; schemaVersion: number; input: unknown; send: WsSend }> = {}) {
  const sent: unknown[] = []
  return {
    callId: overrides.callId ?? 'call-1',
    schemaVersion: overrides.schemaVersion ?? 1,
    input: overrides.input ?? { foo: 'bar' },
    send: overrides.send ?? ((msg) => sent.push(msg)),
    sent,
  }
}

describe('Agent handler registration', () => {
  it('registers a default handler and routes all versions to it', async () => {
    const agent = makeAgent()
    const handler = vi.fn().mockResolvedValue({ ok: true })
    agent.handle(handler)

    const call = makeCall({ schemaVersion: 99 })
    // @ts-expect-error access private
    agent.processCall(call)
    await vi.waitUntil(() => call.sent.length > 0)

    expect(handler).toHaveBeenCalledOnce()
    expect(call.sent[0]).toMatchObject({ type: 'result', callId: 'call-1', output: { ok: true } })
  })

  it('registers versioned handlers and routes by schemaVersion', async () => {
    const agent = makeAgent()
    const v1 = vi.fn().mockResolvedValue('v1-output')
    const v2 = vi.fn().mockResolvedValue('v2-output')
    agent.handle(1, v1).handle(2, v2)

    const callV1 = makeCall({ callId: 'c1', schemaVersion: 1 })
    const callV2 = makeCall({ callId: 'c2', schemaVersion: 2 })
    // @ts-expect-error access private
    agent.processCall(callV1)
    // @ts-expect-error access private
    agent.processCall(callV2)

    await vi.waitUntil(() => callV1.sent.length > 0 && callV2.sent.length > 0)

    expect(callV1.sent[0]).toMatchObject({ type: 'result', output: 'v1-output' })
    expect(callV2.sent[0]).toMatchObject({ type: 'result', output: 'v2-output' })
    expect(v1).toHaveBeenCalledOnce()
    expect(v2).toHaveBeenCalledOnce()
  })

  it('sends error when no handler is registered for a schemaVersion', () => {
    const agent = makeAgent()
    // No handlers registered

    const call = makeCall({ schemaVersion: 5 })
    // @ts-expect-error access private
    agent.processCall(call)

    expect(call.sent[0]).toMatchObject({
      type: 'error',
      callId: 'call-1',
      message: 'No handler for schema version 5',
    })
  })

  it('handler error is caught and sent as error frame', async () => {
    const agent = makeAgent()
    agent.handle(async () => { throw new Error('something broke') })

    const call = makeCall()
    // @ts-expect-error access private
    agent.processCall(call)
    await vi.waitUntil(() => call.sent.length > 0)

    expect(call.sent[0]).toMatchObject({ type: 'error', message: 'something broke' })
  })

  it('times out and sends error frame when handler exceeds timeout', async () => {
    const agent = makeAgent({ timeout: 50 })
    agent.handle(() => new Promise(() => {})) // never resolves

    const call = makeCall()
    // @ts-expect-error access private
    agent.processCall(call)
    await vi.waitUntil(() => call.sent.length > 0, { timeout: 500 })

    expect(call.sent[0]).toMatchObject({ type: 'error', message: 'Handler timeout' })
  })
})

describe('Agent concurrency', () => {
  it('queues calls beyond maxConcurrentCalls', async () => {
    const agent = makeAgent({ maxConcurrentCalls: 1, timeout: 500 })

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
    expect(call2.sent).toHaveLength(0)
    // @ts-expect-error access private
    expect(agent.queue).toHaveLength(1)

    // Unblock call1 → it finishes and call2 is dequeued and starts
    await vi.waitUntil(() => resolvers.length >= 1, { timeout: 500 })
    resolvers[0]()
    await vi.waitUntil(() => call1.sent.length > 0, { timeout: 500 })

    // call2 is now running; unblock it too
    await vi.waitUntil(() => resolvers.length >= 2, { timeout: 500 })
    resolvers[1]()
    await vi.waitUntil(() => call2.sent.length > 0, { timeout: 500 })

    expect(call1.sent[0]).toMatchObject({ type: 'result' })
    expect(call2.sent[0]).toMatchObject({ type: 'result' })
  })

  it('rejects the oldest queued call when queue depth exceeds maxConcurrentCalls × 2', () => {
    const agent = makeAgent({ maxConcurrentCalls: 1 })
    agent.handle(() => new Promise(() => {})) // blocks forever

    const calls = Array.from({ length: 4 }, (_, i) => makeCall({ callId: `c${i}` }))

    // Enqueue all — first runs immediately, next 3 go to queue (max 2)
    for (const c of calls) {
      // @ts-expect-error access private
      agent.enqueue(c)
    }

    // The oldest queued call (c1) should have been rejected
    expect(calls[1].sent[0]).toMatchObject({ type: 'error', message: 'Queue depth exceeded' })
    // @ts-expect-error access private
    expect(agent.queue).toHaveLength(2)
  })
})
