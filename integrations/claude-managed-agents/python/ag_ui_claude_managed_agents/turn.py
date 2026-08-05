"""Drive one turn of a managed session and translate its events into AG-UI events."""

import asyncio
import inspect
import json
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any

from ag_ui.core import (
    BaseEvent,
    ReasoningEndEvent,
    ReasoningMessageEndEvent,
    ReasoningMessageStartEvent,
    ReasoningStartEvent,
    RunErrorEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
)

from ._util import (
    get,
    maybe_await,
    report_swallowed_failure,
    schedule_detached,
    track_background_work,
)
from .constants import (
    BEST_EFFORT_SEND_TIMEOUT_S,
    PARKED_RETRY_DELAYS_S,
    TOOL_RESULT_MAX_CHARS,
)
from .text import describe_tool_result, text_of
from .types import BackendTool, ErrorHandler, TurnOutcome

INTERRUPTED_TOOL_RESULT_TEXT = "Tool execution was interrupted."
"""Posted for a backend tool cut off by a timeout or client disconnect, so
the session is never left parked on a call nothing will answer."""

Emit = Callable[[BaseEvent], None]
SentCallback = Callable[[], Awaitable[None] | None]
ParkCallback = Callable[[str], Awaitable[None] | None]

def _observe_failure(
    task: asyncio.Future[Any],
    on_failure: Callable[[BaseException], None],
) -> None:
    """Route a completed background task's failure to `on_failure`.

    Cancellation is the expected end for work the run walked away from and is
    not reported; a real exception is the only trace of work that ran on after
    the run stopped waiting for it.
    """
    if task.cancelled():
        return
    error = task.exception()
    if error is not None:
        on_failure(error)


async def _close_stream(stream: Any) -> None:
    close = getattr(stream, "close", None)
    if close is None:
        return
    result = close()
    if inspect.isawaitable(result):
        await result


async def _run_callback(callback: SentCallback | None) -> None:
    if callback is not None:
        await maybe_await(callback())


async def run_turn(
    *,
    client: Any,
    session_id: str,
    outbound: list[dict[str, Any]],
    client_tools: Mapping[str, str],
    backend_tools: Mapping[str, BackendTool],
    tool_confirmation: str | None,
    stream_deltas: bool,
    emit: Emit,
    on_results_sent: SentCallback | None = None,
    on_follow_ups_sent: SentCallback | None = None,
    on_client_park: ParkCallback | None = None,
    on_error: ErrorHandler | None = None,
) -> TurnOutcome:
    """Open the event stream, post the outbound events, and translate the
    session's events into AG-UI events until the session goes idle.

    `client_tools` maps normalized frontend tool names to their original AG-UI
    names; calls to these park the session. `backend_tools` maps normalized
    names to tools executed on this server.

    `on_results_sent` fires once the tool-result batch is delivered and
    `on_follow_ups_sent` once the follow-up messages are, so callers persist
    each delivery independently: the results resume the session even if the
    follow-ups later fail.

    `on_client_park` fires as soon as a frontend tool call is handed to the UI
    unanswered. The turn can still fail (or be torn down) before the session
    confirms the park, and the ID has to survive that: nothing else can tell
    the next run which call the remote session is waiting on.

    Invariant: no TEXT_MESSAGE or REASONING block is left open when this returns
    or raises. Every exit path closes them.
    """
    # Open the stream before sending so no early events are missed.
    # "agent.thinking" opts into the live thinking indicator (event_start);
    # thinking carries no text deltas today.
    stream_kwargs: dict[str, Any] = (
        {"event_deltas": ["agent.message", "agent.thinking"]} if stream_deltas else {}
    )
    stream = await client.beta.sessions.events.stream(session_id, **stream_kwargs)

    # A parked session accepts only tool results, so post those first (which
    # resumes it) and any user messages in a second call: the API validates a
    # whole batch against the session's current state. It also un-parks
    # asynchronously, so retry the follow-ups briefly on that specific error.
    follow_ups = [
        e for e in outbound if e.get("type") in ("user.message", "system.message")
    ]
    results = [
        e for e in outbound if e.get("type") not in ("user.message", "system.message")
    ]
    try:
        if results:
            await client.beta.sessions.events.send(session_id, events=results)
            await _run_callback(on_results_sent)
        if follow_ups:
            await _send_follow_ups(client, session_id, follow_ups)
            await _run_callback(on_follow_ups_sent)

        return await _consume(
            client=client,
            session_id=session_id,
            stream=stream,
            client_tools=client_tools,
            backend_tools=backend_tools,
            tool_confirmation=tool_confirmation,
            emit=emit,
            on_client_park=on_client_park,
            on_error=on_error,
        )
    finally:
        await _close_stream(stream)


