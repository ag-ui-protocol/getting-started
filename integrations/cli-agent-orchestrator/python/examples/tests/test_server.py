"""Keyless protocol-contract tests for the CAO AG-UI example server.

These assert the *wire contract* for each Dojo feature — fail-closed,
secret-free, and independent of the LLM-driven Dojo frontend. They run in
whichever backend is installed:

* **projection** (CAO ``cao`` extra present) — asserts CAO's merged run-plane
  frames (STEP_*, STATE_DELTA, CUSTOM cao.generative_ui).
* **mock** (zero-dependency fallback) — asserts the self-contained frames
  (TEXT_MESSAGE_*, TOOL_CALL_*).

The shared lifecycle contract (RUN_STARTED … RUN_FINISHED, the interrupt
approve/deny round-trip, and the privacy boundary) is asserted in **both**.

Run:  uv run --extra test pytest                 # mock backend
      uv sync --extra cao --extra test && pytest # projection backend
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, List

import pytest
from fastapi.testclient import TestClient

from server import app
from server._common import CAO_PROJECTION_AVAILABLE, interpret_resume, resolve_mode

client = TestClient(app)

MODE = resolve_mode()
projection_only = pytest.mark.skipif(MODE != "projection", reason="requires CAO projection backend")
mock_only = pytest.mark.skipif(MODE != "mock", reason="requires mock backend")


def _run_input(thread_id: str, **extra: Any) -> Dict[str, Any]:
    body = {
        "threadId": thread_id,
        "runId": f"run-{thread_id}",
        "state": {},
        "messages": [],
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }
    body.update(extra)
    return body


def _frames(path: str, body: Dict[str, Any]) -> List[Dict[str, Any]]:
    resp = client.post(path, json=body)
    assert resp.status_code == 200, (resp.status_code, resp.text)
    frames: List[Dict[str, Any]] = []
    for line in resp.text.splitlines():
        if line.startswith("data: "):
            frames.append(json.loads(line[len("data: ") :]))
    return frames


def _types(frames: List[Dict[str, Any]]) -> List[str]:
    return [f.get("type") for f in frames]


# --- shared contract (both backends) ---------------------------------------
def test_health():
    resp = client.get("/health")
    assert resp.status_code == 200 and resp.json()["status"] == "ok"


def test_agentic_chat_lifecycle():
    frames = _frames("/agentic-chat/", _run_input("chat"))
    types = _types(frames)
    assert types[0] == "RUN_STARTED"
    assert types[-1] == "RUN_FINISHED"
    assert frames[-1].get("outcome", {}).get("type") == "success"


def test_shared_state_has_snapshot():
    frames = _frames("/shared-state/", _run_input("state"))
    assert "STATE_SNAPSHOT" in _types(frames)


def _steps_snapshots(frames: List[Dict[str, Any]]) -> List[List[Dict[str, Any]]]:
    """Every STATE_SNAPSHOT that carries a ``steps`` list, in stream order."""
    out: List[List[Dict[str, Any]]] = []
    for frame in frames:
        if frame.get("type") != "STATE_SNAPSHOT":
            continue
        steps = (frame.get("snapshot") or {}).get("steps")
        if isinstance(steps, list):
            out.append(steps)
    return out


def test_agentic_generative_ui_state_matches_the_dojo_contract():
    """The shared Dojo page renders ``state.steps[] = {description, status}`` and
    understands exactly two statuses. Asserted in both backends, because the page
    is integration-agnostic — any drift here is invisible until the bar breaks."""
    frames = _frames("/agentic-generative-ui/", _run_input("agui-steps"))
    types = _types(frames)
    assert types[0] == "RUN_STARTED"
    assert types[-1] == "RUN_FINISHED"
    assert frames[-1].get("outcome", {}).get("type") == "success"

    snapshots = _steps_snapshots(frames)
    assert snapshots, f"no STATE_SNAPSHOT carried a steps list: {types}"
    for steps in snapshots:
        assert steps, "steps list must be non-empty or the page renders nothing"
        for step in steps:
            assert isinstance(step.get("description"), str) and step["description"]
            assert step.get("status") in ("pending", "completed"), step


def test_agentic_generative_ui_steps_are_the_real_fleet_primitives():
    """The point of this feature for CAO: the steps are the fleet's own record
    kinds, not a plan an LLM invented. Guards against someone later substituting
    generated prose and quietly losing the differentiator."""
    from server._common import FLEET_STEPS

    frames = _frames("/agentic-generative-ui/", _run_input("agui-vocab"))
    descriptions = [step["description"] for step in _steps_snapshots(frames)[0]]
    assert descriptions == FLEET_STEPS


def test_agentic_generative_ui_is_metadata_only():
    """Same privacy boundary as every other frame: step descriptions may name
    agents, providers and paths, never command output or message bodies."""
    frames = _frames("/agentic-generative-ui/", _run_input("agui-privacy"))
    blob = json.dumps(frames)
    for forbidden in ("rm -rf", "[y/n]", "Allow mock_cli"):
        assert forbidden not in blob


def test_steps_state_clamps_out_of_range_progress():
    from server._common import FLEET_STEPS, steps_state

    total = len(FLEET_STEPS)
    assert all(s["status"] == "pending" for s in steps_state(0)["steps"])
    assert all(s["status"] == "pending" for s in steps_state(-5)["steps"])
    assert all(s["status"] == "completed" for s in steps_state(total)["steps"])
    assert all(s["status"] == "completed" for s in steps_state(total + 99)["steps"])
    partial = steps_state(2)["steps"]
    assert [s["status"] for s in partial] == ["completed", "completed"] + ["pending"] * (total - 2)


def test_interrupt_outcome_then_approve_resume():
    frames = _frames("/interrupt/", _run_input("intr-approve"))
    assert frames[-1]["type"] == "RUN_FINISHED"
    outcome = frames[-1]["outcome"]
    assert outcome["type"] == "interrupt"
    interrupts = outcome["interrupts"]
    assert interrupts, "expected at least one open interrupt"
    interrupt_id = interrupts[0]["id"]

    resume_frames = _frames(
        "/interrupt/",
        _run_input("intr-approve", resume=[{"interruptId": interrupt_id, "status": "resolved", "payload": {"approved": True}}]),
    )
    assert resume_frames[-1]["type"] == "RUN_FINISHED"
    assert resume_frames[-1]["outcome"]["type"] == "success"


def test_interrupt_deny_resume():
    frames = _frames("/interrupt/", _run_input("intr-deny"))
    outcome = frames[-1]["outcome"]
    assert outcome["type"] == "interrupt"
    interrupt_id = outcome["interrupts"][0]["id"]
    resume_frames = _frames(
        "/interrupt/",
        _run_input("intr-deny", resume=[{"interruptId": interrupt_id, "status": "cancelled"}]),
    )
    assert resume_frames[-1]["outcome"]["type"] == "success"


def _open_interrupt(thread_id: str) -> str:
    frames = _frames("/interrupt/", _run_input(thread_id))
    return frames[-1]["outcome"]["interrupts"][0]["id"]


def test_interrupt_picker_approve_payload_resolves():
    """The Dojo picker approves via resolve({chosen_time,...}) — status
    'resolved' with a raw slot payload, not {approved:true}. Both backends must
    normalize that to an approval and finish successfully (projection otherwise
    closes the run with RUN_ERROR on the unrecognized answer shape)."""
    interrupt_id = _open_interrupt("intr-fe-approve")
    resume_frames = _frames(
        "/interrupt/",
        _run_input(
            "intr-fe-approve",
            resume=[{"interruptId": interrupt_id, "status": "resolved", "payload": {"chosen_time": "2026-01-01T10:00:00Z"}}],
        ),
    )
    assert resume_frames[-1]["type"] == "RUN_FINISHED"
    assert resume_frames[-1]["outcome"]["type"] == "success"


def test_interrupt_picker_deny_payload_resolves():
    """The Dojo Cancel button routes through resolve({cancelled:true}) — status
    'resolved' with a cancelled payload, NOT status 'cancelled'. Both backends
    must treat that as a denial and still finish successfully."""
    interrupt_id = _open_interrupt("intr-fe-deny")
    resume_frames = _frames(
        "/interrupt/",
        _run_input(
            "intr-fe-deny",
            resume=[{"interruptId": interrupt_id, "status": "resolved", "payload": {"cancelled": True}}],
        ),
    )
    assert resume_frames[-1]["type"] == "RUN_FINISHED"
    assert resume_frames[-1]["outcome"]["type"] == "success"


def test_interpret_resume_fails_closed():
    """Permission decisions must fail closed: an ambiguous, empty, malformed, or
    unknown resume is a DENIAL — approval requires an explicit positive signal.
    Backend-agnostic, so it holds in both mock and projection."""

    def approved(entry: Dict[str, Any]) -> bool:
        return interpret_resume(entry)["approved"]

    # Explicit approvals still approve.
    assert approved({"status": "resolved", "payload": {"approved": True}}) is True
    assert approved({"status": "resolved", "payload": {"chosen_time": "2026-01-01T10:00:00Z"}}) is True
    # Ambiguous / unknown / cancel shapes must NOT approve.
    assert approved({"status": "resolved", "payload": {}}) is False        # empty payload
    assert approved({"status": "resolved"}) is False                        # no payload
    assert approved({"status": "resolved", "payload": {"foo": "bar"}}) is False  # unknown shape
    assert approved({"status": "resolved", "payload": {"cancelled": True}}) is False
    assert approved({"status": "resolved", "payload": {"approved": False}}) is False
    assert approved({"status": "cancelled"}) is False
    assert approved({}) is False
    # A denied decision reports the cancelled status.
    assert interpret_resume({"status": "resolved", "payload": {}})["status"] == "cancelled"


def test_privacy_boundary_no_raw_command_on_wire():
    frames = _frames("/interrupt/", _run_input("intr-privacy"))
    blob = json.dumps(frames)
    # A destructive raw command body must never reach the wire.
    assert "rm -rf" not in blob
    interrupt = frames[-1]["outcome"]["interrupts"][0]
    assert interrupt.get("reason")
    assert interrupt.get("metadata", {}).get("provider") == "mock_cli"


def test_files_json_embeds_match_server_sources():
    """F2 drift guard: the Dojo content viewer (apps/dojo/src/files.json) embeds a
    copy of each CAO feature's server source. That embed silently drifted from the
    real code once already; this asserts every ``cli-agent-orchestrator::<feature>``
    entry's ``<feature>.py`` embed matches the on-disk ``server/<feature>.py`` so a
    server edit without a regenerate is caught, not shipped.

    Skips if files.json is not reachable (e.g. the package is checked out apart
    from the monorepo), so it never fails spuriously outside this repo.
    """
    here = Path(__file__).resolve()
    files_json = next(
        (p / "apps" / "dojo" / "src" / "files.json"
         for p in here.parents
         if (p / "apps" / "dojo" / "src" / "files.json").exists()),
        None,
    )
    if files_json is None:
        pytest.skip("apps/dojo/src/files.json not reachable (standalone checkout)")

    embeds: Dict[str, Any] = json.loads(files_json.read_text(encoding="utf-8"))
    server_dir = here.parents[1] / "server"  # .../python/examples/server

    checked = 0
    stale: List[str] = []
    for key, entries in embeds.items():
        if not key.startswith("cli-agent-orchestrator::"):
            continue
        for entry in entries:
            name = entry.get("name", "")
            if not name.endswith(".py"):
                continue
            source = server_dir / name
            assert source.exists(), f"{key}/{name} embedded but no source at {source}"
            if entry.get("content") != source.read_text(encoding="utf-8"):
                stale.append(f"{key}/{name}")
            checked += 1

    assert checked >= 4, f"expected >=4 CAO server embeds in files.json, found {checked}"
    assert not stale, (
        "files.json embeds are stale vs server sources: "
        + ", ".join(stale)
        + " — regenerate with `npm run generate-content-json` in apps/dojo "
        "(or `npx tsx apps/dojo/scripts/generate-content-json.ts`)."
    )


def test_files_json_embeds_match_dojo_feature_sources():
    """F2 drift guard, frontend half: assert every ``cli-agent-orchestrator::<feature>``
    entry's *frontend* embeds (``page.tsx``, ``style.css``, ``README.mdx``) match the
    on-disk Dojo sources.

    Its sibling above guards only the ``<feature>.py`` embeds, and that gap is not
    theoretical: all four ``page.tsx`` snapshots silently went stale across a
    367-commit rebase — upstream retyped the shared v2 page (``args.location`` ->
    ``parameters.location``, ``any`` -> a typed result) while our committed snapshots
    kept the old text — and the ``.py``-only guard stayed green throughout. These
    embeds are what the Dojo's content viewer shows a reader, so a stale one
    misrepresents the integration's own code.

    Feature directories are resolved the same way ``generate-content-json.ts``
    resolves them (``resolveFeatureDir``): the ``(v1)`` route group if present,
    otherwise ``(v2)``. Only files actually embedded are compared, so a feature
    without a ``style.css`` is not penalised.

    Skips if the Dojo tree is unreachable (package checked out apart from the
    monorepo), so it never fails spuriously outside this repo.
    """
    here = Path(__file__).resolve()
    dojo_src = next(
        (p / "apps" / "dojo" / "src"
         for p in here.parents
         if (p / "apps" / "dojo" / "src" / "files.json").exists()),
        None,
    )
    if dojo_src is None:
        pytest.skip("apps/dojo/src/files.json not reachable (standalone checkout)")

    feature_base = dojo_src / "app" / "[integrationId]" / "feature"
    if not feature_base.is_dir():
        pytest.skip(f"Dojo feature tree not reachable at {feature_base}")

    embeds: Dict[str, Any] = json.loads((dojo_src / "files.json").read_text(encoding="utf-8"))
    frontend_names = {"page.tsx", "style.css", "README.mdx"}

    checked = 0
    stale: List[str] = []
    missing: List[str] = []
    for key, entries in embeds.items():
        if not key.startswith("cli-agent-orchestrator::"):
            continue
        feature = key.split("::", 1)[1]
        # Mirror resolveFeatureDir(): (v1) wins when present, else (v2).
        v1 = feature_base / "(v1)" / feature
        feature_dir = v1 if v1.is_dir() else feature_base / "(v2)" / feature
        for entry in entries:
            name = entry.get("name", "")
            if name not in frontend_names:
                continue
            source = feature_dir / name
            if not source.exists():
                missing.append(f"{key}/{name} -> {source}")
                continue
            if entry.get("content") != source.read_text(encoding="utf-8"):
                stale.append(f"{key}/{name}")
            checked += 1

    assert not missing, "files.json embeds a frontend file with no source on disk: " + ", ".join(missing)
    assert checked >= 4, f"expected >=4 CAO frontend embeds in files.json, found {checked}"
    assert not stale, (
        "files.json frontend embeds are stale vs the Dojo sources: "
        + ", ".join(stale)
        + " — regenerate with `npx tsx apps/dojo/scripts/generate-content-json.ts` "
        "(or `npm run generate-content-json` in apps/dojo). This is the drift that "
        "survived a 367-commit rebase unnoticed."
    )


def test_dojo_launcher_port_claim_is_exclusive():
    """Guard this integration's port claim inside the shared Dojo launcher.

    ``run-dojo-everything.js`` launches every entry in its service map by default,
    so two entries declaring the same ``PORT`` leave one integration unserved: the
    loser fails to bind while the Dojo still points a URL at that port, which
    surfaces as 404s rather than a startup error. That is not hypothetical — this
    integration and an upstream one both held 8024 after a long-lived rebase,
    a collision no textual merge conflict could reveal because the two
    declarations live in different hunks of the same generated file.

    Asserts our port is claimed exactly once, and that the launcher and this
    server agree on it (the server source is the single source of truth).

    Deliberately scoped to our own claim rather than policing every entry: the
    ``dojo``/``dojo-dev`` pair legitimately shares 9999 and is de-duplicated by
    the launcher itself.

    Skips if the launcher is unreachable (package checked out apart from the
    monorepo), so it never fails spuriously outside this repo.
    """
    here = Path(__file__).resolve()
    launcher = next(
        (p / "apps" / "dojo" / "scripts" / "run-dojo-everything.js"
         for p in here.parents
         if (p / "apps" / "dojo" / "scripts" / "run-dojo-everything.js").exists()),
        None,
    )
    if launcher is None:
        pytest.skip("apps/dojo/scripts/run-dojo-everything.js not reachable (standalone checkout)")

    server_src = (here.parents[1] / "server" / "__init__.py").read_text(encoding="utf-8")
    match = re.search(r'os\.getenv\(\s*"PORT"\s*,\s*"(\d+)"\s*\)', server_src)
    assert match, "could not locate the PORT default in server/__init__.py"
    port = match.group(1)

    text = launcher.read_text(encoding="utf-8")

    claims = re.findall(rf"PORT:\s*{port}\b", text)
    assert len(claims) == 1, (
        f"port {port} is declared {len(claims)} time(s) in {launcher.name}; it must be "
        "claimed exactly once. Every service launches by default, so a shared port "
        "leaves one integration unserved with no startup error. Choose a free port."
    )

    cao_urls = set(re.findall(r'CAO_URL:\s*"http://localhost:(\d+)"', text))
    assert cao_urls == {port}, (
        f"CAO_URL in {launcher.name} points at {sorted(cao_urls) or ['nothing']} but this "
        f"server defaults to {port}; the launcher and the server must agree."
    )


# --- projection-only contract ----------------------------------------------
@projection_only
def test_projection_agentic_chat_steps():
    types = _types(_frames("/agentic-chat/", _run_input("chat-proj")))
    assert "STEP_STARTED" in types and "STEP_FINISHED" in types


@projection_only
def test_projection_shared_state_delta():
    frames = _frames("/shared-state/", _run_input("state-proj"))
    assert "STATE_DELTA" in _types(frames)
    delta = next(f for f in frames if f.get("type") == "STATE_DELTA")
    paths = [op.get("path") for op in delta.get("delta", [])]
    assert "/last_file_mod" in paths


@projection_only
def test_projection_hitl_generative_ui():
    frames = _frames("/human-in-the-loop/", _run_input("hitl-proj"))
    gen_ui = [f for f in frames if f.get("type") == "CUSTOM" and f.get("name") == "cao.generative_ui"]
    assert gen_ui, _types(frames)
    assert gen_ui[0]["value"].get("component") == "approval_card"


@projection_only
def test_projection_agentic_generative_ui_emits_the_real_lifecycle():
    """Projection mode must not merely publish a step list — the same records
    that define the steps have to produce their genuine run-plane frames:
    STEP_* from launch/completion, TOOL_CALL_* from each handoff, and an
    RFC-6902 STATE_DELTA from the file_mod."""
    frames = _frames("/agentic-generative-ui/", _run_input("agui-proj"))
    types = _types(frames)
    assert "STEP_STARTED" in types and "STEP_FINISHED" in types, types
    assert "TOOL_CALL_START" in types, types
    assert "STATE_DELTA" in types, types
    delta = next(f for f in frames if f.get("type") == "STATE_DELTA")
    assert "/last_file_mod" in [op.get("path") for op in delta.get("delta", [])]
    # The steps ride along on the single snapshot the run plane emits per run.
    assert _steps_snapshots(frames), types


@projection_only
def test_projection_agentic_generative_ui_advances_across_turns():
    """The run plane calls snapshot_fn once per run, so progress advances per
    turn. Same thread must move forward; a fresh thread must start over."""
    first = _steps_snapshots(_frames("/agentic-generative-ui/", _run_input("agui-adv")))[0]
    second = _steps_snapshots(_frames("/agentic-generative-ui/", _run_input("agui-adv")))[0]

    def done(steps: List[Dict[str, Any]]) -> int:
        return sum(1 for s in steps if s["status"] == "completed")

    assert done(first) == 1
    assert done(second) == 2
    fresh = _steps_snapshots(_frames("/agentic-generative-ui/", _run_input("agui-adv-other")))[0]
    assert done(fresh) == 1


# --- mock-only contract -----------------------------------------------------
@mock_only
def test_mock_agentic_chat_text_message():
    types = _types(_frames("/agentic-chat/", _run_input("chat-mock")))
    assert "TEXT_MESSAGE_START" in types and "TEXT_MESSAGE_END" in types


@mock_only
def test_mock_agentic_generative_ui_animates_to_all_completed():
    """Mock mode is the path the Dojo launcher, the keyless CI matrix and the
    hosted demo all pin, so it must carry the progressive animation the shared
    page was built for: several snapshots, monotonically increasing progress,
    starting all-pending and ending all-completed."""
    frames = _frames("/agentic-generative-ui/", _run_input("agui-mock"))
    snapshots = _steps_snapshots(frames)
    assert len(snapshots) >= 3, f"expected a progression, got {len(snapshots)} snapshot(s)"

    counts = [sum(1 for s in steps if s["status"] == "completed") for steps in snapshots]
    assert counts[0] == 0, counts
    assert counts[-1] == len(snapshots[-1]), counts
    assert counts == sorted(counts), f"progress must never go backwards: {counts}"
    # A completed step must stay completed across the stream.
    for earlier, later in zip(snapshots, snapshots[1:]):
        for before, after in zip(earlier, later):
            if before["status"] == "completed":
                assert after["status"] == "completed"


@mock_only
def test_mock_hitl_tool_call():
    # The HITL mock emits the planner tool-call only when a plan is requested and
    # no tool result exists yet (mirrors the real Dojo page flow). An empty
    # message list is routed to the greeting branch, so send a plan request.
    body = _run_input(
        "hitl-mock",
        messages=[{"id": "m1", "role": "user", "content": "Give me a plan to set up the project"}],
    )
    types = _types(_frames("/human-in-the-loop/", body))
    assert "TOOL_CALL_START" in types and "TOOL_CALL_END" in types


def _assistant_text(frames: List[Dict[str, Any]]) -> str:
    return " ".join(f.get("delta", "") for f in frames if f.get("type") == "TEXT_MESSAGE_CONTENT").lower()


@mock_only
def test_mock_interrupt_approve_says_granted():
    interrupt_id = _open_interrupt("intr-mock-approve")
    resume_frames = _frames(
        "/interrupt/",
        _run_input(
            "intr-mock-approve",
            resume=[{"interruptId": interrupt_id, "status": "resolved", "payload": {"chosen_time": "2026-01-01T10:00:00Z"}}],
        ),
    )
    text = _assistant_text(resume_frames)
    assert "granted" in text and "denied" not in text


@mock_only
def test_mock_interrupt_deny_says_denied():
    # Regression for the flagship bug: a Cancel (resolve({cancelled:true}),
    # status still "resolved") previously returned "granted".
    interrupt_id = _open_interrupt("intr-mock-deny")
    resume_frames = _frames(
        "/interrupt/",
        _run_input(
            "intr-mock-deny",
            resume=[{"interruptId": interrupt_id, "status": "resolved", "payload": {"cancelled": True}}],
        ),
    )
    text = _assistant_text(resume_frames)
    assert "denied" in text and "granted" not in text


@mock_only
def test_mock_interrupt_ambiguous_resume_denied():
    # An ambiguous resume (status "resolved", empty payload) must fail closed to
    # a denial — never silently grant the permission.
    interrupt_id = _open_interrupt("intr-mock-ambiguous")
    resume_frames = _frames(
        "/interrupt/",
        _run_input("intr-mock-ambiguous", resume=[{"interruptId": interrupt_id, "status": "resolved"}]),
    )
    text = _assistant_text(resume_frames)
    assert "denied" in text and "granted" not in text


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-v"]))
