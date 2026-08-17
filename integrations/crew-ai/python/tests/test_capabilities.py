"""Capability-detection + import-resilience suite.

Covers the graceful-degradation invariants of the crewai capability layer:

* ``_first_module`` treats "module not found" as a soft miss (fall through to
  the next candidate) but PROPAGATES a genuinely broken import inside an
  existing module — so a real bug is not misreported as "install crewai>=1.0".
* When the crewai events package doesn't resolve (``BaseEvent`` /
  ``BaseEventListener`` are ``None``), importing ``ag_ui_crewai.events`` /
  ``ag_ui_crewai.endpoint`` degrades to a plain ``object`` base rather than
  crashing at class-definition time with an opaque
  ``TypeError: NoneType takes no arguments`` (fewer capabilities, not a crash).
* A litellm that raises a non-ImportError from its own top level leaves the
  capability module itself importable, with the whole litellm-backed surface
  reported absent. Importing the PACKAGE still fails on such a build, because
  ``sdk`` imports litellm at top level; that is by design and out of scope here.
"""

import importlib
import subprocess
import sys
import textwrap

import pytest

from ag_ui_crewai import _capabilities as cap


def test_conversational_stream_probe_is_publicly_available():
    """Conversational mode is selected by capability, never by version."""
    assert callable(getattr(cap, "flow_supports_conversational_stream", None))


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


# --------------------------------------------------------------------------
# A broken litellm degrades the Responses channel; it never fails the import
# --------------------------------------------------------------------------
# The litellm probe tolerates ANY exception from litellm's top level (bare
# ``except Exception``) and continues with ``_litellm_available = False``, which
# leaves the Responses channel unavailable and every caller on chat-completions.

#: Preamble installing a meta-path finder whose matched modules raise a
#: NON-ImportError from their body, which is how a genuinely broken install
#: (bad C extension, incompatible transitive dep, failing side effect) presents.
#: A ``ModuleNotFoundError`` would be the uninteresting case: ``_first_module``
#: already treats that as a soft miss.
#:
#: Indented to match the inline scripts below so ``_run_isolated``'s
#: ``textwrap.dedent`` sees ONE common prefix over the concatenation. At column 0
#: it would instead pin the common prefix to zero, leaving every appended line
#: indented into ``find_spec``'s body: dead code after its ``return``, so the
#: subprocess would exit 0 having run none of the assertions.
_BROKEN_MODULE_FINDER = """
        import importlib.abc
        import importlib.machinery
        import sys
        import types


        class _BrokenLoader(importlib.abc.Loader):
            def create_module(self, spec):
                return types.ModuleType(spec.name)

            def exec_module(self, module):
                raise RuntimeError("simulated broken module body")


        class _BrokenFinder(importlib.abc.MetaPathFinder):
            def __init__(self, *names):
                self._names = names

            def find_spec(self, fullname, path=None, target=None):
                if fullname in self._names:
                    return importlib.machinery.ModuleSpec(fullname, _BrokenLoader())
                return None
"""


def test_capabilities_import_survives_broken_litellm_top_level():
    """litellm's top level raising a non-ImportError must not fail this import.

    The litellm probe chose to continue degraded, so the module body must complete
    and report the whole litellm-backed surface as absent rather than re-raising.
    The Responses entrypoint resolves by ``getattr`` off the already-imported
    module, guarded by that same probe, so it degrades to ``None`` with it.

    Loaded straight from its file rather than as ``ag_ui_crewai._capabilities``,
    because that dotted import would first execute the package ``__init__``,
    which reaches ``sdk``'s top-level ``from litellm.types.utils import ...``.
    litellm is a DECLARED DIRECT dependency there, so a broken litellm failing
    that import is by design; this module's degraded mode is not. Loading the
    file directly asserts exactly the leaf-module property its own docstring
    claims, with no dependency on the package's import order.
    """
    result = _run_isolated(
        _BROKEN_MODULE_FINDER
        + """
        import importlib.util
        import pathlib

        # ``find_spec`` on a top-level name locates without executing, so the
        # package __init__ (and its litellm imports) never runs.
        origin = importlib.util.find_spec("ag_ui_crewai").origin
        path = pathlib.Path(origin).with_name("_capabilities.py")

        sys.meta_path.insert(0, _BrokenFinder("litellm"))

        # Load it UNDER the real package name so ``@dataclass`` can resolve the
        # deferred annotations of ``_Capabilities`` through
        # ``sys.modules[__module__]``; a bare file-path load would fail on that,
        # which says nothing about the litellm degradation.
        pkg = importlib.util.module_from_spec(importlib.util.find_spec("ag_ui_crewai"))
        pkg.__path__ = [str(path.parent)]
        sys.modules.setdefault("ag_ui_crewai", pkg)

        spec = importlib.util.spec_from_file_location(
            "ag_ui_crewai._capabilities", path
        )
        cap = importlib.util.module_from_spec(spec)
        # Register before executing: ``@dataclass`` resolves the deferred
        # annotations of ``_Capabilities`` through ``sys.modules[__module__]``.
        sys.modules[spec.name] = cap
        # The module body is the code under test: it must run to completion.
        spec.loader.exec_module(cap)

        assert cap.CAPABILITIES.litellm_available is False
        assert "litellm" in cap.CAPABILITIES.missing
        # The Responses entrypoint degrades to absent, not to a raise.
        assert cap.responses_entrypoint() is None
        assert cap.CAPABILITIES.responses_api_available is False
        # crewai resolved normally, so this is a litellm-only degradation.
        assert cap.CAPABILITIES.has_event_bus is True
        print("OK")
        """
    )
    assert result.returncode == 0, result.stderr
    assert "OK" in result.stdout