async def _consume(
    *,
    client: Any,
    session_id: str,
    stream: Any,
    client_tools: Mapping[str, str],
    backend_tools: Mapping[str, BackendTool],
    tool_confirmation: str | None,
    emit: Emit,
    on_client_park: ParkCallback | None = None,
    on_error: ErrorHandler | None = None,
) -> TurnOutcome:
    previews: dict[str, str] = {}
    closed_messages: set[str] = set()
    open_reasoning: set[str] = set()
    acked_tool_uses: set[str] = set()
    client_parks: set[str] = set()
    asked_confirmations: set[str] = set()

    def close_message(message_id: str) -> None:
        emit(TextMessageEndEvent(message_id=message_id))
        previews.pop(message_id, None)
        closed_messages.add(message_id)

    def close_reasoning(message_id: str) -> None:
        emit(ReasoningMessageEndEvent(message_id=message_id))
        emit(ReasoningEndEvent(message_id=message_id))
        open_reasoning.discard(message_id)

    def close_all() -> None:
        for message_id in list(previews):
            close_message(message_id)
        for reasoning_id in list(open_reasoning):
            close_reasoning(reasoning_id)

    def emit_tool_call(tool_call_id: str, name: str, tool_input: Any) -> None:
        emit(ToolCallStartEvent(tool_call_id=tool_call_id, tool_call_name=name))
        # ensure_ascii=False so non-ASCII arguments arrive as themselves rather
        # than \uXXXX escapes: the other two ports emit them literally, and the
        # transport is UTF-8 either way.
        delta = json.dumps(
            tool_input if tool_input is not None else {},
            separators=(",", ":"),
            ensure_ascii=False,
        )
        emit(ToolCallArgsEvent(tool_call_id=tool_call_id, delta=delta))
        emit(ToolCallEndEvent(tool_call_id=tool_call_id))

    def emit_tool_result(tool_use_id: str, content: str) -> None:
        emit(
            ToolCallResultEvent(
                message_id=f"result_{tool_use_id}",
                tool_call_id=tool_use_id,
                content=content,
                role="tool",
            )
        )

    async def report(operation: str, error: BaseException) -> None:
        """Report a swallowed failure.

        A broken hook must not break the turn; an async hook is awaited so its
        telemetry actually runs. See `report_swallowed_failure`.
        """
        await report_swallowed_failure(
            on_error, operation, error, session_id=session_id
        )

    def report_detached(operation: str, error: BaseException) -> None:
        """`report` from a frame that cannot await, such as a done callback."""
        schedule_detached(report(operation, error))

    async def interrupt() -> bool:
        """Stop the session best-effort, reporting whether it landed.

        Bounded by its own timeout: this runs while the thread's run gate is
        still held, so a stalled connection must not keep the thread's later
        runs out.
        """
        try:
            await asyncio.wait_for(
                client.beta.sessions.events.send(
                    session_id, events=[{"type": "user.interrupt"}]
                ),
                BEST_EFFORT_SEND_TIMEOUT_S,
            )
        except Exception as exc:  # noqa: BLE001 - best-effort interrupt, including its own bound
            await report("interrupt", exc)
            return False
        return True

    def fail(
        message: str, code: str | None = None, session_interrupted: bool = False
    ) -> TurnOutcome:
        """End the turn with a RUN_ERROR.

        `session_interrupted` must be the result of the `interrupt()` that
        preceded it: a landed interrupt invalidates every park recorded this
        turn, and a failed one leaves the session parked.
        """
        close_all()
        emit(RunErrorEvent(message=message, code=code))
        return TurnOutcome(status="errored", session_interrupted=session_interrupted)

    async def send_custom_tool_result(
        tool_use_id: str, text: str, is_error: bool
    ) -> None:
        # Bounded so a stalled connection cannot hold the thread's run gate
        # open (the interrupted-result path shields this from cancellation).
        await asyncio.wait_for(
            _send_custom_tool_result(tool_use_id, text, is_error),
            BEST_EFFORT_SEND_TIMEOUT_S,
        )

    async def _send_custom_tool_result(
        tool_use_id: str, text: str, is_error: bool
    ) -> None:
        await client.beta.sessions.events.send(
            session_id,
            events=[
                {
                    "type": "user.custom_tool_result",
                    "custom_tool_use_id": tool_use_id,
                    "content": [{"type": "text", "text": text}],
                    "is_error": is_error,
                }
            ],
        )
        acked_tool_uses.add(tool_use_id)

    async def post_interrupted_result(tool_use_id: str) -> None:
        """Answer a backend tool call cut off mid-run, so the session is not
        left parked on it. Best-effort and shielded from the cancellation in
        flight (a timeout or client disconnect)."""
        task = asyncio.ensure_future(
            send_custom_tool_result(tool_use_id, INTERRUPTED_TOOL_RESULT_TEXT, True)
        )
        # Keep a strong reference so the loop cannot drop the send mid-flight
        # once this frame unwinds, and observe its eventual outcome: if the
        # outer cancellation lands while we are shielded, the send finishes in
        # the background and its failure must not surface as "exception was
        # never retrieved".
        track_background_work(task)
        # Once the shield below has re-raised the cancellation this frame is
        # gone, so the send's own outcome would otherwise only be consumed.
        # Report it: an unanswered call leaves the session parked, which is
        # exactly what an operator needs to know about.
        task.add_done_callback(
            lambda done: _observe_failure(
                done,
                lambda error: report_detached("post_interrupted_tool_result", error),
            )
        )
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            # The run is being torn down; the send continues in the background
            # and the callback above reports whatever becomes of it.
            raise
        except Exception:  # noqa: BLE001 - best-effort; the done callback reports it
            pass

    async def answer_custom_tool_use(
        tool_use_id: str, text: str, is_error: bool
    ) -> TurnOutcome | None:
        """Answer a custom tool call: deliver the result into the session
        first, and only tell the UI once it landed.

        A TOOL_CALL_RESULT the agent never received would report a success that
        did not happen, so on a failed delivery the session — still parked on
        the call — is interrupted best-effort and the run ends with an error
        instead. Returns the terminal outcome when delivery failed, else None.
        """
        try:
            await send_custom_tool_result(tool_use_id, text, is_error)
        except Exception as exc:  # noqa: BLE001 - reported as a terminal run error
            # The failure itself goes to the hook; the client is told only that
            # the delivery failed. The underlying exception can carry session ids
            # and request detail, and this event is read by the browser.
            await report("post_tool_result", exc)
            return fail(
                f"The result of tool call {tool_use_id} could not be delivered "
                "to the session.",
                "tool_result_delivery_failed",
                await interrupt(),
            )
        emit_tool_result(tool_use_id, text)
        return None

    async def run_backend_tool(
        tool_use_id: str, tool: BackendTool, tool_input: Any
    ) -> TurnOutcome | None:
        """Run a backend custom tool and post its result back into the session.

        Returns the terminal outcome when the result could not be delivered.
        """
        is_error = False
        try:
            text = str(
                await _call_backend_handler(
                    tool.handler,
                    tool_input,
                    on_abandoned_failure=lambda error: report_detached(
                        "abandoned_backend_tool", error
                    ),
                )
            )
        except asyncio.CancelledError as err:
            task = asyncio.current_task()
            if task is None or task.cancelling() > 0:
                # The run itself is being torn down (timeout or disconnect).
                await post_interrupted_result(tool_use_id)
                raise
            # The handler leaked a CancelledError of its own (e.g. re-raised
            # from an inner cancelled task) while the run is healthy: the
            # session is waiting on this call, so report it like any failure.
            is_error = True
            text = str(err) or err.__class__.__name__
        except Exception as err:  # noqa: BLE001 - the tool's failure is reported to the agent
            is_error = True
            text = str(err) or err.__class__.__name__
        return await answer_custom_tool_use(tool_use_id, text, is_error)

    async def consume() -> TurnOutcome:
        async for event in stream:
            event_type = get(event, "type")

            if event_type == "event_start":
                preview = get(event, "event")
                preview_type = get(preview, "type")
                preview_id = get(preview, "id")
                if preview_type == "agent.message":
                    emit(TextMessageStartEvent(message_id=preview_id, role="assistant"))
                    previews[preview_id] = ""
                elif preview_type == "agent.thinking":
                    open_reasoning.add(preview_id)
                    emit(ReasoningStartEvent(message_id=preview_id))
                    emit(
                        ReasoningMessageStartEvent(
                            message_id=preview_id, role="reasoning"
                        )
                    )

            elif event_type == "event_delta":
                event_id = get(event, "event_id")
                # Best-effort; the buffered agent.message is canonical.
                if event_id not in previews:
                    continue
                delta = get(event, "delta")
                content = get(delta, "content")
                if (
                    get(delta, "type") == "content_delta"
                    and get(content, "type") == "text"
                ):
                    # Never emit an empty delta; AG-UI requires non-empty content.
                    text = get(content, "text") or ""
                    if not text:
                        continue
                    previews[event_id] += text
                    emit(TextMessageContentEvent(message_id=event_id, delta=text))

            elif event_type == "agent.thinking":
                # The thinking stretch finished. Its text is not exposed by the
                # API today, so this is a progress signal: close the reasoning
                # block we opened.
                event_id = get(event, "id")
                if event_id in open_reasoning:
                    close_reasoning(event_id)
                else:
                    emit(ReasoningStartEvent(message_id=event_id))
                    emit(ReasoningEndEvent(message_id=event_id))

            elif event_type == "agent.message":
                event_id = get(event, "id")
                if event_id in closed_messages:
                    continue
                final_text = text_of(get(event, "content"))
                if event_id not in previews:
                    emit(TextMessageStartEvent(message_id=event_id, role="assistant"))
                    previews[event_id] = ""
                    if final_text:
                        emit(
                            TextMessageContentEvent(
                                message_id=event_id, delta=final_text
                            )
                        )
                else:
                    previewed = previews[event_id]
                    if final_text.startswith(previewed):
                        if len(final_text) > len(previewed):
                            emit(
                                TextMessageContentEvent(
                                    message_id=event_id,
                                    delta=final_text[len(previewed) :],
                                )
                            )
                    else:
                        # Preview diverged from the final text: close it and re-emit the corrected whole.
                        close_message(event_id)
                        if final_text:
                            corrected_id = f"corrected_{event_id}"
                            emit(
                                TextMessageStartEvent(
                                    message_id=corrected_id, role="assistant"
                                )
                            )
                            emit(
                                TextMessageContentEvent(
                                    message_id=corrected_id, delta=final_text
                                )
                            )
                            emit(TextMessageEndEvent(message_id=corrected_id))
                        continue
                close_message(event_id)

            elif event_type == "agent.custom_tool_use":
                event_id = get(event, "id")
                name = get(event, "name")
                tool_input = get(event, "input")
                # Report the frontend's original tool name, which may differ
                # from the normalized name registered on the managed agent.
                emit_tool_call(event_id, client_tools.get(name, name), tool_input)
                if name in client_tools:
                    # The frontend executes this tool. Leave it unanswered; the
                    # session parks on it and the next run supplies the result.
                    client_parks.add(event_id)
                    if on_client_park is not None:
                        await maybe_await(on_client_park(event_id))
                    continue
                backend = backend_tools.get(name)
                if backend is not None:
                    undelivered = await run_backend_tool(event_id, backend, tool_input)
                    if undelivered is not None:
                        return undelivered
                    continue
                # Nothing can execute this tool. Answer with an error so the agent recovers.
                undelivered = await answer_custom_tool_use(
                    event_id, f'No handler is registered for tool "{name}".', True
                )
                if undelivered is not None:
                    return undelivered

            elif event_type == "agent.tool_use":
                event_id = get(event, "id")
                emit_tool_call(event_id, get(event, "name"), get(event, "input"))
                if get(event, "evaluated_permission") == "ask":
                    asked_confirmations.add(event_id)

            elif event_type == "agent.mcp_tool_use":
                event_id = get(event, "id")
                emit_tool_call(
                    event_id,
                    f"{get(event, 'mcp_server_name')}: {get(event, 'name')}",
                    get(event, "input"),
                )
                if get(event, "evaluated_permission") == "ask":
                    asked_confirmations.add(event_id)

            elif event_type == "agent.tool_result":
                emit_tool_result(
                    get(event, "tool_use_id"),
                    describe_tool_result(get(event, "content"))[:TOOL_RESULT_MAX_CHARS],
                )

            elif event_type == "agent.mcp_tool_result":
                emit_tool_result(
                    get(event, "mcp_tool_use_id"),
                    describe_tool_result(get(event, "content"))[:TOOL_RESULT_MAX_CHARS],
                )

            elif event_type == "span.model_request_end":
                # A failed model request produces no buffered agent.message,
                # so its dangling preview must be closed here. A successful
                # one is left to the buffered message, which may arrive after
                # this event and still needs to reconcile the streamed text.
                if get(event, "is_error") is True:
                    close_all()

            elif event_type == "session.error":
                error = get(event, "error")
                retry_status = get(error, "retry_status")
                if get(retry_status, "type") == "retrying":
                    continue  # transient; the session recovers on its own
                return fail(
                    get(error, "message") or "The session reported an error.",
                    get(error, "type"),
                )

            elif event_type == "session.status_idle":
                stop_reason = get(event, "stop_reason")
                reason_type = get(stop_reason, "type")
                if reason_type == "end_turn":
                    close_all()
                    return TurnOutcome(status="finished")
                if reason_type == "retries_exhausted":
                    return fail(
                        "The session gave up after exhausting its retries.",
                        "retries_exhausted",
                    )
                if reason_type != "requires_action":
                    # A stop reason this version does not know how to answer.
                    # Waiting for the session to resume would burn the whole turn
                    # timeout, so interrupt it and say so — the same as the other
                    # two ports.
                    return fail(
                        "The session went idle for a reason this integration does "
                        f"not handle: {reason_type}.",
                        "unknown_stop_reason",
                        await interrupt(),
                    )
                # requires_action: work out what the session is blocked on.
                event_ids: Sequence[str] = get(stop_reason, "event_ids") or []
                blocked_on = [
                    event_id
                    for event_id in event_ids
                    if event_id not in acked_tool_uses
                ]
                if not blocked_on:
                    continue  # everything is already answered; wait for it to resume

                confirmations = [
                    event_id
                    for event_id in blocked_on
                    if event_id in asked_confirmations
                ]
                if confirmations:
                    if not tool_confirmation:
                        return fail(
                            "A tool requires confirmation but no confirmation policy is configured. "
                            'Set `tool_confirmation` to "allow" or "deny", or use a permission '
                            "policy that does not ask.",
                            "tool_confirmation_required",
                            await interrupt(),
                        )
                    # Bounded like tool-result posts: the session is parked
                    # waiting on these answers. A failed delivery leaves it
                    # parked, so interrupt it and report that cause rather than
                    # letting the bound's TimeoutError surface as something else.
                    try:
                        await asyncio.wait_for(
                            client.beta.sessions.events.send(
                                session_id,
                                events=[
                                    {
                                        "type": "user.tool_confirmation",
                                        "tool_use_id": tool_use_id,
                                        "result": tool_confirmation,
                                    }
                                    for tool_use_id in confirmations
                                ],
                            ),
                            BEST_EFFORT_SEND_TIMEOUT_S,
                        )
                    except asyncio.CancelledError:
                        raise
                    except Exception as exc:  # noqa: BLE001 - reported as a terminal run error
                        await report("post_tool_confirmation", exc)
                        return fail(
                            "The tool confirmation could not be delivered to the "
                            "session.",
                            "tool_confirmation_delivery_failed",
                            await interrupt(),
                        )
                    acked_tool_uses.update(confirmations)
                    if len(confirmations) == len(blocked_on):
                        continue

                client_tool_use_ids = [
                    event_id for event_id in blocked_on if event_id in client_parks
                ]
                unknown = [
                    event_id
                    for event_id in blocked_on
                    if event_id not in asked_confirmations
                    and event_id not in client_parks
                ]
                if unknown:
                    return fail(
                        "The agent is waiting on an action this integration cannot answer.",
                        "unsupported_action",
                        await interrupt(),
                    )
                if client_tool_use_ids:
                    # Hand control back to the frontend to execute its tools.
                    close_all()
                    return TurnOutcome(
                        status="parked", client_tool_use_ids=client_tool_use_ids
                    )

            elif event_type in ("session.status_terminated", "session.deleted"):
                close_all()
                emit(
                    RunErrorEvent(
                        message="The managed session ended on the server. Send another message to start a fresh one.",
                        code="session_ended",
                    )
                )
                return TurnOutcome(status="errored", session_ended=True)

            # status_running, rescheduled, spans, thread events, echoed user events: ignored

        close_all()
        return fail(
            "The session event stream ended before the reply completed.", "stream_ended"
        )

    try:
        return await consume()
    finally:
        close_all()


