"""Tests for CrewAI flow checkpointing / thread persistence.

Covers capability probes, per-method/per-flow kwarg gating, env parsing,
thread-id and restore-reference sanitisation, ``build_checkpoint_kwargs``
end-to-end (off by default; builds a per-thread config; folds a resolvable
resume reference into ``restore_from``; never emits ``restore_from_state_id``;
returns ``{}`` for a flow that predates the kwarg), the driver-level splice,
and real-flow persistence/restore.
"""

import asyncio
import os
from pathlib import Path

import pytest
from ag_ui.core import RunAgentInput
from ag_ui.encoder import EventEncoder

from ag_ui_crewai import _capabilities as caps
from ag_ui_crewai import _checkpoint as ckpt
from ag_ui_crewai import endpoint as ep

# Assertions that pin crewai >= 1.14 checkpoint behaviour must SKIP (not fail)
# on any crewai in the declared >=1.0,<2 support range below 1.14, where the
# API is absent. The bridge itself degrades gracefully there; these tests only
# apply where the capability exists.
requires_checkpointing = pytest.mark.skipif(
    not caps.CAPABILITIES.checkpointing_available,
    reason="installed crewai does not expose the checkpointing API (needs >=1.14)",
)

# The two real-flow end-to-end tests below drive a real crewai Flow, which
# registers crewai's process-global checkpoint listener and serialises the
# event graph. That global-state interaction is opt-in (set
# CREWAI_CHECKPOINT_E2E=1) so the default suite stays fully deterministic and
# cannot perturb unrelated tests that share the crewai event bus. The wiring
# and behaviour these prove are also covered deterministically by the unit
# tests above.
requires_e2e = pytest.mark.skipif(
    not os.getenv("CREWAI_CHECKPOINT_E2E"),
    reason="real-flow e2e; set CREWAI_CHECKPOINT_E2E=1 to run",
)


# -- fixtures / helpers -----------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_checkpoint_warn_dedupe():
    """Clear the one-time warning dedupe set between tests so a warning
    asserted (or suppressed) in one test does not leak into the next."""
    ckpt._WARN_SEEN.clear()
    yield
    ckpt._WARN_SEEN.clear()


def _make_input(*, thread_id="t-1", forwarded_props=None) -> RunAgentInput:
    return RunAgentInput(
        thread_id=thread_id,
        run_id="r-1",
        state={},
        messages=[],
        tools=[],
        context=[],
        forwarded_props=forwarded_props if forwarded_props is not None else {},
    )


class _SupportingFlow:
    """A flow whose kickoff_async/astream accept the checkpoint kwargs."""

    def __init__(self):
        self.received = None

    def __deepcopy__(self, memo):  # noqa: D401 - trivial
        return self

    async def kickoff_async(self, inputs=None, from_checkpoint=None, restore_from_state_id=None):
        self.received = {
            "inputs": inputs,
            "from_checkpoint": from_checkpoint,
            "restore_from_state_id": restore_from_state_id,
        }
        return None

    async def astream(self, inputs=None, from_checkpoint=None, restore_from_state_id=None):
        raise NotImplementedError


class _LegacyFlow:
    """A flow (like the cancellation doubles) that predates checkpointing."""

    def __init__(self):
        self.received = None

    def __deepcopy__(self, memo):  # noqa: D401 - trivial
        return self

    async def kickoff_async(self, inputs=None):
        self.received = {"inputs": inputs}
        return None


# -- capability probes (real crewai) ----------------------------------------


@requires_checkpointing
def test_capabilities_resolves_checkpoint_symbols():
    """On crewai >= 1.14 every checkpoint piece resolves."""
    assert caps.CheckpointConfig is not None
    assert caps.JsonProvider is not None
    assert caps.SqliteProvider is not None
    c = caps.CAPABILITIES
    assert c.checkpoint_config_available is True
    assert c.flow_from_checkpoint_supported is True
    assert c.flow_restore_from_state_id_supported is True
    assert c.checkpoint_fork_supported is True
    assert c.checkpoint_events_available is True
    assert c.checkpointing_available is True


def test_enabling_versions_table_is_complete():
    keys = set(caps.CHECKPOINT_ENABLING_VERSIONS)
    assert keys == {
        "from_checkpoint",
        "checkpoint_config",
        "fork",
        "checkpoint_events",
        "restore_from_state_id",
    }


