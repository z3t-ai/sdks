from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from .types import ResolvedConfig

if TYPE_CHECKING:
    from anthropic import Anthropic
    from google.genai import Client as GoogleClient
    from openai import OpenAI


@dataclass
class LlmClients:
    """Pre-configured LLM provider clients pointing at the z3t LLM proxy.

    Each is `None` if the corresponding optional dependency isn't installed —
    developers who don't call a given `ctx.llm.*` client don't need that
    provider's package installed at all.
    """

    openai: "OpenAI | None"
    anthropic: "Anthropic | None"
    google: "GoogleClient | None"


def create_llm_clients(config: ResolvedConfig, call_id: str | None = None) -> LlmClients:
    """Build a fresh set of LLM clients for a single call, so `x-agent-call-id` can be
    attributed correctly. Cheap — this only wraps configuration, it doesn't open
    a connection."""
    headers = {"x-agent-call-id": call_id} if call_id else {}

    openai_client: Any = None
    try:
        from openai import OpenAI

        openai_client = OpenAI(
            base_url=f"{config.base_url}/llm/openai/v1",
            api_key=config.api_key,
            default_headers=headers,
        )
    except ImportError:
        pass

    anthropic_client: Any = None
    try:
        from anthropic import Anthropic

        anthropic_client = Anthropic(
            base_url=f"{config.base_url}/llm/anthropic",
            api_key=config.api_key,
            default_headers=headers,
        )
    except ImportError:
        pass

    google_client: Any = None
    try:
        from google import genai
        from google.genai import types as genai_types

        # Unlike the TypeScript SDK's Z3tGoogleGenerativeAI wrapper (which only injects
        # baseUrl and can't carry the call-id header — see CLAUDE.md), google-genai's
        # Client takes both base_url and headers directly via HttpOptions, so Google
        # calls here are attributable to a specific call same as OpenAI/Anthropic.
        google_client = genai.Client(
            api_key=config.api_key,
            http_options=genai_types.HttpOptions(
                base_url=f"{config.base_url}/llm/google",
                headers=headers,
            ),
        )
    except ImportError:
        pass

    return LlmClients(openai=openai_client, anthropic=anthropic_client, google=google_client)
