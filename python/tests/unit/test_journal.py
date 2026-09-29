import pytest

from z3t_ai_agent.journal import MAX_CHECKPOINT_BYTES, AskResult, CallJournal, SuspendSignal

SCHEMA = {"type": "object", "properties": {"n": {"type": "string"}}}


def resumed(checkpoint, key="q", action="declined", **extra):
    return CallJournal({"checkpoint": checkpoint, "response": {"key": key, "action": action, **extra}})


async def test_step_runs_once_and_is_recorded():
    journal = CallJournal()
    calls = []

    async def work():
        calls.append(1)
        return {"parties": 2}

    assert await journal.step("case-file", work) == {"parties": 2}
    assert calls == [1]
    assert journal.checkpoint()["steps"]["case-file"] == {"value": {"parties": 2}}


async def test_step_accepts_a_plain_function():
    assert await CallJournal().step("sync", lambda: 3) == 3


async def test_resumed_step_returns_the_recorded_value_without_running():
    first = CallJournal()
    await first.step("case-file", lambda: {"parties": 2})
    journal = resumed(first.checkpoint())

    def boom():
        raise AssertionError("must not run")

    assert await journal.step("case-file", boom) == {"parties": 2}


async def test_step_returns_the_json_form_on_the_first_run():
    assert await CallJournal().step("t", lambda: (1, 2)) == [1, 2]


async def test_a_non_serializable_step_result_fails_immediately():
    import datetime

    with pytest.raises(TypeError):
        await CallJournal().step("when", lambda: datetime.datetime.now())


async def test_duplicate_keys_are_refused():
    journal = CallJournal()
    await journal.step("a", lambda: 1)
    with pytest.raises(ValueError, match='Duplicate step key "a"'):
        await journal.step("a", lambda: 2)


def test_ask_records_the_question_and_suspends():
    journal = CallJournal()
    with pytest.raises(SuspendSignal):
        journal.ask("gaps", "Which contract?", SCHEMA, True)
    assert journal.pending is not None
    assert journal.pending.to_wire() == {"key": "gaps", "message": "Which contract?", "schema": SCHEMA}


def test_suspend_signal_escapes_except_exception():
    assert not issubclass(SuspendSignal, Exception)
    assert issubclass(SuspendSignal, BaseException)


async def test_no_work_after_the_run_decided_to_suspend():
    journal = CallJournal()
    with pytest.raises(SuspendSignal):
        journal.ask("gaps", "Which contract?", SCHEMA, True)

    def boom():
        raise AssertionError("must not run")

    with pytest.raises(SuspendSignal):
        await journal.step("after", boom)


def test_unavailable_is_returned_without_suspending_and_replayed_later():
    journal = CallJournal()
    assert journal.ask("gaps", "Which contract?", SCHEMA, False) == AskResult(action="unavailable")
    assert journal.pending is None

    later = resumed(journal.checkpoint(), key="other")
    assert later.ask("gaps", "Which contract?", SCHEMA, True).action == "unavailable"


def test_a_resume_delivers_the_answer():
    journal = resumed({"v": 1, "steps": {}, "answers": {}}, key="gaps", action="answered", answers={"n": "CX-12"})
    result = journal.ask("gaps", "Which contract?", SCHEMA, True)
    assert result.answered
    assert result.answers == {"n": "CX-12"}


@pytest.mark.parametrize("message, schema", [("", SCHEMA), ("Which?", {"type": "string"})])
def test_malformed_questions_are_rejected_instead_of_suspending(message, schema):
    journal = CallJournal()
    with pytest.raises(ValueError, match="needs"):
        journal.ask("gaps", message, schema, True)
    assert journal.pending is None


async def test_replaying_until_the_answered_question():
    first = CallJournal()
    await first.step("extract", lambda: "facts")
    with pytest.raises(SuspendSignal):
        first.ask("gaps", "Which contract?", SCHEMA, True)

    journal = resumed(first.checkpoint(), key="gaps")
    assert journal.replaying
    await journal.step("extract", lambda: "never")
    assert journal.replaying
    journal.ask("gaps", "Which contract?", SCHEMA, True)
    assert not journal.replaying


async def test_replaying_ends_at_the_first_new_step():
    journal = resumed({"v": 1, "steps": {"a": {"value": 1}}, "answers": {}})
    await journal.step("new-work", lambda: 2)
    assert not journal.replaying


def test_a_fresh_call_is_not_replaying():
    assert not CallJournal().replaying


async def test_an_oversized_checkpoint_is_refused_with_advice():
    journal = CallJournal()
    await journal.step("huge", lambda: "x" * MAX_CHECKPOINT_BYTES)
    with pytest.raises(ValueError, match="ctx.files.upload"):
        journal.checkpoint()


async def test_a_step_result_with_nan_is_refused_on_the_first_run():
    with pytest.raises(ValueError):
        await CallJournal().step("score", lambda: float("nan"))


async def test_the_checkpoint_is_a_snapshot_not_the_live_journal():
    journal = CallJournal()
    await journal.step("a", lambda: 1)
    snapshot = journal.checkpoint()

    await journal.step("b", lambda: 2)  # e.g. a parallel step finishing after the suspend

    assert snapshot["steps"] == {"a": {"value": 1}}


async def test_an_unrecognised_checkpoint_is_not_trusted():
    journal = resumed({"steps": {"a": {"value": "forged"}}})
    assert await journal.step("a", lambda: "real") == "real"
