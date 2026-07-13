/**
 * Agent that calls another agent on the platform (agent-to-agent chaining) and
 * incorporates its output into its own result. Progress events are automatically
 * suppressed for the downstream call.
 *
 * Run:
 *   export Z3T_AGENT_KEY=...
 *   npx tsx examples/agent-chaining.ts
 */

import { Agent, s } from '@z3t-ai/agent-sdk'

const agent = new Agent({ apiKey: process.env.Z3T_AGENT_KEY! })

agent.handle(1, {
  input: s.object({
    document:          s.fileUri({ title: 'Document' }),
    extractionAgentId: s.string({ title: 'Extraction agent ID' }),
    extractionPlanId:  s.string({ title: 'Extraction plan ID' }),
  }),
  output: s.object({
    extractedFields: s.json({ title: 'Extracted fields' }),
    source:          s.string({ title: 'Source document' }),
  }),
}, async (input, ctx) => {
  await ctx.progress('delegating', 'Calling the extraction agent...', 0.3)

  const extraction = await ctx.agents.call(
    input.extractionAgentId,
    input.extractionPlanId,
    { document: input.document },
    { timeoutMs: 20_000 }, // falls back to this agent's own configured timeout if omitted
  )

  await ctx.progress('finishing', 'Formatting results...', 0.8)
  return { extractedFields: JSON.stringify(extraction), source: input.document }
})

agent.start()
