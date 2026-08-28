"""AG-UI adapter for Swarms agents."""
import asyncio
import copy
import uuid
from collections.abc import AsyncIterator, Sequence
from contextlib import suppress
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from swarms import Agent

from ag_ui.core import (
    EventType,
    Message,
    MessagesSnapshotEvent,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
)
from ag_ui.core.types import AssistantMessage
from ag_ui.encoder import EventEncoder


# When a client disconnects mid-stream, the worker thread running the blocking
# ``agent.run`` cannot be cancelled and keeps writing to the shared
# ``agent.short_memory``. The next request waits up to this many seconds for that
# thread to finish before rebuilding memory, so the two never write at once. The
# bound keeps a genuinely hung run from wedging every subsequent request.
_PREVIOUS_RUN_DRAIN_TIMEOUT = 30.0


def _role_label(agent: Agent, role: str) -> str:
    """Map an AG-UI message role to the label Swarms uses in its conversation.

    Swarms flattens its short-term memory into a single prompt string
    (``Conversation.return_history_as_string``) before sending it to the model,
    so these labels are simply the turn authors the model reads. Using the
    agent's own ``user_name``/``agent_name`` keeps replayed history consistent
    with the turns Swarms writes itself.
    """
    if role == "user":
        return getattr(agent, "user_name", "User")
    if role == "assistant":
        return getattr(agent, "agent_name", "Assistant")
    if role == "system":
        return "System"
    if role == "tool":
        return "Tool"
    return role.capitalize()


def _rebuild_memory(
    agent: Agent,
    baseline: Any,
    messages: Sequence[Message],
) -> str:
    """Reset the agent's memory to *baseline* and replay *messages* into it.

    The AG-UI client is the source of truth for conversation history and the
    agent instance is shared across every request, so on each turn we restore
    the agent's pristine baseline (system prompt and anything it seeded at
    construction) and replay the incoming history. The trailing user message is
    returned as the task to run rather than seeded, because ``agent.run`` appends
    the task to memory itself — seeding it too would duplicate the turn.

    Returns the task string for ``agent.run``.
    """
    if baseline is not None:
        agent.short_memory.clear()
        agent.short_memory.batch_add(copy.deepcopy(baseline))

    # The task is the most recent user message; everything before it is context.
    last_user_idx = next(
        (i for i in range(len(messages) - 1, -1, -1) if messages[i].role == "user"),
        None,
    )
    if last_user_idx is None:
        history, task = messages, ""
    else:
        history = messages[:last_user_idx]
        task = messages[last_user_idx].content or ""

    if baseline is not None:
        for message in history:
            content = getattr(message, "content", None)
            if not content:
                continue
            agent.short_memory.add(
                role=_role_label(agent, message.role),
                content=content,
            )

    return task


def _capture_baseline(agent: Agent) -> Any:
    """Snapshot the agent's freshly constructed memory so it can be restored.

    Returns ``None`` if the agent does not expose a Swarms-style
    ``short_memory`` (e.g. a custom stub), in which case history replay is
    skipped and only the latest user message is forwarded.
    """
    short_memory = getattr(agent, "short_memory", None)
    if short_memory is None:
        return None
    to_dict = getattr(short_memory, "to_dict", None)
    if not callable(to_dict):
        return None
    try:
        return copy.deepcopy(to_dict())
    except Exception:  # pylint: disable=broad-exception-caught
        return None


def _chunk_text(chunk: Any) -> str:
    """Extract the text delta from a Swarms streaming chunk.

    Swarms passes either a plain string delta or a dict ``token_info`` to the
    streaming callback depending on the agent's configuration, so both shapes are
    handled.
    """
    if isinstance(chunk, str):
        return chunk
    if isinstance(chunk, dict):
        choices = chunk.get("choices")
        if choices:
            delta = choices[0].get("delta") or {}
            content = delta.get("content")
            if isinstance(content, str):
                return content
        content = chunk.get("content")
        if isinstance(content, str):
            return content
    return ""


