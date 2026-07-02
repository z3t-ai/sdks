from __future__ import annotations

from collections.abc import AsyncIterator

import pytest

from tests.helpers.mock_relay import MockRelay, create_mock_relay


@pytest.fixture
async def mock_relay() -> AsyncIterator[MockRelay]:
    relay = await create_mock_relay()
    try:
        yield relay
    finally:
        await relay.close()