# -- signature filtering -----------------------------------------------------


def test_kwarg_in_signature():
    def f(inputs=None, from_checkpoint=None):
        pass

    def g(inputs=None):
        pass

    def h(inputs=None, **kwargs):
        pass

    assert caps._kwarg_in_signature(f, "from_checkpoint") is True
    assert caps._kwarg_in_signature(g, "from_checkpoint") is False
    assert caps._kwarg_in_signature(h, "from_checkpoint") is True  # **kwargs
    assert caps._kwarg_in_signature(None, "from_checkpoint") is False


def test_supported_checkpoint_kwargs_filters_per_method():
    def accepts(inputs=None, from_checkpoint=None):
        pass

    def rejects(inputs=None):
        pass

    def var_kw(inputs=None, **kw):
        pass

    payload = {"from_checkpoint": object(), "restore_from_state_id": "x"}
    # Only the declared kwarg survives.
    assert caps.supported_checkpoint_kwargs(accepts, payload) == {
        "from_checkpoint": payload["from_checkpoint"]
    }
    # A method that declares neither gets nothing (the cancellation-double case).
    assert caps.supported_checkpoint_kwargs(rejects, payload) == {}
    # A **kwargs method takes everything.
    assert caps.supported_checkpoint_kwargs(var_kw, payload) == payload
    # Empty in, empty out.
    assert caps.supported_checkpoint_kwargs(accepts, {}) == {}


@requires_checkpointing
def test_flow_supports_checkpointing_per_flow():
    assert caps.flow_supports_checkpointing(_SupportingFlow()) is True
    # Legacy flow (kickoff_async(inputs) only) is NOT supported even though the
    # installed crewai is capable, the per-flow probe is what protects the
    # cancellation doubles.
    assert caps.flow_supports_checkpointing(_LegacyFlow()) is False


def test_legacy_flow_never_supported():
    # A flow that predates the kwarg is never checkpoint-supported, on any
    # crewai (no capability guard needed).
    assert caps.flow_supports_checkpointing(_LegacyFlow()) is False


# -- env parsing -------------------------------------------------------------


def test_settings_disabled_by_default(monkeypatch):
    monkeypatch.delenv("CREWAI_CHECKPOINT", raising=False)
    assert ckpt.resolve_checkpoint_settings().enabled is False


def test_settings_reads_all_knobs(monkeypatch):
    monkeypatch.setenv("CREWAI_CHECKPOINT", "true")
    monkeypatch.setenv("CREWAI_CHECKPOINT_PROVIDER", "sqlite")
    monkeypatch.setenv("CREWAI_CHECKPOINT_DIR", "/var/ckpt")
    monkeypatch.setenv("CREWAI_CHECKPOINT_MAX", "5")
    s = ckpt.resolve_checkpoint_settings()
    assert (s.enabled, s.provider, s.base_dir, s.max_checkpoints) == (
        True,
        "sqlite",
        "/var/ckpt",
        5,
    )


def test_settings_bad_values_fall_back(monkeypatch):
    monkeypatch.setenv("CREWAI_CHECKPOINT", "nope")  # not truthy
    monkeypatch.setenv("CREWAI_CHECKPOINT_PROVIDER", "redis")  # unknown -> json
    monkeypatch.setenv("CREWAI_CHECKPOINT_MAX", "-3")  # non-positive -> None
    s = ckpt.resolve_checkpoint_settings()
    assert s.enabled is False
    assert s.provider == "json"
    assert s.max_checkpoints is None


def test_settings_on_events_default_is_flow_trigger(monkeypatch):
    # Default MUST be a flow trigger, the stock CheckpointConfig default
    # (``task_completed``) never fires for a flow, so a flow would silently
    # write zero checkpoints.
    monkeypatch.delenv("CREWAI_CHECKPOINT_ON_EVENTS", raising=False)
    assert ckpt.resolve_checkpoint_settings().on_events == ("method_execution_finished",)


def test_settings_on_events_env_override(monkeypatch):
    monkeypatch.setenv("CREWAI_CHECKPOINT_ON_EVENTS", "flow_finished, method_execution_finished")
    assert ckpt.resolve_checkpoint_settings().on_events == (
        "flow_finished",
        "method_execution_finished",
    )