SENT_WHILE_PARKED_MESSAGE = "waiting on responses"
"""Substring of the API's 400 for an event posted while the session is still
parked on tool results.

NOT VERIFIED AGAINST THE LIVE API. The retry this gates exists because a session
un-parks asynchronously after a tool result, so a follow-up message can
legitimately race ahead of that transition; this wording is what the rejection
was observed to carry, and the API is free to reword it. The tests build the
error from the real SDK exception class, which pins the shape (status code plus
message) but not the wording.

The failure mode is benign and one-directional: a reworded message means the
retry no longer fires and the original 400 surfaces to the caller, never that
something else is retried by mistake. If the parked race starts surfacing as a
run error, check this string first."""


def _is_sent_while_parked(exc: BaseException) -> bool:
    """The API rejects user messages while a session is parked on tool results."""
    status = getattr(exc, "status_code", None) or getattr(exc, "status", None)
    return status == 400 and SENT_WHILE_PARKED_MESSAGE in str(exc)


async def _send_follow_ups(
    client: Any, session_id: str, events: list[dict[str, Any]]
) -> None:
    """Post follow-up messages, retrying while the session finishes un-parking."""
    # One attempt per delay, plus a final attempt that raises on failure.
    for delay in (*PARKED_RETRY_DELAYS_S, None):
        try:
            await client.beta.sessions.events.send(session_id, events=events)
            return
        except Exception as exc:  # noqa: BLE001 - retry only the parked race
            if delay is None or not _is_sent_while_parked(exc):
                raise
            await asyncio.sleep(delay)


async def _call_backend_handler(
    handler: Callable[[Any], Any],
    tool_input: Any,
    on_abandoned_failure: Callable[[BaseException], None] | None = None,
) -> Any:
    """Run a backend tool handler.

    A plain (blocking) function runs in a worker thread so it never stalls
    the event loop that other runs share; a coroutine is awaited directly.

    A worker thread cannot be cancelled, so when the run is torn down the wait
    is abandoned and the thread runs to completion regardless -- the same as a
    started handler in the TypeScript and .NET ports. Its eventual failure is
    then the only trace of a backend tool that broke after the run walked away,
    so shield the future (cancelling the wait must not discard its outcome) and
    hand that outcome to `on_abandoned_failure`. A cancelled outcome is not
    reported: that is the expected end of abandoned work.
    """
    if inspect.iscoroutinefunction(handler):
        return await handler(tool_input)

    pending = asyncio.ensure_future(asyncio.to_thread(handler, tool_input))
    track_background_work(pending)
    try:
        result = await asyncio.shield(pending)
    except asyncio.CancelledError:
        if on_abandoned_failure is not None:
            pending.add_done_callback(
                lambda done: _observe_failure(done, on_abandoned_failure)
            )
        raise
    return await maybe_await(result)
