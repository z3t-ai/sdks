# Examples

Runnable, standalone agents demonstrating each major SDK feature. These mirror the
[Python examples](../../python/examples/) one-for-one.

| File | Demonstrates |
|---|---|
| `quickstart-default-handler.ts` | Minimal agent — smallest useful `s.*` schema, file download/upload, `ctx.llm.openai` |
| `versioned-schema-agent.ts` | Fuller `s.*` schema — `ctx.progress`, optional fields, enums, `ctx.llm.anthropic` |
| `integration-credentials-agent.ts` | Resolving a stored integration credential and calling an external API with it — **⚠️ integrations vault is coming soon, not yet available** |
| `taxonomy-mapping-agent.ts` | Using an org-managed taxonomy to remap values |
| `agent-chaining.ts` | Calling another agent on the platform (`ctx.agents.call`) |

## Running

```bash
npm install @z3t-ai/agent-sdk openai @anthropic-ai/sdk   # SDK + the LLM providers used below
export Z3T_AGENT_KEY=your-agent-api-key
npx tsx quickstart-default-handler.ts
```

Each example declares at least one `s.*` schema — an agent needs one to publish a
contract buyers can call. `agent.start()` connects to the platform and processes calls
until you stop it (Ctrl-C) or call `await agent.stop()` from elsewhere in your program.

Before an agent can receive calls you need to create it in the dashboard and mint an
agent key — see [**From your machine to the marketplace**](../README.md#from-your-machine-to-the-marketplace)
in the main README.