# -- thread-id sanitisation (security: path traversal) -----------------------


@pytest.mark.parametrize(
    "raw,prefix",
    [
        ("thread-abc_123", "thread-abc_123-"),
        # Unsafe chars collapse to "_"; leading/trailing junk stripped.
        ("../../etc/passwd", "etc_passwd-"),
        ("a/b\\c", "a_b_c-"),
    ],
)
def test_safe_thread_segment_readable_prefix(raw, prefix):
    seg = ckpt._safe_thread_segment(raw)
    assert seg is not None and seg.startswith(prefix)


@pytest.mark.parametrize("raw", ["", None, 123])
def test_safe_thread_segment_none_for_unusable(raw):
    # Empty / non-string ids have no usable key -> None (caller skips).
    assert ckpt._safe_thread_segment(raw) is None


def test_safe_thread_segment_injective():
    # Distinct ids that would collide after char-collapse must map to DISTINCT
    # segments (the hash suffix guarantees it), and the same id is stable.
    a = ckpt._safe_thread_segment("a/b")
    b = ckpt._safe_thread_segment("a_b")
    assert a != b
    assert a == ckpt._safe_thread_segment("a/b")
    # Dot-only ids are usable (hash-only segment), not dropped.
    assert ckpt._safe_thread_segment("..") != ckpt._safe_thread_segment(".")


def test_safe_thread_segment_no_separators_or_trailing_dot():
    # The readable prefix never contains path separators or a trailing dot,
    # even when the raw id's boundary would otherwise leave one.
    seg = ckpt._safe_thread_segment("a" * 127 + "." + "b" * 20)
    assert "/" not in seg and "\\" not in seg
    assert seg.split("-")[0] == "a" * 127


# -- resume-reference extraction ---------------------------------------------


def test_resume_reference_from_forwarded_props_top_level():
    inp = _make_input(forwarded_props={"restore_from": "cp-1"})
    assert ckpt._resume_reference(inp) == "cp-1"


def test_resume_reference_from_nested_crewai_key():
    inp = _make_input(forwarded_props={"crewai": {"checkpoint_id": "cp-2"}})
    assert ckpt._resume_reference(inp) == "cp-2"


def test_resume_reference_ignores_blank_and_nonstring():
    # Blank / non-string values are not treated as a resume reference.
    assert ckpt._resume_reference(_make_input(forwarded_props={"state_id": "  "})) is None
    assert ckpt._resume_reference(_make_input(forwarded_props={"checkpoint_id": 123})) is None


def test_resume_reference_absent():
    assert ckpt._resume_reference(_make_input()) is None


def test_resolve_restore_path(tmp_path):
    # Bare id resolves under <location>/main/<id>.json when it exists.
    location = str(tmp_path / "t1")
    branch = tmp_path / "t1" / "main"
    branch.mkdir(parents=True)
    ck = branch / "cp-abc.json"
    ck.write_text("{}")
    assert ckpt._resolve_restore_path(location, "cp-abc") == str(ck)
    # .json suffix added automatically; a missing id resolves to None (no crash).
    assert ckpt._resolve_restore_path(location, "cp-abc.json") == str(ck)
    assert ckpt._resolve_restore_path(location, "missing") is None


def test_resolve_restore_path_bad_input_never_raises(tmp_path):
    # A NUL byte (realpath ValueError) or other odd input must degrade to None,
    # never propagate a ValueError that would 500 the request.
    location = str(tmp_path / "t1")
    (tmp_path / "t1" / "main").mkdir(parents=True)
    assert ckpt._resolve_restore_path(location, "foo\x00bar") is None
    assert ckpt._resolve_restore_path(location, "\x00") is None


def test_resolve_restore_path_rejects_traversal_and_absolute(tmp_path):
    # Security: a client-controlled id must not escape the thread's store.
    location = str(tmp_path / "t1")
    branch = tmp_path / "t1" / "main"
    branch.mkdir(parents=True)
    # A real checkpoint in a DIFFERENT thread's store.
    other = tmp_path / "other" / "main"
    other.mkdir(parents=True)
    victim = other / "secret.json"
    victim.write_text("{}")
    # Absolute paths, separators and ".." are all rejected outright.
    assert ckpt._resolve_restore_path(location, str(victim)) is None
    assert ckpt._resolve_restore_path(location, "../../other/main/secret") is None
    assert ckpt._resolve_restore_path(location, "..") is None
    assert ckpt._resolve_restore_path(location, "sub/cp") is None
    assert ckpt._resolve_restore_path(location, "a\\b") is None


