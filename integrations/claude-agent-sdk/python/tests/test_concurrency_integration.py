"""Thread-level concurrency integration tests for the Claude Agent SDK adapter.

Unlike ``test_adapter.py`` — whose ``TestWorkerLifecycle`` /
``TestPoisonedWorkerCache`` suites monkeypatch the whole ``SessionWorker`` class
with ``_Fake*Worker`` stand-ins — these tests drive the **real** adapter +
the **real** :class:`ag_ui_claude_sdk.session.SessionWorker`. Only the leaf
``ClaudeSDKClient`` (the thing that would actually spawn the Claude CLI and hit
the Anthropic API) is substituted.

Why this matters: the white-box fakes replace ``SessionWorker.query`` directly,
so they never exercise the worker's background task, its input/output queue
plumbing, ``client.connect()`` / ``client.query()`` / ``client.receive_response()``,
or its ``start()`` / ``stop()`` lifecycle. The per-thread ``active_runs`` refcount
hardening (PR #1878, "item 7") is therefore proven today only against fakes.
These tests close that gap: two genuinely-concurrent ``run()`` invocations share
one real worker through the full adapter stack, with the LLM substituted at the
SDK-client boundary (the same boundary the dojo e2e mocks via aimock +
``ANTHROPIC_BASE_URL``, just pushed down into the process instead of over HTTP).

LLM substitution mechanism
---------------------------
``SessionWorker._run`` does ``from claude_agent_sdk import ClaudeSDKClient`` at
call time, so monkeypatching ``claude_agent_sdk.ClaudeSDKClient`` swaps the real
client for a scripted one while leaving the worker (and the adapter) entirely
real. The fake client implements the exact surface the worker uses:
``connect()``, ``query()``, ``receive_response()``, ``disconnect()``,
``interrupt()`` — and streams back real ``claude_agent_sdk`` message objects
(``StreamEvent`` / ``ResultMessage``), so the adapter's translation layer runs
for real too.
"""

import asyncio

import pytest

from ag_ui.core import EventType
from ag_ui_claude_sdk.adapter import ClaudeAgentAdapter
from ag_ui_claude_sdk import session as session_module
from ag_ui_claude_sdk.session import SessionWorker

from .conftest import stream_event


def _types(events):
    return [e.type for e in events]


# ---------------------------------------------------------------------------
# Scripted ClaudeSDKClient — the ONLY substituted component. Everything above
# it (SessionWorker queues/lifecycle, adapter run()) is real.
# ---------------------------------------------------------------------------


class _ScriptedClient:
    """Stand-in for ``claude_agent_sdk.ClaudeSDKClient``.

    Streams a minimal but real Claude SDK message sequence (a couple of
    streaming text deltas wrapped in ``StreamEvent`` + a terminal
    ``ResultMessage``). A per-instance ``release`` event lets a test hold the
    stream open to force genuine overlap between two concurrent runs sharing
    one worker.

    Each instance records that it was constructed/connected so a test can prove
    the **real** ``SessionWorker._run`` path executed (a fake worker never
    constructs a ClaudeSDKClient at all).
    """

    def __init__(self, *, instances, options=None, fail=False, release=None):
        self.options = options
        self._fail = fail
        self._release = release
        self.connected = False
        self.disconnected = False
        self.query_calls = []
        instances.append(self)

    async def connect(self):
        self.connected = True

    async def query(self, prompt, session_id="default"):
        self.query_calls.append((prompt, session_id))

    async def receive_response(self):
        from claude_agent_sdk import ResultMessage

        # Optionally block so a peer run can be proven mid-stream on the SAME
        # shared worker before this one completes.
        if self._release is not None:
            await self._release.wait()

        if self._fail:
            raise RuntimeError("scripted client boom")

        msg_id_event = stream_event({"type": "message_start"})
        text_start = stream_event(
            {
                "type": "content_block_delta",
                "delta": {"type": "text_delta", "text": "hello "},
            }
        )
        text_more = stream_event(
            {
                "type": "content_block_delta",
                "delta": {"type": "text_delta", "text": "world"},
            }
        )
        msg_stop = stream_event({"type": "message_stop"})
        for ev in (msg_id_event, text_start, text_more, msg_stop):
            yield ev

        yield ResultMessage(
            subtype="success",
            duration_ms=1,
            duration_api_ms=1,
            is_error=False,
            num_turns=1,
            session_id="sess",
            total_cost_usd=0.0,
            usage={},
            result="hello world",
        )

    async def disconnect(self):
        self.disconnected = True

    async def interrupt(self):
        pass


