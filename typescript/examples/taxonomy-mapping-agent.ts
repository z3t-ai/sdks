/**
 * Agent that uses an org-managed taxonomy to remap a column of raw category values
 * to canonical ones, flagging anything it couldn't map.
 *
 * Run:
 *   export Z3T_AGENT_KEY=...
 *   npx tsx examples/taxonomy-mapping-agent.ts
 */

import { Agent, s } from '@z3t-ai/agent-sdk'

const agent = new Agent({ apiKey: process.env.Z3T_AGENT_KEY! })

agent.handle(1, {
  input: s.object({
    columnMapping: s.taxonomyRef({ title: 'Category mapping' }),
    rows: s.array(s.object({ rawCategory: s.string({ title: 'Raw category' }) }), { title: 'Rows' }),
  }),
  output: s.object({
    rows: s.array(s.object({
      rawCategory: s.string({ title: 'Raw category' }),
      category:    s.string({ title: 'Mapped category' }),
    }), { layout: 'table', title: 'Mapped rows' }),
    unmapped: s.array(s.object({ rawCategory: s.string({ title: 'Raw category' }) }), { title: 'Unmapped' }),
  }),
}, async (input, ctx) => {
  // input.columnMapping = "z3t://taxonomies/xyz789"
  const entries = await ctx.taxonomies.entries(input.columnMapping)
  const lookup = new Map(entries.map(e => [e.key, String(e.value)] as const))

  const transformed = input.rows.map(row => ({
    ...row,
    category: lookup.get(row.rawCategory) ?? row.rawCategory,
  }))
  const unmapped = input.rows.filter(row => !lookup.has(row.rawCategory))

  return { rows: transformed, unmapped }
})

agent.start()
