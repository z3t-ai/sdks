import type OpenAI from 'openai'
import type Anthropic from '@anthropic-ai/sdk'
import type { GoogleGenAI } from '@google/genai'
import type { SchemaField } from './schema'

export interface AgentConfig {
  /** Agent API key from the z3t dashboard */
  apiKey: string

  /** HTTP base URL for the relay API.
   *  Default: 'https://relay.z3t.ai/v1'
   *  Relay WebSocket URLs are fetched from this endpoint on start — no need to configure them. */
  baseUrl?: string

  /** Override relay WebSocket URLs. If omitted, URLs are fetched from the platform on start.
   *  Useful for local development and testing. */
  relayUrls?: string[]

  /** Per-call handler timeout in ms. Default: 25000 */
  timeout?: number

  /** Maximum simultaneous calls handled; excess calls are queued. Default: 10 */
  maxConcurrentCalls?: number

  /** Initial reconnect backoff in ms. Default: 1000 */
  reconnectDelay?: number

  /** Maximum reconnect backoff in ms. Default: 60000 */
  maxReconnectDelay?: number

  /** Heartbeat interval in ms. The SDK sends a WebSocket ping every interval and
   *  terminates the socket (forcing a reconnect) if no traffic arrives before the
   *  next one — this is what detects silently-dropped ("half-open") connections that
   *  never emit a 'close' event. Set to 0 to disable. Default: 30000 */
  heartbeatInterval?: number

  /** Custom logger. Default: console */
  logger?: Logger
}

export interface Logger {
  info(...a: unknown[]): void
  warn(...a: unknown[]): void
  error(...a: unknown[]): void
}

export interface TaxonomyEntry {
  key: string
  value: unknown
  label?: string
}

/** What became of a question asked with `ctx.ask`. Never throws for a non-answer — every outcome is
 *  a value, so the handler always has a best-effort path:
 *  - `answered` — the consumer filled in the form; `answers` matches the schema you asked with.
 *  - `declined` — the consumer chose to skip the question.
 *  - `expired` — nobody answered before the platform's deadline (7 days by default).
 *  - `unavailable` — this run can't take questions: the version isn't `interactive`, the caller
 *    can't answer (an API integration that didn't opt in, or another agent), or the call has used
 *    its question rounds. The handler did not suspend. */
export type AskResult<A = Record<string, unknown>> =
  | { action: 'answered'; answers: A }
  | { action: 'declined' }
  | { action: 'expired' }
  | { action: 'unavailable' }

/** The wire form of an outcome, as the relay delivers it on resume. */
export type AskResponse = AskResult<Record<string, unknown>> & { respondedAt?: string }

export interface AskOptions<A> {
  /** Markdown shown to the consumer above the form: what you found and why you're asking. Written
   *  for a person who hasn't seen your intermediate work — quote the document, name the field. */
  message: string
  /** The answer form. A flat `s.object({...})` of strings, numbers, booleans, enums, dates, and file
   *  uploads (or arrays of those). Mark fields `.optional()` if a partial answer is still useful. */
  schema: SchemaField<A>
}

export interface CallContext {
  callId: string
  schemaVersion: number
  /** Which turn of the call this is: 0 on the first dispatch, +1 after every answered question. */
  turn: number
  /** Whether `ctx.ask` can suspend this run to ask the consumer. When false, `ctx.ask` returns
   *  `{ action: 'unavailable' }` immediately — useful to decide up front whether to ask at all. */
  canAsk: boolean

  /** Runs `fn` once per call and remembers its result across a suspend/resume. On a resumed turn the
   *  stored result is returned without running `fn` again — so an expensive LLM pass before a
   *  question is paid for once. The result must be JSON-serializable, and is returned in its JSON
   *  form even on the first run (a Date comes back as a string). Keys must be unique per call.
   *
   *  Wrap anything with a side effect you must not repeat (an upload, a charge) in a step. Code
   *  outside steps runs again on every resume, so keep it cheap. */
  step<T>(key: string, fn: () => Promise<T> | T): Promise<T>