# -- build_checkpoint_kwargs -------------------------------------------------


def test_build_disabled_returns_empty(monkeypatch):
    monkeypatch.delenv("CREWAI_CHECKPOINT", raising=False)
    assert ckpt.build_checkpoint_kwargs(_SupportingFlow(), _make_input()) == {}


@requires_checkpointing
def test_build_enabled_supporting_flow_builds_per_thread_config(monkeypatch, tmp_path):
    monkeypatch.setenv("CREWAI_CHECKPOINT", "1")
    monkeypatch.setenv("CREWAI_CHECKPOINT_DIR", str(tmp_path))
    kwargs = ckpt.build_checkpoint_kwargs(_SupportingFlow(), _make_input(thread_id="abc"))
    assert "from_checkpoint" in kwargs
    config = kwargs["from_checkpoint"]
    assert isinstance(config, caps.CheckpointConfig)
    # Per-thread location under the configured base dir (injective segment).
    import os as _os

    seg = ckpt._safe_thread_segment("abc")
    assert config.location == _os.path.join(str(tmp_path), seg)
    assert seg.startswith("abc-")
    # No restore id was requested.
    assert "restore_from_state_id" not in kwargs


@requires_checkpointing
def test_build_never_emits_restore_from_state_id(monkeypatch, tmp_path):
    # from_checkpoint and restore_from_state_id are mutually exclusive in crewai
    # (combining them raises ValueError). The builder must NEVER emit the latter,
    # even when the client supplies a resume reference.
    monkeypatch.setenv("CREWAI_CHECKPOINT", "1")
    monkeypatch.setenv("CREWAI_CHECKPOINT_DIR", str(tmp_path))
    inp = _make_input(forwarded_props={"restore_from": "cp-9"})
    kwargs = ckpt.build_checkpoint_kwargs(_SupportingFlow(), inp)
    assert set(kwargs) == {"from_checkpoint"}
    assert "restore_from_state_id" not in kwargs


@requires_checkpointing
def test_build_resolvable_reference_sets_restore_from(monkeypatch, tmp_path):
    # A resolvable checkpoint reference is folded into the config's restore_from
    # (in the checkpointing system), not passed as a separate kwarg.
    monkeypatch.setenv("CREWAI_CHECKPOINT", "1")
    monkeypatch.setenv("CREWAI_CHECKPOINT_DIR", str(tmp_path))
    seg = ckpt._safe_thread_segment("abc")
    branch = tmp_path / seg / "main"
    branch.mkdir(parents=True)
    ck = branch / "cp-1.json"
    ck.write_text("{}")
    inp = _make_input(thread_id="abc", forwarded_props={"restore_from": "cp-1"})
    kwargs = ckpt.build_checkpoint_kwargs(_SupportingFlow(), inp)
    assert set(kwargs) == {"from_checkpoint"}
    assert kwargs["from_checkpoint"].restore_from == str(ck)


@requires_checkpointing
def test_build_unresolvable_reference_warns_and_persists(monkeypatch, tmp_path, caplog):
    # A stale / unknown reference must NOT crash (crewai would raise
    # FileNotFoundError): warn and continue with plain persistence.
    monkeypatch.setenv("CREWAI_CHECKPOINT", "1")
    monkeypatch.setenv("CREWAI_CHECKPOINT_DIR", str(tmp_path))
    inp = _make_input(thread_id="abc", forwarded_props={"restore_from": "does-not-exist"})
    with caplog.at_level("WARNING"):
        kwargs = ckpt.build_checkpoint_kwargs(_SupportingFlow(), inp)
    assert set(kwargs) == {"from_checkpoint"}
    assert kwargs["from_checkpoint"].restore_from is None
    assert any("could not be resolved to a checkpoint" in r.message for r in caplog.records)


