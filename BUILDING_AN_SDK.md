# Building a z3t Agent SDK in a New Language

z3t publishes official agent SDKs for TypeScript (`@z3t-ai/agent-sdk`) and Python
(`z3t-ai-agent-sdk`). If you're working in either of those, use the official package
instead of building your own.

This guide is for every other language. It documents the full wire protocol, HTTP
contract, and behavioral rules an agent SDK must implement to work correctly with the
z3t platform — independent of any particular language — so you can build a
conformant SDK for Go, Rust, Java, Ruby, PHP, or anything else.

This document does not assume access to any z3t source code. Everything you need to
implement a working SDK is specified here: every message shape, every HTTP
endpoint, every default value, and every behavioral edge case we know matters. If you
hit something this guide doesn't cover, the platform's actual behavior — observed
against your own agent credentials — is authoritative; treat any gap here as a bug in
the guide.

---

## Table of contents

1. [What an SDK provides](#1-what-an-sdk-provides)
2. [The non-negotiable contract](#2-the-non-negotiable-contract)
3. [Configuration surface](#3-configuration-surface)
4. [Bootstrap: relay discovery](#4-bootstrap-relay-discovery)
5. [WebSocket protocol](#5-websocket-protocol)
6. [Call dispatch & concurrency](#6-call-dispatch--concurrency)
7. [CallContext: resource access](#7-callcontext-resource-access)
8. [LLM proxy clients](#8-llm-proxy-clients)
9. [Schema declaration & sync](#9-schema-declaration--sync)
10. [Schema wire format reference](#10-schema-wire-format-reference)
11. [Error handling reference](#11-error-handling-reference)
12. [Testing a new SDK](#12-testing-a-new-sdk)
13. [Publishing your SDK](#13-publishing-your-sdk)
14. [What to adapt vs. what to copy exactly](#14-what-to-adapt-vs-what-to-copy-exactly)

---

## 1. What an SDK provides

A developer installs the package, writes one or more handler functions, and calls
`start()`. The SDK owns everything else:

- WebSocket connection(s) to the relay, with auth and reconnect
- Heartbeat (responding to relay pings)
- Routing incoming calls to the right handler by schema version
- Concurrency limiting and queueing
- Per-call timeout enforcement
- Catching handler exceptions and turning them into error frames
- Resource access (files, taxonomies, integrations, LLM proxy, agent-to-agent calls)
  as simple async methods on a context object passed into every handler
- Schema declaration sync, if the developer declares typed input/output schemas

## 2. The non-negotiable contract

These rules apply regardless of language. Everything else in this document is detail
in service of these:

1. **Exactly one terminal frame per `callId`.** Every dispatched call ends with
   exactly one `result` or `error` frame sent back over the WebSocket — never zero,
   never two. `progress` frames may be sent zero or more times before the terminal
   frame.
2. **Never block the WebSocket read loop on a handler.** Each call must run as an
   independent concurrent unit (goroutine, task, green thread, etc.) so other calls —
   and `ping` frames — keep being processed while a handler is running.
3. **Respond to `ping` with `pong` immediately**, without queuing behind in-flight
   handlers.
4. **Reconnect with exponential backoff** on disconnect, capped at a max delay, and
   re-send `auth` on every reconnect.
5. **The platform — not the SDK — validates consumer input** against the published
   schema. The SDK passes the raw `input` JSON straight to the handler; it does not
   re-validate it client-side.
6. **A timed-out or queue-evicted call still gets exactly one `error` frame.** Don't
   let rule 1 lapse just because the handler never returned.

## 3. Configuration surface

Every SDK should expose an equivalent of an `AgentConfig` struct:

| Field                | Required | Default                  | Purpose                                                              |
| -------------------- | -------- | ------------------------ | -------------------------------------------------------------------- |
| `apiKey`             | yes      | —                        | Agent API key from the z3t dashboard                                 |
| `baseUrl`            | no       | `https://relay.z3t.ai/v1`   | HTTP base for bootstrap, schema-sync, and all `ctx.*` resource calls |
| `relayUrls`          | no       | fetched via bootstrap    | Override to skip bootstrap — used for local dev and tests            |
| `timeout`            | no       | `25000` ms               | Per-call handler timeout                                             |
| `maxConcurrentCalls` | no       | `10`                     | Calls processed at once before queueing                              |
| `reconnectDelay`     | no       | `1000` ms                | Initial reconnect backoff                                            |
| `maxReconnectDelay`  | no       | `60000` ms               | Backoff ceiling                                                      |
| `logger`             | no       | stdout/stderr equivalent | Needs `info`/`warn`/`error` methods                                  |

Use a single host (`https://relay.z3t.ai/v1`) for every HTTP call your SDK makes —
bootstrap, schema-sync, and every `ctx.*` resource call. Don't try to discover or
construct a separate hostname for any of these; the platform routes everything
through this one host, and a different hostname may not work at all.

## 4. Bootstrap: relay discovery

On `start()`, if the developer didn't override `relayUrls`, fetch them:

```
GET {baseUrl}/bootstrap
Authorization: Bearer {apiKey}

→ 200 { "relayUrls": ["wss://...", "wss://..."] }
```

- Non-2xx → fail startup with `Bootstrap failed: HTTP {status}`.
- Empty/missing `relayUrls` → fail startup with `Bootstrap returned no relay URLs`.
- If the developer _did_ set `relayUrls` in config, skip this call entirely — this is
  the local-dev/test escape hatch (point straight at a mock relay).

## 5. WebSocket protocol

Open **one persistent connection per URL** returned by bootstrap (dual-relay
redundancy — both connections stay open simultaneously; the platform guarantees only
one relay delivers any given call, so your handler still runs exactly once per call
regardless of how many relay connections are open). Each connection runs its own
auth/heartbeat/reconnect cycle independently.

```
CONNECT wss://{relayUrl}        — one per URL

→ OPEN
    send { type: 'auth', apiKey, supportedVersions: number[] }
        supportedVersions = every handler version you've registered
        (omit the key entirely if you have none — don't send null/[])

← { type: 'auth_ok', agentId, relayInstanceId }
    log it; no further action required

← { type: 'ping' }
    → immediately send { type: 'pong' }

← { type: 'call', callId, schemaVersion, input }
    → dispatch to your concurrency manager (see §6)

→ { type: 'result', callId, output }      — handler resolved
→ { type: 'error',  callId, message }     — handler threw / timed out / no handler
→ { type: 'progress', callId, step, message, progress? }   — fire-and-forget,
        zero or more times before the terminal frame; omit `progress` key if
        the caller didn't pass a value (don't send null)

← { type: 'ack' }
    no-op — relay acknowledging receipt of your result/error frame

← { type: 'error', message, callId? }
    relay-level error, not tied to a specific call you dispatched.
    If `callId` is absent, log it. If `callId` is present, there is
    nothing to do client-side (the call already reached a terminal
    state on your end) — don't resend anything.

← CLOSE / socket error
    schedule reconnect (see backoff below); send `auth` again on reconnect.
    In-flight calls on the dropped connection are NOT re-dispatched — the
    platform handles timing them out and refunding tokens. Do not try to
    replay them yourself.
```

**Reconnect backoff** (reset the attempt counter to 0 on every successful `open`):

```
delay = min(reconnectDelay × 2^attempt, maxReconnectDelay)
attempt += 1
```

## 6. Call dispatch & concurrency

On `{ type: 'call', callId, schemaVersion, input }`:

1. **Handler lookup**: a version-specific handler registered for `schemaVersion`
   takes priority; fall back to the default (unversioned) handler if one exists. If
   neither exists, send `{ type: 'error', callId, message: 'No handler for schema
version {schemaVersion}' }` immediately and stop — this does not consume a
   concurrency slot.
2. **Concurrency gate**: if fewer than `maxConcurrentCalls` calls are active, run it
   now. Otherwise push it onto a FIFO queue.
3. **Queue overflow**: if the queue's length exceeds `maxConcurrentCalls × 2` after
   pushing, evict the _oldest_ queued call (not the one you just pushed), log a
   warning, and send it `{ type: 'error', callId, message: 'Queue depth exceeded' }`.
   The platform will have already timed that call out on its end, so this is just
   cleanup, not a surprise to the consumer.
4. **Run**: build a fresh `CallContext` (§7) for this `callId`, invoke
   `handler(input, ctx)` as an independent concurrent unit, and race it against a
   timer of `timeout` ms.
   - Resolves first → `{ type: 'result', callId, output }`
   - Throws first → `{ type: 'error', callId, message: err.message }`
   - Timer fires first → `{ type: 'error', callId, message: 'Handler timeout' }`,
     **and you must guarantee the handler's eventual settlement (success or throw)
     never also sends a frame** — that would violate the one-terminal-frame rule.
     Some languages get this for free because their concurrency primitive isn't
     cancellable (nothing is left awaiting the loser of the race, so its eventual
     result is simply discarded); if your language has real task cancellation
     (structured concurrency, cancellation tokens, context cancellation), prefer
     actually cancelling the handler on timeout instead — just make sure the
     cancelled task can't still emit a result/error frame afterward.
5. **On settlement** (success, error, or timeout), decrement the active count and
   pull the next queued call, if any, into a free slot.

## 7. CallContext: resource access

Every handler receives `(input, ctx)`. `ctx` exposes `callId`, `schemaVersion`, and
the methods below. All of them are thin HTTP wrappers over the relay's REST API.

**Every HTTP request** (except the two storage-direct calls noted below) must send:

```
Authorization: Bearer {apiKey}
x-agent-call-id: {callId}
Content-Type: application/json   (when there's a body)
```

A non-2xx response should raise `HTTP {status}: {body text}` in the handler's
language-native exception type, which naturally becomes an `error` frame per §6.

**Resource URIs** are `z3t://{resourceType}/{id}` — e.g. `z3t://files/abc123`.
Extract the id with something equivalent to `^z3t://[^/]+/(.+)$`; raise on mismatch.

| Method                                          | Calls                                                                                                                               | Notes                                                                                                      |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `progress(step, message, progress?)`            | WS `{ type: 'progress', callId, step, message, progress? }`                                                                         | Fire-and-forget — don't make the handler await a relay ack                                                 |
| `files.download(uri)`                           | `GET /files/{id}/agent-url` → `{ signedUrl, filename, mimeType }`, then `GET signedUrl` directly (storage host, **no auth header**) | Returns `{ buffer, filename, mimeType }` — not a raw buffer                                                |
| `files.upload(data, filename, mimeType)`        | 3 steps — see below                                                                                                                 | Returns the new `z3t://files/{id}` URI as a string                                                         |
| `taxonomies.entries(uri)`                       | `GET /taxonomies/{id}/entries` → `{ entries: [...] }`                                                                               | Returns the array directly                                                                                 |
| `taxonomies.lookup(uri, key)`                   | `GET /taxonomies/{id}/entries/{url-encoded key}`                                                                                    | Returns `null` on HTTP 404, throws on any other error                                                      |
| `integrations.credentials(uri)`                 | `GET /integrations/{id}/credentials`                                                                                                | Returns an opaque key/value map — shape depends on the integration's auth type, don't assume specific keys |
| `agents.call(agentId, planId, input, options?)` | `POST /agents/call`                                                                                                                 | See below                                                                                                  |

**`files.upload` is a 3-step presigned flow** — don't simplify it to a single
multipart POST, that's not how the backend handles it:

```
1. POST /files/agent-output/prepare
   body: { callId, filename, mimeType, sizeBytes }
   → { fileId, uploadUrl, internalUri }

2. PUT {uploadUrl}                          ← presigned storage URL, NOT the relay
   headers: Content-Type: {mimeType}, Content-Length: {byteLength}
   body: raw bytes
   (no Authorization header — the URL itself is the credential)

3. POST /files/agent-output/confirm
   body: { fileId, callId }
   → marks the file ready; ignore the response body

return internalUri   (captured from step 1)
```

**`agents.call`** always sends `capabilities: []` in the body — progress events are
suppressed for agent-to-agent calls, since there's no consumer watching a nested
call's progress in real time:

```
POST /agents/call
body: {
  agentId, planId, input,
  schemaVersion?,        // omit key if not set, don't send null
  consumerOrgId?,        // omit key if not set
  timeoutMs: options.timeoutMs ?? config.timeout,
  capabilities: []
}
→ { output }     // return `output` to the caller
```

## 8. LLM proxy clients

`ctx.llm` exposes pre-configured clients for the official OpenAI, Anthropic, and
Google GenAI SDKs in your language, each pointed at the platform's proxy instead of
the provider directly, using the agent's own API key for both:

| Provider  | Proxy base URL            | Notes                                                                                                      |
| --------- | ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| OpenAI    | `{baseUrl}/llm/openai/v1` | Standard `baseURL` override                                                                                |
| Anthropic | `{baseUrl}/llm/anthropic` | Standard `baseURL` override                                                                                |
| Google    | `{baseUrl}/llm/google`    | See below — official clients sometimes don't expose a base URL override as directly as OpenAI/Anthropic do |

Construct each with `apiKey: config.apiKey`, and build a fresh set **per call** (not
once at `start()`) so you can inject `x-agent-call-id: {callId}` as a default header
on every request. This is cheap — it just wraps configuration, it doesn't open a
connection — and it matters: **every** provider client, including Google's, must
carry this header on every request, or usage made through that client can't be
attributed to the call that generated it. Don't let Google be the exception just
because its client library makes base-URL/header configuration less convenient than
OpenAI's or Anthropic's.

If your language's official Google GenAI client doesn't accept a base URL and custom
headers directly as constructor/instance options, check whether a newer or
alternative client library for that provider does before resorting to a workaround —
some ecosystems have more than one official Google GenAI client, and the newer ones
tend to support this cleanly. If none do, wrap the client: subclass or compose it and
override whichever method actually creates a model/session so it injects the base URL
and headers into the underlying request options. Don't skip proxying Google just
because the constructor is awkward — the platform needs every LLM call routed through
its proxy to function (billing, rate limiting, and provider failover all depend on
it).

Treat the provider SDKs as **optional dependencies** — a developer who never calls
`ctx.llm.anthropic` shouldn't be forced to install the Anthropic package. Use
whatever optional-dependency mechanism is idiomatic for your ecosystem (optional peer
dependencies, extras, feature flags, or just clear documentation if your ecosystem
has no such mechanism), and have your LLM-client constructor degrade gracefully
(e.g. leave that client `null`/`None`/unset) when the corresponding package isn't
installed, rather than crashing at import/startup time for developers who don't need
it.

## 9. Schema declaration & sync

Handlers can optionally declare typed input/output schemas per version. If a
developer declares any, sync them to the platform on every `start()`:

```
POST {baseUrl}/schema-sync
Authorization: Bearer {apiKey}
body: {
  versions: [
    {
      version: number,
      inputSchema: <JSON Schema, see §10>,
      outputSchema: <JSON Schema, see §10>,
      status: 'draft' | 'active',     // default 'draft' if omitted
      deprecates?: number[],           // omit key if empty
      deprecationNotice?: string,      // omit key if not set
    },
    ...
  ]
}

→ {
  deprecatedVersions?: number[],
  versions?: [{ version, status }]
}
```

**Lifecycle**: `'draft'` schemas are mutable and invisible to consumers — safe to
resync on every restart while iterating. `'active'` publishes the schema and freezes
it; resyncing an already-active version with different content will fail. Log a
clear message for any version that came back `'draft'` so the developer knows it's
not yet publicly visible, and log any `deprecatedVersions` returned.

## 10. Schema wire format reference

The schema _builder API_ (however you expose `s.string()`-style helpers in your
language) is purely a language-idiomatic convenience — design whatever feels natural.
What actually crosses the wire to `/schema-sync` is standard **JSON Schema**, plus a
set of `x-z3t-*` extension keys the platform's frontend reads to decide how to render
a field. Your builder just needs to be capable of emitting this shape; the exact
builder ergonomics are yours to design (see §14).

**Standard JSON Schema vocabulary used**: `type`, `properties`, `required`, `items`,
`enum`, `const`, `format`, `minimum`/`maximum`, `minLength`/`maxLength`, `pattern`,
`minItems`/`maxItems`, `multipleOf`, `title`, `description`.

**`format` values the platform interprets specially:**

| `format`                                    | Meaning                                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `email`, `uri`, `date`, `date-time`         | Standard JSON Schema formats                                                        |
| `z3t-file-uri`                              | Input: file upload picker; value resolves to `z3t://files/{id}`                     |
| `z3t-taxonomy-ref`                          | Input: taxonomy dropdown; value resolves to `z3t://taxonomies/{id}`                 |
| `z3t-integration-ref`                       | Input: integration dropdown; value resolves to `z3t://integrations/{id}`            |
| `markdown`, `html`, `code`, `json`, `image` | Output rendering                                                                    |
| `percent`                                   | Output: percentage bar; value must be `0–1`                                         |
| `z3t-file-output`                           | Output: download button                                                             |
| `z3t-file-list`                             | Output: auto-applied to an array whose `items` is `z3t-file-output`                 |
| `table`                                     | Output: applied to an array of objects when the array option requests table display |

**`x-z3t-*` extension keys:**

| Key                                               | Applies to                        | Meaning                                                                                                                                                             |
| ------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `x-z3t-hint`                                      | any field                         | Short inline helper text below the field                                                                                                                            |
| `x-z3t-order`                                     | any field                         | Explicit sort order in the rendered form                                                                                                                            |
| `x-z3t-group`                                     | any field                         | Visual grouping label for adjacent fields                                                                                                                           |
| `x-z3t-display`                                   | varies                            | `'textarea'\|'markdown'\|'code'\|'hidden'` (string), `'range'` (number/integer — builder exposes this as a `slider` option), `'toggle'` (boolean), `'radio'` (enum) |
| `x-z3t-code-language`                             | string with `code` display/format | Syntax highlight language                                                                                                                                           |
| `x-z3t-min` / `x-z3t-max`                         | date/datetime                     | JSON Schema's `date`/`date-time` formats have no native bounds, so these carry min/max as strings                                                                   |
| `x-z3t-color-map`                                 | enum                              | `{ VALUE: 'colorName' }` badge color mapping for output rendering                                                                                                   |
| `x-z3t-accept`                                    | `z3t-file-uri`                    | Accepted MIME types array                                                                                                                                           |
| `x-z3t-max-size-mb`                               | `z3t-file-uri`                    | UI hint for max upload size                                                                                                                                         |
| `x-z3t-taxonomy-slug`                             | `z3t-taxonomy-ref`                | Pre-select a specific taxonomy                                                                                                                                      |
| `x-z3t-integration-provider`                      | `z3t-integration-ref`             | Filter dropdown to one provider                                                                                                                                     |
| `x-z3t-table-sortable` / `x-z3t-table-searchable` | array with `table` format         | Table interaction flags                                                                                                                                             |

**Two composite value shapes** the platform renders specially. Both the _runtime
value_ a handler returns and the _schema field declaration_ that advertises it are
fully specified below — don't guess at either.

Runtime values (what a handler actually returns in its output):

```jsonc
// PDF source reference — clickable chip, opens PDF preview modal
{ "format": "pdf-reference", "file": "z3t://files/{id}", "page": 12, "hint": "..." }
// page and hint are optional

// Self-describing typed value — frontend picks renderer from `format`
{ "format": "markdown", "value": "**hi**" }
// format ∈ text | markdown | number | date | boolean | enum
```

The corresponding schema field declarations (what your builder emits for these two
field types):

```jsonc
// pdf-reference field
{
  "type": "object",
  "properties": {
    "format": { "type": "string", "const": "pdf-reference" },
    "file":   { "type": "string", "format": "z3t-file-uri" },
    "page":   { "type": "integer" },
    "hint":   { "type": "string" }
  },
  "required": ["format", "file"],
  "x-z3t-display": "pdf-reference"
}

// typed-value field
{
  "type": "object",
  "properties": {
    "format": { "type": "string", "enum": ["text", "markdown", "number", "date", "boolean", "enum"] },
    "value":  { "type": "string" }
  },
  "required": ["format", "value"],
  "x-z3t-display": "typed-value"
}
```

**Required-by-default**: every field is required unless explicitly marked optional —
i.e. your builder's "optional" marker should be the thing that _removes_ a key from
the object's `required` array, not the thing that adds it.

## 11. Error handling reference

| Scenario                                     | Behavior                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Handler throws                               | `{ type: 'error', callId, message: err.message }`                                                                         |
| Handler exceeds `timeout`                    | `{ type: 'error', callId, message: 'Handler timeout' }`                                                                   |
| No handler for `schemaVersion`               | `{ type: 'error', callId, message: 'No handler for schema version {N}' }` — sent immediately, never queued                |
| Queue depth exceeds `maxConcurrentCalls × 2` | Oldest queued call gets `{ type: 'error', callId, message: 'Queue depth exceeded' }`                                      |
| Any `ctx.*` HTTP call returns 4xx/5xx        | Raises in the handler → caught as "Handler throws" above (except `taxonomies.lookup` 404 → `null`, not a throw)           |
| WebSocket disconnects                        | Reconnect with backoff; in-flight calls on that connection are left for the platform to time out — don't re-dispatch them |
| Auth rejected                                | Treat identically to a disconnect: log, let the close handler's reconnect logic retry                                     |

The platform refunds the consumer's tokens for any call that ends in an error frame
— this is platform-side behavior, not something the SDK needs to implement, but it's
why "send exactly one terminal frame" (§2 rule 1) matters: a missing error frame
means a call the platform thinks is still pending until it times out on its own.

## 12. Testing a new SDK

**Unit tests** (one file/module per responsibility is fine):

- Handler registration: default handler, versioned handlers, calling an
  unregistered version sends the right error
- `maxConcurrentCalls` queues excess calls; queue overflow evicts the oldest with
  the right error message
- Reconnect: backoff delay doubles each attempt, capped at `maxReconnectDelay`,
  resets to the initial delay after a successful reconnect
- `ping` → `pong` sent immediately, not queued behind a running handler
- `auth` frame sent on every connect/reconnect, with `supportedVersions` matching
  registered handler versions
- Each `ctx.*` method issues the right HTTP request (method, path, headers, body) —
  mock the HTTP layer, don't hit a real backend
- Schema builder: required-by-default, "optional" removes from `required`,
  spot-check a few field types against the JSON Schema shapes in §10

**Integration tests**, against an in-process mock relay you write and fully control
(a tiny WebSocket server, not a real z3t relay): accept a connection, auto-reply
`auth_ok` to `auth`, expose a way to push a `call` frame to the connected agent on
demand, and a way to force-close the connection to test reconnect. Then verify:

- Full round trip: connect → `auth_ok` → dispatch a call → handler runs → `result`
  frame observed by the mock relay
- Handler throws → `error` frame observed
- Handler exceeds `timeout` → `error` frame with `'Handler timeout'` observed
- `ctx.progress()` mid-handler → `progress` frame observed before the terminal frame
- Force-close the mock relay's connection → SDK reconnects → new `auth` sent →
  the call that was in flight is **not** redispatched
- `ctx.agents.call(...)` request body always has `capabilities: []`

Target ~90% line coverage. No external services needed — the mock relay and a
mocked HTTP layer should make the whole suite self-contained, runnable in CI without
any z3t credentials.

## 13. Publishing your SDK

Structure your implementation by responsibility, however that maps onto idiomatic
module/package boundaries in your language:

| Responsibility        | What it owns                                                                      |
| --------------------- | --------------------------------------------------------------------------------- |
| Core agent/dispatcher | Handler registry, `start`/`stop` lifecycle, concurrency manager, queueing         |
| Transport             | WebSocket lifecycle: connect, auth, ping/pong, reconnect backoff                  |
| Resource context      | `CallContext` implementations — files/taxonomies/integrations/agents HTTP calls   |
| LLM proxy             | Pre-configured provider client construction                                       |
| Schema                | Builder API + JSON Schema/`x-z3t-*` emission — design this idiomatically, see §14 |
| Config & types        | Config struct, context type, handler type, defaults                               |
| Public entry point    | Whatever your package exports at its root                                         |

Keeping these separate (rather than one large module) makes it easier for someone
else to find and audit the one piece they care about — particularly the transport
and dispatch logic, since that's where the non-negotiable contract in §2 lives.

**Naming**: pick a name that fits your ecosystem's convention — a scoped npm
package, a PyPI distribution name, a Go module path, a Cargo crate, a Maven
coordinate, etc. There's no required naming scheme; just make it discoverable by
search (e.g. include "z3t" and "agent" somewhere in the name).

**README**: cover installation, a quick-start example that exercises a file
download → LLM call → file upload round trip (the most representative path through
the SDK), a table of schema builder fields, a `CallContext` method reference, and a
configuration reference.

**CI**: run your full test suite on every push, and only build/package a release
artifact if tests pass. Keep it self-contained (per §12) so it doesn't depend on
live z3t credentials.

If you publish an SDK built from this guide and would like it referenced from z3t's
official developer documentation, reach out to the z3t team once it's published and
stable.

## 14. What to adapt vs. what to copy exactly

**Copy exactly — this is the wire contract, get it byte-for-byte right:**

- Every message `type` string and field name in §5
- Every HTTP path, method, and body shape in §7 and §9
- The JSON Schema `format` values and `x-z3t-*` keys in §10
- The reconnect backoff formula
- The "exactly one terminal frame per callId" invariant
- Omitting optional keys entirely rather than sending `null` (every "omit if not set"
  note above matters — the relay's JSON parsing distinguishes absent from null)

**Adapt idiomatically — these are implementation choices, not part of the
contract.** Existing SDKs for this platform differ from each other on exactly these
points, which is itself useful evidence of where the real boundary is — agreement
between independent implementations is a strong signal something is contractual;
disagreement is a signal it was a language-specific choice:

- The schema builder's _API shape_ (method chaining vs. struct tags vs. decorators
  vs. a builder pattern, object-literal options vs. keyword arguments) — only the
  JSON it emits is contractual.
- How you represent "independent concurrent unit of work" (a future/promise,
  an async task, a goroutine, a spawned coroutine, a virtual thread — whatever is
  idiomatic and lets your WS read loop keep running without blocking on a handler).
- Whether timeout actually cancels the handler task or just races it — prefer real
  cancellation where your language supports it cleanly (see the note in §6 step 4).
- Logger interface shape, as long as it has the equivalent of info/warn/error —
  structural typing (duck typing, an interface, a protocol) is preferable to forcing
  inheritance from a specific base class.
- How optional dependencies for the LLM provider SDKs are expressed and how your
  client construction degrades when one isn't installed.
- Units for config durations — pick whatever matches your language's standard
  concurrency/async APIs (seconds, milliseconds, a `Duration` type, etc.), and
  convert at the one point a duration actually crosses the wire (`agents.call`'s
  `timeoutMs` body field is always milliseconds, regardless of your internal unit).
- Handler registration syntax — a decorator, an overloaded method, a builder
  pattern, whatever your language's idiom is for "register a callback with some
  optional metadata attached."

If you get partway through implementing this and find a behavior the guide doesn't
cover, don't guess: connect a test agent with your own credentials and observe what
the platform actually sends and expects, and treat that as ground truth over any gap
or ambiguity in this document.
