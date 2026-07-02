import type { CallContext, ResolvedConfig, TaxonomyEntry, WsSend } from './types'
import type { LlmClients } from './llm'

/** Extract the resource ID from a z3t:// URI (e.g. z3t://files/abc123 → abc123) */
export function extractId(uri: string): string {
  const match = /^z3t:\/\/[^/]+\/(.+)$/.exec(uri)
  if (!match) throw new Error(`Invalid z3t URI: ${uri}`)
  return match[1]
}

async function apiFetch(
  path: string,
  init: RequestInit,
  apiKey: string,
  baseUrl: string,
  callId?: string,
): Promise<Response> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init.headers,
      Authorization: `Bearer ${apiKey}`,
      ...(callId ? { 'x-agent-call-id': callId } : {}),
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${body}`)
  }
  return res
}

export function createCallContext(
  callId: string,
  schemaVersion: number,
  send: WsSend,
  config: ResolvedConfig,
  llm: LlmClients,
): CallContext {
  const { apiKey, baseUrl } = config

  return {
    callId,
    schemaVersion,

    async progress(step, message, progress) {
      send({
        type: 'progress',
        callId,
        step,
        message,
        ...(progress !== undefined ? { progress } : {}),
      })
    },

    files: {
      async download(uri) {
        const id = extractId(uri)
        const res = await apiFetch(`/files/${id}/agent-url`, { method: 'GET' }, apiKey, baseUrl, callId)
        const { signedUrl, filename, mimeType } = (await res.json()) as { signedUrl: string; filename: string; mimeType: string }
        const dl = await fetch(signedUrl)
        if (!dl.ok) throw new Error(`Storage download failed: HTTP ${dl.status}`)
        return { buffer: Buffer.from(await dl.arrayBuffer()), filename, mimeType }
      },

      async upload(data, filename, mimeType) {
        // Step 1: request a presigned PUT URL from the relay
        const prepareRes = await apiFetch(
          '/files/agent-output/prepare',
          {
            method: 'POST',
            body: JSON.stringify({ callId, filename, mimeType, sizeBytes: data.byteLength }),
          },
          apiKey,
          baseUrl,
          callId,
        )
        const { fileId, uploadUrl, internalUri } = (await prepareRes.json()) as {
          fileId: string
          uploadUrl: string
          internalUri: string
        }

        // Step 2: upload directly to DO Spaces via the presigned PUT URL
        const putRes = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': mimeType, 'Content-Length': String(data.byteLength) },
          body: data,
        })
        if (!putRes.ok) throw new Error(`Storage upload failed: HTTP ${putRes.status}`)

        // Step 3: confirm the upload so the relay marks the file as ready
        await apiFetch(
          '/files/agent-output/confirm',
          {
            method: 'POST',
            body: JSON.stringify({ fileId, callId }),
          },
          apiKey,
          baseUrl,
          callId,
        )

        return internalUri
      },
    },

    taxonomies: {
      async entries(uri) {
        const id = extractId(uri)
        const res = await apiFetch(`/taxonomies/${id}/entries`, { method: 'GET' }, apiKey, baseUrl, callId)
        const { entries } = (await res.json()) as { entries: TaxonomyEntry[] }
        return entries
      },

      async lookup(uri, key) {
        const id = extractId(uri)
        try {
          const res = await apiFetch(
            `/taxonomies/${id}/entries/${encodeURIComponent(key)}`,
            { method: 'GET' },
            apiKey,
            baseUrl,
            callId,
          )
          return (await res.json()) as TaxonomyEntry
        } catch (err) {
          if ((err as Error).message.startsWith('HTTP 404')) return null
          throw err
        }
      },
    },

    integrations: {
      async credentials(uri) {
        const id = extractId(uri)
        const res = await apiFetch(
          `/integrations/${id}/credentials`,
          { method: 'GET' },
          apiKey,
          baseUrl,
          callId,
        )
        return (await res.json()) as Record<string, string>
      },
    },

    llm,

    agents: {
      async call(agentId, planId, input, options = {}) {
        const { schemaVersion, consumerOrgId, timeoutMs = config.timeout } = options
        const res = await apiFetch(
          '/agents/call',
          {
            method: 'POST',
            body: JSON.stringify({
              agentId,
              planId,
              input,
              ...(schemaVersion !== undefined ? { schemaVersion } : {}),
              ...(consumerOrgId !== undefined ? { consumerOrgId } : {}),
              timeoutMs,
              capabilities: [], // progress events are suppressed for agent-to-agent calls
            }),
          },
          apiKey,
          baseUrl,
          callId,
        )
        const { output } = (await res.json()) as { output: unknown }
        return output
      },
    },
  }
}