@requires_checkpointing
def test_build_traversal_reference_is_not_restored(monkeypatch, tmp_path):
    # A traversal / absolute restore reference must not resolve; persistence
    # continues but restore_from stays None (no arbitrary-file read).
    monkeypatch.setenv("CREWAI_CHECKPOINT", "1")
    monkeypatch.setenv("CREWAI_CHECKPOINT_DIR", str(tmp_path))
    for ref in ("../../etc/passwd", "/etc/passwd", "foo\x00bar"):
        inp = _make_input(thread_id="abc", forwarded_props={"restore_from": ref})
        kwargs = ckpt.build_checkpoint_kwargs(_SupportingFlow(), inp)
        assert set(kwargs) == {"from_checkpoint"}
        assert kwargs["from_checkpoint"].restore_from is None


@requires_checkpointing
def test_build_sqlite_restore_reference_warns_and_skips(monkeypatch, tmp_path, caplog):
    # Restore-by-id targets the json layout; under sqlite it is ignored with a
    # warning rather than silently resolving to nothing.
    monkeypatch.setenv("CREWAI_CHECKPOINT", "1")
    monkeypatch.setenv("CREWAI_CHECKPOINT_PROVIDER", "sqlite")
    monkeypatch.setenv("CREWAI_CHECKPOINT_DIR", str(tmp_path))
    inp = _make_input(thread_id="abc", forwarded_props={"restore_from": "cp-1"})
    with caplog.at_level("WARNING"):
        kwargs = ckpt.build_checkpoint_kwargs(_SupportingFlow(), inp)
    assert set(kwargs) == {"from_checkpoint"}
    assert kwargs["from_checkpoint"].restore_from is None
    assert any("only supported for the json provider" in r.message for r in caplog.records)


@requires_checkpointing
def test_build_enabled_max_checkpoints(monkeypatch, tmp_path):
    monkeypatch.setenv("CREWAI_CHECKPOINT", "1")
    monkeypatch.setenv("CREWAI_CHECKPOINT_DIR", str(tmp_path))
    monkeypatch.setenv("CREWAI_CHECKPOINT_MAX", "7")
    kwargs = ckpt.build_checkpoint_kwargs(_SupportingFlow(), _make_input())
    assert kwargs["from_checkpoint"].max_checkpoints == 7


def test_build_enabled_legacy_flow_returns_empty_and_warns(monkeypatch, caplog):
    monkeypatch.setenv("CREWAI_CHECKPOINT", "1")
    with caplog.at_level("WARNING"):
        kwargs = ckpt.build_checkpoint_kwargs(_LegacyFlow(), _make_input())
    assert kwargs == {}
    assert any("CREWAI_CHECKPOINT is set" in r.message for r in caplog.records)


@requires_checkpointing
def test_build_sqlite_provider_selected(monkeypatch, tmp_path):
    monkeypatch.setenv("CREWAI_CHECKPOINT", "1")
    monkeypatch.setenv("CREWAI_CHECKPOINT_PROVIDER", "sqlite")
    monkeypatch.setenv("CREWAI_CHECKPOINT_DIR", str(tmp_path))
    kwargs = ckpt.build_checkpoint_kwargs(_SupportingFlow(), _make_input())
    provider = kwargs["from_checkpoint"].provider
    assert isinstance(provider, caps.SqliteProvider)


@requires_checkpointing
def test_build_empty_thread_id_skips_checkpointing(monkeypatch, tmp_path):
    # An unusable thread_id must NOT collapse into a shared bucket (cross-session
    # leak); build returns {} instead.
    monkeypatch.setenv("CREWAI_CHECKPOINT", "1")
    monkeypatch.setenv("CREWAI_CHECKPOINT_DIR", str(tmp_path))
    assert ckpt.build_checkpoint_kwargs(_SupportingFlow(), _make_input(thread_id="")) == {}


@requires_checkpointing
def test_build_resume_id_without_config_returns_empty(monkeypatch, tmp_path):
    # A resume id must never be returned alone (no store to restore from): with
    # an unusable thread_id the whole dict is empty, not {restore_from_state_id}.
    monkeypatch.setenv("CREWAI_CHECKPOINT", "1")
    monkeypatch.setenv("CREWAI_CHECKPOINT_DIR", str(tmp_path))
    inp = _make_input(thread_id="", forwarded_props={"restore_from_state_id": "cp-1"})
    assert ckpt.build_checkpoint_kwargs(_SupportingFlow(), inp) == {}


