"""The default store must not alias the records it holds."""

import pytest

from ag_ui_claude_managed_agents.constants import IN_MEMORY_SESSION_STORE_MAX_ENTRIES
from ag_ui_claude_managed_agents.sessions import InMemorySessionStore
from ag_ui_claude_managed_agents.types import SessionRecord


def _record() -> SessionRecord:
    return SessionRecord(
        session_id="sesn_1",
        tool_names=["a"],
        pending_client_tool_use_ids=["ctu_1"],
    )


def test_does_not_alias_the_record_it_was_given() -> None:
    store = InMemorySessionStore()
    original = _record()
    store.set("t", original)

    original.pending_client_tool_use_ids.append("ctu_2")
    original.session_id = "sesn_mutated"

    read = store.get("t")
    assert read is not None
    assert read.session_id == "sesn_1"
    assert read.pending_client_tool_use_ids == ["ctu_1"]


def test_does_not_alias_the_record_it_hands_out() -> None:
    store = InMemorySessionStore()
    store.set("t", _record())

    # The agent mutates records in place between persists; those mutations
    # must not be visible until they are actually written back.
    first = store.get("t")
    assert first is not None
    first.pending_client_tool_use_ids.append("ctu_2")
    first.last_user_message_id = "m_unpersisted"

    second = store.get("t")
    assert second is not None
    assert second.pending_client_tool_use_ids == ["ctu_1"]
    assert second.last_user_message_id is None


def test_unknown_and_deleted_threads_read_as_none() -> None:
    store = InMemorySessionStore()
    assert store.get("nope") is None
    store.set("t", _record())
    store.delete("t")
    assert store.get("t") is None


def test_evicts_the_least_recently_used_mapping_once_full() -> None:
    """Thread ids come from the client, so an unbounded dict is a memory leak an
    untrusted caller controls."""
    store = InMemorySessionStore(max_entries=2)
    store.set("a", _record())
    store.set("b", _record())
    # A read counts as use: "a" is now the newer of the two.
    assert store.get("a") is not None

    store.set("c", _record())

    assert len(store) == 2
    assert store.get("b") is None
    assert store.get("a") is not None
    assert store.get("c") is not None


def test_defaults_to_a_bounded_capacity_and_rejects_a_nonsensical_one() -> None:
    assert IN_MEMORY_SESSION_STORE_MAX_ENTRIES > 0
    with pytest.raises(ValueError):
        InMemorySessionStore(max_entries=0)
