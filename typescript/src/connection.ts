import WebSocket from 'ws'
import type { IncomingCall, ResolvedConfig } from './types'

/** Called by the Connection whenever the relay dispatches a call to this agent.
 *
 *  Deliberately carries no send channel. Binding a call's replies to the socket it arrived on is
 *  what made a long run unrecoverable: the socket dies mid-call, the closure keeps pointing at it,
 *  and every later frame — including the result the user is waiting for — is dropped in silence.
 *  Delivery is the Agent's job, across whichever connection is alive when there is something to
 *  say. See Agent.deliver. */
export type CallDispatcher = (call: IncomingCall) => void

/** Connection lifecycle signals the Agent needs in order to route and confirm delivery. */
export interface ConnectionHooks {
  /** The relay has accepted our auth — this connection can now carry call traffic. */
  onReady?(): void
  /** The relay has durably recorded a turn-terminal frame (result, error, or suspend) for this
   *  call. `turn` is absent from relays that predate interactive calls. */
  onAck?(callId: string, turn?: number): void
}

export class Connection {
  private ws: WebSocket | null = null
  /** Frames sent before the relay answers our auth are rejected, so "open" is not enough. */
  private authenticated = false
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
    private readonly supportedVersions: number[] = [],
    private readonly hooks: ConnectionHooks = {},
  ) {}

  /** True when this connection can carry a frame right now. */
  isOpen(): boolean {
    return this.authenticated && this.ws?.readyState === WebSocket.OPEN
  }

  /** Attempts to send on the CURRENT socket. Returns false if this connection cannot carry it,
   *  so the caller can try another connection or queue the frame. */
  send(payload: unknown): boolean {
    if (!this.isOpen()) return false
    try {
      this.ws!.send(JSON.stringify(payload))
      return true
    } catch (err) {
      this.config.logger.warn(`[z3t SDK] Send failed on ${this.url}:`, (err as Error).message)
      return false
    }
  }

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
    this.authenticated = false

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
      this.authenticated = false
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
        this.authenticated = true
        this.config.logger.info(
          `[z3t SDK] Authenticated on ${this.url} — agentId: ${msg.agentId}`,
        )
        // Anything queued while every connection was down can go out now.
        this.hooks.onReady?.()
        break

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }))
        break

      case 'call':
        this.dispatch({
          callId: msg.callId as string,
          schemaVersion: msg.schemaVersion as number,
          input: msg.input,
          turn: typeof msg.turn === 'number' ? msg.turn : 0,
          capabilities: Array.isArray(msg.capabilities) ? (msg.capabilities as string[]) : [],
          canAsk: msg.canAsk === true,
          ...(msg.resume ? { resume: msg.resume as IncomingCall['resume'] } : {}),
        })
        break

      case 'ack':
        // The relay has recorded the turn-terminal frame — the Agent can stop retrying it.
        this.hooks.onAck?.(msg.callId as string, typeof msg.turn === 'number' ? msg.turn : undefined)
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
