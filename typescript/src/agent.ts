import { Connection, type CallDispatcher } from './connection'
import { createCallContext } from './context'
import { createLlmClients } from './llm'
import { DEFAULTS, type AgentConfig, type Handler, type ResolvedConfig, type WsSend } from './types'
import type { VersionSchema } from './schema'

interface QueuedCall {
  callId: string
  schemaVersion: number
  input: unknown
}

/** How often an unacknowledged terminal frame is re-sent. */
const RESULT_RETRY_MS = 5_000

/** How long to keep retrying before giving up and logging. Comfortably longer than any relay
 *  reconnect, and longer than the platform's own call timeout, so we stop only once nobody
 *  could still be waiting for the answer. */
const RESULT_RETRY_TIMEOUT_MS = 10 * 60_000

/** Cap on frames held while every connection is down. Terminal frames are never dropped — they
 *  live in `pending` and are retried — so this only bounds best-effort telemetry. */
const OUTBOX_MAX = 50

export class Agent {
  private readonly handlers = new Map<number | 'default', Handler>()
  private readonly versionSchemas = new Map<number, VersionSchema<unknown, unknown>>()
  private readonly config: ResolvedConfig
  private activeCount = 0
  private readonly queue: QueuedCall[] = []
  private readonly connections: Connection[] = []

  /** Frames that could not go out because no connection was live, flushed on the next auth_ok. */
  private readonly outbox: unknown[] = []

  /** Terminal frames awaiting the relay's ack, keyed by callId. A result that is not acknowledged
   *  has not been recorded, whatever the socket reported — this is the only thing standing between
   *  a completed ten-minute run and a call that times out with the work already done. */
  private readonly pending = new Map<string, { payload: unknown; since: number; timer: NodeJS.Timeout }>()

  constructor(config: AgentConfig) {
    this.config = {
      baseUrl: DEFAULTS.baseUrl,
      timeout: DEFAULTS.timeout,
      maxConcurrentCalls: DEFAULTS.maxConcurrentCalls,
      reconnectDelay: DEFAULTS.reconnectDelay,
      maxReconnectDelay: DEFAULTS.maxReconnectDelay,
      heartbeatInterval: DEFAULTS.heartbeatInterval,
      logger: console,
      relayUrls: [], // populated on start() via bootstrap or config override
      ...config,
    }
  }

  /** Register a versioned handler with an input/output schema.
   *
   * The schema is synced with the platform on agent.start() and drives frontend
   * form rendering and output display. TypeScript infers the input/output types
   * from the schema so the handler is fully typed.
   *
   * Schemas sync as `status: 'draft'` by default — mutable, invisible to consumers,
   * safe to keep editing across restarts. Set `status: 'active'` once ready to publish;
   * from then on the schema is immutable (changing it will fail schema-sync).
   *
   * @example
   * agent.handle(1, {
   *   input: s.object({ doc: s.fileUri() }),
   *   output: s.object({ summary: s.markdown() }),
   *   status: 'active', // omit while iterating — defaults to 'draft'
   * }, async (input, ctx) => {
   *   // input.doc is typed as string
   * })
   */
  handle<I, O>(version: number, schema: VersionSchema<I, O>, handler: Handler<I, O>): this

  /** Register a versioned handler without an inline schema. Runs for that version but
   *  declares no schema itself — the version's schema must already exist (declared on a
   *  previous run, or by another handler). */
  handle(version: number, handler: Handler): this

  /** Register a default handler that runs for every schema version. Declares no schema
   *  itself — provide one via the versioned `handle(version, schema, handler)` overload. */
  handle(handler: Handler): this

  handle(
    versionOrHandler: number | Handler,
    schemaOrHandler?: VersionSchema<unknown, unknown> | Handler,
    handler?: Handler,
  ): this {
    if (typeof versionOrHandler === 'function') {
      this.handlers.set('default', versionOrHandler)
    } else if (typeof schemaOrHandler === 'function') {
      this.handlers.set(versionOrHandler, schemaOrHandler)
    } else if (schemaOrHandler && handler) {
      this.handlers.set(versionOrHandler, handler)
      this.versionSchemas.set(versionOrHandler, schemaOrHandler)
    }
    return this
  }

