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
| `context.ts` | `CallContext` — files/taxonomies/integrations/agents HTTP calls, `step`/`ask` |
| `journal.ts` | `CallJournal` — memoized steps + answers for suspend/resume, `SuspendSignal` |
| `llm.ts` | Pre-configured OpenAI/Anthropic/Google proxy clients (built per call) |
| `schema.ts` | `s.*` builder — emits JSON Schema + `x-z3t-*` extensions |
| `types.ts` | `AgentConfig`, `CallContext`, `Handler`, defaults |
| `index.ts` | Public re-exports |

### Python (`python/z3t_ai_agent/`)

| File | Owns |
|------|------|
| `agent.py` | `Agent` class, `handle()` decorator factory, lifecycle |
| `connection.py` | websockets-based loop: auth, heartbeat, reconnect |
| `context.py` | `CallContext` dataclass + all `ctx.*` implementations (incl. `subprogress`, `step`, `ask`) |
| `journal.py` | `CallJournal`, `AskResult`, `SuspendSignal` (a `BaseException`) — mirrors `journal.ts` |
| `llm.py` | `create_llm_clients()` — proxy clients built per call |
| `schema.py` | `s` builder — same JSON Schema + `x-z3t-*` wire format as TypeScript |
| `types.py` | `ResolvedConfig`, `Logger` protocol, `TaxonomyEntry`, defaults |
| `__init__.py` | Public re-exports |

---

## Wire protocol (both SDKs)

```
→ { type: 'auth', apiKey, supportedVersions: number[] }
← { type: 'auth_ok', agentId, relayInstanceId }
← { type: 'call', callId, schemaVersion, input, turn, capabilities, canAsk, resume? }
→ { type: 'result', callId, turn, output }
→ { type: 'error', callId, turn, message }
→ { type: 'suspend', callId, turn, request: { key, message, schema }, checkpoint }
→ { type: 'progress', callId, step, message, progress? }
→ { type: 'subprogress', callId, message, progress? }
← { type: 'ping' }
→ { type: 'pong' }
← { type: 'ack', callId, turn? }
```

**Interactive calls — suspend and resume (added 2026-09-29).** A version synced with
`interactive: true` may pause a run to ask the consumer a question (`ctx.ask`). The handler does
not wait: `ask` records the question in the call's `CallJournal` and throws `SuspendSignal`; the
agent's turn-finisher sends `suspend` with the question and the journal (`{ v: 1, steps, answers }`,
≤ 2 MB compact JSON), whatever the handler did with the throw. The platform re-dispatches the call
as `turn + 1` with `resume: { checkpoint, response }`; the handler re-runs from the top, `ctx.step`
returns journaled values without re-running, `ctx.ask` returns the outcome, and progress is
suppressed while replaying. `ask` outcomes are values (`answered`/`declined`/`expired`/`unavailable`),
never exceptions. The pending map is keyed by `callId` + `turn` (turn 0 keeps the bare callId), and
an ack without `turn` (an older relay) settles every turn of the call. **No local caching of the
journal, by design** — the relay pushes it in the resume frame, a resume can land on any replica,
and it holds consumer data that must stay under platform retention/erasure. Contract:
`BUILDING_AN_SDK.md §6.1`; platform side: `backend/shared/src/interactions.ts`.

**Delivery is at-least-once, and `ack` is what closes the loop.** Both SDKs route frames through
the `Agent` (`_deliver` / `deliver`), which picks a live connection at send time rather than
capturing the socket a call arrived on — a ten-minute call routinely outlives its socket, and a
result written to a dead one is lost in silence, leaving the platform to reap a call whose work
actually finished. Terminal frames are held in a pending map and re-sent every 5s, and immediately
on any `auth_ok`, until the relay acks; the SDK gives up after 10 minutes and logs. The relay's
handlers are guarded on the call still being live, so duplicates are no-ops. `progress` and
`subprogress` are best-effort: bounded queue (50 frames), dropped past the cap, never retried.
**Python reached parity on 2026-09-29** — before that it bound replies to the arrival socket,
ignored `ack`, never retried, and had no `subprogress`; this paragraph described TypeScript only.
The Python retry constants are module-level in `agent.py` (`RESULT_RETRY_S`,
`RESULT_RETRY_TIMEOUT_S`, `OUTBOX_MAX`) so tests can shrink them with `monkeypatch`.

**`progress` vs `subprogress` (added in 0.2.0).** `progress` is a milestone — the platform persists
it and the caller's UI adds a row per event. `subprogress` is detail about the step already running:
it carries **no `step`** (it belongs to whichever milestone is newest, and the single ordered event
channel is what establishes that), is never persisted, and each one REPLACES the previous live line
rather than adding a row. It exists so a stage that runs for ten minutes — retrying OCR strategies
on a scanned document, walking 40 pages — can report continuously without flooding the log. The
relay caches only the newest one (Redis, 35min TTL) so a page reload still sees it, and drops it on
the next `progress` or on any terminal frame. See
[`BUILDING_AN_SDK.md §5.2`](BUILDING_AN_SDK.md).