@requires_checkpointing
def test_build_provider_constructor_raising_degrades(monkeypatch, tmp_path):
    # A raising provider constructor must degrade to {} (no persistence), never
    # bubble a 500 out of the request handler.
    class _BoomProvider:
        def __init__(self):
            raise RuntimeError("boom")

    monkeypatch.setenv("CREWAI_CHECKPOINT", "1")
    monkeypatch.setenv("CREWAI_CHECKPOINT_DIR", str(tmp_path))
    monkeypatch.setattr(caps, "JsonProvider", _BoomProvider)
    # Must not raise.
    assert ckpt.build_checkpoint_kwargs(_SupportingFlow(), _make_input()) == {}


@requires_checkpointing
def test_build_json_falls_back_to_sqlite_when_json_missing(monkeypatch, tmp_path):
    # Symmetric fallback: a "json" request with JsonProvider absent falls back
    # to the installed SqliteProvider (mirrors the sqlite->json path).
    monkeypatch.setenv("CREWAI_CHECKPOINT", "1")
    monkeypatch.setenv("CREWAI_CHECKPOINT_DIR", str(tmp_path))
    monkeypatch.setattr(caps, "JsonProvider", None)
    kwargs = ckpt.build_checkpoint_kwargs(_SupportingFlow(), _make_input())
    assert isinstance(kwargs["from_checkpoint"].provider, caps.SqliteProvider)


@requires_checkpointing
def test_build_sqlite_falls_back_to_json_when_sqlite_missing(monkeypatch, tmp_path, caplog):
    # Symmetric fallback: a "sqlite" request with SqliteProvider absent falls
    # back to json and warns once.
    monkeypatch.setenv("CREWAI_CHECKPOINT", "1")
    monkeypatch.setenv("CREWAI_CHECKPOINT_PROVIDER", "sqlite")
    monkeypatch.setenv("CREWAI_CHECKPOINT_DIR", str(tmp_path))
    monkeypatch.setattr(caps, "SqliteProvider", None)
    with caplog.at_level("WARNING"):
        kwargs = ckpt.build_checkpoint_kwargs(_SupportingFlow(), _make_input())
    assert isinstance(kwargs["from_checkpoint"].provider, caps.JsonProvider)
    assert any("falling back to the other" in r.message for r in caplog.records)


@requires_checkpointing
def test_build_omits_max_checkpoints_when_unset(monkeypatch, tmp_path):
    monkeypatch.delenv("CREWAI_CHECKPOINT_MAX", raising=False)
    monkeypatch.setenv("CREWAI_CHECKPOINT", "1")
    monkeypatch.setenv("CREWAI_CHECKPOINT_DIR", str(tmp_path))
    kwargs = ckpt.build_checkpoint_kwargs(_SupportingFlow(), _make_input())
    assert kwargs["from_checkpoint"].max_checkpoints is None


def test_warn_unsupported_flow_does_not_advise_crewai_upgrade(monkeypatch, caplog):
    # When crewai IS capable but the flow lacks the kwarg, the warning must NOT
    # tell the operator to upgrade crewai (that would not help).
    if not caps.CAPABILITIES.checkpointing_available:
        pytest.skip("needs a capable crewai to exercise the flow-unsupported branch")
    monkeypatch.setenv("CREWAI_CHECKPOINT", "1")
    with caplog.at_level("WARNING"):
        assert ckpt.build_checkpoint_kwargs(_LegacyFlow(), _make_input()) == {}
    msgs = " ".join(r.message for r in caplog.records)
    assert "does not accept the from_checkpoint" in msgs
    assert "Upgrade to crewai" not in msgs


# -- driver-level splice -----------------------------------------------------


async def _drain(gen):
    out = []
    try:
        async for chunk in gen:
            out.append(chunk)
    except StopAsyncIteration:  # pragma: no cover - defensive
        pass
    return out


async def test_event_stream_passes_checkpoint_kwargs_to_kickoff():
    """The from_checkpoint config built upstream actually reaches ``kickoff_async``."""
    flow = _SupportingFlow()
    sentinel = object()
    gen = ep._run_flow_event_stream(
        flow_copy=flow,
        encoder=EventEncoder(),
        input_data=_make_input(),
        inputs={"id": "t-1"},
        timeout=5.0,
        checkpoint_kwargs={"from_checkpoint": sentinel},
    )
    await asyncio.wait_for(_drain(gen), timeout=10.0)
    assert flow.received is not None
    assert flow.received["from_checkpoint"] is sentinel


