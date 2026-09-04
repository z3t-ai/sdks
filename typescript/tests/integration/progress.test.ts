import { describe, it, expect, afterEach, vi } from 'vitest'
import { Agent } from '../../src/agent'
import { createMockRelay, type MockRelay } from '../helpers/mock-relay'

const noop = () => {}
const silentLogger = { info: noop, warn: noop, error: noop }

describe('ctx.progress()', () => {
  let relay: MockRelay
  let agent: Agent

  afterEach(async () => {
    agent?.stop()
    await relay?.close()
  })

  it('sends progress frame mid-handler with correct fields', async () => {
    relay = createMockRelay()
    agent = new Agent({
      apiKey: 'test-key',
      relayUrls: [`ws://localhost:${relay.port}`],
      logger: silentLogger,
      timeout: 2_000,
    })

    agent.handle(async (input, ctx) => {
      await ctx.progress('downloading_file', 'Downloading...', 0.1)
      await ctx.progress('extracting_text', 'Extracting...', 0.5)
      return { done: true }
    })
    agent.start()

    await vi.waitUntil(
      () => relay.received.some((m: unknown) => (m as Record<string, string>).type === 'auth'),
      { timeout: 1000 },
    )

    relay.dispatch('call-prog', {})

    await vi.waitUntil(
      () => relay.received.filter((m: unknown) => (m as Record<string, string>).type === 'progress').length >= 2,
      { timeout: 2000 },
    )

    const progressFrames = relay.received.filter(
      (m: unknown) => (m as Record<string, string>).type === 'progress',
    )
    expect(progressFrames[0]).toMatchObject({
      type: 'progress',
      callId: 'call-prog',
      step: 'downloading_file',
      message: 'Downloading...',
      progress: 0.1,
    })
    expect(progressFrames[1]).toMatchObject({
      type: 'progress',
      callId: 'call-prog',
      step: 'extracting_text',
      message: 'Extracting...',
      progress: 0.5,
    })
  })

  it('omits progress field when not provided', async () => {
    relay = createMockRelay()
    agent = new Agent({
      apiKey: 'test-key',
      relayUrls: [`ws://localhost:${relay.port}`],
      logger: silentLogger,
      timeout: 2_000,
    })

    agent.handle(async (_, ctx) => {
      await ctx.progress('step', 'indeterminate step')
      return {}
    })
    agent.start()

    await vi.waitUntil(
      () => relay.received.some((m: unknown) => (m as Record<string, string>).type === 'auth'),
      { timeout: 1000 },
    )

    relay.dispatch('call-ind', {})

    await vi.waitUntil(
      () => relay.received.some((m: unknown) => (m as Record<string, string>).type === 'progress'),
      { timeout: 2000 },
    )

    const frame = relay.received.find((m: unknown) => (m as Record<string, string>).type === 'progress')
    expect(frame).not.toHaveProperty('progress')
    expect(frame).toMatchObject({ type: 'progress', callId: 'call-ind', step: 'step', message: 'indeterminate step' })
  })
})

describe('ctx.subprogress()', () => {
  let relay: MockRelay
  let agent: Agent

  afterEach(async () => {
    agent?.stop()
    await relay?.close()
  })

  it('sends a subprogress frame carrying no step — it belongs to the newest milestone', async () => {
    relay = createMockRelay()
    agent = new Agent({
      apiKey: 'test-key',
      relayUrls: [`ws://localhost:${relay.port}`],
      logger: silentLogger,
      timeout: 2_000,
    })

    agent.handle(async (_input, ctx) => {
      await ctx.progress('extracting_text', 'Reading the contract…', 0.2)
      await ctx.subprogress('page 7 of 12', 0.25)
      await ctx.subprogress('page 8 of 12')
      return { done: true }
    })
    agent.start()

    await vi.waitUntil(
      () => relay.received.some((m: unknown) => (m as Record<string, string>).type === 'auth'),
      { timeout: 1000 },
    )

    relay.dispatch('call-sub', {})

    await vi.waitUntil(
      () => relay.received.filter((m: unknown) => (m as Record<string, string>).type === 'subprogress').length >= 2,
      { timeout: 2000 },
    )

    const frames = relay.received.filter(
      (m: unknown) => (m as Record<string, string>).type === 'subprogress',
    ) as Array<Record<string, unknown>>

    expect(frames[0]).toEqual({
      type: 'subprogress',
      callId: 'call-sub',
      message: 'page 7 of 12',
      progress: 0.25,
    })
    // Omitted rather than sent as null, matching how `progress` treats an absent fraction.
    expect(frames[1]).toEqual({ type: 'subprogress', callId: 'call-sub', message: 'page 8 of 12' })
  })
})