  /** Connect to the platform relay and begin handling calls.
   *
   * On first call, this:
   * 1. Fetches relay WebSocket URLs from the platform (unless overridden in config)
   * 2. Syncs any declared schemas (creates new versions as draft by default, deprecates removed ones)
   * 3. Opens a persistent WebSocket connection to each relay URL
   *
   * Errors during bootstrap or schema sync are logged and abort the startup.
   */
  start(): void {
    this.bootstrap()
      .then(({ relayUrls }) => {
        if (this.versionSchemas.size > 0) {
          return this.syncSchemas().then(() => relayUrls)
        }
        return relayUrls
      })
      .then((relayUrls) => this.connectAll(relayUrls))
      .catch((err: Error) => {
        this.config.logger.error('[z3t SDK] Startup failed:', err.message)
      })
  }

  /** Disconnect from all relays. Useful for testing or graceful shutdown. */
  stop(): void {
    for (const { timer } of this.pending.values()) clearInterval(timer)
    this.pending.clear()
    this.outbox.length = 0
    for (const conn of this.connections) conn.stop()
    this.connections.length = 0
  }

  // ─── Delivery ────────────────────────────────────────────────────────────

  /** Sends on whichever connection is live, rather than the one a call arrived on.
   *
   *  A reconnect replaces the socket — and may land on a different relay instance — but results
   *  and progress are addressed by callId, so any authenticated connection can carry them.
   *  Returns whether the frame went out. */
  private deliver(payload: unknown): boolean {
    for (const conn of this.connections) {
      if (conn.send(payload)) return true
    }
    return false
  }

  /** Best-effort telemetry: queued briefly if nothing is live, dropped once the cap is hit.
   *  Progress that arrives late is worth little, and flooding the relay after a long outage
   *  with a backlog of stale steps is worth less than nothing. */
  private deliverBestEffort(payload: unknown): void {
    if (this.deliver(payload)) return
    this.outbox.push(payload)
    while (this.outbox.length > OUTBOX_MAX) this.outbox.shift()
  }

  /** At-least-once: retried until the relay acks it. The relay's handlers are keyed by callId and
   *  guarded on the call still being live, so a duplicate is a no-op — which is what makes retry
   *  safe here. */
  private deliverTerminal(callId: string, payload: unknown): void {
    this.deliver(payload)

    const timer = setInterval(() => {
      const entry = this.pending.get(callId)
      if (!entry) return
      if (Date.now() - entry.since > RESULT_RETRY_TIMEOUT_MS) {
        this.config.logger.error(
          `[z3t SDK] Gave up delivering the result for call ${callId} after ` +
            `${Math.round(RESULT_RETRY_TIMEOUT_MS / 60_000)} minutes without an acknowledgement`,
        )
        this.settle(callId)
        return
      }
      this.deliver(entry.payload)
    }, RESULT_RETRY_MS)
    timer.unref?.()

    this.pending.set(callId, { payload, since: Date.now(), timer })
  }

  private settle(callId: string): void {
    const entry = this.pending.get(callId)
    if (!entry) return
    clearInterval(entry.timer)
    this.pending.delete(callId)
  }

