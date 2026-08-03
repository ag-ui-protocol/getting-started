"""Small internal helpers."""

import asyncio
import inspect
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from .constants import BEST_EFFORT_SEND_TIMEOUT_S

_logger = logging.getLogger("ag_ui_claude_managed_agents")


async def maybe_await(value: Any) -> Any:
    """Await `value` if it is awaitable (session-store methods may be sync or async)."""
    if inspect.isawaitable(value):
        return await value
    return value


def get(obj: Any, name: str, default: Any = None) -> Any:
    """Read `name` from a Managed Agents event, which may be a model or a dict."""
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def observe_task(task: "asyncio.Task[Any] | asyncio.Future[Any]") -> None:
    """Consume a background task's outcome so an eventual failure never
    surfaces as an "exception was never retrieved" warning."""
    if not task.cancelled():
        task.exception()


# Work that must outlive the frame that started it: best-effort sends, worker
# threads, and error-hook coroutines scheduled from a synchronous frame. Strong
# references only — asyncio keeps weak ones and would let the loop drop them
# mid-flight.
_background_work: set["asyncio.Future[Any]"] = set()


def _finish_background_work(task: "asyncio.Future[Any]") -> None:
    _background_work.discard(task)
    observe_task(task)


def track_background_work(task: "asyncio.Future[Any]") -> None:
    """Keep `task` referenced until it finishes, then consume its outcome."""
    _background_work.add(task)
    task.add_done_callback(_finish_background_work)


def schedule_detached(coro: "Awaitable[None]") -> None:
    """Run `coro` without awaiting it, from a frame that cannot await.

    Used for the error hook on synchronous paths: an un-scheduled coroutine
    would never run at all, so the telemetry would silently not happen.
    """
    try:
        task = asyncio.ensure_future(coro)
    except RuntimeError:
        # No running loop, so nothing can run it. Close the coroutine rather
        # than leaving a "never awaited" warning behind.
        close = getattr(coro, "close", None)
        if close is not None:
            close()
        return
    track_background_work(task)


def _describe(ids: dict[str, Any]) -> str:
    """` (sessionId=..., threadId=...)`, or empty when nothing is known."""
    known = {k: v for k, v in ids.items() if v is not None}
    return f" ({', '.join(f'{k}={v}' for k, v in known.items())})" if known else ""


async def report_swallowed_failure(
    on_error: Callable[[BaseException, dict[str, Any]], Awaitable[None] | None] | None,
    operation: str,
    error: BaseException,
    *,
    timeout_s: float = BEST_EFFORT_SEND_TIMEOUT_S,
    **ids: Any,
) -> None:
    """Hand a swallowed failure to the error hook.

    A broken hook must never break the run, and an async hook is a broken hook
    waiting to happen: calling one without awaiting it leaves a coroutine that
    never runs (and a "coroutine was never awaited" warning), so the telemetry
    the operator was relying on silently does not happen. An awaitable result is
    therefore awaited here, and both a synchronous raise and an asynchronous one
    are swallowed.

    The await is bounded, because the hook is consumer code on the run's critical
    path and gets the same bound as any other best-effort call. Without one, a
    hook that never settles (an `await` on a host that blackholes the connection)
    would hold the caller forever: the run's terminal event would never be
    emitted and the thread's run gate would never be released, so every later run
    on that thread would be refused for the process's lifetime. Abandoning the
    hook is the lesser loss -- the telemetry is best-effort, the run is not.
    """
    if on_error is None:
        # No hook configured -- the default. Without this the cause would be
        # discarded outright, because RUN_ERROR deliberately carries no
        # third-party text: an operator with a rotated API key would see "The run
        # failed." and an empty log. Logged server-side, never sent to the
        # client, so the redaction the client relies on is untouched.
        _logger.warning(
            "%s failed%s", operation, _describe(ids), exc_info=error
        )
        return
    try:
        pending = on_error(error, {"operation": operation, **ids})
    except Exception:  # noqa: BLE001 - a broken hook is not the run's problem
        return
    if not inspect.isawaitable(pending):
        return
    try:
        await asyncio.wait_for(pending, timeout_s)
    except asyncio.CancelledError:
        # Only the run's own teardown may propagate. A `CancelledError` raised
        # inside the hook (a telemetry client cancelling its own future) is the
        # hook's failure, not the run's, and the other two ports swallow it --
        # letting it out here would skip the terminal event the caller emits next.
        task = asyncio.current_task()
        if task is not None and task.cancelling() > 0:
            raise
        return
    except Exception:  # noqa: BLE001 - a broken hook is not the run's problem, nor is its timeout
        return
