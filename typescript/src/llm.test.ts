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
    heartbeatInterval: 30_000,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  }
}

describe('ctx.llm.openai (openai)', () => {
  it('returns an OpenAI instance pointed at the z3t proxy', () => {
    const clients = createLlmClients(makeConfig({ baseUrl: 'https://relay.example/v1' }), 'call-1')
    const o = clients.openai
    expect(o.constructor.name).toBe('OpenAI')
    expect(o).toHaveProperty('chat')
    // baseURL is threaded through to the /llm/openai/v1 proxy path
    expect(o.baseURL).toBe('https://relay.example/v1/llm/openai/v1')
  })

  it('caches the instance across accesses', () => {
    const clients = createLlmClients(makeConfig())
    expect(clients.openai).toBe(clients.openai)
  })
})

describe('ctx.llm.anthropic (@anthropic-ai/sdk)', () => {
  it('returns an Anthropic instance pointed at the z3t proxy', () => {
    const clients = createLlmClients(makeConfig({ baseUrl: 'https://relay.example/v1' }), 'call-1')
    const a = clients.anthropic
    expect(a.constructor.name).toBe('Anthropic')
    expect(a).toHaveProperty('messages')
    expect(a.baseURL).toBe('https://relay.example/v1/llm/anthropic')
  })

  it('caches the instance across accesses', () => {
    const clients = createLlmClients(makeConfig())
    expect(clients.anthropic).toBe(clients.anthropic)
  })

  it('creates a fresh instance per createLlmClients call', () => {
    const a = createLlmClients(makeConfig())
    const b = createLlmClients(makeConfig())
    expect(a.anthropic).not.toBe(b.anthropic)
  })
})

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
