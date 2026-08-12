"""Tests for the approval demo's decision handling.

resolve_approval is the gate in front of a paused run: it decides whether a
request resumes that run or starts a fresh turn. No model, no network — just
the decision logic, driven with a stub RunState.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

EXAMPLES = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(EXAMPLES))

from agents_examples.human_in_the_loop_approval import resolve_approval  # noqa: E402


class _StubState:
    """Stands in for a paused RunState carrying one interruption."""

    def __init__(self, call_id: str = "call_1") -> None:
        self.item = SimpleNamespace(raw_item=SimpleNamespace(call_id=call_id))

    def get_interruptions(self) -> list:
        return [self.item]


def _decision(call_id: str = "call_1", approve: bool = True) -> dict:
    return {"approval": {"call_id": call_id, "approve": approve}}


def test_matching_decision_resumes_and_claims_the_paused_run():
    state = _StubState()
    store = {"t1": state}

    pending_state, item, approve = resolve_approval(store, "t1", _decision())

    assert pending_state is state
    assert item is state.item
    assert approve is True
    assert store == {}, "the claimed run must not stay behind for a second request"


def test_reject_decision_resumes_with_approve_false():
    state = _StubState()
    _, item, approve = resolve_approval({"t1": state}, "t1", _decision(approve=False))
    assert item is state.item
    assert approve is False


def test_second_concurrent_decision_finds_nothing_to_resume():
    # Both requests validate before either runs, so the store is the only thing
    # keeping a double-clicked Approve from resuming the same run twice.
    store = {"t1": _StubState()}
    first = resolve_approval(store, "t1", _decision())
    second = resolve_approval(store, "t1", _decision())

    assert first[1] is not None
    assert second == (None, None, False)


def test_plain_message_starts_a_fresh_turn_instead_of_wedging_the_thread():
    # The user typed something else instead of deciding. That abandons the
    # paused run rather than blocking every later message on the thread.
    store = {"t1": _StubState()}

    assert resolve_approval(store, "t1", None) == (None, None, False)
    assert store == {}


@pytest.mark.parametrize("approve", ["false", "true", 0, 1, None, "", "yes"])
def test_a_non_boolean_approve_never_resumes_the_run(approve):
    # "false" is a truthy string — reading it as approval would refund an order
    # the user declined. Only a real bool decides anything.
    store = {"t1": _StubState()}
    assert resolve_approval(
        store, "t1", {"approval": {"call_id": "call_1", "approve": approve}}
    ) == (None, None, False)


def test_decision_for_an_unknown_call_id_starts_fresh():
    store = {"t1": _StubState(call_id="call_1")}
    assert resolve_approval(store, "t1", _decision(call_id="other")) == (None, None, False)


def test_decision_with_no_pending_run_starts_fresh():
    assert resolve_approval({}, "t1", _decision()) == (None, None, False)
