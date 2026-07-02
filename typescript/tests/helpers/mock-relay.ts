import { WebSocketServer, WebSocket } from 'ws'
import type { AddressInfo } from 'net'

export interface MockRelay {
  port: number
  /** All messages received from any connected agent */
  received: unknown[]
  /** Dispatch a call to the agent (after auth) */
  dispatch(callId: string, input: unknown, schemaVersion?: number): void
  /** Force-close all connected client WebSockets (triggers agent reconnect) */
  closeConnections(): void
  /** Close the server */
  close(): Promise<void>
}

export function createMockRelay(): MockRelay {
  const wss = new WebSocketServer({ port: 0 })
  const port = (wss.address() as AddressInfo).port
  const received: unknown[] = []

  let activeWs: WebSocket | null = null

  wss.on('connection', (ws) => {
    activeWs = ws

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      received.push(msg)

      if (msg.type === 'auth') {
        ws.send(
          JSON.stringify({ type: 'auth_ok', agentId: 'mock-agent-id', relayInstanceId: 'mock-relay' }),
        )
      }
    })

    ws.on('close', () => {
      if (activeWs === ws) activeWs = null
    })
  })

  return {
    port,
    received,

    closeConnections() {
      for (const client of wss.clients) {
        client.terminate()
      }
    },

    dispatch(callId, input, schemaVersion = 1) {
      if (!activeWs || activeWs.readyState !== WebSocket.OPEN) {
        throw new Error('No active WebSocket connection to dispatch to')
      }
      activeWs.send(JSON.stringify({ type: 'call', callId, schemaVersion, input }))
    },

    close() {
      return new Promise((res, rej) => wss.close((err) => (err ? rej(err) : res())))
    },
  }
}
