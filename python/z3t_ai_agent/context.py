from __future__ import annotations

import re
import urllib.parse
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

import httpx

from .journal import AskResult, CallJournal
from .llm import LlmClients
from .types import ResolvedConfig, TaxonomyEntry

_URI_RE = re.compile(r"^z3t://[^/]+/(.+)$")

Send = Callable[[dict[str, Any]], Awaitable[None]]


def extract_id(uri: str) -> str:
    """Extract the resource ID from a z3t:// URI (e.g. z3t://files/abc123 → abc123)."""
    match = _URI_RE.match(uri)
    if not match:
        raise ValueError(f"Invalid z3t URI: {uri}")
    return match.group(1)


async def _api_fetch(
    http: httpx.AsyncClient,
    method: str,
    path: str,
    *,
    api_key: str,
    base_url: str,
    call_id: str | None = None,
    json_body: Any = None,
) -> httpx.Response:
    headers = {"Authorization": f"Bearer {api_key}"}
    if call_id:
        headers["x-agent-call-id"] = call_id
    resp = await http.request(method, f"{base_url}{path}", headers=headers, json=json_body)
    if resp.is_error:
        raise RuntimeError(f"HTTP {resp.status_code}: {resp.text}")
    return resp


# ─── Result / namespace types ───────────────────────────────────────────────


@dataclass
class DownloadResult:
    buffer: bytes
    filename: str
    mime_type: str


@dataclass
class FilesContext:
    _download: Callable[[str], Awaitable[DownloadResult]]
    _upload: Callable[[bytes, str, str], Awaitable[str]]

    async def download(self, uri: str) -> DownloadResult:
        """Download a z3t://files/{id} URI → bytes + original filename + MIME type."""
        return await self._download(uri)

    async def upload(self, data: bytes, filename: str, mime_type: str) -> str:
        """Upload bytes → returns the new z3t://files/{id} URI."""
        return await self._upload(data, filename, mime_type)


@dataclass
class TaxonomiesContext:
    _entries: Callable[[str], Awaitable[list[TaxonomyEntry]]]
    _lookup: Callable[[str, str], Awaitable[TaxonomyEntry | None]]

    async def entries(self, uri: str) -> list[TaxonomyEntry]:
        """Fetch all entries for a z3t://taxonomies/{id} URI."""
        return await self._entries(uri)

    async def lookup(self, uri: str, key: str) -> TaxonomyEntry | None:
        """Look up a single key within a taxonomy. Returns None if not found."""
        return await self._lookup(uri, key)


@dataclass
class IntegrationsContext:
    _credentials: Callable[[str], Awaitable[dict[str, str]]]

    async def credentials(self, uri: str) -> dict[str, str]:
        """Resolve z3t://integrations/{id} → decrypted credential fields."""
        return await self._credentials(uri)


@dataclass
class AgentsContext:
    _call: Callable[..., Awaitable[Any]]

    async def call(
        self,
        agent_id: str,
        plan_id: str,
        input: Any,
        *,
        schema_version: int | None = None,
        consumer_org_id: str | None = None,
        timeout: float | None = None,
    ) -> Any:
        """Call another agent on the platform. Blocks until the call completes or times out.
        Progress events are suppressed for agent-to-agent calls. `timeout` is in seconds."""
        return await self._call(agent_id, plan_id, input, schema_version, consumer_org_id, timeout)


@dataclass
class CallContext:
    call_id: str
    schema_version: int
    #: Report a progress milestone — each call adds a row to the caller's activity log, so emit
    #: one per stage. ``progress(step, message, progress=None)``.
    progress: Callable[..., Awaitable[None]]
    #: Detail *within* the current step — REPLACES the previous sub-line rather than adding a row,
    #: so a long stage can report often ("page 7 of 12"). ``subprogress(message, progress=None)``.
    subprogress: Callable[..., Awaitable[None]]
    files: FilesContext
    taxonomies: TaxonomiesContext
    integrations: IntegrationsContext
    llm: LlmClients
    agents: AgentsContext
    #: Runs ``fn`` once per call and remembers its result across a suspend/resume: on a resumed
    #: turn the stored result is returned without running ``fn`` again, so an expensive LLM pass
    #: before a question is paid for once. The result must be JSON-serializable and is returned in
    #: its JSON form even on the first run. Keys must be unique per call. ``fn`` may be sync or
    #: async. Wrap anything with a side effect you must not repeat (an upload) in a step — code
    #: outside steps runs again on every resume.
    step: Callable[..., Awaitable[Any]]
    #: Asks the consumer a clarifying question and pauses the run until they answer — hours or
    #: days later, possibly on another replica. The handler exits here and is re-run from the top
    #: on resume (see ``step``); ``ask`` then returns an ``AskResult``. Requires the version to be
    #: declared ``interactive=True``. ``ask(key, *, message, schema)`` — ``schema`` is an
    #: ``s.object(...)`` of scalars, enums, dates and file uploads.
    ask: Callable[..., Awaitable[AskResult]]
    #: Which turn of the call this is: 0 on the first dispatch, +1 after every answered question.
    turn: int = 0
    #: Whether ``ask`` can suspend this run. When False, ``ask`` returns ``unavailable`` at once.
    can_ask: bool = False


# ─── Factory ─────────────────────────────────────────────────────────────────