async def test_event_stream_filters_kwargs_for_legacy_flow():
    """A flow that predates the kwargs is called exactly as before (no crash)."""
    flow = _LegacyFlow()
    gen = ep._run_flow_event_stream(
        flow_copy=flow,
        encoder=EventEncoder(),
        input_data=_make_input(),
        inputs={"id": "t-1"},
        timeout=5.0,
        checkpoint_kwargs={"from_checkpoint": object(), "restore_from_state_id": "cp-x"},
    )
    # Must not raise TypeError: unexpected keyword argument.
    await asyncio.wait_for(_drain(gen), timeout=10.0)
    assert flow.received == {"inputs": {"id": "t-1"}}


async def test_event_stream_no_checkpoint_kwargs_is_unchanged():
    """checkpoint_kwargs=None keeps the legacy call shape."""
    flow = _LegacyFlow()
    gen = ep._run_flow_event_stream(
        flow_copy=flow,
        encoder=EventEncoder(),
        input_data=_make_input(),
        inputs={"id": "t-1"},
        timeout=5.0,
    )
    await asyncio.wait_for(_drain(gen), timeout=10.0)
    assert flow.received == {"inputs": {"id": "t-1"}}


class _FakeStreamSession:
    """Minimal AsyncStreamSession stand-in: ends immediately, closes cleanly."""

    def __aiter__(self):
        return self

    async def __anext__(self):
        raise StopAsyncIteration

    async def aclose(self):
        return None


class _AstreamRecordingFlow:
    """Frame-path flow double: records the kwargs astream is invoked with."""

    def __init__(self):
        self.received = None

    def __deepcopy__(self, memo):  # noqa: D401 - trivial
        return self

    def astream(self, inputs=None, from_checkpoint=None, restore_from_state_id=None):
        self.received = {
            "inputs": inputs,
            "from_checkpoint": from_checkpoint,
            "restore_from_state_id": restore_from_state_id,
        }
        return _FakeStreamSession()


async def test_frame_stream_passes_checkpoint_kwargs_to_astream():
    """The StreamFrame/astream path (the default on crewai >=1.6) also splices
    the checkpoint kwargs, not just the legacy kickoff_async path."""
    flow = _AstreamRecordingFlow()
    sentinel = object()
    gen = ep._run_flow_frame_stream(
        flow_copy=flow,
        encoder=EventEncoder(),
        input_data=_make_input(),
        inputs={"id": "t-1"},
        timeout=5.0,
        checkpoint_kwargs={"from_checkpoint": sentinel},
    )
    await asyncio.wait_for(_drain(gen), timeout=10.0)
    assert flow.received is not None
    assert flow.received["from_checkpoint"] is sentinel


# -- real crewai Flow persistence (end-to-end) -------------------------------


def _isolate_checkpoint_bus(monkeypatch):
    """Give the real-flow tests a clean, ISOLATED crewai event bus.

    crewai's checkpoint listener is a process-global registered once behind a
    module-level ``_handlers_registered`` flag, and writes checkpoints by
    serialising the captured event graph. Foreign listeners left on the shared
    bus by other tests carry unpicklable state (``_thread.RLock``), which makes
    the checkpoint write raise ``TypeError: cannot pickle`` unless the bus is
    clean.

    Swap each handler container for a fresh empty one via ``monkeypatch`` (which
    restores the ORIGINAL container, with every other test's handlers intact, on
    teardown) rather than mutating the shared dicts in place. This gives the run
    a clean bus without corrupting global state other tests depend on.
    """
    import crewai.state.checkpoint_listener as _cl

    bus = caps.crewai_event_bus
    for attr in ("_sync_handlers", "_async_handlers", "_handlers"):
        handlers = getattr(bus, attr, None)
        if handlers is not None:
            monkeypatch.setattr(bus, attr, type(handlers)(), raising=False)
    # raising=True: if crewai renames this internal, fail loudly rather than let
    # the order-independence workaround silently become a no-op.
    monkeypatch.setattr(_cl, "_handlers_registered", False, raising=True)


