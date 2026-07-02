import httpx
import pytest

from z3t_ai_agent.context import create_call_context, extract_id
from z3t_ai_agent.llm import LlmClients
from z3t_ai_agent.types import ConsoleLogger, ResolvedConfig


def make_config(**overrides) -> ResolvedConfig:
    defaults = dict(
        api_key="test-key",
        base_url="https://relay.z3t.ai/v1",
        relay_urls=[],
        timeout=25.0,
        max_concurrent_calls=10,
        reconnect_delay=1.0,
        max_reconnect_delay=60.0,
        logger=ConsoleLogger(),
    )
    defaults.update(overrides)
    return ResolvedConfig(**defaults)


def test_extract_id():
    assert extract_id("z3t://files/abc123") == "abc123"


def test_extract_id_invalid_uri():
    with pytest.raises(ValueError, match="Invalid z3t URI"):
        extract_id("not-a-uri")


@pytest.mark.respx(base_url="https://relay.z3t.ai/v1")
async def test_files_download(respx_mock):
    respx_mock.get("/files/abc/agent-url").mock(
        return_value=httpx.Response(
            200, json={"signedUrl": "https://storage.example/abc.pdf", "filename": "abc.pdf", "mimeType": "application/pdf"}
        )
    )
    respx_mock.get("https://storage.example/abc.pdf").mock(return_value=httpx.Response(200, content=b"hello"))

    sent = []

    async def send(payload):
        sent.append(payload)

    async with httpx.AsyncClient() as http:
        ctx = create_call_context(
            "call-1", 1, send, make_config(), LlmClients(openai=None, anthropic=None, google=None), http
        )
        result = await ctx.files.download("z3t://files/abc")

    assert result.buffer == b"hello"
    assert result.filename == "abc.pdf"
    assert result.mime_type == "application/pdf"

    auth_header = respx_mock.calls[0].request.headers["Authorization"]
    assert auth_header == "Bearer test-key"
    assert respx_mock.calls[0].request.headers["x-agent-call-id"] == "call-1"


@pytest.mark.respx(base_url="https://relay.z3t.ai/v1")
async def test_files_upload_three_step_flow(respx_mock):
    prepare = respx_mock.post("/files/agent-output/prepare").mock(
        return_value=httpx.Response(
            200,
            json={"fileId": "file-1", "uploadUrl": "https://storage.example/upload", "internalUri": "z3t://files/file-1"},
        )
    )
    put = respx_mock.put("https://storage.example/upload").mock(return_value=httpx.Response(200))
    confirm = respx_mock.post("/files/agent-output/confirm").mock(return_value=httpx.Response(200, json={}))

    async def send(payload):
        pass

    async with httpx.AsyncClient() as http:
        ctx = create_call_context(
            "call-1", 1, send, make_config(), LlmClients(openai=None, anthropic=None, google=None), http
        )
        uri = await ctx.files.upload(b"data", "out.csv", "text/csv")

    assert uri == "z3t://files/file-1"
    assert prepare.called
    assert put.called
    assert confirm.called
    assert confirm.calls[0].request.headers["Authorization"] == "Bearer test-key"


@pytest.mark.respx(base_url="https://relay.z3t.ai/v1")
async def test_taxonomy_lookup_returns_none_on_404(respx_mock):
    respx_mock.get("/taxonomies/xyz/entries/missing-key").mock(return_value=httpx.Response(404))

    async def send(payload):
        pass

    async with httpx.AsyncClient() as http:
        ctx = create_call_context(
            "call-1", 1, send, make_config(), LlmClients(openai=None, anthropic=None, google=None), http
        )
        result = await ctx.taxonomies.lookup("z3t://taxonomies/xyz", "missing-key")

    assert result is None


@pytest.mark.respx(base_url="https://relay.z3t.ai/v1")
async def test_files_download_storage_failure_raises(respx_mock):
    respx_mock.get("/files/abc/agent-url").mock(
        return_value=httpx.Response(
            200, json={"signedUrl": "https://storage.example/abc.pdf", "filename": "abc.pdf", "mimeType": "application/pdf"}
        )
    )
    respx_mock.get("https://storage.example/abc.pdf").mock(return_value=httpx.Response(500))

    async def send(payload):
        pass

    async with httpx.AsyncClient() as http:
        ctx = create_call_context(
            "call-1", 1, send, make_config(), LlmClients(openai=None, anthropic=None, google=None), http
        )
        with pytest.raises(RuntimeError, match="Storage download failed: HTTP 500"):
            await ctx.files.download("z3t://files/abc")


