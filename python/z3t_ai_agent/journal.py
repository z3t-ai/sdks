"""Durable pause/resume for a single call.

When a handler asks the consumer a question (``ctx.ask``) it does NOT wait for the answer — that
could take days, and a waiting handler would hold a concurrency slot, die on every deploy, and pin
the call to one process. Instead the SDK ends the turn with a ``suspend`` frame carrying the question
and this journal. When the consumer answers (or skips, or the deadline passes), the platform
dispatches the call again with the journal and the response, and the handler runs from the top:
``ctx.step(key)`` returns what it returned last time instead of doing the work again, and
``ctx.ask(key)`` returns the answer. The platform stores the journal and hands it back; it never
reads it, and the SDK keeps no copy of its own.

Mirrors ``typescript/src/journal.ts``.
"""

from __future__ import annotations

import inspect
import json
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal, TypeVar, Union

T = TypeVar("T")

#: Uncompressed. The relay enforces the same cap.
MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024

AskAction = Literal["answered", "declined", "expired", "unavailable"]


@dataclass(frozen=True)
class AskResult:
    """What became of a question asked with ``ctx.ask``. Never raised — every outcome is a value,
    so the handler always has a best-effort path:

    - ``answered`` — the consumer filled in the form; ``answers`` matches the schema you asked with.
    - ``declined`` — the consumer chose to skip the question.
    - ``expired`` — nobody answered before the platform's deadline (7 days by default).
    - ``unavailable`` — this run can't take questions: the version isn't ``interactive``, the
      caller can't answer (an API integration that didn't opt in, or another agent), or the call
      has used its question rounds. The handler did not suspend.
    """

    action: AskAction
    answers: dict[str, Any] | None = None

    @property
    def answered(self) -> bool:
        return self.action == "answered"


class SuspendSignal(BaseException):
    """Raised by ``ctx.ask`` (and by any later ``ctx.step``) once the run has decided to suspend.

    A ``BaseException``, not an ``Exception``, so a handler's ``except Exception:`` can't swallow
    it. Even if something does catch it, nothing changes: the SDK suspends the run anyway, based on
    the question recorded in the journal, and logs a warning.
    """

    def __init__(self) -> None:
        super().__init__("[z3t SDK] The run is suspended to ask the consumer a question — let this propagate.")


@dataclass
class PendingQuestion:
    key: str
    message: str
    schema: dict[str, Any]

    def to_wire(self) -> dict[str, Any]:
        return {"key": self.key, "message": self.message, "schema": self.schema}


def _is_journal(value: Any) -> bool:
    return isinstance(value, dict) and value.get("v") == 1


@dataclass
class CallJournal:
    resume: dict[str, Any] | None = None
    pending: PendingQuestion | None = None
    _data: dict[str, Any] = field(init=False)
    _seen: set[str] = field(init=False, default_factory=set)
    _resumed_key: str | None = field(init=False, default=None)
    _replaying: bool = field(init=False, default=False)

    def __post_init__(self) -> None:
        checkpoint = (self.resume or {}).get("checkpoint")
        if _is_journal(checkpoint):
            self._data = {
                "v": 1,
                "steps": dict(checkpoint.get("steps") or {}),
                "answers": dict(checkpoint.get("answers") or {}),
            }
        else:
            self._data = {"v": 1, "steps": {}, "answers": {}}

        response = (self.resume or {}).get("response")
        if isinstance(response, dict) and response.get("key"):
            key = response["key"]
            self._data["answers"][key] = {k: v for k, v in response.items() if k != "key"}
            self._resumed_key = key
        self._replaying = bool(self._data["steps"] or self._data["answers"])

    @property
    def replaying(self) -> bool:
        """True while re-running code that already ran in an earlier turn. Progress is suppressed
        then, or every resume would repeat the activity log's rows."""
        return self._replaying

    def _claim_key(self, kind: str, key: str) -> None:
        if not isinstance(key, str) or not key:
            raise ValueError(f"[z3t SDK] {kind} needs a non-empty key")
        if key in self._seen:
            raise ValueError(f'[z3t SDK] Duplicate {kind} key "{key}" — step and ask keys must be unique within a call')
        self._seen.add(key)

    async def step(self, key: str, fn: Callable[[], Union[T, Awaitable[T]]]) -> T:
        if self.pending is not None:
            raise SuspendSignal()
        self._claim_key("step", key)

        if key in self._data["steps"]:
            return self._data["steps"][key].get("value")

        self._replaying = False
        value = fn()
        if inspect.isawaitable(value):
            value = await value
        # Round-trip through JSON NOW, not only on replay: a datetime that can't be stored, or a
        # tuple that comes back as a list, must surprise the developer on the first run — not
        # days later, on the resume, in production. NaN/Infinity are refused: Python would write
        # them, but the relay's JSON parser can't read them back.
        stored = json.loads(json.dumps({"value": value}, allow_nan=False))
        self._data["steps"][key] = stored
        return stored.get("value")

    def ask(self, key: str, message: str, schema: dict[str, Any], can_ask: bool) -> AskResult:
        if self.pending is not None:
            raise SuspendSignal()
        self._claim_key("ask", key)

        known = self._data["answers"].get(key)
        if known is not None:
            if key == self._resumed_key:
                self._replaying = False
            return AskResult(action=known.get("action", "unavailable"), answers=known.get("answers"))

        self._replaying = False
        if not can_ask:
            # Recorded so a later turn replays the same decision even if asking has become possible.
            self._data["answers"][key] = {"action": "unavailable"}
            return AskResult(action="unavailable")

        if not isinstance(message, str) or not message:
            raise ValueError(f'[z3t SDK] ctx.ask("{key}") needs a message')
        if not isinstance(schema, dict) or schema.get("type") != "object":
            raise ValueError(f'[z3t SDK] ctx.ask("{key}") needs an s.object(...) schema')
        self.pending = PendingQuestion(key=key, message=message, schema=schema)
        raise SuspendSignal()

    def checkpoint(self) -> dict[str, Any]:
        """The journal to hand the platform on suspend. Raises if it exceeds the cap — better a
        clear failure in the agent than a rejection at the relay."""
        # Compact separators: the relay measures JSON.stringify's output, which has no spaces.
        encoded = json.dumps(self._data, ensure_ascii=False, separators=(",", ":"))
        size = len(encoded.encode("utf-8"))
        if size > MAX_CHECKPOINT_BYTES:
            raise ValueError(
                f"[z3t SDK] Checkpoint is {size} bytes, over the {MAX_CHECKPOINT_BYTES}-byte limit. "
                "Keep step results small — upload large artifacts with ctx.files.upload and journal the URI."
            )
        # A copy, not the live journal: a step still running in parallel with the ask may finish
        # after the suspend, and must not change what the retries re-send.
        return json.loads(encoded)