  /** A connection just authenticated — drain anything that had nowhere to go, and re-send every
   *  still-unacknowledged result immediately rather than waiting out the retry interval. */
  private onConnectionReady(): void {
    while (this.outbox.length > 0) {
      if (!this.deliver(this.outbox[0])) return
      this.outbox.shift()
    }
    for (const { payload } of this.pending.values()) this.deliver(payload)
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private async bootstrap(): Promise<{ relayUrls: string[] }> {
    // Developer-provided relay URLs take precedence — useful for local dev and tests
    if (this.config.relayUrls.length > 0) {
      return { relayUrls: this.config.relayUrls }
    }

    const res = await fetch(`${this.config.baseUrl}/bootstrap`, {
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
    })
    if (!res.ok) {
      throw new Error(`Bootstrap failed: HTTP ${res.status}`)
    }
    const { relayUrls } = (await res.json()) as { relayUrls: string[] }
    if (!relayUrls?.length) throw new Error('Bootstrap returned no relay URLs')
    return { relayUrls }
  }

  private async syncSchemas(): Promise<void> {
    const versions = [...this.versionSchemas.entries()].map(([version, schema]) => ({
      version,
      inputSchema: schema.input._def,
      outputSchema: schema.output._def,
      status: schema.status ?? 'draft',
      ...(schema.deprecates?.length ? { deprecates: schema.deprecates } : {}),
      ...(schema.deprecationNotice ? { deprecationNotice: schema.deprecationNotice } : {}),
    }))

    const res = await fetch(`${this.config.baseUrl}/schema-sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({ versions }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Schema sync failed: HTTP ${res.status}: ${body}`)
    }

    const result = (await res.json()) as {
      deprecatedVersions?: number[]
      versions?: Array<{ version: number; status: string }>
    }
    if (result.deprecatedVersions?.length) {
      this.config.logger.info(
        `[z3t SDK] Schema versions deprecated: ${result.deprecatedVersions.join(', ')}`,
      )
    }
    const drafts = result.versions?.filter((v) => v.status === 'draft').map((v) => v.version)
    if (drafts?.length) {
      this.config.logger.info(
        `[z3t SDK] Synced as draft (not visible to consumers): v${drafts.join(', v')} — ` +
          `set status: 'active' in .handle() to publish.`,
      )
    }
  }

  private connectAll(relayUrls: string[]): void {
    const supportedVersions = [...this.handlers.keys()].filter(
      (v): v is number => typeof v === 'number',
    )

    const dispatch: CallDispatcher = (callId, schemaVersion, input) => {
      this.enqueue({ callId, schemaVersion, input })
    }

    for (const url of relayUrls) {
      const conn = new Connection(url, this.config, dispatch, supportedVersions, {
        onReady: () => this.onConnectionReady(),
        onAck: (callId) => this.settle(callId),
      })
      this.connections.push(conn)
      conn.start()
    }
  }

  private enqueue(call: QueuedCall): void {
    if (this.activeCount < this.config.maxConcurrentCalls) {
      this.processCall(call)
      return
    }

    this.queue.push(call)

    const maxQueue = this.config.maxConcurrentCalls * 2
    if (this.queue.length > maxQueue) {
      const oldest = this.queue.shift()!
      this.config.logger.warn(
        `[z3t SDK] Queue depth exceeded (max ${maxQueue}) — rejecting call ${oldest.callId}`,
      )
      this.deliverTerminal(oldest.callId, {
        type: 'error', callId: oldest.callId, message: 'Queue depth exceeded',
      })
    }
  }

  private dequeue(): void {
    if (this.queue.length > 0 && this.activeCount < this.config.maxConcurrentCalls) {
      this.processCall(this.queue.shift()!)
    }
  }

  private processCall(call: QueuedCall): void {
    this.activeCount++

    const handler = this.handlers.get(call.schemaVersion) ?? this.handlers.get('default')
    if (!handler) {
      this.activeCount--
      this.deliverTerminal(call.callId, {
        type: 'error',
        callId: call.callId,
        message: `No handler for schema version ${call.schemaVersion}`,
      })
      this.dequeue()
      return
    }

    const send: WsSend = (payload) => this.deliverBestEffort(payload)
    const ctx = createCallContext(call.callId, call.schemaVersion, send, this.config, createLlmClients(this.config, call.callId))

    const handlerPromise = handler(call.input as Record<string, unknown>, ctx)
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Handler timeout')), this.config.timeout)
    })

    Promise.race([handlerPromise, timeoutPromise])
      .then((output) => {
        this.deliverTerminal(call.callId, { type: 'result', callId: call.callId, output })
      })
      .catch((err: Error) => {
        this.deliverTerminal(call.callId, { type: 'error', callId: call.callId, message: err.message })
      })
      .finally(() => {
        this.activeCount--
        this.dequeue()
      })
  }
}