**Liveness / half-open detection** is separate from the app-level `ping`/`pong` above.
Both SDKs run a keepalive watchdog (`heartbeatInterval`, default 30s / `heartbeat_interval`
30s) using **protocol-level** WebSocket ping/pong: if no frame of any kind arrives within
the interval, the socket is terminated so the reconnect path fires. Without it, a socket
dropped by a NAT/LB idle timeout or a relay crash stays half-open (OPEN but dead, no close
event) and the agent never reconnects. TS hand-rolls the watchdog in `connection.ts`;
Python configures the `websockets` library's built-in `ping_interval`/`ping_timeout`. See
[`BUILDING_AN_SDK.md §5.1`](BUILDING_AN_SDK.md).

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

### JSON Schema compliance — do not repurpose standard keywords

The schema builder must emit valid JSON Schema. Standard keywords must keep their spec-defined meaning:

- **`format` is for validated string constraints only.** Standard values (`email`, `uri`, `date-time`, etc.) and custom registered values (`z3t-file-uri`, `z3t-taxonomy-ref`, `z3t-integration-ref`) are valid because they constrain the value and are backed by Ajv validation. `format` is never valid on `type: "array"` or `type: "object"`.
- **Display or rendering hints are not `format` values.** A field whose value is "any string, rendered as Markdown" is not constrained by format — it uses `x-z3t-display: 'markdown'`. Same for `html`, `code`, `json`, `image`, `percent`, `file-output`. None of these validate the value; they only tell the frontend how to render it.
- **Anything that affects display or behaviour beyond the data contract belongs in `x-z3t-*` extension keys**, not in standard keywords.


### `x-z3t-*` extension keys

All z3t-specific annotations use the `x-z3t-` prefix so they are clearly non-standard and ignored by generic JSON Schema tooling.

**Rule**: `x-z3t-display` answers "how do I render this field's value" (widget for a leaf). `x-z3t-layout` answers "how do I arrange my children" (spatial structure for a container). They are orthogonal — a field can have both.

| Key | Applies to | Purpose |
|-----|-----------|---------|
| `x-z3t-hint` | any field | Short helper text shown below the field in the form |
| `x-z3t-order` | any field | Explicit sort position within the form |
| `x-z3t-group` | any field | Visual grouping label for adjacent fields |
| `x-z3t-display` | scalar / object | Rendering widget hint — see values below |
| `x-z3t-layout` | `object`, `array` | Spatial arrangement of children — see values below |
| `x-z3t-code-language` | `string` | Syntax-highlight language when `x-z3t-display: 'code'` |
| `x-z3t-color-map` | `enum` | Map of enum value → badge colour, e.g. `{ ACTIVE: 'green' }` |
| `x-z3t-accept` | `z3t-file-uri` | Accepted MIME types for the file upload widget |
| `x-z3t-max-size-mb` | `z3t-file-uri` | Max file size hint shown in the upload widget (MB) |
| `x-z3t-taxonomy-slug` | `z3t-taxonomy-ref` | Pre-selects a specific taxonomy in the dropdown |
| `x-z3t-integration-provider` | `z3t-integration-ref` | Filters the integration dropdown to one provider |
| `x-z3t-min` | `date`, `datetime` | Minimum allowed date (ISO string) |
| `x-z3t-max` | `date`, `datetime` | Maximum allowed date (ISO string) |

**`x-z3t-display` values** — widget for a single field's value (scalars and opaque objects)

| Value | Field type | Effect |
|-------|-----------|--------|
| `'textarea'` | `string` | Multi-line text input (form) |
| `'markdown'` | `string` | Markdown editor (form) / rendered Markdown (output) |
| `'html'` | `string` | Rendered sanitized HTML (output) |
| `'code'` | `string` | Code editor (form) / syntax-highlighted block (output); use with `x-z3t-code-language` |
| `'json'` | `string` | Syntax-highlighted pretty-printed JSON block (output) |
| `'image'` | `string` | Inline image (output); value is a URL or `z3t://files/{id}` |
| `'hidden'` | `string` | Field is not shown in the form |
| `'range'` | `number` / `integer` | Slider input (form) |
| `'percent'` | `number` | Percentage bar (output); value must be `0–1` |
| `'toggle'` | `boolean` | Toggle switch instead of checkbox (form) |
| `'radio'` | `enum` | Radio buttons instead of dropdown (form) |
| `'file-output'` | `string` | Agent-produced file URI — rendered as a download button (output) |
| `'pdf-reference'` | `object` | Renders as a clickable chip that opens a PDF preview (bypasses field-by-field rendering) |
| `'typed-value'` | `object` | Renders `{ format, value }` objects based on their inner format (bypasses field-by-field rendering) |

**`x-z3t-layout` values** — arrangement of children in a container

| Value | Container | Effect |
|-------|-----------|--------|
| `{ type: 'table', sortable?, searchable? }` | `array` | Renders output array as a table; columns from `items.properties` |
| `{ type: 'file-list' }` | `array` | Renders output array of file URIs as download links |
| `{ type: 'gallery' }` | `array` | Renders output array of images as a gallery |
| `{ type: 'grid', columns? }` | `array` | Renders items in a multi-column card grid |
| `{ type: 'list' }` | `array` | Stacks items vertically (default when no layout is set) |
| `{ type: 'grid', columns: N, areas: [...] }` | `object` | Arranges named fields in a CSS-grid-style layout with explicit rows and colspan |
