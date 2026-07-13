/**
 * Agent that resolves a stored integration credential and pushes data to an
 * external API with it (e.g. a CRM).
 *
 * ⚠️  The integrations credentials vault is COMING SOON — not yet available.
 *     `s.integrationRef()` and `ctx.integrations.credentials()` are part of the SDK
 *     surface, but the platform feature that backs them isn't live yet. This example
 *     is here so you can see the shape ahead of time; it won't resolve real
 *     credentials until the vault ships.
 *
 * Run (once the vault is available):
 *   export Z3T_AGENT_KEY=...
 *   npx tsx examples/integration-credentials-agent.ts
 */

import { Agent, s } from '@z3t-ai/agent-sdk'

const agent = new Agent({ apiKey: process.env.Z3T_AGENT_KEY! })

agent.handle(1, {
  input: s.object({
    targetCRM: s.integrationRef({ title: 'Target CRM' }),
    records:   s.array(s.object({ name: s.string({ title: 'Name' }) }), { title: 'Records to push' }),
  }),
  output: s.object({
    status:         s.string({ title: 'Status' }),
    recordsCreated: s.integer({ title: 'Records created' }),
  }),
}, async (input, ctx) => {
  // input.targetCRM = "z3t://integrations/abc123"  (Salesforce, api_key type)
  const { apiKey } = await ctx.integrations.credentials(input.targetCRM)

  const resp = await fetch('https://api.salesforce.com/...', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(input.records),
  })
  if (!resp.ok) throw new Error(`CRM push failed: HTTP ${resp.status}`)

  return { status: 'pushed', recordsCreated: input.records.length }
})

agent.start()