def create_call_context(
    call_id: str,
    schema_version: int,
    send: Send,
    config: ResolvedConfig,
    llm: LlmClients,
    http: httpx.AsyncClient,
    *,
    journal: CallJournal | None = None,
    can_ask: bool = False,
    turn: int = 0,
) -> CallContext:
    api_key, base_url = config.api_key, config.base_url
    # Absent for callers that don't care (tests, tools): a fresh journal on turn 0 with asking
    # disabled — exactly the pre-interactive behaviour.
    call_journal = journal if journal is not None else CallJournal()

    # Both kinds of progress are silent while a resumed turn re-runs code from an earlier turn —
    # those rows are already in the caller's activity log.
    async def progress(step: str, message: str, progress: float | None = None) -> None:
        if call_journal.replaying:
            return
        payload: dict[str, Any] = {"type": "progress", "callId": call_id, "step": step, "message": message}
        if progress is not None:
            payload["progress"] = progress
        await send(payload)

    async def subprogress(message: str, progress: float | None = None) -> None:
        if call_journal.replaying:
            return
        payload: dict[str, Any] = {"type": "subprogress", "callId": call_id, "message": message}
        if progress is not None:
            payload["progress"] = progress
        await send(payload)

    async def step(key: str, fn: Callable[[], Any]) -> Any:
        return await call_journal.step(key, fn)

    async def ask(key: str, *, message: str, schema: Any) -> AskResult:
        schema_def = getattr(schema, "_def", schema)
        return call_journal.ask(key, message, schema_def, can_ask)

    async def download(uri: str) -> DownloadResult:
        resource_id = extract_id(uri)
        resp = await _api_fetch(
            http, "GET", f"/files/{resource_id}/agent-url", api_key=api_key, base_url=base_url, call_id=call_id
        )
        data = resp.json()
        dl = await http.get(data["signedUrl"])
        if dl.is_error:
            raise RuntimeError(f"Storage download failed: HTTP {dl.status_code}")
        return DownloadResult(buffer=dl.content, filename=data["filename"], mime_type=data["mimeType"])

    async def upload(data: bytes, filename: str, mime_type: str) -> str:
        # Step 1: request a presigned PUT URL from the relay
        prepare = await _api_fetch(
            http,
            "POST",
            "/files/agent-output/prepare",
            api_key=api_key,
            base_url=base_url,
            call_id=call_id,
            json_body={"callId": call_id, "filename": filename, "mimeType": mime_type, "sizeBytes": len(data)},
        )
        prepared = prepare.json()

        # Step 2: upload directly to DO Spaces via the presigned PUT URL
        put_resp = await http.put(
            prepared["uploadUrl"],
            content=data,
            headers={"Content-Type": mime_type, "Content-Length": str(len(data))},
        )
        if put_resp.is_error:
            raise RuntimeError(f"Storage upload failed: HTTP {put_resp.status_code}")

        # Step 3: confirm the upload so the relay marks the file as ready
        await _api_fetch(
            http,
            "POST",
            "/files/agent-output/confirm",
            api_key=api_key,
            base_url=base_url,
            call_id=call_id,
            json_body={"fileId": prepared["fileId"], "callId": call_id},
        )

        return prepared["internalUri"]

    async def taxonomy_entries(uri: str) -> list[TaxonomyEntry]:
        resource_id = extract_id(uri)
        resp = await _api_fetch(
            http, "GET", f"/taxonomies/{resource_id}/entries", api_key=api_key, base_url=base_url, call_id=call_id
        )
        return resp.json()["entries"]

    async def taxonomy_lookup(uri: str, key: str) -> TaxonomyEntry | None:
        resource_id = extract_id(uri)
        try:
            resp = await _api_fetch(
                http,
                "GET",
                f"/taxonomies/{resource_id}/entries/{urllib.parse.quote(key, safe='')}",
                api_key=api_key,
                base_url=base_url,
                call_id=call_id,
            )
        except RuntimeError as exc:
            if str(exc).startswith("HTTP 404"):
                return None
            raise
        return resp.json()

    async def credentials(uri: str) -> dict[str, str]:
        resource_id = extract_id(uri)
        resp = await _api_fetch(
            http, "GET", f"/integrations/{resource_id}/credentials", api_key=api_key, base_url=base_url, call_id=call_id
        )
        return resp.json()

    async def agents_call(
        agent_id: str,
        plan_id: str,
        input: Any,
        schema_version: int | None,
        consumer_org_id: str | None,
        timeout: float | None,
    ) -> Any:
        timeout_seconds = timeout if timeout is not None else config.timeout
        body: dict[str, Any] = {
            "agentId": agent_id,
            "planId": plan_id,
            "input": input,
            "timeoutMs": round(timeout_seconds * 1000),
            # progress events are suppressed for agent-to-agent calls
            "capabilities": [],
        }
        if schema_version is not None:
            body["schemaVersion"] = schema_version
        if consumer_org_id is not None:
            body["consumerOrgId"] = consumer_org_id

        resp = await _api_fetch(
            http, "POST", "/agents/call", api_key=api_key, base_url=base_url, call_id=call_id, json_body=body
        )
        return resp.json()["output"]

    return CallContext(
        call_id=call_id,
        schema_version=schema_version,
        progress=progress,
        subprogress=subprogress,
        files=FilesContext(_download=download, _upload=upload),
        taxonomies=TaxonomiesContext(_entries=taxonomy_entries, _lookup=taxonomy_lookup),
        integrations=IntegrationsContext(_credentials=credentials),
        llm=llm,
        agents=AgentsContext(_call=agents_call),
        step=step,
        ask=ask,
        turn=turn,
        can_ask=can_ask,
    )
