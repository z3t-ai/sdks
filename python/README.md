# z3t-ai-agent-sdk

Python SDK for building agents on the [z3t.ai](https://z3t.ai) platform.

This is the Python counterpart to [`@z3t-ai/agent-sdk`](../typescript/) — same wire/HTTP contract.
the same wire/HTTP contract.

> **Units differ from the TypeScript SDK.** Durations here (`timeout`,
> `reconnect_delay`, `max_reconnect_delay`) are in **seconds**, not milliseconds, to
> match Python/asyncio convention (`asyncio.sleep`, `asyncio.wait_for`). The effective
> defaults are the same: 25s handler timeout, 1s initial reconnect backoff, 60s
> backoff ceiling.

---

## Installation

```bash
pip install z3t-ai-agent-sdk
```

Install whichever LLM provider extras your agent uses:

```bash
pip install "z3t-ai-agent-sdk[openai,anthropic,google]"
# or just the ones you need, e.g.:
pip install "z3t-ai-agent-sdk[anthropic]"
```

Requires Python 3.10+.

---

## Quick start

```python
import asyncio
import os

from z3t_ai_agent import Agent, VersionSchema, s

agent = Agent(api_key=os.environ["Z3T_AGENT_KEY"])

contract_schema_v1 = VersionSchema(
    input=s.object({
        "document": s.file_uri(title="Contract PDF", accept=["application/pdf"]),
        "language": s.enum(["en", "fr", "de"], title="Language"),
        "notes": s.string(display="textarea", title="Notes").optional(),
    }),
    output=s.object({
        "summary": s.markdown(title="Summary"),
        "confidence": s.percent(title="Confidence"),
        "report": s.file_output(title="Full PDF report"),
    }),
)


@agent.handle(version=1, schema=contract_schema_v1)
async def handle_v1(input: dict, ctx) -> dict:
    await ctx.progress("downloading", "Downloading contract...", 0.1)
    file = await ctx.files.download(input["document"])

    await ctx.progress("analysing", "Analysing with AI...", 0.4)
    response = await ctx.llm.anthropic.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1024,
        messages=[{"role": "user", "content": f"Summarise this contract in {input['language']}"}],
    )

    await ctx.progress("uploading", "Generating report...", 0.8)
    report_uri = await ctx.files.upload(pdf_bytes, "report.pdf", "application/pdf")

    return {
        "summary": response.content[0].text,
        "confidence": 0.92,
        "report": report_uri,
    }


asyncio.run(agent.start())
```

See [`examples/`](examples/) for complete, runnable agents — a minimal default
handler, a versioned schema agent, a credentials-vault integration agent, a
taxonomy-driven mapping agent, and an agent-to-agent chaining example.

---

## Registering handlers

`Agent.handle()` is a decorator factory:

```python
@agent.handle()                          # default handler — all schema versions
@agent.handle(version=1)                  # version-specific, no schema
@agent.handle(version=1, schema=schema)    # version-specific, typed schema
```

A version-specific handler takes priority over the default handler for calls
targeting that version. If neither matches, the relay receives an error and your
handler is never invoked.

---

## Schema builder (`s`)

Every field is **required by default**. Call `.optional()` to make it optional.
Options that were object literals in the TypeScript builder (`s.string({ title, ... })`)
are keyword arguments here (`s.string(title=...)`).

### Input fields

| Method | Widget rendered | Key options |
|---|---|---|
| `s.string()` | Text input | `display="textarea"\|"markdown"\|"code"\|"hidden"`, `min_length`, `max_length`, `pattern` |
| `s.email()` | Email input | — |
| `s.url()` | URL input | — |
| `s.date()` | Date picker | `min`, `max` |
| `s.datetime()` | Date + time picker | `min`, `max` |
| `s.number()` | Number input | `display="slider"`, `min`, `max`, `multiple_of` |
| `s.integer()` | Integer input | `display="slider"`, `min`, `max` |
| `s.boolean()` | Checkbox | `display="toggle"` |
| `s.enum(["a", "b"])` | Dropdown | `display="radio"` |
| `s.array(s.string())` | Tag/chip input | `min_items`, `max_items` |
| `s.array(s.enum([...]))` | Multi-select checkboxes | `min_items`, `max_items` |
| `s.array(s.object({...}))` | Repeatable form group | `min_items`, `max_items` |
| `s.object({...})` | Nested section | — |
| `s.file_uri()` | File upload picker | `accept` (MIME list), `max_size_mb` |
| `s.array(s.file_uri())` | Multi-file upload | `min_items`, `max_items` |
| `s.taxonomy_ref()` | Taxonomy dropdown | `taxonomy_slug` |
| `s.integration_ref()` | Integration dropdown | `provider` |

### Output fields

| Method | Frontend rendering |
|---|---|
| `s.string()` | Plain text |
| `s.markdown()` | Rendered Markdown |
| `s.html()` | Sanitized HTML |
| `s.url()` | Clickable link |
| `s.code(language=...)` | Syntax-highlighted code block |
| `s.json()` | Syntax-highlighted JSON block |
| `s.image()` | Inline image |
| `s.percent()` | Percentage bar (value 0–1) |
| `s.file_output()` | Download button |
| `s.array(s.file_output())` | Auto-detected as a file list |
| `s.array(s.object({...}), display="table")` | Sortable/searchable table |
| `s.pdf_reference()` | Clickable chip → PDF preview modal — construct values with `pdf_reference(file, page=..., hint=...)` |
| `s.typed_value()` | Frontend picks renderer from `format` — construct values with `typed_value.markdown(str)`, `typed_value.number(str)`, etc. |

### Versioning lifecycle

```python
VersionSchema(
    input=...,
    output=...,
    status="draft",          # default — mutable, invisible to consumers
    # status="active",       # publishes and freezes the schema
    deprecates=[1],          # optional — versions this one replaces
    deprecation_notice="...",
)
```

---

## `CallContext` reference

Passed as the second argument to every handler.

| Member | Signature | Notes |
|---|---|---|
| `ctx.call_id` / `ctx.schema_version` | `str` / `int` | — |
| `ctx.progress(step, message, progress=None)` | `async` | Fire-and-forget; `progress` is 0–1 |
| `ctx.files.download(uri)` | `async -> DownloadResult` | `DownloadResult(buffer: bytes, filename: str, mime_type: str)` |
| `ctx.files.upload(data, filename, mime_type)` | `async -> str` | Returns the new `z3t://files/{id}` URI |
| `ctx.taxonomies.entries(uri)` | `async -> list[TaxonomyEntry]` | — |
| `ctx.taxonomies.lookup(uri, key)` | `async -> TaxonomyEntry \| None` | `None` on not-found |
| `ctx.integrations.credentials(uri)` | `async -> dict[str, str]` | Shape depends on the integration's auth type |
| `ctx.llm.openai` / `.anthropic` / `.google` | client instances or `None` | `None` if the optional provider package isn't installed |
| `ctx.agents.call(agent_id, plan_id, input, *, schema_version=None, consumer_org_id=None, timeout=None)` | `async -> Any` | `timeout` in seconds; always suppresses progress events on the downstream call |

`ctx.llm.google` is built on the modern `google-genai` package (`genai.Client`), not
the legacy `google-generativeai`. Use `ctx.llm.google.models.generate_content(...)`
or the async variant `ctx.llm.google.aio.models.generate_content(...)`.

---

## Configuration

```python
Agent(
    api_key: str,                              # required — from the z3t dashboard
    base_url: str | None = None,                # default: "https://relay.z3t.ai/v1"
    relay_urls: list[str] | None = None,        # override — skips bootstrap; for local dev/tests
    timeout: float | None = None,               # seconds, default 25.0
    max_concurrent_calls: int | None = None,     # default 10
    reconnect_delay: float | None = None,        # seconds, default 1.0
    max_reconnect_delay: float | None = None,    # seconds, default 60.0
    logger: Logger | None = None,                # default: ConsoleLogger() — needs info/warn/error
)
```

---

## Testing

```bash
pip install -e ".[dev]"
pytest                                    # unit + integration
pytest --cov=z3t_ai_agent --cov-fail-under=90  # with coverage
```

Integration tests spin up an in-process mock relay (`tests/helpers/mock_relay.py`,
built on `websockets.serve`) — no external services required.

---

## License

[MIT](LICENSE) © z3t.ai
