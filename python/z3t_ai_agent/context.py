from __future__ import annotations

import re
import urllib.parse
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

import httpx

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
    progress: Callable[..., Awaitable[None]]
    files: FilesContext
    taxonomies: TaxonomiesContext
    integrations: IntegrationsContext
    llm: LlmClients
    agents: AgentsContext


# ─── Factory ─────────────────────────────────────────────────────────────────


def create_call_context(
    call_id: str,
    schema_version: int,
    send: Send,
    config: ResolvedConfig,
    llm: LlmClients,
    http: httpx.AsyncClient,
) -> CallContext:
    api_key, base_url = config.api_key, config.base_url

    async def progress(step: str, message: str, progress: float | None = None) -> None:
        payload: dict[str, Any] = {"type": "progress", "callId": call_id, "step": step, "message": message}
        if progress is not None:
            payload["progress"] = progress
        await send(payload)

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
        files=FilesContext(_download=download, _upload=upload),
        taxonomies=TaxonomiesContext(_entries=taxonomy_entries, _lookup=taxonomy_lookup),
        integrations=IntegrationsContext(_credentials=credentials),
        llm=llm,
        agents=AgentsContext(_call=agents_call),
    )