@pytest.mark.respx(base_url="https://relay.z3t.ai/v1")
async def test_files_upload_storage_failure_raises(respx_mock):
    respx_mock.post("/files/agent-output/prepare").mock(
        return_value=httpx.Response(
            200, json={"fileId": "file-1", "uploadUrl": "https://storage.example/upload", "internalUri": "z3t://files/file-1"}
        )
    )
    respx_mock.put("https://storage.example/upload").mock(return_value=httpx.Response(500))

    async def send(payload):
        pass

    async with httpx.AsyncClient() as http:
        ctx = create_call_context(
            "call-1", 1, send, make_config(), LlmClients(openai=None, anthropic=None, google=None), http
        )
        with pytest.raises(RuntimeError, match="Storage upload failed: HTTP 500"):
            await ctx.files.upload(b"data", "out.csv", "text/csv")


@pytest.mark.respx(base_url="https://relay.z3t.ai/v1")
async def test_taxonomy_entries(respx_mock):
    respx_mock.get("/taxonomies/xyz/entries").mock(
        return_value=httpx.Response(200, json={"entries": [{"key": "a", "value": 1, "label": "A"}]})
    )

    async def send(payload):
        pass

    async with httpx.AsyncClient() as http:
        ctx = create_call_context(
            "call-1", 1, send, make_config(), LlmClients(openai=None, anthropic=None, google=None), http
        )
        entries = await ctx.taxonomies.entries("z3t://taxonomies/xyz")

    assert entries == [{"key": "a", "value": 1, "label": "A"}]


@pytest.mark.respx(base_url="https://relay.z3t.ai/v1")
async def test_taxonomy_lookup_reraises_non_404_errors(respx_mock):
    respx_mock.get("/taxonomies/xyz/entries/key").mock(return_value=httpx.Response(500, text="boom"))

    async def send(payload):
        pass

    async with httpx.AsyncClient() as http:
        ctx = create_call_context(
            "call-1", 1, send, make_config(), LlmClients(openai=None, anthropic=None, google=None), http
        )
        with pytest.raises(RuntimeError, match="HTTP 500"):
            await ctx.taxonomies.lookup("z3t://taxonomies/xyz", "key")


@pytest.mark.respx(base_url="https://relay.z3t.ai/v1")
async def test_integrations_credentials(respx_mock):
    respx_mock.get("/integrations/abc/credentials").mock(
        return_value=httpx.Response(200, json={"apiKey": "secret"})
    )

    async def send(payload):
        pass

    async with httpx.AsyncClient() as http:
        ctx = create_call_context(
            "call-1", 1, send, make_config(), LlmClients(openai=None, anthropic=None, google=None), http
        )
        creds = await ctx.integrations.credentials("z3t://integrations/abc")

    assert creds == {"apiKey": "secret"}


@pytest.mark.respx(base_url="https://relay.z3t.ai/v1")
async def test_agents_call_with_explicit_overrides(respx_mock):
    route = respx_mock.post("/agents/call").mock(return_value=httpx.Response(200, json={"output": "ok"}))

    async def send(payload):
        pass

    async with httpx.AsyncClient() as http:
        ctx = create_call_context(
            "call-1", 1, send, make_config(), LlmClients(openai=None, anthropic=None, google=None), http
        )
        await ctx.agents.call(
            "agent-2", "plan-1", {"x": 1}, schema_version=3, consumer_org_id="org-9", timeout=5.0
        )

    import json

    body = json.loads(route.calls[0].request.content)
    assert body["schemaVersion"] == 3
    assert body["consumerOrgId"] == "org-9"
    assert body["timeoutMs"] == 5000


@pytest.mark.respx(base_url="https://relay.z3t.ai/v1")
async def test_agents_call_always_sends_empty_capabilities(respx_mock):
    route = respx_mock.post("/agents/call").mock(return_value=httpx.Response(200, json={"output": {"ok": True}}))

    async def send(payload):
        pass

    async with httpx.AsyncClient() as http:
        ctx = create_call_context(
            "call-1", 1, send, make_config(timeout=25.0), LlmClients(openai=None, anthropic=None, google=None), http
        )
        output = await ctx.agents.call("agent-2", "plan-1", {"x": 1})

    assert output == {"ok": True}
    body = route.calls[0].request.content
    import json

    parsed = json.loads(body)
    assert parsed["capabilities"] == []
    assert parsed["timeoutMs"] == 25000
