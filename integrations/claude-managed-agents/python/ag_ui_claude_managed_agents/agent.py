"""ManagedAgentsAgent: an AG-UI agent backed by Claude Managed Agents."""

import asyncio
from collections.abc import AsyncIterator, Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, ClassVar, Literal

from ag_ui.core import (
    BaseEvent,
    CustomEvent,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
    StateSnapshotEvent,
)
from anthropic import AsyncAnthropic

from ._util import get, maybe_await, report_swallowed_failure, schedule_detached
from .constants import BEST_EFFORT_SEND_TIMEOUT_S, DEFAULT_TURN_TIMEOUT_S
from .sessions import InMemorySessionStore
from .tools import custom_tool_from, normalize_tool_name, tools_fingerprint
from .turn import Emit, run_turn
from .types import (
    BackendTool,
    ErrorHandler,
    SessionRecord,
    SessionStore,
    TurnOutcome,
)

_DONE = object()

NO_OVERRIDES_FINGERPRINT = tools_fingerprint([])
"""The fingerprint stored for a session created without custom tools, i.e. one
that runs the managed agent as-is with no override list."""

RUN_FAILED_MESSAGE = "The run failed."
"""The only thing a client is told about a failure this integration did not author.

An SDK, session-store or API exception can carry session ids, request paths,
backend hostnames or credentials, and the AG-UI client is not necessarily a
trusted operator surface -- so the cause goes to `on_error` and the client gets
this plus the machine-readable `code`.
"""


def _user_text(message: Any) -> str:
    """The text of a user message (string content or multimodal parts).

    Non-text parts (images, documents) are dropped: a message carrying only
    those has no text and errors as an empty run.
    """
    content = getattr(message, "content", None)
    if isinstance(content, str):
        return content
    parts: list[str] = []
    for part in content or []:
        text = getattr(part, "text", None)
        if isinstance(text, str):
            parts.append(text)
    return "".join(parts)


@dataclass
class _Outbound:
    events: list[dict[str, Any]] = field(default_factory=list)
    still_parked: list[str] = field(default_factory=list)
    last_user_message_id: str | None = None


@dataclass
class _RunState:
    session_id: str | None = None
    busy_key: str | None = None
    """The busy-thread gate this run holds, released when the run unwinds."""
    terminated: bool = False
    """Whether a terminal event (RUN_ERROR or RUN_FINISHED) was already emitted."""
    record: SessionRecord | None = None
    """This thread's record, so teardown can reconcile it after an interrupt."""
    store_key: str | None = None