def _install_scripted_client(monkeypatch, instances, *, fail_when=None, release_when=None):
    """Patch ``claude_agent_sdk.ClaudeSDKClient`` with a factory that produces
    ``_ScriptedClient`` instances.

    ``fail_when`` / ``release_when`` are callables ``(index) -> bool`` keyed on
    construction order, letting a test designate which worker's client fails or
    blocks. (One worker per thread_id, so for a single shared thread the index
    maps to run order.)
    """
    import claude_agent_sdk

    counter = {"n": 0}
    releases = []

    def factory(options=None, **kwargs):
        idx = counter["n"]
        counter["n"] += 1
        release = None
        if release_when is not None and release_when(idx):
            release = asyncio.Event()
            releases.append(release)
        return _ScriptedClient(
            instances=instances,
            options=options,
            fail=bool(fail_when and fail_when(idx)),
            release=release,
        )

    monkeypatch.setattr(claude_agent_sdk, "ClaudeSDKClient", factory)
    return releases


@pytest.mark.asyncio
async def test_real_worker_passes_multimodal_prompt_to_sdk_client(
    make_input, monkeypatch
):
    """Exercise the real adapter and SessionWorker up to the SDK client."""
    instances = []
    _install_scripted_client(monkeypatch, instances)
    adapter = ClaudeAgentAdapter(name="t")
    inp = make_input(
        thread_id="multimodal-thread",
        messages=[
            {
                "id": "1",
                "role": "user",
                "content": [
                    {"type": "text", "text": "describe"},
                    {
                        "type": "image",
                        "source": {
                            "type": "data",
                            "value": "aW1hZ2U=",
                            "mime_type": "image/png",
                        },
                    },
                    {
                        "type": "document",
                        "source": {
                            "type": "data",
                            "value": "cGRm",
                            "mime_type": "application/pdf",
                        },
                    },
                ],
            }
        ],
    )

    try:
        _ = [event async for event in adapter.run(inp)]
        assert len(instances) == 1
        prompt, session_id = instances[0].query_calls[0]
        sdk_messages = [message async for message in prompt]

        assert session_id == "multimodal-thread"
        assert sdk_messages == [
            {
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "describe"},
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/png",
                                "data": "aW1hZ2U=",
                            },
                        },
                        {
                            "type": "document",
                            "source": {
                                "type": "base64",
                                "media_type": "application/pdf",
                                "data": "cGRm",
                            },
                        },
                    ],
                },
                "parent_tool_use_id": None,
                "session_id": "multimodal-thread",
            }
        ]
    finally:
        await adapter.shutdown()


async def _drive(adapter, inp):
    return [e async for e in adapter.run(inp)]


async def _wait_for(predicate, *, tries=400):
    """Cooperatively yield until ``predicate()`` is truthy (or give up)."""
    for _ in range(tries):
        if predicate():
            return True
        await asyncio.sleep(0)
    return False


