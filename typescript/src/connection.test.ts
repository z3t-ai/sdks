import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocketServer } from 'ws'
import type { AddressInfo } from 'net'
import { Connection } from './connection'
import type { ResolvedConfig } from './types'

const noop = () => {}
const silentLogger = { info: noop, warn: noop, error: noop }

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    apiKey: 'test-key',
    relayUrls: [],
    baseUrl: 'http://localhost',
    timeout: 5_000,
    maxConcurrentCalls: 10,
    reconnectDelay: 50,
    maxReconnectDelay: 200,
    heartbeatInterval: 0, // disabled by default in tests; opt in per-test
    logger: silentLogger,
    ...overrides,
  }
}

function startServer(): { wss: WebSocketServer; port: number } {
  const wss = new WebSocketServer({ port: 0 })
  const port = (wss.address() as AddressInfo).port
  return { wss, port }
}

describe('Connection — auth', () => {
  it('sends auth message on open', async () => {
    const { wss, port } = startServer()
    const received: unknown[] = []

    wss.on('connection', (ws) => {
      ws.on('message', (raw) => received.push(JSON.parse(raw.toString())))
    })

    const conn = new Connection(`ws://localhost:${port}`, makeConfig(), noop)
    conn.start()

    await vi.waitUntil(() => received.length > 0, { timeout: 1000 })
    expect(received[0]).toEqual({ type: 'auth', apiKey: 'test-key', supportedVersions: [] })

    conn.stop()
    await new Promise((res) => wss.close(res))
  })
})

describe('Connection — heartbeat', () => {
  it('responds to ping with pong', async () => {
    const { wss, port } = startServer()
    const received: unknown[] = []

    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString())
        received.push(msg)
        if (msg.type === 'auth') {
          ws.send(JSON.stringify({ type: 'auth_ok', agentId: 'agent-1', relayInstanceId: 'relay-1' }))
          ws.send(JSON.stringify({ type: 'ping' }))
        }
      })
    })

    const conn = new Connection(`ws://localhost:${port}`, makeConfig(), noop)
    conn.start()

    await vi.waitUntil(() => received.some((m: unknown) => (m as Record<string, string>).type === 'pong'), { timeout: 1000 })
    expect(received).toContainEqual({ type: 'pong' })

    conn.stop()
    await new Promise((res) => wss.close(res))
  })
})

describe('Connection — call dispatch', () => {
  it('invokes dispatch callback with correct arguments on call message', async () => {
    const { wss, port } = startServer()
    const dispatched: unknown[] = []

    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'auth') {
          ws.send(JSON.stringify({ type: 'auth_ok', agentId: 'agent-1', relayInstanceId: 'relay-1' }))
          ws.send(JSON.stringify({ type: 'call', callId: 'call-99', schemaVersion: 2, input: { x: 1 } }))
        }
      })
    })

    const conn = new Connection(
      `ws://localhost:${port}`,
      makeConfig(),
      (call) => dispatched.push(call),
    )
    conn.start()

    await vi.waitUntil(() => dispatched.length > 0, { timeout: 1000 })
    // A relay that predates interactive calls sends none of the new fields — they default to a
    // one-shot call that can't ask.
    expect(dispatched[0]).toEqual({
      callId: 'call-99', schemaVersion: 2, input: { x: 1 }, turn: 0, capabilities: [], canAsk: false,
    })

    conn.stop()
    await new Promise((res) => wss.close(res))
  })

  it('passes turn, capabilities, canAsk, and the resume payload through', async () => {
    const { wss, port } = startServer()
    const dispatched: any[] = []
    const acks: unknown[] = []
    const resume = { checkpoint: { v: 1, steps: {}, answers: {} }, response: { key: 'gaps', action: 'declined' } }

    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'auth') {
          ws.send(JSON.stringify({ type: 'auth_ok', agentId: 'agent-1', relayInstanceId: 'relay-1' }))
          ws.send(JSON.stringify({
            type: 'call', callId: 'call-7', schemaVersion: 3, input: {}, turn: 2,
            capabilities: ['progress', 'input'], canAsk: true, resume,
          }))
          ws.send(JSON.stringify({ type: 'ack', callId: 'call-7', turn: 1 }))
        }
      })
    })

    const conn = new Connection(`ws://localhost:${port}`, makeConfig(), (call) => dispatched.push(call), [], {
      onAck: (callId, turn) => acks.push({ callId, turn }),
    })
    conn.start()

    await vi.waitUntil(() => dispatched.length > 0 && acks.length > 0, { timeout: 1000 })
    expect(dispatched[0]).toMatchObject({ turn: 2, capabilities: ['progress', 'input'], canAsk: true, resume })
    expect(acks[0]).toEqual({ callId: 'call-7', turn: 1 })

    conn.stop()
    await new Promise((res) => wss.close(res))
  })
})

describe('Connection — reconnect', () => {
  it('reconnects after disconnect with exponential backoff', async () => {
    const { wss, port } = startServer()
    const connectionCount = { value: 0 }

    wss.on('connection', (ws) => {
      connectionCount.value++
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'auth' && connectionCount.value === 1) {
          // Immediately close first connection to trigger reconnect
          ws.close()
        }
      })
    })

    const conn = new Connection(`ws://localhost:${port}`, makeConfig({ reconnectDelay: 30 }), noop)
    conn.start()

    await vi.waitUntil(() => connectionCount.value >= 2, { timeout: 2000 })
    expect(connectionCount.value).toBeGreaterThanOrEqual(2)

    conn.stop()
    await new Promise((res) => wss.close(res))
  })

  it('reconnects when the connection dies silently (no close frame)', async () => {
    // autoPong: false makes the server ignore the client's ws.ping() — simulating a
    // half-open connection where the socket stays OPEN but no traffic arrives and no
    // 'close' event ever fires. The heartbeat watchdog must terminate it and reconnect.
    const wss = new WebSocketServer({ port: 0, autoPong: false })
    const port = (wss.address() as AddressInfo).port
    const connectionCount = { value: 0 }

    wss.on('connection', (ws) => {
      connectionCount.value++
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'auth') {
          ws.send(JSON.stringify({ type: 'auth_ok', agentId: 'agent-1', relayInstanceId: 'relay-1' }))
          // Then go silent forever: no pings, no pongs, no close.
        }
      })
    })

    const conn = new Connection(
      `ws://localhost:${port}`,
      makeConfig({ heartbeatInterval: 40, reconnectDelay: 30 }),
      noop,
    )
    conn.start()

    await vi.waitUntil(() => connectionCount.value >= 2, { timeout: 3000 })
    expect(connectionCount.value).toBeGreaterThanOrEqual(2)

    conn.stop()
    await new Promise((res) => wss.close(res))
  })

  it('does not reconnect after stop()', async () => {
    const { wss, port } = startServer()
    const connectionCount = { value: 0 }

    wss.on('connection', () => { connectionCount.value++ })

    const conn = new Connection(`ws://localhost:${port}`, makeConfig({ reconnectDelay: 30 }), noop)
    conn.start()

    await vi.waitUntil(() => connectionCount.value === 1, { timeout: 1000 })
    conn.stop()

    await new Promise((res) => setTimeout(res, 150))
    expect(connectionCount.value).toBe(1)

    await new Promise((res) => wss.close(res))
  })
})