class ManagedAgentsAgent:
    """An AG-UI agent backed by Claude Managed Agents.

    Each AG-UI thread maps to one managed session; each run drives one turn
    of that session.
    """

    # Keyed by session-store identity: the store is the unit of tenancy, so
    # agents sharing a store serialize runs per thread (even across instances),
    # while per-caller stores keep one caller's runs from blocking another's.
    # Keys within a store's set are scoped to the managed agent.
    _busy_threads: ClassVar[dict[int, set[str]]] = {}

    def __init__(
        self,
        *,
        managed_agent_id: str,
        environment_id: str,
        agent_version: int | None = None,
        client: AsyncAnthropic | None = None,
        session_store: SessionStore | None = None,
        backend_tools: list[BackendTool] | None = None,
        session_title: Callable[[str], str] | None = None,
        vault_ids: Sequence[str] | None = None,
        tool_confirmation: Literal["allow", "deny"] | None = None,
        turn_timeout_s: float = DEFAULT_TURN_TIMEOUT_S,
        stream_deltas: bool = True,
        on_error: ErrorHandler | None = None,
    ) -> None:
        self.managed_agent_id = managed_agent_id
        self.environment_id = environment_id
        self.agent_version = agent_version
        self.client = client if client is not None else AsyncAnthropic()
        self.store: SessionStore = (
            session_store if session_store is not None else InMemorySessionStore()
        )
        # Keyed by normalized name; on a normalized-name collision (e.g. "search
        # web" and "search_web") the last tool wins.
        self.backend_tools: dict[str, BackendTool] = {
            normalize_tool_name(tool.name): tool for tool in backend_tools or []
        }
        self.session_title = session_title
        # Vault ids (`vlt_...`) for stored credentials the agent may use, attached
        # to each session this agent creates. Required for MCP servers that
        # authenticate; the API only accepts them at session creation, so changing
        # them takes effect on new threads.
        self.vault_ids = list(vault_ids or [])
        self.tool_confirmation = tool_confirmation
        self.turn_timeout_s = turn_timeout_s
        self.stream_deltas = stream_deltas
        self.on_error = on_error
        # Strong references to in-flight worker tasks so they are not collected.
        self._tasks: set[asyncio.Task[None]] = set()

    async def run(self, input: RunAgentInput) -> AsyncIterator[BaseEvent]:  # noqa: A002 - matches AG-UI adapters
        """Run one turn for `input`, yielding AG-UI events."""
        queue: asyncio.Queue[Any] = asyncio.Queue()
        state = _RunState()
        emit = self._single_terminal_emit(queue.put_nowait, state, input.thread_id)
        worker = asyncio.create_task(self._drive(input, emit, state))
        self._tasks.add(worker)
        worker.add_done_callback(self._tasks.discard)
        worker.add_done_callback(lambda _task: queue.put_nowait(_DONE))
        try:
            while True:
                item = await queue.get()
                if item is _DONE:
                    return
                yield item
        finally:
            # The client went away (or iteration stopped): cancel the turn,
            # which interrupts the session.
            if not worker.done():
                worker.cancel()

    def _single_terminal_emit(
        self, emit: Emit, state: _RunState, thread_id: str
    ) -> Emit:
        """Wrap `emit` so the run emits exactly one terminal event.

        Something failing after the turn already reported an outcome — a session
        store that rejects the closing write, say — must not append a second
        RUN_ERROR behind a RUN_ERROR or a RUN_FINISHED. The dropped error still
        reaches the error hook so it is not lost.
        """

        def guarded(event: BaseEvent) -> None:
            if isinstance(event, (RunErrorEvent, RunFinishedEvent)):
                if state.terminated:
                    if isinstance(event, RunErrorEvent):
                        # A sync frame (the emit gate), so the hook is scheduled
                        # rather than awaited; `report_swallowed_failure` keeps
                        # its failure from surfacing anywhere.
                        schedule_detached(
                            report_swallowed_failure(
                                self.on_error,
                                "dropped_terminal_event",
                                RuntimeError(event.message),
                                thread_id=thread_id,
                            )
                        )
                    return
                state.terminated = True
            emit(event)

        return guarded

    async def _drive(self, input: RunAgentInput, emit: Emit, state: _RunState) -> None:  # noqa: A002
        try:
            # `asyncio.timeout` rather than `wait_for` so `expired()` can tell
            # this deadline apart from an inner bounded operation that timed out
            # on its own: both raise TimeoutError, but only one of them means
            # the turn ran past its configured limit.
            async with asyncio.timeout(self.turn_timeout_s) as turn_deadline:
                await self._run_turn_for_input(input, emit, state)
        except asyncio.TimeoutError as timeout_error:
            if not turn_deadline.expired():
                # An inner bounded operation (a best-effort send) timed out.
                # Report that, not the turn limit it never reached.
                await self._report(
                    "run_failed", timeout_error, thread_id=input.thread_id
                )
                emit(
                    RunErrorEvent(
                        message=(
                            "An operation timed out before the turn completed:"
                            f" {BEST_EFFORT_SEND_TIMEOUT_S:g}s bound exceeded."
                        ),
                        code="run_failed",
                    )
                )
                return
            if await self._interrupt(state.session_id):
                await self._forget_parked_calls(state)
            emit(
                RunErrorEvent(
                    message=(
                        f"The turn exceeded the {self.turn_timeout_s:g}s limit"
                        " and was interrupted."
                    ),
                    code="turn_timeout",
                )
            )
        except asyncio.CancelledError:
            # Client disconnected mid-turn: stop the session; there is nobody
            # left to tell. This runs before the busy gate is released (see
            # `finally`), so a user who resends right away is not interrupted
            # by this late stop.
            if await self._interrupt(state.session_id):
                await self._forget_parked_calls(state)
            raise
        except Exception as err:  # noqa: BLE001 - surfaced to the client as RUN_ERROR
            # Detail to the hook, not to the client: see RUN_FAILED_MESSAGE.
            await self._report("run_failed", err, thread_id=input.thread_id)
            emit(RunErrorEvent(message=RUN_FAILED_MESSAGE, code="run_failed"))
        finally:
            # Release the per-thread gate only after any interrupt above has
            # been posted, never before.
            if state.busy_key is not None:
                busy = ManagedAgentsAgent._busy_threads.get(id(self.store))
                if busy is not None:
                    busy.discard(state.busy_key)
                    if not busy:
                        del ManagedAgentsAgent._busy_threads[id(self.store)]

    async def _interrupt(self, session_id: str | None) -> bool:
        """Stop the session best-effort, reporting whether it landed."""
        if not session_id:
            return False
        try:
            # Bounded: this runs while the busy gate is still held, so a
            # stalled send must not block the thread's later runs.
            await asyncio.wait_for(
                self.client.beta.sessions.events.send(
                    session_id, events=[{"type": "user.interrupt"}]
                ),
                BEST_EFFORT_SEND_TIMEOUT_S,
            )
        except Exception as exc:  # noqa: BLE001 - best-effort interrupt
            await self._report("interrupt", exc, session_id=session_id)
            return False
        return True

    async def _forget_parked_calls(self, state: _RunState) -> None:
        """Drop the parked tool calls recorded for this thread, because the
        session was interrupted and will never answer them.

        A thrown or timed-out turn never reaches `_record_outcome`, so the
        teardown paths reconcile here. Best-effort: the run is already ending,
        and a store that refuses the write must not replace the error that got
        us here.
        """
        record, store_key = state.record, state.store_key
        if record is None or store_key is None:
            return
        if not record.pending_client_tool_use_ids:
            return
        record.pending_client_tool_use_ids = []
        try:
            await maybe_await(self.store.set(store_key, record))
        except Exception as exc:  # noqa: BLE001 - best-effort; the run is already ending
            await self._report(
                "forget_parked_calls", exc, session_id=state.session_id
            )

    async def _report(
        self, operation: str, error: BaseException, **ids: Any
    ) -> None:
        """Report a swallowed failure.

        A broken hook must not break the run; an async hook is awaited so its
        telemetry actually runs. See `report_swallowed_failure`.
        """
        await report_swallowed_failure(self.on_error, operation, error, **ids)

    async def _run_turn_for_input(
        self, input: RunAgentInput, emit: Emit, state: _RunState
    ) -> None:  # noqa: A002
        # RunAgentInput is not validated at runtime; a body without `messages`
        # or `tools` must read as an empty run, not an AttributeError surfaced
        # as `run_failed`. `tools` was already defended at each use site; this
        # covers `messages` the same way, matching the TypeScript reference.
        if getattr(input, "messages", None) is None:
            input = input.model_copy(update={"messages": []})
        thread_id, run_id = input.thread_id, input.run_id
        # One key for the session store and the busy-run gate, so a stored
        # session and the gate that serializes access to it cannot disagree.
        store_key = self._session_key(thread_id)
        emit(RunStartedEvent(thread_id=thread_id, run_id=run_id))
        if input.state is not None:
            emit(StateSnapshotEvent(snapshot=input.state))

        # A blank thread id is not a thread: every caller that omitted one would
        # share a single key, and so a single managed session and its history.
        if not isinstance(thread_id, str) or not thread_id.strip():
            emit(
                RunErrorEvent(
                    message="This run has no thread id. Every run must carry a non-empty threadId.",
                    code="invalid_thread_id",
                )
            )
            return

        if store_key in ManagedAgentsAgent._busy_threads.get(id(self.store), ()):
            emit(
                RunErrorEvent(
                    message="A run is already in progress on this thread.",
                    code="run_in_progress",
                )
            )
            return
        # Check for something sendable before touching the API, so a malformed
        # run does not create an orphan session.
        if not self._has_sendable_content(input.messages):
            emit(
                RunErrorEvent(
                    message="There is nothing to send: this run has no user message or tool result.",
                    code="empty_run",
                )
            )
            return

        # Hold the per-thread gate for the rest of the run; `_drive` releases
        # it after any interrupt has been posted.
        ManagedAgentsAgent._busy_threads.setdefault(id(self.store), set()).add(store_key)
        state.busy_key = store_key

        record = await self._get_or_create_session(store_key, thread_id, input, emit)
        if record is None:
            emit(
                RunErrorEvent(
                    message="There is nothing to send: a tool result arrived for a thread with no session.",
                    code="tool_result_without_session",
                )
            )
            return
        state.session_id = record.session_id
        state.record = record
        state.store_key = store_key
        await self._sync_client_tools(record, input.tools or [])

        outbound = self._outbound_events(record, input.messages)
        if not outbound.events:
            emit(
                RunErrorEvent(
                    message="There is nothing new to send: no user message or tool result in this run.",
                    code="nothing_to_send",
                )
            )
            return

        # Some parked tool calls are still unanswered: post what we have and
        # stay parked instead of waiting on a session that will not resume.
        if outbound.still_parked:
            await self.client.beta.sessions.events.send(
                record.session_id, events=outbound.events
            )
            record.pending_client_tool_use_ids = outbound.still_parked
            record.last_user_message_id = (
                outbound.last_user_message_id or record.last_user_message_id
            )
            await maybe_await(self.store.set(store_key, record))
            emit(RunFinishedEvent(thread_id=thread_id, run_id=run_id))
            return

        # Persist each delivery as soon as it lands, so a failure or
        # interruption later in the turn does not re-post it next run: the
        # tool results resume the session even if the follow-ups then fail.
        async def on_results_sent() -> None:
            record.pending_client_tool_use_ids = []
            await maybe_await(self.store.set(store_key, record))

        async def on_follow_ups_sent() -> None:
            if outbound.last_user_message_id:
                record.last_user_message_id = outbound.last_user_message_id
            await maybe_await(self.store.set(store_key, record))

        async def on_client_park(tool_use_id: str) -> None:
            # Persist a park the moment the call is handed to the UI. A later
            # event can fail the turn before the session confirms the park, and
            # the remote session would then wait on an ID nothing remembers.
            if tool_use_id in record.pending_client_tool_use_ids:
                return
            record.pending_client_tool_use_ids = [
                *record.pending_client_tool_use_ids,
                tool_use_id,
            ]
            await maybe_await(self.store.set(store_key, record))

        outcome = await run_turn(
            client=self.client,
            session_id=record.session_id,
            outbound=outbound.events,
            on_results_sent=on_results_sent,
            on_follow_ups_sent=on_follow_ups_sent,
            on_client_park=on_client_park,
            client_tools=self._client_tools(input.tools or []),
            backend_tools=self.backend_tools,
            tool_confirmation=self.tool_confirmation,
            stream_deltas=self.stream_deltas,
            on_error=self.on_error,
            emit=emit,
        )

        await self._record_outcome(store_key, record, outcome)
        if outcome.status != "errored":
            emit(RunFinishedEvent(thread_id=thread_id, run_id=run_id))

    def _client_tools(self, client_tools: Sequence[Any]) -> dict[str, str]:
        """Normalized frontend tool name -> its original AG-UI name.

        On a normalized-name collision the last tool wins.
        """
        return {normalize_tool_name(tool.name): tool.name for tool in client_tools}

    def _has_sendable_content(self, messages: Sequence[Any]) -> bool:
        """Whether the run carries a user message with text or a tool result."""
        for message in messages:
            role = getattr(message, "role", None)
            if role == "tool":
                return True
            if role == "user" and _user_text(message).strip():
                return True
        return False

    def _session_key(self, thread_id: str) -> str:
        """The key that identifies this thread's state, in the session store and
        in the busy-run gate alike, so two agents sharing one store neither adopt
        each other's sessions nor serialize against each other's threads.

        Every field baked into the remote session at creation is part of the key:
        none of them can be re-checked or changed on resume, so an agent must
        never inherit a session created with a different environment, pinned
        version or vault set. Each is length-prefixed so no two combinations can
        collide -- plain concatenation would let a `managed_agent_id` of
        "support:beta" with thread "t1" and one of "support" with thread
        "beta:t1" share one record. The thread id is last, so it needs no prefix
        and may contain anything.
        """

        def field(value: str) -> str:
            return f"{len(value)}:{value}|"

        return (
            field(self.managed_agent_id)
            + field("" if self.agent_version is None else str(self.agent_version))
            + field(self.environment_id)
            # Sorted: the same vaults in a different order are the same session.
            + field(",".join(sorted(self.vault_ids)))
            + thread_id
        )

    async def _record_outcome(
        self, store_key: str, record: SessionRecord, outcome: TurnOutcome
    ) -> None:
        """Reconcile the record with how the turn ended.

        An errored turn keeps whatever `on_client_park` already persisted: the
        remote session is still parked on those calls and the next run has to
        answer them.
        """
        if outcome.status == "errored":
            if outcome.session_ended:
                await maybe_await(self.store.delete(store_key))
            elif outcome.session_interrupted:
                # An interrupt that landed cancelled whatever the session was
                # waiting on, so a park recorded during this turn is no longer
                # answerable: posting a result for it next run is rejected as
                # stale and wedges the thread.
                record.pending_client_tool_use_ids = []
                await maybe_await(self.store.set(store_key, record))
            return
        if outcome.status == "parked":
            record.pending_client_tool_use_ids = list(outcome.client_tool_use_ids)
            await maybe_await(self.store.set(store_key, record))
            return
        # The session went idle on end_turn: nothing is awaited any more.
        if record.pending_client_tool_use_ids:
            record.pending_client_tool_use_ids = []
            await maybe_await(self.store.set(store_key, record))

    def _outbound_events(
        self, record: SessionRecord, messages: Sequence[Any]
    ) -> _Outbound:
        """Work out what to post into the session for this run: results for any
        tool calls the frontend was asked to run, plus every user message not
        yet delivered (in order).
        """
        events: list[dict[str, Any]] = []
        pending = list(record.pending_client_tool_use_ids)

        for message in messages:
            if getattr(message, "role", None) != "tool":
                continue
            tool_call_id = getattr(message, "tool_call_id", None)
            if tool_call_id not in pending:
                continue
            error_text = getattr(message, "error", None)
            result_text = "\n".join(
                part for part in (message.content or "", error_text or "") if part
            )
            events.append(
                {
                    "type": "user.custom_tool_result",
                    "custom_tool_use_id": tool_call_id,
                    "content": [{"type": "text", "text": result_text}],
                    "is_error": bool(error_text),
                }
            )
            pending.remove(tool_call_id)

        # User messages after the last delivered one; on first contact, just the newest.
        last_user_message_id: str | None = None
        user_messages = [
            message for message in messages if getattr(message, "role", None) == "user"
        ]
        delivered_index = next(
            (
                i
                for i, message in enumerate(user_messages)
                if message.id == record.last_user_message_id
            ),
            -1,
        )
        undelivered = (
            user_messages[delivered_index + 1 :]
            if delivered_index >= 0
            else user_messages[-1:]
        )
        for message in undelivered:
            text = _user_text(message).strip()
            if not text:
                continue
            events.append(
                {"type": "user.message", "content": [{"type": "text", "text": text}]}
            )
            last_user_message_id = message.id

        # The user moved on without answering the tools the frontend was asked
        # to run: fail those calls so the agent can respond to the new message.
        if last_user_message_id is not None and pending:
            abandoned = [
                {
                    "type": "user.custom_tool_result",
                    "custom_tool_use_id": tool_use_id,
                    "content": [
                        {
                            "type": "text",
                            "text": "The user did not provide a result for this tool call.",
                        }
                    ],
                    "is_error": True,
                }
                for tool_use_id in pending
            ]
            events[:0] = abandoned
            pending.clear()

        return _Outbound(
            events=events,
            still_parked=pending,
            last_user_message_id=last_user_message_id,
        )

    async def _get_or_create_session(
        self, store_key: str, thread_id: str, input: RunAgentInput, emit: Emit
    ) -> SessionRecord | None:  # noqa: A002
        existing = await maybe_await(self.store.get(store_key))
        if existing is not None:
            return existing

        # A tool result only answers a pending call on an existing session;
        # never create a session to receive one.
        if not any(
            getattr(m, "role", None) == "user" and _user_text(m).strip()
            for m in input.messages
        ):
            return None

        # The busy-thread gate serializes runs per thread, so creation cannot race.
        record = await self._create_session(thread_id, input.tools or [])
        await maybe_await(self.store.set(store_key, record))
        emit(
            CustomEvent(
                name="managed_agents.session",
                value={"sessionId": record.session_id, "threadId": thread_id},
            )
        )
        return record

    async def _create_session(
        self, thread_id: str, client_tools: Sequence[Any]
    ) -> SessionRecord:
        custom_tools = self._custom_tools(client_tools)
        title = (
            self.session_title(thread_id)
            if self.session_title
            else f"AG-UI thread {thread_id}"
        )

        # An empty custom list means no overrides at all: the session runs the
        # agent as-is, so Console edits to its tools apply without an update
        # from here.
        registered: list[Any] = (
            await self._merged_tools(custom_tools) if custom_tools else []
        )
        agent: dict[str, Any]
        if not custom_tools:
            agent = {"type": "agent", "id": self.managed_agent_id}
            if self.agent_version is not None:
                agent["version"] = self.agent_version
        else:
            agent = {"type": "agent_with_overrides", "id": self.managed_agent_id}
            if self.agent_version is not None:
                agent["version"] = self.agent_version
            # Overrides replace the tool list, so keep the agent's own tools.
            agent["tools"] = registered

        create_kwargs: dict[str, Any] = {
            "agent": agent,
            "environment_id": self.environment_id,
            "title": title,
        }
        if self.vault_ids:
            create_kwargs["vault_ids"] = list(self.vault_ids)
        session = await self.client.beta.sessions.create(**create_kwargs)
        return SessionRecord(
            session_id=session.id,
            tool_names=[tool["name"] for tool in custom_tools],
            tool_definitions_fingerprint=tools_fingerprint(registered),
        )

    def _custom_tools(self, client_tools: Sequence[Any]) -> list[dict[str, Any]]:
        """Frontend tools plus configured backend tools, as custom tool definitions.

        Keyed by normalized name. Distinct names that normalize alike never
        raise: the last one wins, and a frontend tool beats a backend tool with
        the same normalized name, matching dispatch order in the turn loop.
        """
        by_name: dict[str, dict[str, Any]] = {}
        for name, tool in self.backend_tools.items():
            by_name[name] = custom_tool_from(tool)
        for tool in client_tools:
            custom = custom_tool_from(tool)
            by_name[custom["name"]] = custom
        return list(by_name.values())

    async def _sync_client_tools(
        self, record: SessionRecord, client_tools: Sequence[Any]
    ) -> None:
        """Keep the session's full replacement tool list aligned with this run.

        The fingerprint covers the merged list, not just the custom tools: an
        override session's list is a full replacement frozen at the last update,
        so editing the agent's own tools in the Console changes what the session
        should hold while every custom tool stays identical. Comparing custom
        tools alone declared that a match and left the session on a stale list
        indefinitely.

        The cost is re-reading the agent's tools once per run for a session that
        uses overrides. A session with no custom tools runs the agent as-is,
        needs no update, and is short-circuited before that read.
        """
        desired = self._custom_tools(client_tools)
        if not desired and record.tool_definitions_fingerprint == NO_OVERRIDES_FINGERPRINT:
            return

        # Note this still merges when `desired` is empty but the session does
        # have an override list: it must be replaced with the agent's own tools,
        # not emptied.
        registered = await self._merged_tools(desired)
        fingerprint = tools_fingerprint(registered)
        if record.tool_definitions_fingerprint == fingerprint:
            return
        await self.client.beta.sessions.update(
            record.session_id, agent={"tools": registered}
        )
        record.tool_names = [tool["name"] for tool in desired]
        record.tool_definitions_fingerprint = fingerprint

    async def _merged_tools(self, custom_tools: list[dict[str, Any]]) -> list[Any]:
        """The agent's own tools plus custom tools, without duplicate names.

        Overrides replace the whole list, so the agent's tools are carried
        along, but a custom tool of the same name wins over the agent's copy.
        """
        names = {tool["name"] for tool in custom_tools}
        base = [
            tool
            for tool in await self._base_tools()
            if get(tool, "type") != "custom" or get(tool, "name") not in names
        ]
        return [*base, *custom_tools]

    async def _base_tools(self) -> list[Any]:
        """The tools defined on the managed agent itself, fetched fresh so console edits apply."""
        if self.agent_version is not None:
            agent = await self.client.beta.agents.retrieve(
                self.managed_agent_id, version=self.agent_version
            )
        else:
            agent = await self.client.beta.agents.retrieve(self.managed_agent_id)
        # The read shape is structurally compatible with the params shape.
        return list(getattr(agent, "tools", None) or [])
