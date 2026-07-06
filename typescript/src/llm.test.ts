import { describe, it, expect } from 'vitest'
import { createLlmClients } from './llm'
import type { ResolvedConfig } from './types'

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    apiKey: 'agent-key',
    relayUrls: [],
    baseUrl: 'https://relay.z3t.ai/v1',
    timeout: 25_000,
    maxConcurrentCalls: 10,
    reconnectDelay: 1_000,
    maxReconnectDelay: 60_000,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  }
}

describe('ctx.llm.google (@google/genai)', () => {
  it('returns a GoogleGenAI instance with the expected API surface', () => {
    const clients = createLlmClients(makeConfig(), 'call-abc')
    const g = clients.google
    // instanceof fails across ESM/CJS module boundaries; check shape instead
    expect(g.constructor.name).toBe('GoogleGenAI')
    expect(g).toHaveProperty('models')
    expect(g).toHaveProperty('chats')
  })

  it('caches the instance across accesses', () => {
    const clients = createLlmClients(makeConfig())
    expect(clients.google).toBe(clients.google)
  })

  it('creates a fresh instance per createLlmClients call', () => {
    const a = createLlmClients(makeConfig())
    const b = createLlmClients(makeConfig())
    expect(a.google).not.toBe(b.google)
  })
})