  /** Asks the consumer a clarifying question and pauses the run until they answer — hours or days
   *  later, possibly on another replica of this agent. The handler exits here and is re-run from
   *  the top on resume (see `step`); `ask` then returns the outcome. Requires the version to be
   *  declared `interactive: true`.
   *
   *  Ask early — before the expensive work — and only when the answer would change the result.
   *  Keys must be unique per call. */
  ask<A>(key: string, options: AskOptions<A>): Promise<AskResult<A>>

  /** Report a progress milestone. Each call adds a new line to the caller's activity log, so
   *  emit one per stage — not once per loop iteration. Fire-and-forget: do not await if not
   *  needed. `progress` is the overall 0–1 position, if the agent can estimate one. */
  progress(step: string, message: string, progress?: number): Promise<void>

  /** Report intermediate detail *within* the current step. Each call REPLACES the previous
   *  subprogress line rather than adding a row, so a long stage can report as often as it likes —
   *  "page 7 of 12", "OCR strategy 2 of 3", an elapsed counter — without turning a ten-minute run
   *  into sixty rows. This is what tells the user a slow stage is still working.
   *
   *  Only the newest line is kept (cached by the relay so a page reload still sees it); nothing is
   *  persisted to the call's durable event history. A subsequent `progress()` clears it. */
  subprogress(message: string, progress?: number): Promise<void>

  files: {
    /** Download a z3t://files/{id} URI → buffer + original filename */
    download(uri: string): Promise<{ buffer: Buffer; filename: string; mimeType: string }>
    /** Upload bytes → returns z3t://files/{id} URI */
    upload(data: Buffer, filename: string, mimeType: string): Promise<string>
  }

  taxonomies: {
    /** Fetch all entries for a z3t://taxonomies/{id} URI */
    entries(uri: string): Promise<TaxonomyEntry[]>
    /** Look up a single key within a taxonomy. Returns null if not found. */
    lookup(uri: string, key: string): Promise<TaxonomyEntry | null>
  }

  integrations: {
    /** Resolve z3t://integrations/{id} → decrypted credential fields */
    credentials(uri: string): Promise<Record<string, string>>
  }

  llm: {
    /** Pre-configured OpenAI client pointing to the z3t LLM proxy */
    openai: OpenAI
    /** Pre-configured Anthropic client pointing to the z3t LLM proxy */
    anthropic: Anthropic
    /** Pre-configured Google AI client pointing to the z3t LLM proxy */
    google: GoogleGenAI
  }

  agents: {
    /** Call another agent on the platform. Blocks until the call completes or times out.
     *  Progress events are suppressed for agent-to-agent calls. */
    call(
      agentId: string,
      planId: string,
      input: unknown,
      options?: {
        schemaVersion?: number
        consumerOrgId?: string
        timeoutMs?: number
      }
    ): Promise<unknown>
  }
}

export type Handler<Input = Record<string, unknown>, Output = unknown> = (
  input: Input,
  ctx: CallContext
) => Promise<Output>

/** Function used by context methods to send a WS frame back on the delivering connection */
export type WsSend = (msg: unknown) => void

/** A call as the relay dispatches it. Fields beyond the first three are absent from relays that
 *  predate interactive calls, which is why they're defaulted where the frame is parsed. */
export interface IncomingCall {
  callId: string
  schemaVersion: number
  input: unknown
  turn?: number
  capabilities?: string[]
  canAsk?: boolean
  resume?: {
    checkpoint: unknown
    response: AskResponse & { key: string }
  }
}

/** Fully resolved config — all fields present after defaults and bootstrap are applied */
export interface ResolvedConfig {
  apiKey: string
  relayUrls: string[]
  baseUrl: string
  timeout: number
  maxConcurrentCalls: number
  reconnectDelay: number
  maxReconnectDelay: number
  heartbeatInterval: number
  logger: Logger
}

export const DEFAULTS = {
  baseUrl: 'https://relay.z3t.ai/v1',
  timeout: 25_000,
  maxConcurrentCalls: 10,
  reconnectDelay: 1_000,
  maxReconnectDelay: 60_000,
  heartbeatInterval: 30_000,
} as const
