"""Claude Agent SDK adapter for AG-UI protocol."""

import asyncio
import os
import logging
import json
import uuid
from datetime import datetime
from typing import AsyncIterator, Optional, List, Dict, Any, Union, TYPE_CHECKING

from ag_ui.core import (
    EventType,
    RunAgentInput,
    BaseEvent,
    AssistantMessage as AguiAssistantMessage,
    ToolCall as AguiToolCall,
    FunctionCall as AguiFunctionCall,
    RunStartedEvent,
    RunFinishedEvent,
    RunErrorEvent,
    TextMessageStartEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    ToolCallStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    StateSnapshotEvent,
    MessagesSnapshotEvent,
    CustomEvent,
    ReasoningStartEvent,
    ReasoningMessageStartEvent,
    ReasoningMessageContentEvent,
    ReasoningMessageEndEvent,
    ReasoningEndEvent,
    ReasoningEncryptedValueEvent,
)

if TYPE_CHECKING:
    from claude_agent_sdk import ClaudeAgentOptions

from .utils import (
    build_state_context_addendum,
    convert_agui_tool_to_claude_sdk,
    create_state_management_tool,
    apply_forwarded_props,
    extract_tool_names,
    strip_mcp_prefix,
    build_agui_assistant_message,
    build_agui_tool_message,
    _is_state_management_tool,
    fix_surrogates,
    fix_surrogates_deep,
)
from .config import (
    ALLOWED_FORWARDED_PROPS,
    STATE_MANAGEMENT_TOOL_FULL_NAME,
    AG_UI_MCP_SERVER_NAME,
)
from .handlers import (
    handle_tool_use_block,
    handle_tool_result_block,
)
from .session import SessionWorker

logger = logging.getLogger(__name__)

if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s'))
    logger.addHandler(handler)
    logger.setLevel(getattr(logging, os.getenv("LOGLEVEL", "INFO").upper(), logging.INFO))


