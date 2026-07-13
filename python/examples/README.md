# Examples

Runnable, standalone agents demonstrating each major SDK feature.

| File | Demonstrates |
|---|---|
| `quickstart_default_handler.py` | Minimal agent — smallest useful `s.*` schema, file download/upload, `ctx.llm.openai` |
| `versioned_schema_agent.py` | Fuller `s.*` schema — `ctx.progress`, optional fields, enums, `ctx.llm.anthropic` |
| `integration_credentials_agent.py` | Resolving a stored integration credential and calling an external API with it — **⚠️ integrations vault is coming soon, not yet available** |
| `taxonomy_mapping_agent.py` | Using an org-managed taxonomy to remap values |
| `agent_chaining.py` | Calling another agent on the platform (`ctx.agents.call`) |

## Running

```bash
pip install -e "..[anthropic,openai]"   # from this directory; installs the SDK + LLM extras used below
export Z3T_AGENT_KEY=your-agent-api-key
python quickstart_default_handler.py
```

Each example declares at least one `s.*` schema — an agent needs one to publish a
contract buyers can call. `agent.start()` blocks and processes calls until you stop it
(Ctrl-C) or call `await agent.stop()` from elsewhere in your program.
