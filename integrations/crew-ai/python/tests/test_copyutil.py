"""Safe deep-copy isolation suite (``ag_ui_crewai._copyutil``).

Covers the ``safe_deepcopy`` contract the per-request flow/crew COPY relies on:
plain ``copy.deepcopy`` on healthy objects, the pin-and-share fallback when an
object carries non-deep-copyable runtime state, and a FAIL-LOUD guard that
refuses to serve a copy whose conversation ``_state`` was not actually
isolated from the original.
"""

import threading

import pytest

from ag_ui_crewai import _copyutil


@pytest.fixture(autouse=True)
def _reset_needs_pin_latch():
    """``_copyutil._NEEDS_PIN`` is a process-global latch: once any earlier
    ``safe_deepcopy`` hits an uncopyable object it stays True for the process,
    which would make the healthy-path test below silently run the pin-and-share
    fallback instead of the plain ``copy.deepcopy`` it names (depending on suite
    order). Reset it around every test in this module so each one deterministically
    exercises its named path regardless of order."""
    _copyutil._NEEDS_PIN = False
    yield
    _copyutil._NEEDS_PIN = False


class _Isolatable:
    """Minimal object carrying an isolatable ``_state`` (like a crewai Flow)."""

    def __init__(self):
        self._state = {"messages": []}


def test_safe_deepcopy_isolates_state_on_healthy_object():
    """The happy path deep-copies ``_state`` so the copy is isolated."""
    original = _Isolatable()
    copied = _copyutil.safe_deepcopy(original, what="flow")
    assert copied is not original
    assert copied._state is not original._state
    # Mutating the copy does not bleed into the original (real isolation).
    copied._state["messages"].append("x")
    assert original._state["messages"] == []
    # Proves this test exercised the plain-deepcopy path, not the pin fallback
    # (a healthy object never latches _NEEDS_PIN).
    assert _copyutil._NEEDS_PIN is False


def test_safe_deepcopy_pins_uncopyable_but_still_isolates_state():
    """An object holding BOTH an uncopyable lock (in one field) AND ``_state``
    (in a DIFFERENT field) copies via the pin-and-share fallback: the lock is
    pinned by reference while ``_state`` is still deep-copied / isolated."""

    class _WithLock:
        def __init__(self):
            self._state = {"messages": []}
            self._lock = threading.Lock()  # not deep-copyable

    original = _WithLock()
    copied = _copyutil.safe_deepcopy(original, what="flow")
    # Lock is shared by reference (pinned); state is isolated.
    assert copied._lock is original._lock
    assert copied._state is not original._state


def test_assert_state_isolated_raises_when_state_shared():
    """The fail-loud guard raises when a copy SHARES ``_state`` with the
    original — the silent isolation-loss the top-level-granular pinning could
    otherwise produce."""
    original = _Isolatable()
    not_isolated = _Isolatable()
    # Simulate the pin-and-share collapse: copy ended up sharing _state.
    not_isolated._state = original._state
    with pytest.raises(RuntimeError, match="did NOT isolate"):
        _copyutil._assert_state_isolated(original, not_isolated, "flow")


def test_assert_state_isolated_noop_when_isolated_or_stateless():
    """The guard is a no-op when ``_state`` is isolated, or when either side
    lacks a ``_state`` (a copied ``Crew`` / test stub) — nothing to isolate."""
    a, b = _Isolatable(), _Isolatable()
    # Isolated: distinct _state objects -> no raise.
    _copyutil._assert_state_isolated(a, b, "flow")

    class _NoState:
        pass

    # Missing _state on either side -> no raise.
    _copyutil._assert_state_isolated(_NoState(), b, "crew")
    _copyutil._assert_state_isolated(a, _NoState(), "crew")
