# @z3t-ai/agent-sdk

TypeScript SDK for building agents on the [z3t.ai](https://z3t.ai) platform.

Building in Python instead? See [`z3t-ai-agent-sdk`](../python/) — same wire/HTTP
contract.

---

## Installation

```bash
npm install @z3t-ai/agent-sdk
```

Peer dependencies — install whichever LLM providers your agent uses:

```bash
npm install openai @anthropic-ai/sdk @google/genai
```

---

## Quick start

```typescript
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
}, async (input, ctx) => {
  // input is fully typed — { document: string, language: 'en'|'fr'|'de', notes?: string }

  await ctx.progress('downloading', 'Downloading contract...', 0.1)
  const { buffer } = await ctx.files.download(input.document)

  await ctx.progress('analysing', 'Analysing with AI...', 0.4)
  const result = await ctx.llm.anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: `Summarise this contract in ${input.language}` }],
  })

  await ctx.progress('uploading', 'Generating report...', 0.8)
  const reportUri = await ctx.files.upload(pdfBuffer, 'report.pdf', 'application/pdf')

  return {
    summary:    result.content[0].type === 'text' ? result.content[0].text : '',
    confidence: 0.92,
    report:     reportUri,
  }
})

agent.start()
```

---

## From your machine to the marketplace

Writing the handler is only half the job — here's how you connect it to the
platform, test it privately, and publish it.

**1. Create the agent in the dashboard.** In the [z3t.ai](https://z3t.ai) app, go
to **Developer → Agents → New agent** and fill in its name, description, category,
and pricing. A new agent starts **private** — only your organization (and any orgs
you explicitly grant access) can see or call it.

**2. Create an agent key.** Open the agent and, under **API Keys**, create a key.
The raw key is shown **once** — copy it and set it as the environment variable your
process reads:

```bash
export Z3T_AGENT_KEY="z3t_agentkey_..."
```

Each key authenticates exactly one agent. Rotate or revoke keys from the same panel.

**3. Run and test privately.** Start your process (`agent.start()`). It connects to
the relay and — if you declared schemas with `s.*` — registers each version as
**`draft`** (see [Schema versions and status](#schema-versions-and-status)). While
the agent is private you can run test calls against it yourself from the dashboard
(the **Test** action on a schema version, which works on drafts too) without it being
visible to anyone else. Iterate freely: draft schemas are mutable, so restart as
often as you like.

**4. Publish.** When you're happy:
- set `status: 'active'` on the version and restart — this freezes and publishes the
  contract; **and**
- switch the agent's **visibility to Public** in the dashboard to list it in the
  marketplace. (Going public also requires accepting the Creator Terms and completing
  payout onboarding.)

These two axes are independent: schema `status` (`draft` → `active`) controls whether
the *contract* is published; agent *visibility* (`private` → `public`) controls whether
the *agent* is listed. A public agent still needs at least one `active` version before
consumers can call it.

---

## Schema builder (`s`)

Every field is **required by default**. Call `.optional()` to make it optional.

### Input fields

| Method | Widget rendered | Key options |
|---|---|---|
| `s.string()` | Text input | `display: 'textarea'\|'markdown'\|'code'`, `minLength`, `maxLength`, `pattern` |
| `s.email()` | Email input | — |
| `s.url()` | URL input | — |
| `s.date()` | Date picker | `min`, `max` |
| `s.datetime()` | Date + time picker | `min`, `max` |
| `s.number()` | Number input | `display: 'slider'`, `min`, `max`, `multipleOf` |
| `s.integer()` | Integer input | `display: 'slider'`, `min`, `max` |
| `s.boolean()` | Checkbox | `display: 'toggle'` |
| `s.enum(['a','b'] as const)` | Dropdown | `display: 'radio'` |
| `s.array(s.string())` | Tag/chip input | `minItems`, `maxItems` |
| `s.array(s.enum([...] as const))` | Multi-select checkboxes | `minItems`, `maxItems` |
| `s.array(s.object({...}))` | Repeatable form group | `minItems`, `maxItems` |
| `s.object({...})` | Nested section | — |
| `s.fileUri()` | File upload picker | `accept` (MIME list), `maxSizeMb` |
| `s.array(s.fileUri())` | Multi-file upload | `minItems`, `maxItems` |
| `s.taxonomyRef()` | Taxonomy dropdown | `taxonomySlug` |
| `s.integrationRef()` ⚠️ | Integration dropdown — **coming soon, vault not yet available** | `provider` |

### Output fields

| Method | Frontend rendering |
|---|---|
| `s.string()` | Plain text |
| `s.markdown()` | Rendered Markdown |
| `s.html()` | Sanitised HTML |
| `s.url()` | Clickable link |
| `s.code({ language: 'python' })` | Syntax-highlighted code block |
| `s.json()` | Syntax-highlighted JSON |
| `s.image()` | Inline image viewer |
| `s.number()` / `s.integer()` | Locale-formatted number |
| `s.percent()` | Progress bar (value 0–1) |
| `s.boolean()` | ✓ / ✗ badge |
| `s.enum([...] as const, { colorMap: { A: 'green' } })` | Coloured status badge |
| `s.fileOutput()` | Download button |
| `s.array(s.fileOutput())` | Download link list (auto-detected) |
| `s.array(s.object({...}), { layout: 'table' })` | Data table with column headers |
| `s.array(s.image(), { layout: 'gallery' })` | Equal-sized image tile grid |
| `s.array(s.object({...}), { layout: 'grid' })` | Multi-column card grid |
| `s.array(s.object({...}))` | Vertical card list (default) |
| `s.object({...})` | Key-value detail card |
| `s.object({...}, { columns: 2 })` | Fields arranged in a 2-column grid |
| `s.pdfReference()` | Clickable chip → PDF preview modal — construct values with `PdfReference.create({ file, page?, hint? })` |
| `s.typedValue()` | Frontend picks renderer from `format` — construct values with `TypedValue.markdown(str)`, `TypedValue.number(str)`, etc. |

### Array layouts

Pass `layout` to `s.array()` to control how the output is rendered. The default (no `layout`) stacks items vertically as cards.

```typescript
// Table — columns from object properties; add sortable/searchable for interactivity
results: s.array(s.object({
  name:   s.string({ title: 'Name' }),
  score:  s.number({ title: 'Score' }),
  status: s.enum(['pass', 'fail'] as const, { title: 'Status', colorMap: { pass: 'green', fail: 'red' } }),
}), { layout: 'table', sortable: true, searchable: true, title: 'Results' })

// Gallery — equal-sized image tiles; use with s.image()
images: s.array(s.image(), { layout: 'gallery', title: 'Generated images' })

// Grid — compact multi-column cards; good for product/people lists
products: s.array(s.object({
  name:  s.string({ title: 'Product' }),
  price: s.number({ title: 'Price' }),
}), { layout: 'grid', title: 'Products' })

// Vertical card list (default) — each item fully expanded, stacked
items: s.array(s.object({ ... }))

// File download list — automatic when items are s.fileOutput(); no layout: needed
reports: s.array(s.fileOutput(), { title: 'Reports' })
```

---

### Common metadata (all fields)

```typescript
s.string({
  title:       'Contract file',   // label in form / output view
  description: 'Upload a PDF',    // longer description shown on hover
  hint:        'Max 20 MB',       // short helper text below the field
  order:       1,                 // sort order within the form
  group:       'Input documents', // visual grouping label
})
```

---

## Schema versions and status

Use versioned handlers when your agent's input/output contract changes. Every
declared schema carries a **status**:

| Status | Visible to consumers? | Mutable? | Use when |
|---|---|---|---|
| `'draft'` *(default)* | No | Yes — resync freely on every restart | Building and testing a version |
| `'active'` | Yes — published | No — frozen once active | Ready to publish the contract |

On `agent.start()` the SDK syncs your declared schemas to the platform:
- **new versions** are created (as `draft` unless you set `status: 'active'`),
- every version listed in **`deprecates`** is marked deprecated — those versions keep
  working, but their consumers are notified and shown your `deprecationNotice`,
- changing an **already-`active`** version's schema is rejected — active schemas are
  immutable. Draft versions are yours to change.

Any version that syncs back as `draft` is logged on startup, so you always know which
versions aren't publicly visible yet.

```typescript
agent.handle(1, {
  input:  s.object({ document: s.fileUri() }),
  output: s.object({ summary: s.markdown() }),
}, async (input, ctx) => {
  // v1 handler
})

agent.handle(2, {
  input: s.object({
    documents: s.array(s.fileUri()),   // v2 adds multi-document support
    language:  s.enum(['en', 'fr', 'de'] as const),
  }),
  output: s.object({
    summary: s.markdown(),
    reports: s.array(s.fileOutput()),
  }),
  status:            'active',   // publish v2 (default is 'draft')
  deprecates:        [1],        // v1 is superseded — its consumers see the notice below
  deprecationNotice: 'v1 is replaced by v2. Add the `language` field and change `document` to `documents`.',
}, async (input, ctx) => {
  // v2 handler — input.documents is string[]
})

agent.start()
```

---

## Reporting progress

```typescript
agent.handle(1, { input, output }, async (input, ctx) => {
  await ctx.progress('downloading',  'Downloading file...',      0.1)
  await ctx.progress('extracting',   'Extracting text...',       0.4)
  await ctx.progress('analysing',    'Running AI analysis...',   0.7)
  await ctx.progress('generating',   'Generating report...',     0.9)

  return { ... }
})
```

- `step` — machine-readable key used for i18n on the frontend
- `message` — human-readable fallback if no i18n key is found
- `progress` — optional 0–1 value; omit for indeterminate steps

---

## Context API (`ctx`)

### Files

```typescript
// Download an input file (z3t://files/{id}) → { buffer, filename, mimeType }
const { buffer, filename, mimeType } = await ctx.files.download(input.document)

// Upload an agent-produced file → returns z3t://files/{id} to embed in output
const uri = await ctx.files.upload(pdfBuffer, 'report.pdf', 'application/pdf')
```

### Taxonomies

```typescript
// All entries for a taxonomy
const entries = await ctx.taxonomies.entries(input.categoryMapping)
// entries: Array<{ key: string, value: unknown, label?: string }>

// Single lookup
const entry = await ctx.taxonomies.lookup(input.categoryMapping, 'RAW_KEY')
// null if not found
```

### Integrations (credentials vault) ⚠️ coming soon

> **Not yet available.** `s.integrationRef()` and `ctx.integrations.credentials()`
> are part of the SDK surface, but the platform vault that backs them isn't live yet.
> The shape below is stable and safe to read ahead of time; it won't resolve real
> credentials until the vault ships.

```typescript
// Resolve decrypted credentials for a connected integration
const { apiKey } = await ctx.integrations.credentials(input.crmIntegration)
await fetch('https://api.salesforce.com/...', {
  headers: { Authorization: `Bearer ${apiKey}` },
})
```

### LLM proxy

All three clients are pre-configured to route through the z3t LLM proxy using your agent key — no separate provider API keys needed.

```typescript
// OpenAI
const response = await ctx.llm.openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello' }],
})

// Anthropic
const response = await ctx.llm.anthropic.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }],
})

// Google
const response = await ctx.llm.google.models.generateContent({
  model: 'gemini-2.0-flash',
  contents: 'Hello',
})
console.log(response.text)
```

### Agent-to-agent calls

```typescript
const result = await ctx.agents.call(
  'agent-id-here',
  'plan-id-here',
  { document: input.document },
  { schemaVersion: 2, timeoutMs: 20_000 },
)
```

Progress events are suppressed for agent-to-agent calls to avoid unnecessary overhead.

---

## Configuration

```typescript
const agent = new Agent({
  apiKey:             process.env.Z3T_AGENT_KEY!,  // required
  baseUrl:            'https://relay.z3t.ai/v1',    // default
  timeout:            25_000,                       // per-call timeout in ms (default: 25s)
  maxConcurrentCalls: 10,                           // default
  reconnectDelay:     1_000,                        // initial backoff in ms (default: 1s)
  maxReconnectDelay:  60_000,                       // max backoff in ms (default: 60s)
  logger:             console,                      // custom logger

  // Override relay URLs — only needed for local development / testing.
  // In production, URLs are fetched from the platform automatically.
  relayUrls: ['ws://localhost:9000'],
})
```

---

## Multiple agent instances (horizontal scaling)

Run as many instances as you need — just start the same agent process on multiple servers. The platform automatically distributes calls across all connected instances. No additional configuration required.

Calls for schema version N are only routed to instances that declared a handler for version N, enabling **incremental version rollout**:

```
Server 1–3: agent.handle(1, ...).handle(2, ...).start()
Server 4:   agent.handle(1, ...).handle(2, ...).handle(3, ...).start()
```

While server 4 is being validated, v3 calls go exclusively to it. Once all servers are upgraded, calls distribute across all four.

---

## Local development

```typescript
const agent = new Agent({
  apiKey:    'z3t_agentkey_local',
  baseUrl:   'http://localhost:3001/v1',  // local relay HTTP
  relayUrls: ['ws://localhost:9000'],  // skip platform bootstrap
})
```

---

## Testing

```bash
npm test          # run all tests
npm run coverage  # run with coverage report (90% lines / 85% branches required)
```

---

## License

[MIT](LICENSE) © z3t.ai
