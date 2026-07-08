import type OpenAI from 'openai'
import type Anthropic from '@anthropic-ai/sdk'
import type { GoogleGenAI } from '@google/genai'

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

export interface CallContext {
  callId: string
  schemaVersion: number

  /** Report a progress step to the platform. Fire-and-forget — do not await if not needed. */
  progress(step: string, message: string, progress?: number): Promise<void>

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

/** Fully resolved config — all fields present after defaults and bootstrap are applied */
export interface ResolvedConfig {
  apiKey: string
  relayUrls: string[]
  baseUrl: string
  timeout: number
  maxConcurrentCalls: number
  reconnectDelay: number
  maxReconnectDelay: number
  logger: Logger
}

export const DEFAULTS = {
  baseUrl: 'https://relay.z3t.ai/v1',
  timeout: 25_000,
  maxConcurrentCalls: 10,
  reconnectDelay: 1_000,
  maxReconnectDelay: 60_000,
} as const
