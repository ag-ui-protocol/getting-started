"""Capability-detection + import-resilience suite.

Covers two graceful-degradation invariants of the crewai capability layer:

* ``_first_module`` treats "module not found" as a soft miss (fall through to
  the next candidate) but PROPAGATES a genuinely broken import inside an
  existing module — so a real bug is not misreported as "install crewai>=1.0".
* When the crewai events package doesn't resolve (``BaseEvent`` /
  ``BaseEventListener`` are ``None``), importing ``ag_ui_crewai.events`` /
  ``ag_ui_crewai.endpoint`` degrades to a plain ``object`` base rather than
  crashing at class-definition time with an opaque
  ``TypeError: NoneType takes no arguments`` (fewer capabilities, not a crash).
"""

import importlib
import subprocess
import sys
import textwrap

import pytest

from ag_ui_crewai import _capabilities as cap


def _run_isolated(script: str) -> subprocess.CompletedProcess:
    """Run ``script`` in a fresh interpreter (this venv's python).

    The degradation checks below force a crewai event symbol to ``None`` and
    ``importlib.reload`` ``events`` / ``endpoint``, which rebinds their classes
    — doing that in-process poisons exact-type event dispatch for the rest of
    the suite. A subprocess isolates the reload completely.
    """
    return subprocess.run(
        [sys.executable, "-c", textwrap.dedent(script)],
        capture_output=True,
        text=True,
        timeout=120,
    )


# --------------------------------------------------------------------------
# _first_module: soft-miss on ImportError, propagate everything else
# --------------------------------------------------------------------------

def test_first_module_returns_none_for_genuinely_missing_modules():
    """A list of non-existent modules is a soft miss -> (None, None)."""
    module, name = cap._first_module(
        ["ag_ui_crewai._definitely_not_a_real_module_xyz"]
    )
    assert module is None
    assert name is None


def test_first_module_resolves_first_importable_candidate():
    """The first importable candidate wins; earlier misses are skipped."""
    module, name = cap._first_module(
        ["ag_ui_crewai._definitely_not_a_real_module_xyz", "json"]
    )
    assert name == "json"
    assert module is importlib.import_module("json")


def test_first_module_propagates_non_import_error(monkeypatch):
    """A NON-ImportError raised while importing an existing module must NOT be
    swallowed — otherwise a real bug inside e.g.
    ``crewai.events`` is misreported as a missing module. A bare ``except:``
    would swallow this ``ValueError``; the narrowed
    ``except (ImportError, ModuleNotFoundError)`` lets it surface."""

    def _boom(_name):
        raise ValueError("broken top-level import side effect")

    monkeypatch.setattr(cap.importlib, "import_module", _boom)
    with pytest.raises(ValueError, match="broken top-level"):
        cap._first_module(["crewai.events"])


# --------------------------------------------------------------------------
# events / endpoint import degrades (does not crash) when the crewai event
# symbols are None
# --------------------------------------------------------------------------

def test_events_module_degrades_when_base_event_missing():
    """With ``_capabilities.BaseEvent`` forced to ``None``, reloading
    ``ag_ui_crewai.events`` must NOT raise ``TypeError: NoneType takes no
    arguments`` — the ``Bridged*`` classes fall back to an ``object`` base."""
    result = _run_isolated(
        """
        import importlib
        import ag_ui_crewai._capabilities as cap
        import ag_ui_crewai.events as events_mod
        cap.BaseEvent = None
        importlib.reload(events_mod)
        # Fell back to the inert sibling base (not crewai's BaseEvent).
        assert events_mod._BridgedBase is events_mod._InertBridgedBase
        # Class definition succeeded (no opaque TypeError / MRO error at import).
        assert issubclass(events_mod.BridgedToolCallChunkEvent, events_mod._InertBridgedBase)
        print("OK")
        """
    )
    assert result.returncode == 0, result.stderr
    assert "OK" in result.stdout


def test_endpoint_module_degrades_when_base_event_listener_missing():
    """With ``_capabilities.BaseEventListener`` forced to ``None``, reloading
    ``ag_ui_crewai.endpoint`` must NOT crash at class-definition time — the
    listener falls back to an ``object`` base (inert, since the bus is also
    unavailable in that scenario)."""
    result = _run_isolated(
        """
        import importlib
        import ag_ui_crewai._capabilities as cap
        import ag_ui_crewai.endpoint as endpoint_mod
        cap.BaseEventListener = None
        importlib.reload(endpoint_mod)
        assert endpoint_mod._EventListenerBase is object, endpoint_mod._EventListenerBase
        assert endpoint_mod.FastAPICrewFlowEventListener is not None
        print("OK")
        """
    )
    assert result.returncode == 0, result.stderr
    assert "OK" in result.stdout
