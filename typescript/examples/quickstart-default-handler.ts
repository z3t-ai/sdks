/**
 * Minimal agent: a single version with the smallest useful schema. Downloads an input
 * file, asks an LLM to summarise it, and uploads a result file.
 *
 * Every agent should declare at least one schema — it defines the buyer-facing form and
 * the output view, so without one there's no published contract buyers can call. This is
 * the smallest useful schema; see versioned-schema-agent.ts for progress reporting,
 * optional fields, and enums.
 *
 * Run:
 *   export Z3T_AGENT_KEY=...
 *   npx tsx examples/quickstart-default-handler.ts
 */

import { Agent, s } from '@z3t-ai/agent-sdk'

const agent = new Agent({ apiKey: process.env.Z3T_AGENT_KEY! })

agent.handle(1, {
  input: s.object({ document: s.fileUri({ title: 'Document' }) }),
  output: s.object({
    summary: s.markdown({ title: 'Summary' }),
    report:  s.fileOutput({ title: 'Summary file' }),
  }),
}, async (input, ctx) => {
  const { buffer } = await ctx.files.download(input.document)

  const response = await ctx.llm.openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: `Summarise this document: ${buffer.subarray(0, 2000).toString()}` }],
  })
  const summary = response.choices[0].message.content ?? ''

  const reportUri = await ctx.files.upload(Buffer.from(summary), 'summary.txt', 'text/plain')

  return {
    summary,
    report: reportUri, // z3t://files/{id} — frontend renders a download button
  }
})

agent.start()
