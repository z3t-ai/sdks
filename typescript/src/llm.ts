import type OpenAI from 'openai'
import type Anthropic from '@anthropic-ai/sdk'
import type { GoogleGenerativeAI, ModelParams, RequestOptions } from '@google/generative-ai'
import type { ResolvedConfig } from './types'

export type LlmClients = {
  openai: OpenAI
  anthropic: Anthropic
  google: GoogleGenerativeAI
}

// Lazy getters — each LLM package is only require()'d when the handler actually
// accesses ctx.llm.openai / .anthropic / .google, so missing optional peer deps
// don't crash agents that don't use that provider.
export function createLlmClients(config: ResolvedConfig, callId?: string): LlmClients {
  const callHeaders = callId ? { 'x-agent-call-id': callId } : {}
  let _openai: OpenAI | undefined
  let _anthropic: Anthropic | undefined
  let _google: GoogleGenerativeAI | undefined

  return {
    get openai() {
      if (!_openai) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { default: Ctor } = require('openai') as { default: new (opts: object) => OpenAI }
          _openai = new Ctor({ baseURL: `${config.baseUrl}/llm/openai/v1`, apiKey: config.apiKey, defaultHeaders: callHeaders })
        } catch {
          throw new Error("ctx.llm.openai requires the 'openai' package. Run: npm install openai")
        }
      }
      return _openai
    },
    get anthropic() {
      if (!_anthropic) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { default: Ctor } = require('@anthropic-ai/sdk') as { default: new (opts: object) => Anthropic }
          _anthropic = new Ctor({ baseURL: `${config.baseUrl}/llm/anthropic`, apiKey: config.apiKey, defaultHeaders: callHeaders })
        } catch {
          throw new Error("ctx.llm.anthropic requires the '@anthropic-ai/sdk' package. Run: npm install @anthropic-ai/sdk")
        }
      }
      return _anthropic
    },
    get google() {
      if (!_google) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { GoogleGenerativeAI: Ctor } = require('@google/generative-ai') as { GoogleGenerativeAI: new (apiKey: string) => GoogleGenerativeAI & { getGenerativeModel(p: ModelParams, o?: RequestOptions): ReturnType<GoogleGenerativeAI['getGenerativeModel']> } }
          const proxyBaseUrl = `${config.baseUrl}/llm/google`
          const instance = new Ctor(config.apiKey)
          const origGet = instance.getGenerativeModel.bind(instance)
          instance.getGenerativeModel = (modelParams: ModelParams, requestOptions?: RequestOptions) =>
            origGet(modelParams, { ...requestOptions, baseUrl: requestOptions?.baseUrl ?? proxyBaseUrl })
          _google = instance
        } catch {
          throw new Error("ctx.llm.google requires the '@google/generative-ai' package. Run: npm install @google/generative-ai")
        }
      }
      return _google
    },
  }
}