@requires_e2e
@requires_checkpointing
async def test_real_flow_persists_checkpoints_with_default_settings(monkeypatch, tmp_path):
    """A real crewai Flow driven with our default config actually writes
    checkpoint files, the proof that ``on_events`` is a flow trigger, not the
    stock crew default (which would silently write nothing)."""
    from crewai.flow.flow import Flow, listen, start

    _isolate_checkpoint_bus(monkeypatch)

    class _RealFlow(Flow):
        @start()
        def step_a(self):
            self.state["a"] = 1
            return "a"

        @listen(step_a)
        def step_b(self, _):
            self.state["b"] = 2
            return "b"

    monkeypatch.setenv("CREWAI_CHECKPOINT", "1")
    monkeypatch.setenv("CREWAI_CHECKPOINT_DIR", str(tmp_path))

    flow = _RealFlow()
    kwargs = ckpt.build_checkpoint_kwargs(flow, _make_input(thread_id="thread-xyz"))
    assert "from_checkpoint" in kwargs

    await asyncio.wait_for(
        flow.kickoff_async(inputs={"id": "thread-xyz"}, **kwargs), timeout=30.0
    )

    # Checkpoints landed under the per-thread location.
    written = list(Path(kwargs["from_checkpoint"].location).rglob("*.json"))
    assert written, "expected checkpoint files to be written for the flow run"


@requires_e2e
@requires_checkpointing
async def test_real_flow_restore_config_accepted_without_crash(monkeypatch, tmp_path):
    """The real resume path (persist run 1, restore run 2) is accepted by crewai
    without raising, and the builder plumbs the checkpoint into
    ``CheckpointConfig.restore_from`` -- never as the incompatible
    ``restore_from_state_id`` kwarg (which, combined with ``from_checkpoint``,
    raises ``ValueError: Cannot combine ...``). This is the end-to-end
    crash-regression for the two-systems incompatibility.

    NOTE on scope: that a restored run SKIPS already-completed steps is crewai's
    documented behaviour and is verified against the installed wheel in a
    standalone process. It is asserted here only at the config-plumbing level:
    crewai's restore short-circuit is driven by a process-global checkpoint
    listener whose registration the shared conftest event-bus fixture rewrites
    between tests, which masks the step-skip inside the suite. Asserting the
    skip here would be flaky, so we assert the robust, harness-stable facts:
    the config carries restore_from and the real kickoff does not raise."""
    from crewai.flow.flow import Flow, listen, start

    _isolate_checkpoint_bus(monkeypatch)
    monkeypatch.setenv("CREWAI_CHECKPOINT", "1")
    monkeypatch.setenv("CREWAI_CHECKPOINT_DIR", str(tmp_path))

    class _RealFlow(Flow):
        @start()
        def step_a(self):
            self.state["a"] = 1
            return "a"

        @listen(step_a)
        def step_b(self, _):
            self.state["b"] = 2
            return "b"

    # Run 1: persist.
    k1 = ckpt.build_checkpoint_kwargs(_RealFlow(), _make_input(thread_id="cont"))
    await asyncio.wait_for(_RealFlow().kickoff_async(inputs={"id": "cont"}, **k1), timeout=30.0)
    checkpoints = sorted((Path(k1["from_checkpoint"].location) / "main").glob("*.json"))
    assert checkpoints, "run 1 must have written checkpoints"

    # Run 2: build a resume config from a real checkpoint and drive the real
    # kickoff. The builder must emit from_checkpoint ONLY (never the
    # incompatible restore_from_state_id) with restore_from set, and the real
    # kickoff must complete without raising the "Cannot combine" ValueError.
    ck = checkpoints[-1]
    # Clients pass a bare checkpoint id (never an absolute path); the builder
    # resolves it within this thread's store.
    inp = _make_input(thread_id="cont", forwarded_props={"restore_from": ck.stem})
    k2 = ckpt.build_checkpoint_kwargs(_RealFlow(), inp)
    assert set(k2) == {"from_checkpoint"}
    assert k2["from_checkpoint"].restore_from == str(ck)
    result = await asyncio.wait_for(
        _RealFlow().kickoff_async(inputs={"id": "cont"}, **k2), timeout=30.0
    )
    assert result is not None