async def _event_stream(
    agent: Agent,
    body: RunAgentInput,
    encoder: EventEncoder,
    baseline: Any,
    lock: asyncio.Lock,
    pending_run: dict[str, Any],
) -> AsyncIterator[str]:
    run_id = body.run_id or str(uuid.uuid4())
    thread_id = body.thread_id or str(uuid.uuid4())
    message_id = str(uuid.uuid4())

    yield encoder.encode(
        RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id=thread_id,
            run_id=run_id,
        )
    )

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def on_chunk(chunk: Any) -> None:
        text = _chunk_text(chunk)
        if text:
            loop.call_soon_threadsafe(queue.put_nowait, ("chunk", text))

    def run_blocking(task: str) -> None:
        # ``agent.run`` is blocking (it drives the model) and only invokes the
        # streaming callback when the agent has streaming enabled; otherwise it
        # simply returns the full response, which the fallback below emits as a
        # single chunk.
        try:
            result = agent.run(task, streaming_callback=on_chunk)
            loop.call_soon_threadsafe(queue.put_nowait, ("result", result))
        except Exception as exc:  # pylint: disable=broad-exception-caught
            loop.call_soon_threadsafe(queue.put_nowait, ("error", exc))
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, ("done", None))

    message_open = False
    streamed: list[str] = []
    result: Any = None
    error: Exception | None = None

    # Rebuilding the shared agent's memory and running it must not interleave
    # with another in-flight request, so the run is serialized per agent. Text
    # deltas are forwarded as they arrive; the message is opened on the first
    # delta so an error before any output surfaces as a clean RUN_ERROR rather
    # than leaving an unterminated TEXT_MESSAGE_* sequence on the wire.
    async with lock:
        # Wait for any previous run's worker thread to finish before mutating
        # the shared agent memory. On a normal turn the previous run already
        # completed, so this returns immediately; it only blocks when an earlier
        # client disconnected mid-stream, leaving its uncancellable worker thread
        # still writing to ``agent.short_memory``. Shielded so a timeout here
        # does not cancel that thread's future, and bounded so a genuinely hung
        # run cannot wedge every subsequent request.
        previous = pending_run["future"]
        if previous is not None and not previous.done():
            try:
                await asyncio.wait_for(
                    asyncio.shield(previous), _PREVIOUS_RUN_DRAIN_TIMEOUT
                )
            except asyncio.TimeoutError:
                pass

        task = _rebuild_memory(agent, baseline, body.messages)
        run_future = asyncio.ensure_future(asyncio.to_thread(run_blocking, task))
        pending_run["future"] = run_future
        while True:
            kind, payload = await queue.get()
            if kind == "chunk":
                if not message_open:
                    message_open = True
                    yield encoder.encode(
                        TextMessageStartEvent(
                            type=EventType.TEXT_MESSAGE_START,
                            message_id=message_id,
                            role="assistant",
                        )
                    )
                streamed.append(payload)
                yield encoder.encode(
                    TextMessageContentEvent(
                        type=EventType.TEXT_MESSAGE_CONTENT,
                        message_id=message_id,
                        delta=payload,
                    )
                )
            elif kind == "result":
                result = payload
            elif kind == "error":
                error = payload
            elif kind == "done":
                break

        # Normal completion: the worker emitted "done" from its finally and is
        # about to return. Await it so the shared memory is provably quiescent
        # before the lock is released. On client disconnect this is skipped —
        # GeneratorExit unwinds the lock and the next request drains the worker.
        with suppress(Exception):
            await run_future

    if error is not None:
        if message_open:
            yield encoder.encode(
                TextMessageEndEvent(
                    type=EventType.TEXT_MESSAGE_END,
                    message_id=message_id,
                )
            )
        yield encoder.encode(
            RunErrorEvent(
                type=EventType.RUN_ERROR,
                message=str(error),
                code="SWARMS_RUN_ERROR",
            )
        )
        return

    response = result if isinstance(result, str) else "".join(streamed)
    if not response and result is not None:
        response = str(result)

    # Fallback: the agent did not stream (streaming disabled), so emit the full
    # response as a single delta.
    if not message_open:
        yield encoder.encode(
            TextMessageStartEvent(
                type=EventType.TEXT_MESSAGE_START,
                message_id=message_id,
                role="assistant",
            )
        )
        yield encoder.encode(
            TextMessageContentEvent(
                type=EventType.TEXT_MESSAGE_CONTENT,
                message_id=message_id,
                delta=response,
            )
        )
    yield encoder.encode(
        TextMessageEndEvent(
            type=EventType.TEXT_MESSAGE_END,
            message_id=message_id,
        )
    )

    snapshot: list[Message] = list(body.messages) + [
        AssistantMessage(
            id=message_id,
            role="assistant",
            content=response,
        )
    ]
    yield encoder.encode(
        MessagesSnapshotEvent(
            type=EventType.MESSAGES_SNAPSHOT,
            messages=snapshot,
        )
    )
    yield encoder.encode(
        RunFinishedEvent(
            type=EventType.RUN_FINISHED,
            thread_id=thread_id,
            run_id=run_id,
        )
    )


def add_swarms_fastapi_endpoint(
    app: FastAPI,
    agent: Agent,
    path: str = "/",
) -> None:
    """Register a POST endpoint on *app* that wraps *agent* as an AG-UI SSE stream.

    The full AG-UI conversation history is replayed into the agent on every
    request, so the agent has multi-turn context. The agent's memory is reset to
    the state captured here (its system prompt and any construction-time seeding)
    before each request, keeping the endpoint stateless and the client the source
    of truth for history.
    """
    baseline = _capture_baseline(agent)
    lock = asyncio.Lock()
    # Holds the worker future of the most recent run so the next run can wait for
    # it to drain before rebuilding the shared agent memory (see _event_stream).
    # Shared across requests and guarded by ``lock``.
    pending_run: dict[str, Any] = {"future": None}

    @app.post(path)
    async def swarms_endpoint(body: RunAgentInput, request: Request):
        encoder = EventEncoder(accept=request.headers.get("accept"))
        return StreamingResponse(
            _event_stream(agent, body, encoder, baseline, lock, pending_run),
            media_type=encoder.get_content_type(),
        )
