# z3t Agent SDKs — working notes

Two SDKs, same wire contract: TypeScript (`@z3t-ai/agent-sdk`) and Python (`z3t-ai-agent-sdk`).

---

## Repo layout

| Path | Purpose |
|------|---------|
| `typescript/` | `@z3t-ai/agent-sdk` npm package |
| `typescript/src/` | Source files (compiled to `dist/`) |
| `typescript/tests/` | Integration tests (full round-trip against in-process mock relay) |
| `python/` | `z3t-ai-agent-sdk` PyPI package |
| `python/z3t_ai_agent/` | Source package |
| `python/tests/` | Unit + integration tests |
| `python/examples/` | 5 runnable standalone agents |
| `BUILDING_AN_SDK.md` | Wire/HTTP contract spec for porting to a new language |

---

## Running tests

```bash
# TypeScript
cd typescript && npm install && npm test
npm run coverage   # 90% lines / 85% branches required

# Python
cd python && pip install -e ".[dev]" && pytest
pytest --cov=z3t_ai_agent --cov-fail-under=90
```

Both suites are self-contained — they spin up an in-process mock relay and mock HTTP, so no z3t credentials or external services are needed.

---

## Key source files

### TypeScript (`typescript/src/`)

| File | Owns |
|------|------|
| `agent.ts` | `Agent` class, handler registration, concurrency/queueing |
| `connection.ts` | WebSocket lifecycle: auth, heartbeat, reconnect |
| `context.ts` | `CallContext` — files/taxonomies/integrations/agents HTTP calls |
| `llm.ts` | Pre-configured OpenAI/Anthropic/Google proxy clients (built per call) |
| `schema.ts` | `s.*` builder — emits JSON Schema + `x-z3t-*` extensions |
| `types.ts` | `AgentConfig`, `CallContext`, `Handler`, defaults |
| `index.ts` | Public re-exports |

### Python (`python/z3t_ai_agent/`)

| File | Owns |
|------|------|
| `agent.py` | `Agent` class, `handle()` decorator factory, lifecycle |
| `connection.py` | websockets-based loop: auth, heartbeat, reconnect |
| `context.py` | `CallContext` dataclass + all `ctx.*` implementations |
| `llm.py` | `create_llm_clients()` — proxy clients built per call |
| `schema.py` | `s` builder — same JSON Schema + `x-z3t-*` wire format as TypeScript |
| `types.py` | `ResolvedConfig`, `Logger` protocol, `TaxonomyEntry`, defaults |
| `__init__.py` | Public re-exports |

---

## Wire protocol (both SDKs)

```
→ { type: 'auth', apiKey, supportedVersions: number[] }
← { type: 'auth_ok', agentId, relayInstanceId }
← { type: 'call', callId, schemaVersion, input }
→ { type: 'result', callId, output }
→ { type: 'error', callId, message }
→ { type: 'progress', callId, step, message, progress? }
← { type: 'ping' }
→ { type: 'pong' }
```

Full spec (every HTTP endpoint, every default, every behavioral rule): [`BUILDING_AN_SDK.md`](BUILDING_AN_SDK.md).

---

## Deliberate API differences between SDKs

These are sanctioned language-idiomatic choices, not drift — see `BUILDING_AN_SDK.md §14`:

- `Agent.handle()` is a **decorator factory** in Python, an overloaded method in TypeScript
- Config durations are **seconds** in Python, milliseconds in TypeScript
- Handler timeout uses `asyncio.wait_for` (real cancellation) in Python; `Promise.race` (non-cancelling) in TypeScript
- `CallContext` lives in `context.py` (Python), `types.ts` (TypeScript)

---

## `ctx.files.download` returns an object, not raw bytes

Both SDKs: `await ctx.files.download(uri)` returns `{ buffer, filename, mimeType }` (TS) / `DownloadResult(buffer, filename, mime_type)` (Python). Tests that assert on the download result must check `result.buffer`, not `result` directly.

---

## Schema builder

`s.*` (TypeScript) / `s` (Python) emits standard JSON Schema plus `x-z3t-*` extension keys. Full field reference: [`typescript/README.md`](typescript/README.md) or [`python/README.md`](python/README.md). Wire format: [`BUILDING_AN_SDK.md §10`](BUILDING_AN_SDK.md#10-schema-wire-format-reference).

Every field is **required by default** — `.optional()` removes the key from the `required` array.
