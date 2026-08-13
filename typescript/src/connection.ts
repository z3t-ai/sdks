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
  private heartbeatTimer: NodeJS.Timeout | null = null
  /** Set true whenever any frame arrives from the relay; the heartbeat watchdog
   *  clears it each tick and terminates the socket if it's still false next tick. */
  private isAlive = false
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
    this.stopHeartbeat()
    this.ws?.close()
  }

  private connect(): void {
    const ws = new WebSocket(this.url)
    this.ws = ws

    ws.on('open', () => {
      this.reconnectAttempt = 0
      this.isAlive = true
      ws.send(
        JSON.stringify({
          type: 'auth',
          apiKey: this.config.apiKey,
          supportedVersions: this.supportedVersions,
        }),
      )
      this.startHeartbeat(ws)
    })

    ws.on('message', (raw: Buffer) => {
      // Any inbound frame proves the connection is live.
      this.isAlive = true
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>
      } catch {
        return
      }
      this.handleMessage(ws, msg)
    })

    // Protocol-level pong (reply to our ws.ping()) — also proves liveness.
    ws.on('pong', () => {
      this.isAlive = true
    })

    ws.on('close', () => {
      this.stopHeartbeat()
      if (!this.stopped) this.scheduleReconnect()
    })

    ws.on('error', (err) => {
      // 'close' fires after 'error' — reconnect is handled there
      this.config.logger.error(`[z3t SDK] WS error on ${this.url}:`, err.message)
    })
  }

  /** Detects silently-dropped ("half-open") connections. Node's `ws` only emits
   *  'close' when a FIN/RST is actually delivered; a connection killed by a NAT/LB
   *  idle timeout, a firewall, or a relay crash can stay in readyState OPEN forever,
   *  so 'close' never fires and reconnect never runs. Each tick we terminate the
   *  socket unless a frame arrived since the last tick — terminate() forces the
   *  'close' event that drives scheduleReconnect(). */
  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat()
    if (this.config.heartbeatInterval <= 0) return

    this.heartbeatTimer = setInterval(() => {
      if (!this.isAlive) {
        this.config.logger.warn(
          `[z3t SDK] No heartbeat from ${this.url}; terminating dead connection`,
        )
        ws.terminate()
        return
      }
      this.isAlive = false
      if (ws.readyState === WebSocket.OPEN) ws.ping()
    }, this.config.heartbeatInterval)

    // Don't keep the process alive just for the heartbeat.
    this.heartbeatTimer.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
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
