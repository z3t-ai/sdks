import WebSocket from 'ws'
import type { ResolvedConfig, WsSend } from './types'

/** Called by the Connection whenever the relay dispatches a call to this agent */
export type CallDispatcher = (
  callId: string,
  schemaVersion: number,
  input: unknown,
  send: WsSend,
) => void

export class Connection {
  private ws: WebSocket | null = null
  private reconnectAttempt = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private stopped = false

  constructor(
    private readonly url: string,
    private readonly config: ResolvedConfig,
    private readonly dispatch: CallDispatcher,
    /** Schema versions this agent instance handles — sent in the auth message so the relay
     *  can route calls to instances that support the requested version. */
    private readonly supportedVersions: number[],
  ) {}

  start(): void {
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws?.close()
  }

  private connect(): void {
    const ws = new WebSocket(this.url)
    this.ws = ws

    ws.on('open', () => {
      this.reconnectAttempt = 0
      ws.send(
        JSON.stringify({
          type: 'auth',
          apiKey: this.config.apiKey,
          supportedVersions: this.supportedVersions,
        }),
      )
    })

    ws.on('message', (raw: Buffer) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>
      } catch {
        return
      }
      this.handleMessage(ws, msg)
    })

    ws.on('close', () => {
      if (!this.stopped) this.scheduleReconnect()
    })

    ws.on('error', (err) => {
      // 'close' fires after 'error' — reconnect is handled there
      this.config.logger.error(`[z3t SDK] WS error on ${this.url}:`, err.message)
    })
  }

  private handleMessage(ws: WebSocket, msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'auth_ok':
        this.config.logger.info(
          `[z3t SDK] Authenticated on ${this.url} — agentId: ${msg.agentId}`,
        )
        break

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }))
        break

      case 'call': {
        const send: WsSend = (payload) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(payload))
          }
        }
        this.dispatch(msg.callId as string, msg.schemaVersion as number, msg.input, send)
        break
      }

      case 'ack':
        // No-op — relay acknowledges result/error receipt
        break

      case 'error':
        if (!msg.callId) {
          this.config.logger.error(`[z3t SDK] Relay error:`, msg.message)
        }
        break
    }
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      this.config.reconnectDelay * Math.pow(2, this.reconnectAttempt),
      this.config.maxReconnectDelay,
    )
    this.config.logger.info(
      `[z3t SDK] Reconnecting to ${this.url} in ${delay}ms (attempt ${this.reconnectAttempt + 1})`,
    )
    this.reconnectAttempt++
    this.reconnectTimer = setTimeout(() => {
      if (!this.stopped) this.connect()
    }, delay)
  }
}
