import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenerativeAI, type ModelParams, type RequestOptions } from '@google/generative-ai'
import type { ResolvedConfig } from './types'

/** Wraps GoogleGenerativeAI to transparently inject the z3t proxy baseUrl into every request */
class Z3tGoogleGenerativeAI extends GoogleGenerativeAI {
  constructor(apiKey: string, private readonly proxyBaseUrl: string) {
    super(apiKey)
  }

  getGenerativeModel(modelParams: ModelParams, requestOptions?: RequestOptions) {
    return super.getGenerativeModel(modelParams, {
      ...requestOptions,
      baseUrl: requestOptions?.baseUrl ?? this.proxyBaseUrl,
    })
  }
}

export type LlmClients = {
  openai: OpenAI
  anthropic: Anthropic
  google: GoogleGenerativeAI
}

export function createLlmClients(config: ResolvedConfig, callId?: string): LlmClients {
  const callHeaders = callId ? { 'x-agent-call-id': callId } : {}
  return {
    openai: new OpenAI({
      baseURL: `${config.baseUrl}/llm/openai/v1`,
      apiKey: config.apiKey,
      defaultHeaders: callHeaders,
    }),
    anthropic: new Anthropic({
      baseURL: `${config.baseUrl}/llm/anthropic`,
      apiKey: config.apiKey,
      defaultHeaders: callHeaders,
    }),
    google: new Z3tGoogleGenerativeAI(
      config.apiKey,
      `${config.baseUrl}/llm/google`,
    ),
  }
}
