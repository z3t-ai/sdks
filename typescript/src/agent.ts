import { Connection, type CallDispatcher } from './connection'
import { createCallContext } from './context'
import { createLlmClients } from './llm'
import { DEFAULTS, type AgentConfig, type Handler, type ResolvedConfig, type WsSend } from './types'
import type { VersionSchema } from './schema'

interface QueuedCall {
  callId: string
  schemaVersion: number
  input: unknown
  send: WsSend
}

export class Agent {
  private readonly handlers = new Map<number | 'default', Handler>()
  private readonly versionSchemas = new Map<number, VersionSchema<unknown, unknown>>()
  private readonly config: ResolvedConfig
  private activeCount = 0
  private readonly queue: QueuedCall[] = []
  private readonly connections: Connection[] = []

  constructor(config: AgentConfig) {
    this.config = {
      baseUrl: DEFAULTS.baseUrl,
      timeout: DEFAULTS.timeout,
      maxConcurrentCalls: DEFAULTS.maxConcurrentCalls,
      reconnectDelay: DEFAULTS.reconnectDelay,
      maxReconnectDelay: DEFAULTS.maxReconnectDelay,
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
    for (const conn of this.connections) conn.stop()
    this.connections.length = 0
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

    const dispatch: CallDispatcher = (callId, schemaVersion, input, send) => {
      this.enqueue({ callId, schemaVersion, input, send })
    }

    for (const url of relayUrls) {
      const conn = new Connection(url, this.config, dispatch, supportedVersions)
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
      oldest.send({ type: 'error', callId: oldest.callId, message: 'Queue depth exceeded' })
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
      call.send({
        type: 'error',
        callId: call.callId,
        message: `No handler for schema version ${call.schemaVersion}`,
      })
      this.dequeue()
      return
    }

    const ctx = createCallContext(call.callId, call.schemaVersion, call.send, this.config, createLlmClients(this.config, call.callId))

    const handlerPromise = handler(call.input as Record<string, unknown>, ctx)
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Handler timeout')), this.config.timeout)
    })

    Promise.race([handlerPromise, timeoutPromise])
      .then((output) => {
        call.send({ type: 'result', callId: call.callId, output })
      })
      .catch((err: Error) => {
        call.send({ type: 'error', callId: call.callId, message: err.message })
      })
      .finally(() => {
        this.activeCount--
        this.dequeue()
      })
  }
}