class ClaudeAgentAdapter:
    """
    AG-UI adapter for the Anthropic Claude Agent SDK.
    
    Manages the SDK client lifecycle internally via per-thread session workers.
    Call ``run(input_data)`` to get an async iterator of AG-UI events.
    """

    def __init__(
        self,
        name: str,
        options: Union["ClaudeAgentOptions", dict, None] = None,
        description: str = "",
        max_workers: int = 1000,
        worker_ttl_seconds: float = 1800,   # 30 min
        query_timeout_seconds: Optional[float] = 300,   # 5 min; bounds a hung/slow worker
    ):
        self.name = name
        self.description = description
        self._options = options
        self._max_workers = max_workers
        self._worker_ttl_seconds = worker_ttl_seconds
        self._query_timeout_seconds = query_timeout_seconds
        # thread_id -> {"worker": SessionWorker, "last_used": datetime, "active": bool, "active_runs": int}
        self._workers: Dict[str, Dict] = {}
        self._state_locks: Dict[str, asyncio.Lock] = {}
        # Per-thread RUN-ADMISSION lock. This is a SEPARATE lock from
        # ``_state_locks`` on purpose: ``_state_locks[thread_id]`` is acquired
        # mid-stream by the state-management-tool path (``async with lock:`` in
        # ``_stream_claude_sdk``), and ``asyncio.Lock`` is non-reentrant, so
        # reusing it for run admission would self-deadlock the instant the model
        # emits a state-update tool call. Lock ordering is fixed: the run-lock is
        # OUTERMOST (acquired at admission, before streaming / before
        # RUN_STARTED) and the state-lock is INNERMOST (acquired only mid-stream).
        # No path may hold ``_state_locks`` then wait on ``_run_locks``.
        self._run_locks: Dict[str, asyncio.Lock] = {}
        self._per_thread_state: Dict[str, Any] = {}  # thread_id -> current state
        # Per-RUN result keyed by (thread_id, run_id). ``RUN_FINISHED.result`` is
        # per-run by definition, so it must not share a per-thread slot that a
        # concurrent/serialized peer run could clobber.
        self._per_run_result: Dict[tuple, Any] = {}  # (thread_id, run_id) -> result data
        # Strong references to fire-and-forget cleanup tasks (e.g. worker.stop()
        # during eviction). Without this the only reference is local and the
        # event loop keeps only a weak reference, so a pending stop task can be
        # garbage-collected mid-flight before the worker actually shuts down.
        # We discard each task from the set when it completes. (Item 7)
        self._pending_tasks: set = set()

    def _spawn_cleanup_task(self, coro) -> "asyncio.Task":
        """Schedule a fire-and-forget cleanup coroutine, retaining a strong
        reference until it completes so it cannot be GC'd mid-flight."""
        task = asyncio.create_task(coro)
        self._pending_tasks.add(task)

        def _done(t: "asyncio.Task") -> None:
            self._pending_tasks.discard(t)
            if t.exception() is not None:
                logger.warning(f"Worker eviction error: {t.exception()}")

        task.add_done_callback(_done)
        return task

    async def interrupt(self, thread_id: Optional[str] = None) -> None:
        """Interrupt the active query for a thread, or all workers if no thread specified."""
        if thread_id and thread_id in self._workers:
            await self._workers[thread_id]["worker"].interrupt()
        else:
            for entry in self._workers.values():
                await entry["worker"].interrupt()

    def _drop_thread_results(self, thread_id: str) -> None:
        """Drop every per-run result entry belonging to ``thread_id``.

        ``_per_run_result`` is keyed by ``(thread_id, run_id)``; thread-scoped
        cleanup (eviction / clear_session / error path) must purge all of a
        thread's run results, not a single run."""
        for key in [k for k in self._per_run_result if k[0] == thread_id]:
            self._per_run_result.pop(key, None)

    async def shutdown(self) -> None:
        """Gracefully stop all session workers. Call on server shutdown."""
        for entry in list(self._workers.values()):
            await entry["worker"].stop()
        self._workers.clear()
        self._state_locks.clear()
        # ``_run_locks`` is cleared ONLY here, on full adapter shutdown (no run
        # can be in-flight or waiting past this point); it is intentionally NOT
        # evicted per-thread — see ``_evict_workers`` for the rationale.
        self._run_locks.clear()
        self._per_run_result.clear()

    def _evict_workers(self) -> None:
        """Evict idle workers by TTL and LRU cap.

        IMPORTANT: ``_run_locks[tid]`` is deliberately NOT popped here (nor on
        ``clear_session`` / the run error path). The run-admission lock's
        lifecycle is run SERIALIZATION, which must stay decoupled from
        worker-cache eviction. Popping it opens an orphan race: a run B parked on
        ``await run_lock.acquire()`` in the window after run A released the lock
        (worker now idle, active_runs==0) but before B wakes can have its lock
        entry popped by eviction; a later run D then ``setdefault``s a FRESH lock
        and runs CONCURRENTLY with B — serialization defeated. Re-validating
        identity after acquire (in ``run``) is not sufficient alone, because a
        held/waited lock can still be popped and re-created. So we leave run-lock
        entries resident. Only ``_run_locks`` is exempt from eviction here:
        ``_state_locks`` IS still popped (below), because it is acquired only
        mid-stream UNDER the run-lock, so a live run always holds the run-lock
        while touching it and it can never be orphaned by eviction. This is
        bounded by the number of distinct ``thread_id``
        values seen (each maps to one tiny ``asyncio.Lock``); a future
        ``ThreadContext`` unification (one record per thread owning worker + all
        locks + state, reaped together) is the long-term home for bounding it —
        do NOT add a separate reaper here now.
        """
        now = datetime.now()
        # TTL eviction: remove idle workers older than TTL
        to_remove = [
            tid for tid, entry in self._workers.items()
            if not entry["active"] and (now - entry["last_used"]).total_seconds() > self._worker_ttl_seconds
        ]
        for tid in to_remove:
            entry = self._workers.pop(tid)
            self._spawn_cleanup_task(entry["worker"].stop())
            self._state_locks.pop(tid, None)
            self._per_thread_state.pop(tid, None)
            self._drop_thread_results(tid)

        # LRU eviction: if still over cap, remove oldest idle entries
        while len(self._workers) > self._max_workers:
            idle = [(tid, e) for tid, e in self._workers.items() if not e["active"]]
            if not idle:
                break
            oldest_tid = min(idle, key=lambda x: x[1]["last_used"])[0]
            entry = self._workers.pop(oldest_tid)
            self._spawn_cleanup_task(entry["worker"].stop())
            self._state_locks.pop(oldest_tid, None)
            self._per_thread_state.pop(oldest_tid, None)
            self._drop_thread_results(oldest_tid)

    async def clear_session(self, thread_id: str) -> None:
        """Stop and remove the session worker for a thread."""
        entry = self._workers.pop(thread_id, None)
        if entry:
            await entry["worker"].stop()
        self._state_locks.pop(thread_id, None)
        # see _evict_workers: _run_locks intentionally not evicted (only full
        # ``shutdown`` clears the map).
        self._per_thread_state.pop(thread_id, None)
        self._drop_thread_results(thread_id)

    async def run(self, input_data: RunAgentInput) -> AsyncIterator[BaseEvent]:
        """Run the agent and yield AG-UI events."""
        from .utils import process_messages

        thread_id = input_data.thread_id or str(uuid.uuid4())
        run_id = input_data.run_id or str(uuid.uuid4())
        result_key = (thread_id, run_id)

        # ── Run-admission serialization (Fix 1) ──
        # Acquire the per-thread RUN lock at admission — BEFORE worker.query() /
        # RUN_STARTED — and hold it across the WHOLE run, releasing in the
        # ``finally`` (and therefore on every ``except`` path too). Effect: a
        # second run on the same thread_id waits here until the first emits
        # RUN_FINISHED and releases; different thread_ids stay concurrent (the
        # lock is per-thread). This is a DISTINCT lock from ``_state_locks``
        # (acquired mid-stream on the state-update-tool path); reusing the
        # non-reentrant state-lock would self-deadlock. Lock ordering is fixed:
        # run-lock OUTERMOST, state-lock INNERMOST.
        # Acquire the CURRENT lock entry, then re-validate identity: if the entry
        # in ``_run_locks`` changed while we were parked (defense-in-depth against
        # any residual repopulation race — note eviction no longer pops the lock,
        # so this loop normally runs once), release the stale lock and retry on
        # the current one. Loop until we hold the lock that is actually the live
        # ``_run_locks[thread_id]``, so no two runs can ever hold "the" run-lock
        # for the same thread at once.
        while True:
            run_lock = self._run_locks.setdefault(thread_id, asyncio.Lock())
            await run_lock.acquire()
            if self._run_locks.get(thread_id) is run_lock:
                break
            # A different lock is now the live entry; we acquired a stale one.
            run_lock.release()

        # Re-seed per-thread state for THIS run, now that we hold the thread
        # exclusively. Fresh ``input_data.state`` REPLACES any prior thread state
        # (documented reset semantics); doing it under the run-lock keeps the
        # reset per-run rather than racing a peer's seed. ``_per_run_result`` is
        # keyed per-run so a serialized peer can never clobber it (Fix 4).
        self._per_thread_state[thread_id] = input_data.state
        self._per_run_result[result_key] = None

        # Set True only once this run has been counted into a worker's
        # ``active_runs`` refcount, so the ``finally`` block decrements exactly
        # the runs it incremented. The fail-loud dead-worker-with-live-peer path
        # below returns WITHOUT counting itself in, so it must leave this False
        # to avoid decrementing the peer's refcount. (Item 7a)
        counted_in = False

        try:
            # Get or create worker for this thread.
            # Guard against a poisoned cache entry: if a previously-cached
            # worker's background task has died (e.g. client.connect() failed),
            # reusing it would hang forever on a queue nothing drains. Evict the
            # dead worker and fall through to creating a fresh one.
            entry = self._workers.get(thread_id)
            if entry is not None and not entry["worker"].is_alive():
                if entry.get("active_runs", 0) > 0:
                    # DEFENSE-IN-DEPTH / UNREACHABLE under run-admission
                    # serialization (Fix 1): the per-thread run-lock admits one
                    # run at a time, so while THIS run holds the lock no peer run
                    # on the same thread can be mid-stream (``active_runs`` is
                    # per-thread and capped at 1). This branch is retained as a
                    # belt-and-suspenders guard in case that invariant is ever
                    # violated by a future change. If somehow a peer IS streaming
                    # on this (now-dead) worker, we are wedged between two
                    # unacceptable options:
                    #   * REUSE the dead worker — querying it would hang this
                    #     arriving run forever (the peer's exited run-loop will
                    #     never service our output queue).
                    #   * EVICT (pop+stop) the shared entry — that tears the
                    #     worker out from under the live peer (item-7 violation).
                    # So FAIL LOUD instead: surface a descriptive RunErrorEvent
                    # and stop, leaving the peer's entry (and its refcount)
                    # completely untouched. ``counted_in`` stays False so the
                    # ``finally`` block does NOT decrement the peer's refcount.
                    logger.error(
                        f"Worker for thread={thread_id} is dead but a peer run is "
                        f"still active (active_runs={entry.get('active_runs')}); "
                        f"failing this run loudly rather than reusing (hang risk) "
                        f"or evicting (would corrupt the live peer)"
                    )
                    yield RunErrorEvent(
                        type=EventType.RUN_ERROR,
                        thread_id=thread_id,
                        run_id=run_id,
                        message=(
                            f"cannot start run on thread {thread_id}: its worker "
                            f"has terminated while another run is still active"
                        ),
                    )
                    return
                else:
                    logger.warning(
                        f"Evicting dead worker for thread={thread_id} (task terminated); creating fresh worker"
                    )
                    dead_entry = self._workers.pop(thread_id, None)
                    if dead_entry is not None:
                        await dead_entry["worker"].stop()
                    self._state_locks.pop(thread_id, None)
                    entry = None

            if entry is None:
                options = self.build_options(input_data, thread_id=thread_id)
                worker = SessionWorker(thread_id, options)
                await worker.start()
                # ``active_runs`` is a refcount of in-flight run() invocations
                # sharing this worker. A plain ``active`` bool wedged on
                # concurrent reuse: the first run to finish flipped it False
                # while a second run was still streaming, making the worker
                # evictable mid-stream. The bool is kept (derived from the
                # count) for callers/tests that read it. (Item 7a)
                entry = {"worker": worker, "last_used": datetime.now(), "active": True, "active_runs": 1}
                self._workers[thread_id] = entry
                counted_in = True
                self._evict_workers()
                logger.debug(f"Created worker for thread={thread_id}")
            else:
                entry["active_runs"] = entry.get("active_runs", 0) + 1
                counted_in = True
                entry["active"] = True
                entry["last_used"] = datetime.now()
                worker = entry["worker"]
                logger.debug(f"Reusing worker for thread={thread_id}")

            prompt, _ = process_messages(input_data)
            message_stream = worker.query(prompt, session_id=thread_id)

            # Log parent_run_id if provided (for branching/time travel tracking)
            if input_data.parent_run_id:
                logger.debug(
                    f"Run {run_id[:8]}... is branched from parent run {input_data.parent_run_id[:8]}..."
                )
            
            # Emit RUN_STARTED
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=thread_id,
                run_id=run_id,
                parent_run_id=input_data.parent_run_id,
                input={
                    "thread_id": thread_id,
                    "run_id": run_id,
                    "parent_run_id": input_data.parent_run_id,
                    "messages": input_data.messages,
                    "tools": input_data.tools,
                    "state": input_data.state,
                    "context": input_data.context,
                    "forwarded_props": input_data.forwarded_props,
                }
            )
            
            # Extract frontend tool names for halt detection
            frontend_tool_names = set(extract_tool_names(input_data.tools)) if input_data.tools else set()
            if frontend_tool_names:
                logger.debug(f"Frontend tools detected: {frontend_tool_names}")
            
            # Emit initial state snapshot if provided
            if input_data.state is not None:
                yield StateSnapshotEvent(
                    type=EventType.STATE_SNAPSHOT,
                    snapshot=input_data.state
                )
            
            # Translate Claude SDK messages into AG-UI events
            if self._query_timeout_seconds:
                async with asyncio.timeout(self._query_timeout_seconds):
                    async for event in self._stream_claude_sdk(
                        message_stream, thread_id, run_id, input_data, frontend_tool_names
                    ):
                        yield event
            else:
                async for event in self._stream_claude_sdk(
                    message_stream, thread_id, run_id, input_data, frontend_tool_names
                ):
                    yield event
            
            # Terminal event — owned by run(), one per run. On a turn whose
            # ResultMessage carried is_error (API failure, #2145) RUN_ERROR
            # REPLACES RUN_FINISHED: AG-UI's verifyEvents rejects any event
            # after RUN_ERROR, so the two terminals are mutually exclusive,
            # matching the except paths below. The worker is NOT evicted here —
            # the stream completed cleanly, so the CLI session stays reusable
            # (unlike the exception paths).
            run_result = self._per_run_result.get(result_key) or {}
            if run_result.get("is_error"):
                api_error_status = run_result.get("api_error_status")
                logger.error(
                    f"Run {run_id} on thread={thread_id} ended with an API error"
                    + (f" (status {api_error_status})" if api_error_status is not None else "")
                )
                yield RunErrorEvent(
                    type=EventType.RUN_ERROR,
                    thread_id=thread_id,
                    run_id=run_id,
                    message=run_result.get("result") or "The run ended with an API error.",
                    code=str(api_error_status) if api_error_status is not None else None,
                )
            else:
                # Emit RUN_FINISHED — read THIS run's own result (keyed per-run,
                # so a serialized peer on the same thread cannot have clobbered
                # it). (Fix 4)
                yield RunFinishedEvent(
                    type=EventType.RUN_FINISHED,
                    thread_id=thread_id,
                    run_id=run_id,
                    result=self._per_run_result.get(result_key, None),
                )
            
        except asyncio.TimeoutError as e:
            logger.error(f"Query timeout in run for thread={thread_id}: {e}")
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                thread_id=thread_id,
                run_id=run_id,
                message=f"Query timed out after {self._query_timeout_seconds}s",
            )
        except Exception as e:
            logger.error(f"Error in run: {e}")
            # Evict the broken worker — but ONLY if this is the last in-flight run
            # sharing it. The ``active_runs > 1`` guard below is DEFENSE-IN-DEPTH /
            # UNREACHABLE under run-admission serialization (Fix 1): the per-thread
            # run-lock caps a thread's concurrent runs at 1, so when this run
            # errors there is no peer run still streaming on the same thread, and
            # the ``else`` branch (pop + stop the solo worker) is the live path.
            # The guard is retained so that, were serialization ever broken,
            # tearing the worker down here would not yank it out from under a peer;
            # instead we would leave the shared entry intact and let the
            # ``finally`` block decrement this run's refcount exactly once. (Item 7a)
            entry = self._workers.get(thread_id)
            if entry is not None and entry.get("active_runs", 1) > 1:
                logger.warning(
                    f"Run errored but a peer run is still active on thread={thread_id}; "
                    f"keeping shared worker (active_runs={entry.get('active_runs')})"
                )
            else:
                broken_entry = self._workers.pop(thread_id, None)
                if broken_entry:
                    await broken_entry["worker"].stop()
                self._state_locks.pop(thread_id, None)
                self._per_thread_state.pop(thread_id, None)
                self._drop_thread_results(thread_id)
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                thread_id=thread_id,
                run_id=run_id,
                message=str(e),
            )
        finally:
            # Only decrement if THIS run was counted into the refcount. The
            # fail-loud dead-worker-with-live-peer path returns early without
            # counting itself in (``counted_in`` stays False), so it must not
            # decrement — doing so would corrupt the live peer's refcount. (Item 7a)
            entry = self._workers.get(thread_id)
            if entry and counted_in:
                # Decrement the in-flight refcount. Under run-admission
                # serialization (Fix 1) ``active_runs`` for a given thread is
                # capped at 1, so this normally takes it 1 -> 0; the
                # multi-run-sharing semantics below are DEFENSE-IN-DEPTH for the
                # (now-unreachable) case of concurrent same-thread runs. As coded,
                # the worker only becomes idle (and thus evictable) once ALL runs
                # counted into it have finished, so a peer run could never be
                # evicted mid-stream even if serialization were bypassed. (Item 7a)
                remaining = entry.get("active_runs", 1) - 1
                entry["active_runs"] = max(remaining, 0)
                entry["active"] = entry["active_runs"] > 0
                entry["last_used"] = datetime.now()

            # Drop THIS run's result slot (per-run keyed; thread-scoped cleanup
            # paths above may already have purged it, hence pop with default).
            self._per_run_result.pop(result_key, None)

            # Release the run-admission lock on EVERY exit path (success, error,
            # timeout, and the fail-loud early return) so a waiting same-thread
            # run can proceed. We acquired it unconditionally before this try.
            run_lock.release()

    def build_options(self, input_data: Optional[RunAgentInput] = None, thread_id: Optional[str] = None) -> "ClaudeAgentOptions":
        """Build ClaudeAgentOptions from base config + RunAgentInput."""
        from claude_agent_sdk import ClaudeAgentOptions, create_sdk_mcp_server
        
        # Start with sensible defaults
        merged_kwargs: Dict[str, Any] = {
            "include_partial_messages": True,
            "stderr": lambda data: logger.debug(f"[Claude CLI stderr] {data.rstrip()}"),
        }
        
        # Merge in provided options
        if self._options is not None:
            if isinstance(self._options, dict):
                # Dict format - merge directly
                for key, value in self._options.items():
                    if value is not None:
                        merged_kwargs[key] = value
                           
            else:
                # ClaudeAgentOptions object - extract attributes
                # Try Pydantic v2 style first
                if hasattr(self._options, "model_dump"):
                    base_dict = self._options.model_dump(exclude_none=True)
                    merged_kwargs.update(base_dict)
                # Fall back to Pydantic v1 style
                elif hasattr(self._options, "dict"):
                    base_dict = self._options.dict(exclude_none=True)
                    merged_kwargs.update(base_dict)
                # Fall back to __dict__ for plain dataclasses/objects
                elif hasattr(self._options, "__dict__"):
                    for key, value in self._options.__dict__.items():
                        if not key.startswith("_") and value is not None:
                            merged_kwargs[key] = value
        logger.debug(f"Merged kwargs: {merged_kwargs}")
        
        # Append state and context to the system prompt (not the user message).
        if input_data:
            addendum = build_state_context_addendum(input_data)
            if addendum:
                base = merged_kwargs.get("system_prompt", "") or ""
                merged_kwargs["system_prompt"] = f"{base}\n\n{addendum}" if base else addendum
                logger.debug(f"Appended state/context ({len(addendum)} chars) to system_prompt")
        
        # Ensure ag_ui tools are always allowed (frontend tools + state management)
        if input_data and (input_data.state is not None or input_data.tools):
            allowed_tools = merged_kwargs.get("allowed_tools", [])
            tools_to_add = []
            
            # Add state management tool if state is provided
            if input_data.state is not None and STATE_MANAGEMENT_TOOL_FULL_NAME not in allowed_tools:
                tools_to_add.append(STATE_MANAGEMENT_TOOL_FULL_NAME)
            
            # Add frontend tools (prefixed with mcp__ag_ui__)
            if input_data.tools:
                for tool_name in extract_tool_names(input_data.tools):
                    prefixed_name = f"mcp__ag_ui__{tool_name}"
                    if prefixed_name not in allowed_tools:
                        tools_to_add.append(prefixed_name)
            
            if tools_to_add:
                merged_kwargs["allowed_tools"] = [*allowed_tools, *tools_to_add]
                logger.debug(f"Auto-granted permission to ag_ui tools: {tools_to_add}")
        
        # Remove api_key from options kwargs (handled via environment variable)
        merged_kwargs.pop("api_key", None)
        logger.debug(f"Merged kwargs after pop: {merged_kwargs}")
        
        # Apply forwarded_props as per-run overrides (before adding dynamic tools)
        if input_data and input_data.forwarded_props:
            merged_kwargs = apply_forwarded_props(
                input_data.forwarded_props, 
                merged_kwargs, 
                ALLOWED_FORWARDED_PROPS
            )
        
        # Add dynamic tools from input.tools and state management
        if input_data:
            # Get existing MCP servers
            existing_servers = merged_kwargs.get("mcp_servers", {})
            ag_ui_tools = []
            
            # Add frontend tools from input.tools
            if input_data.tools:
                logger.debug(f"Building dynamic MCP server with {len(input_data.tools)} frontend tools")
                
                for tool_def in input_data.tools:
                    try:
                        claude_tool = convert_agui_tool_to_claude_sdk(tool_def)
                        ag_ui_tools.append(claude_tool)
                    except Exception as e:
                        logger.warning(f"Failed to convert tool: {e}")
            
            # Add state management tool if state is provided
            if input_data.state is not None:
                logger.debug("Adding ag_ui_update_state tool for state management")
                state_tool = create_state_management_tool()
                ag_ui_tools.append(state_tool)
            
            # Create ag_ui MCP server if we have any tools
            if ag_ui_tools:
                ag_ui_server = create_sdk_mcp_server(
                    AG_UI_MCP_SERVER_NAME,
                    "1.0.0",
                    tools=ag_ui_tools
                )
                
                # Merge with existing servers
                merged_kwargs["mcp_servers"] = {
                    **existing_servers,
                    AG_UI_MCP_SERVER_NAME: ag_ui_server
                }
                
                # Get tool names safely (SdkMcpTool objects don't have __name__)
                tool_names = []
                for t in ag_ui_tools:
                    if hasattr(t, '__name__'):
                        tool_names.append(t.__name__)
                    elif hasattr(t, 'name'):
                        tool_names.append(t.name)
                    else:
                        tool_names.append(str(type(t).__name__))
                
                logger.debug(
                    f"Created ag_ui MCP server with {len(ag_ui_tools)} tools: {tool_names}"
                )
        
        
        # Guard against kwargs that are not valid ClaudeAgentOptions fields.
        # forwarded_props are whitelisted by NAME (ALLOWED_FORWARDED_PROPS), but
        # some whitelisted runtime controls (e.g. ``temperature``, ``max_tokens``)
        # are NOT ClaudeAgentOptions dataclass fields, so passing them straight
        # through would raise a TypeError at runtime and crash the whole run.
        # Drop unknown keys (with a warning) so an unexpected/forwarded prop can
        # never wedge a run. (Item 6)
        import dataclasses
        valid_fields = {f.name for f in dataclasses.fields(ClaudeAgentOptions)}
        unknown_keys = [k for k in merged_kwargs if k not in valid_fields]
        if unknown_keys:
            for k in unknown_keys:
                logger.warning(
                    f"Dropping unsupported ClaudeAgentOptions kwarg: {k!r} "
                    f"(not a valid option field)"
                )
                merged_kwargs.pop(k, None)

        logger.debug(f"Creating ClaudeAgentOptions with merged kwargs: {merged_kwargs}")
        return ClaudeAgentOptions(**merged_kwargs)

    async def _stream_claude_sdk(
        self,
        message_stream: Any,
        thread_id: str,
        run_id: str,
        input_data: RunAgentInput,
        frontend_tool_names: set[str],
    ) -> AsyncIterator[BaseEvent]:
        """Translate a Claude SDK message stream into AG-UI events."""
        # Per-run state (local to this invocation)
        current_message_id: Optional[str] = None
        in_reasoning_block: bool = False
        reasoning_message_id: Optional[str] = None
        has_streamed_text: bool = False
        unstreamed_fallback_ids: set[str] = set()

        # Tool call streaming state
        current_tool_call_id: Optional[str] = None
        current_tool_call_name: Optional[str] = None
        current_tool_display_name: Optional[str] = None
        accumulated_tool_json: str = ""
        
        # Track which tools we've already emitted START for (to avoid duplicates)
        processed_tool_ids: set = set()
        
        # Frontend tool halt flag
        halt_event_stream: bool = False
        
        # ── MESSAGES_SNAPSHOT accumulation ──
        run_messages: List[Any] = []
        pending_msg: Optional[Dict[str, Any]] = None
        accumulated_signature = ""

        def _get_msg_id(msg):
            """Extract message ID from either a dict or an object."""
            if isinstance(msg, dict):
                return msg.get("id")
            return getattr(msg, "id", None)

        def upsert_message(msg):
            """Upsert a message: replace if same ID exists, otherwise append."""
            msg_id = _get_msg_id(msg)
            if msg_id is not None:
                for i, m in enumerate(run_messages):
                    if _get_msg_id(m) == msg_id:
                        run_messages[i] = msg
                        return
            run_messages.append(msg)

        def flush_pending_msg():
            """Flush pendingMsg -> run_messages."""
            nonlocal pending_msg
            if pending_msg is None:
                return
            # Use explicit `is not None` checks — empty string "" is falsy but
            # a message with empty content and non-empty tool_calls is valid.
            has_content = pending_msg.get("content") is not None and pending_msg["content"] != ""
            has_tools = bool(pending_msg.get("tool_calls"))
            if has_content or has_tools:
                upsert_message(
                    AguiAssistantMessage(
                        id=pending_msg["id"],
                        role="assistant",
                        content=pending_msg["content"] if has_content else None,
                        tool_calls=pending_msg["tool_calls"] if has_tools else None,
                    )
                )
            pending_msg = None
        
        
        from claude_agent_sdk import (
            AssistantMessage,
            UserMessage,
            SystemMessage,
            ResultMessage,
            ToolUseBlock,
            ToolResultBlock,
        )
        from claude_agent_sdk.types import StreamEvent
        
        
        message_count = 0
        
        async for message in message_stream:
            message_count += 1
            
            # If we've halted due to frontend tool, break out of loop
            if halt_event_stream:
                logger.debug(f"[Message #{message_count}]: Halted - breaking stream loop")
                break
            
            logger.debug(f"[Message #{message_count}]: {type(message).__name__}")
            
            # Handle StreamEvent for real-time streaming chunks
            if isinstance(message, StreamEvent):
                event_data = message.event
                event_type = event_data.get('type')
                
                if event_type == 'message_start':
                    current_message_id = str(uuid.uuid4())
                    has_streamed_text = False
                    pending_msg = {"id": current_message_id, "content": "", "tool_calls": []}
                
                elif event_type == 'content_block_delta':
                    delta_data = event_data.get('delta', {})
                    delta_type = delta_data.get('type', '')
                    
                    if delta_type == 'text_delta':
                        text_chunk = fix_surrogates(delta_data.get('text', ''))
                        if text_chunk and current_message_id:
                            if not has_streamed_text:
                                yield TextMessageStartEvent(
                                    type=EventType.TEXT_MESSAGE_START,
                                    thread_id=thread_id,
                                    run_id=run_id,
                                    message_id=current_message_id,
                                    role="assistant",
                                )
                            has_streamed_text = True
                            if pending_msg is not None:
                                pending_msg["content"] += text_chunk

                            yield TextMessageContentEvent(
                                type=EventType.TEXT_MESSAGE_CONTENT,
                                thread_id=thread_id,
                                run_id=run_id,
                                message_id=current_message_id,
                                delta=text_chunk,
                            )
                    elif delta_type == 'thinking_delta':
                        thinking_chunk = delta_data.get('thinking', '')
                        if thinking_chunk and reasoning_message_id:
                            yield ReasoningMessageContentEvent(
                                type=EventType.REASONING_MESSAGE_CONTENT,
                                message_id=reasoning_message_id,
                                delta=thinking_chunk,
                            )
                    elif delta_type == 'signature_delta':
                        sig = delta_data.get('signature', '')
                        if sig:
                            accumulated_signature += sig
                    elif delta_type == 'input_json_delta':
                        partial_json = delta_data.get('partial_json', '')
                        if partial_json and current_tool_call_id:
                            accumulated_tool_json += partial_json
                            # Fix surrogates before Pydantic serialization.
                            # JS String.slice() splits emoji into surrogate
                            # pairs across chunks. Lone surrogates in a
                            # single chunk can't be reassembled, so replace
                            # them — the full JSON is fixed later via
                            # fix_surrogates() on accumulated_tool_json.
                            safe_delta = fix_surrogates(partial_json)
                            yield ToolCallArgsEvent(
                                type=EventType.TOOL_CALL_ARGS,
                                thread_id=thread_id,
                                run_id=run_id,
                                tool_call_id=current_tool_call_id,
                                delta=safe_delta,
                            )
                
                elif event_type == 'content_block_start':
                    block_data = event_data.get('content_block', {})
                    block_type = block_data.get('type', '')
                    
                    if block_type == 'thinking':
                        in_reasoning_block = True
                        reasoning_message_id = str(uuid.uuid4())
                        yield ReasoningStartEvent(
                            type=EventType.REASONING_START,
                            message_id=reasoning_message_id,
                        )
                        yield ReasoningMessageStartEvent.model_construct(
                            type=EventType.REASONING_MESSAGE_START,
                            message_id=reasoning_message_id,
                            role="reasoning",
                        )
                    elif block_type == 'tool_use':
                        current_tool_call_id = block_data.get('id')
                        current_tool_call_name = block_data.get('name', 'unknown')
                        accumulated_tool_json = ""
                        
                        if current_tool_call_id:
                            current_tool_display_name = strip_mcp_prefix(current_tool_call_name)
                            processed_tool_ids.add(current_tool_call_id)
                            
                            yield ToolCallStartEvent(
                                type=EventType.TOOL_CALL_START,
                                thread_id=thread_id,
                                run_id=run_id,
                                tool_call_id=current_tool_call_id,
                                tool_call_name=current_tool_display_name,
                                parent_message_id=current_message_id,
                            )
                
                elif event_type == 'content_block_stop':
                    if in_reasoning_block and reasoning_message_id:
                        in_reasoning_block = False
                        yield ReasoningMessageEndEvent(
                            type=EventType.REASONING_MESSAGE_END,
                            message_id=reasoning_message_id,
                        )
                        yield ReasoningEndEvent(
                            type=EventType.REASONING_END,
                            message_id=reasoning_message_id,
                        )

                        # Emit encrypted signature if present.
                        #
                        # Tie it to THIS thinking block (reasoning_message_id),
                        # not the enclosing assistant message id. A single
                        # message can contain multiple thinking blocks, each
                        # with its own signature_delta; binding to the message
                        # id (and resetting per block) attached a later block's
                        # signature to the wrong entity. Capture the block id
                        # before it is cleared below. (Item 2)
                        if accumulated_signature and reasoning_message_id:
                            yield ReasoningEncryptedValueEvent(
                                type=EventType.REASONING_ENCRYPTED_VALUE,
                                subtype="message",
                                entity_id=reasoning_message_id,
                                encrypted_value=accumulated_signature,
                            )

                        # Reset per-block signature accumulation so the next
                        # thinking block starts clean and cannot inherit this
                        # block's signature.
                        accumulated_signature = ""
                        reasoning_message_id = None
                    
                    # Close tool call if we were streaming one
                    if current_tool_call_id:
                        # Check if this is the state management tool
                        if _is_state_management_tool(current_tool_call_name):
                            try:
                                state_updates = json.loads(fix_surrogates(accumulated_tool_json))
                                if isinstance(state_updates, dict):
                                    updates = state_updates.get("state_updates", state_updates)
                                    if isinstance(updates, str):
                                        updates = json.loads(updates)
                                    lock = self._state_locks.setdefault(thread_id, asyncio.Lock())
                                    async with lock:
                                        prior = self._per_thread_state.get(thread_id)
                                        prev_state_json = json.dumps(prior, sort_keys=True, default=str)
                                        # Merge dict updates onto the prior dict.
                                        # When there is no prior state (None),
                                        # treat it as an empty dict so a dict
                                        # update MERGES onto {} rather than the
                                        # `else` branch silently replacing state
                                        # with `updates` (functionally the same
                                        # for a bare dict, but the explicit form
                                        # keeps the merge/replace semantics
                                        # unambiguous and consistent with the
                                        # non-streaming handler).
                                        if isinstance(updates, dict) and (prior is None or isinstance(prior, dict)):
                                            new_state = {**(prior or {}), **updates}
                                        else:
                                            new_state = updates
                                        new_state = fix_surrogates_deep(new_state)
                                        self._per_thread_state[thread_id] = new_state
                                        if json.dumps(self._per_thread_state.get(thread_id), sort_keys=True, default=str) != prev_state_json:
                                            yield StateSnapshotEvent(
                                                type=EventType.STATE_SNAPSHOT,
                                                snapshot=self._per_thread_state.get(thread_id),
                                            )
                            except (json.JSONDecodeError, ValueError) as e:
                                logger.warning(f"Failed to parse tool JSON for state update: {e}")
                                yield CustomEvent(
                                    type=EventType.CUSTOM,
                                    name="state_update_error",
                                    value={"error": str(e)},
                                )

                        # Push tool call onto in-flight message (skip state management)
                        if (
                            pending_msg is not None
                            and current_tool_call_id
                            and current_tool_display_name
                            and not _is_state_management_tool(current_tool_call_name)
                        ):
                            pending_msg["tool_calls"].append(
                                AguiToolCall(
                                    id=current_tool_call_id,
                                    type="function",
                                    function=AguiFunctionCall(
                                        name=current_tool_display_name,
                                        arguments=accumulated_tool_json,
                                    ),
                                )
                            )

                        # Check if this is a frontend tool -- halt stream
                        is_frontend_tool = current_tool_display_name in frontend_tool_names
                        
                        if is_frontend_tool:
                            flush_pending_msg()

                            yield ToolCallEndEvent(
                                type=EventType.TOOL_CALL_END,
                                thread_id=thread_id,
                                run_id=run_id,
                                tool_call_id=current_tool_call_id,
                            )
                            
                            if current_message_id and has_streamed_text:
                                yield TextMessageEndEvent(
                                    type=EventType.TEXT_MESSAGE_END,
                                    thread_id=thread_id,
                                    run_id=run_id,
                                    message_id=current_message_id,
                                )
                                current_message_id = None

                            logger.debug(f"Frontend tool halt: {current_tool_display_name}")
                            current_tool_call_id = None
                            current_tool_call_name = None
                            current_tool_display_name = None
                            accumulated_tool_json = ""
                            halt_event_stream = True
                            continue
                        
                        # Emit TOOL_CALL_END for regular backend tools
                        yield ToolCallEndEvent(
                            type=EventType.TOOL_CALL_END,
                            thread_id=thread_id,
                            run_id=run_id,
                            tool_call_id=current_tool_call_id,
                        )

                        # Reset tool streaming state
                        current_tool_call_id = None
                        current_tool_call_name = None
                        current_tool_display_name = None
                        accumulated_tool_json = ""
                
                elif event_type == 'message_stop':
                    flush_pending_msg()

                    if current_message_id and has_streamed_text:
                        yield TextMessageEndEvent(
                            type=EventType.TEXT_MESSAGE_END,
                            thread_id=thread_id,
                            run_id=run_id,
                            message_id=current_message_id,
                        )
                    current_message_id = None
                
                elif event_type == 'message_delta':
                    delta_data = event_data.get('delta', {})
                    stop_reason = delta_data.get('stop_reason')
                    if stop_reason:
                        logger.debug(f"Message stop_reason: {stop_reason}")
                
                continue
            
            # Handle complete messages
            if isinstance(message, (AssistantMessage, UserMessage)):
                # msg_id (used below and passed to handle_tool_use_block()) —
                # not current_message_id, which is only valid inside the
                # streaming loop and is already None here.
                msg_id = current_message_id or str(uuid.uuid4())
                if isinstance(message, AssistantMessage):
                    if current_message_id is None:
                        unstreamed_fallback_ids.add(msg_id)
                    agui_msg = build_agui_assistant_message(message, msg_id)
                    if agui_msg:
                        upsert_message(agui_msg)

                # Process non-streamed blocks (fallback for tools not seen via stream events)
                for block in getattr(message, 'content', []) or []:
                    if isinstance(block, ToolUseBlock):
                        tool_id = getattr(block, 'id', None)
                        if tool_id and tool_id in processed_tool_ids:
                            continue
                        updated_state, tool_events = await handle_tool_use_block(
                            block, message, thread_id, run_id, self._per_thread_state.get(thread_id),
                            parent_message_id=msg_id,
                        )
                        if tool_id:
                            processed_tool_ids.add(tool_id)
                        if updated_state is not None:
                            self._per_thread_state[thread_id] = updated_state
                        async for event in tool_events:
                            yield event

                        # Check for frontend tool halt (same logic as streaming path)
                        block_display_name = strip_mcp_prefix(getattr(block, 'name', '') or '')
                        if block_display_name and block_display_name in frontend_tool_names:
                            flush_pending_msg()
                            if current_message_id and has_streamed_text:
                                yield TextMessageEndEvent(
                                    type=EventType.TEXT_MESSAGE_END,
                                    thread_id=thread_id,
                                    run_id=run_id,
                                    message_id=current_message_id,
                                )
                                current_message_id = None
                            logger.debug(f"Frontend tool halt (non-streaming): {block_display_name}")
                            halt_event_stream = True
                            break

                    elif isinstance(block, ToolResultBlock):
                        tool_use_id = getattr(block, 'tool_use_id', None)
                        block_content = getattr(block, 'content', None)
                        if tool_use_id:
                            upsert_message(build_agui_tool_message(tool_use_id, block_content))
                        parent_id = getattr(message, 'parent_tool_use_id', None)
                        async for event in handle_tool_result_block(block, thread_id, run_id, parent_id):
                            yield event
            
            elif isinstance(message, SystemMessage):
                subtype = getattr(message, 'subtype', '')
                data = getattr(message, 'data', {}) or {}
                
                # Emit system messages as CUSTOM events with the raw SDK data
                yield CustomEvent(
                    type=EventType.CUSTOM,
                    name=f"system:{subtype or 'unknown'}",
                    value=data or {},
                )
            
            elif isinstance(message, ResultMessage):
                is_error = getattr(message, 'is_error', None)
                result_text = getattr(message, 'result', None)
                
                # Capture metadata for the terminal event. Key per-run
                # (thread_id, run_id) so a serialized peer on the same thread
                # cannot clobber this run's result. (Fix 4)
                run_result = {
                    "is_error": is_error,
                    "duration_ms": getattr(message, 'duration_ms', None),
                    "duration_api_ms": getattr(message, 'duration_api_ms', None),
                    "num_turns": getattr(message, 'num_turns', None),
                    "total_cost_usd": getattr(message, 'total_cost_usd', None),
                    "usage": getattr(message, 'usage', None),
                    "structured_output": getattr(message, 'structured_output', None),
                    # Best-effort: absent from ResultMessage on claude-agent-sdk
                    # versions predating the field (including the current pin
                    # floor), in which case RUN_ERROR.code is None.
                    "api_error_status": getattr(message, 'api_error_status', None),
                }
                if is_error:
                    # Thread the failure text to run(), which owns terminal
                    # events and emits RUN_ERROR in place of RUN_FINISHED
                    # (#2145). Added only on errored turns so the success-path
                    # RunFinishedEvent.result payload (emitted verbatim) is
                    # unchanged.
                    run_result["result"] = result_text
                self._per_run_result[(thread_id, run_id)] = run_result

                if not has_streamed_text and result_text and not is_error:
                    result_msg_id = str(uuid.uuid4())
                    yield TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, thread_id=thread_id, run_id=run_id, message_id=result_msg_id, role="assistant")
                    yield TextMessageContentEvent(type=EventType.TEXT_MESSAGE_CONTENT, thread_id=thread_id, run_id=run_id, message_id=result_msg_id, delta=result_text)
                    yield TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, thread_id=thread_id, run_id=run_id, message_id=result_msg_id)

                    upsert_message(AguiAssistantMessage(
                        id=result_msg_id,
                        role="assistant",
                        content=result_text,
                    ))
        
        # ── Event cleanup ──
        # Close any hanging events so the frontend doesn't get stuck
        # waiting for END events that will never arrive.
        # Handles: normal stream completion and halt/break cases.
        if current_tool_call_id:
            logger.debug(f"Cleanup: closing hanging TOOL_CALL_START for {current_tool_call_id}")
            yield ToolCallEndEvent(
                type=EventType.TOOL_CALL_END,
                thread_id=thread_id,
                run_id=run_id,
                tool_call_id=current_tool_call_id,
            )
            current_tool_call_id = None

        if in_reasoning_block and reasoning_message_id:
            logger.debug("Cleanup: closing hanging reasoning block")
            yield ReasoningMessageEndEvent(
                type=EventType.REASONING_MESSAGE_END,
                message_id=reasoning_message_id,
            )
            yield ReasoningEndEvent(
                type=EventType.REASONING_END,
                message_id=reasoning_message_id,
            )
            in_reasoning_block = False
            reasoning_message_id = None

        if has_streamed_text and current_message_id:
            logger.debug(f"Cleanup: closing hanging TEXT_MESSAGE_START for {current_message_id}")
            yield TextMessageEndEvent(
                type=EventType.TEXT_MESSAGE_END,
                thread_id=thread_id,
                run_id=run_id,
                message_id=current_message_id,
            )

        flush_pending_msg()

        run_result = self._per_run_result.get((thread_id, run_id), {}) or {}
        if run_result.get("is_error") and unstreamed_fallback_ids:
            run_messages[:] = [m for m in run_messages if _get_msg_id(m) not in unstreamed_fallback_ids]

        # Emit MESSAGES_SNAPSHOT with input messages + new messages from this run
        if run_messages:
            all_messages = list(input_data.messages or []) + run_messages
            logger.debug(
                f"MESSAGES_SNAPSHOT: {len(all_messages)} msgs ({message_count} SDK messages processed)"
            )
            yield MessagesSnapshotEvent(
                type=EventType.MESSAGES_SNAPSHOT,
                messages=all_messages,
            )

