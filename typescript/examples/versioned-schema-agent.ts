/**
 * Versioned handler with a declared input/output schema (s.*). The schema syncs to
 * the platform on agent.start() and drives the frontend's form rendering and output
 * display. Demonstrates progress reporting, file download/upload, and an LLM call.
 *
 * The schema syncs as `draft` (mutable, invisible to consumers) — flip `status` to
 * 'active' to publish and freeze the contract once you're happy with it.
 *
 * Run:
 *   export Z3T_AGENT_KEY=...
 *   npx tsx examples/versioned-schema-agent.ts
 */

import { Agent, s } from '@z3t-ai/agent-sdk'

const agent = new Agent({ apiKey: process.env.Z3T_AGENT_KEY! })

agent.handle(1, {
  input: s.object({
    document: s.fileUri({ title: 'Contract PDF', accept: ['application/pdf'] }),
    language: s.enum(['en', 'fr', 'de'] as const, { title: 'Language' }),
    notes:    s.string({ display: 'textarea', title: 'Notes' }).optional(),
  }),
  output: s.object({
    summary:    s.markdown({ title: 'Summary' }),
    confidence: s.percent({ title: 'Confidence' }),
    report:     s.fileOutput({ title: 'Full PDF report' }),
  }),
  status: 'draft', // flip to 'active' once you're ready to publish this version
}, async (input, ctx) => {
  await ctx.progress('downloading', 'Downloading contract...', 0.1)
  const contract = await ctx.files.download(input.document)

  await ctx.progress('analysing', 'Analysing with AI...', 0.4)
  const result = await ctx.llm.anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `Summarise this contract in ${input.language}: ${contract.buffer.subarray(0, 4000).toString()}`,
    }],
  })
  const summary = result.content[0].type === 'text' ? result.content[0].text : ''

  await ctx.progress('uploading', 'Generating report...', 0.8)
  const reportUri = await ctx.files.upload(Buffer.from(summary), 'report.pdf', 'application/pdf')

  return {
    summary,
    confidence: 0.92,
    report: reportUri,
  }
})

agent.start()
