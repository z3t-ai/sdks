import httpx
import pytest

from z3t_ai_agent.agent import Agent
from z3t_ai_agent.schema import VersionSchema, s


def make_agent(**kwargs) -> Agent:
    return Agent(api_key="test-key", **kwargs)


async def test_bootstrap_returns_override_without_http_call():
    agent = make_agent(relay_urls=["ws://override:1234"])
    agent._http = httpx.AsyncClient()
    try:
        urls = await agent._bootstrap()
        assert urls == ["ws://override:1234"]
    finally:
        await agent._http.aclose()


@pytest.mark.respx(base_url="https://relay.z3t.ai/v1")
async def test_bootstrap_fetches_from_platform(respx_mock):
    respx_mock.get("/bootstrap").mock(return_value=httpx.Response(200, json={"relayUrls": ["wss://relay-a", "wss://relay-b"]}))

    agent = make_agent()
    agent._http = httpx.AsyncClient()
    try:
        urls = await agent._bootstrap()
        assert urls == ["wss://relay-a", "wss://relay-b"]
        assert respx_mock.calls[0].request.headers["Authorization"] == "Bearer test-key"
    finally:
        await agent._http.aclose()


@pytest.mark.respx(base_url="https://relay.z3t.ai/v1")
async def test_bootstrap_raises_on_http_error(respx_mock):
    respx_mock.get("/bootstrap").mock(return_value=httpx.Response(500))

    agent = make_agent()
    agent._http = httpx.AsyncClient()
    try:
        with pytest.raises(RuntimeError, match="Bootstrap failed: HTTP 500"):
            await agent._bootstrap()
    finally:
        await agent._http.aclose()


@pytest.mark.respx(base_url="https://relay.z3t.ai/v1")
async def test_bootstrap_raises_on_empty_relay_urls(respx_mock):
    respx_mock.get("/bootstrap").mock(return_value=httpx.Response(200, json={"relayUrls": []}))

    agent = make_agent()
    agent._http = httpx.AsyncClient()
    try:
        with pytest.raises(RuntimeError, match="Bootstrap returned no relay URLs"):
            await agent._bootstrap()
    finally:
        await agent._http.aclose()


@pytest.mark.respx(base_url="https://relay.z3t.ai/v1")
async def test_sync_schemas_posts_versions_and_logs_drafts(respx_mock):
    route = respx_mock.post("/schema-sync").mock(
        return_value=httpx.Response(
            200, json={"deprecatedVersions": [0], "versions": [{"version": 1, "status": "draft"}]}
        )
    )

    agent = make_agent()
    agent._http = httpx.AsyncClient()

    @agent.handle(version=1, schema=VersionSchema(input=s.object({}), output=s.object({})))
    async def handler(input, ctx):
        return {}

    try:
        await agent._sync_schemas()
        body = route.calls[0].request
        assert body.headers["Authorization"] == "Bearer test-key"
        import json

        parsed = json.loads(body.content)
        assert parsed["versions"] == [
            {"version": 1, "inputSchema": {"type": "object", "properties": {}}, "outputSchema": {"type": "object", "properties": {}}, "status": "draft"}
        ]
    finally:
        await agent._http.aclose()


@pytest.mark.respx(base_url="https://relay.z3t.ai/v1")
async def test_sync_schemas_raises_on_http_error(respx_mock):
    respx_mock.post("/schema-sync").mock(return_value=httpx.Response(422, text="bad schema"))

    agent = make_agent()
    agent._http = httpx.AsyncClient()

    @agent.handle(version=1, schema=VersionSchema(input=s.object({}), output=s.object({})))
    async def handler(input, ctx):
        return {}

    try:
        with pytest.raises(RuntimeError, match="Schema sync failed: HTTP 422"):
            await agent._sync_schemas()
    finally:
        await agent._http.aclose()


async def test_stop_stops_all_connections_and_clears_list():
    agent = make_agent()
    stopped = []

    class FakeConnection:
        async def stop(self) -> None:
            stopped.append(True)

    agent._connections = [FakeConnection(), FakeConnection()]
    await agent.stop()

    assert stopped == [True, True]
    assert agent._connections == []


@pytest.mark.respx(base_url="https://relay.z3t.ai/v1")
async def test_start_logs_and_aborts_on_bootstrap_failure(respx_mock):
    respx_mock.get("/bootstrap").mock(return_value=httpx.Response(503))

    errors = []

    class RecordingLogger:
        def info(self, *a):
            pass

        def warn(self, *a):
            pass

        def error(self, *a):
            errors.append(a)

    agent = make_agent(logger=RecordingLogger())
    await agent.start()  # returns instead of raising; logs and aborts

    assert len(errors) == 1
    assert errors[0][0] == "[z3t SDK] Startup failed:"
    assert agent._connections == []
    assert agent._http is None