class TestRealWorkerConcurrency:
    """Drives the REAL SessionWorker + adapter; only ClaudeSDKClient is faked.

    Same-thread runs are now SERIALIZED by the per-thread run-admission lock
    (Fix 1), so two overlapping same-thread runs no longer co-exist in-flight
    (the refcount never exceeds 1). These scenarios verify the real worker is
    nonetheless REUSED across the serialized runs (not duplicated, not torn
    down) and torn down cleanly afterward.
    """

    @pytest.mark.asyncio
    async def test_scenario_a_two_overlapping_runs_serialized_on_one_real_worker(
        self, make_input, monkeypatch
    ):
        # (a) Two overlapping run() invocations on the SAME thread_id are
        # SERIALIZED: B's RUN_STARTED is emitted only after A's RUN_FINISHED.
        # Both complete on the ONE shared REAL worker (reused, not duplicated),
        # which drains to refcount 0 and survives throughout.
        instances = []
        _install_scripted_client(monkeypatch, instances)

        adapter = ClaudeAgentAdapter(name="t")
        inp = make_input(
            thread_id="shared", messages=[{"id": "1", "role": "user", "content": "hi"}]
        )

        order = []

        async def drive(marker):
            evs = []
            async for e in adapter.run(inp):
                evs.append(e)
                if e.type in (EventType.RUN_STARTED, EventType.RUN_FINISHED):
                    order.append((marker, e.type))
            return evs

        t1 = asyncio.create_task(drive("A"))
        await _wait_for(lambda: ("A", EventType.RUN_STARTED) in order)
        t2 = asyncio.create_task(drive("B"))

        events1, events2 = await asyncio.gather(t1, t2)

        assert EventType.RUN_FINISHED in _types(events1)
        assert EventType.RUN_FINISHED in _types(events2)
        # Real translation layer ran: streamed text surfaced as AG-UI events.
        assert EventType.TEXT_MESSAGE_CONTENT in _types(events1)
        assert EventType.TEXT_MESSAGE_CONTENT in _types(events2)

        # SERIALIZED: A's RUN_FINISHED strictly precedes B's RUN_STARTED.
        idx_a_fin = order.index(("A", EventType.RUN_FINISHED))
        idx_b_start = order.index(("B", EventType.RUN_STARTED))
        assert idx_a_fin < idx_b_start, f"runs not serialized: {order}"

        # ONE real worker served both runs (reused, not duplicated).
        entry = adapter._workers["shared"]
        assert isinstance(entry["worker"], SessionWorker)
        assert entry["active_runs"] == 0
        assert entry["active"] is False
        assert len(instances) == 1, "worker was duplicated instead of reused"

        await adapter.shutdown()

    @pytest.mark.asyncio
    async def test_scenario_b_erroring_run_then_next_run_proceeds(
        self, make_input, monkeypatch
    ):
        # (b) Two overlapping same-thread runs; the FIRST-admitted one raises
        # mid-stream. Because runs are serialized, the second run only begins
        # after the first releases its run-lock (on the error path). The errored
        # run surfaces RUN_ERROR; the next run completes normally.
        instances = []

        import claude_agent_sdk

        class _SharedClient:
            served = 0

            def __init__(self, options=None, **kwargs):
                self.options = options
                self.connected = False
                self.disconnected = False
                instances.append(self)

            async def connect(self):
                self.connected = True

            async def query(self, prompt, session_id="default"):
                pass

            async def receive_response(self):
                from claude_agent_sdk import ResultMessage

                served = _SharedClient.served
                _SharedClient.served += 1
                if served == 0:
                    # First served query (A): raise mid-stream.
                    raise RuntimeError("scripted client boom")
                    yield  # pragma: no cover
                # Next query (B): complete normally.
                yield stream_event({"type": "message_start"})
                yield stream_event(
                    {
                        "type": "content_block_delta",
                        "delta": {"type": "text_delta", "text": "ok"},
                    }
                )
                yield stream_event({"type": "message_stop"})
                yield ResultMessage(
                    subtype="success",
                    duration_ms=1,
                    duration_api_ms=1,
                    is_error=False,
                    num_turns=1,
                    session_id="sess",
                    total_cost_usd=0.0,
                    usage={},
                    result="ok",
                )

            async def disconnect(self):
                self.disconnected = True

            async def interrupt(self):
                pass

        monkeypatch.setattr(claude_agent_sdk, "ClaudeSDKClient", _SharedClient)

        adapter = ClaudeAgentAdapter(name="t")
        inp = make_input(
            thread_id="shared", messages=[{"id": "1", "role": "user", "content": "hi"}]
        )

        # A (admitted first, fails) and B (proceeds after A releases the lock).
        t_a = asyncio.create_task(_drive(adapter, inp))
        await _wait_for(
            lambda: (adapter._workers.get("shared") or {}).get("active_runs", 0) >= 1
        )
        t_b = asyncio.create_task(_drive(adapter, inp))

        events_a, events_b = await asyncio.wait_for(
            asyncio.gather(t_a, t_b), timeout=10.0
        )
        assert EventType.RUN_ERROR in _types(events_a)
        assert EventType.RUN_FINISHED in _types(events_b)
        assert EventType.RUN_ERROR not in _types(events_b)

        # End state: refcount 0, idle, evictable, no leak.
        entry = adapter._workers["shared"]
        assert isinstance(entry["worker"], SessionWorker)
        assert entry["active_runs"] == 0
        assert entry["active"] is False

        await adapter.shutdown()

    @pytest.mark.asyncio
    async def test_scenario_c_worker_cleanly_evictable_after_runs(
        self, make_input, monkeypatch
    ):
        # (c) explicit: after two serialized same-thread runs finish, the shared
        # real worker is refcount 0 and is actually torn down (stop() disconnects
        # the client) by clear_session — no leak, no lingering background task.
        instances = []
        _install_scripted_client(monkeypatch, instances)

        adapter = ClaudeAgentAdapter(name="t")
        inp = make_input(
            thread_id="shared", messages=[{"id": "1", "role": "user", "content": "hi"}]
        )

        t1 = asyncio.create_task(_drive(adapter, inp))
        t2 = asyncio.create_task(_drive(adapter, inp))
        await asyncio.gather(t1, t2)

        entry = adapter._workers["shared"]
        worker = entry["worker"]
        assert entry["active_runs"] == 0
        assert isinstance(worker, SessionWorker)
        assert worker.is_alive() is True  # idle but still alive until evicted

        # Cleanly evict: the real worker's background task stops and the real
        # client is disconnected — proving full lifecycle teardown, not a fake.
        await adapter.clear_session("shared")
        assert "shared" not in adapter._workers
        assert worker.is_alive() is False
        assert instances[0].disconnected is True
