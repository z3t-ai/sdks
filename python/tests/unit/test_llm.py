import sys

import pytest

from z3t_ai_agent.llm import create_llm_clients
from z3t_ai_agent.types import ConsoleLogger, ResolvedConfig


def make_config() -> ResolvedConfig:
    return ResolvedConfig(
        api_key="test-key",
        base_url="https://relay.z3t.ai/v1",
        relay_urls=[],
        timeout=25.0,
        max_concurrent_calls=10,
        reconnect_delay=1.0,
        max_reconnect_delay=60.0,
        logger=ConsoleLogger(),
    )


def test_clients_built_when_packages_installed():
    clients = create_llm_clients(make_config(), call_id="call-1")
    assert clients.openai is not None
    assert clients.anthropic is not None
    assert clients.google is not None


def test_openai_and_anthropic_get_call_id_header():
    clients = create_llm_clients(make_config(), call_id="call-1")
    assert clients.openai.default_headers["x-agent-call-id"] == "call-1"
    assert clients.anthropic.default_headers["x-agent-call-id"] == "call-1"


def test_google_client_gets_base_url_and_call_id_header():
    clients = create_llm_clients(make_config(), call_id="call-1")
    http_options = clients.google._api_client._http_options
    assert http_options.base_url == "https://relay.z3t.ai/v1/llm/google"
    assert http_options.headers["x-agent-call-id"] == "call-1"


def test_no_call_id_omits_header():
    clients = create_llm_clients(make_config())
    assert "x-agent-call-id" not in clients.openai.default_headers


@pytest.mark.parametrize("missing", ["openai", "anthropic"])
def test_gracefully_skips_missing_optional_dependency(monkeypatch, missing):
    monkeypatch.setitem(sys.modules, missing, None)
    clients = create_llm_clients(make_config(), call_id="call-1")
    assert getattr(clients, missing) is None


def test_gracefully_skips_missing_google_dependency(monkeypatch):
    monkeypatch.setitem(sys.modules, "google.genai", None)
    clients = create_llm_clients(make_config(), call_id="call-1")
    assert clients.google is None
