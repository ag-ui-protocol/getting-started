"""Session worker for Claude Agent SDK.

Owns one ClaudeSDKClient per thread in a long-lived background task.
Uses queue-based communication to avoid receive_response() issues
on multi-turn conversations.
"""

import asyncio
import logging
from contextlib import suppress
from collections.abc import AsyncIterable
from typing import Any, AsyncIterator, Optional

logger = logging.getLogger(__name__)

_SHUTDOWN = object()


class WorkerError:
    """Sentinel to signal an error from the background worker."""
    def __init__(self, exception: Exception):
        self.exception = exception


class SessionWorker:
    """Background task owning one ClaudeSDKClient for a thread.

    The task is created by :meth:`start` and runs until :meth:`stop` is
    called (or the client errors out). Request handlers call :meth:`query`
    which bridges to the background task via a pair of asyncio queues.
    """

    def __init__(self, thread_id: str, options: Any):
        self.thread_id = thread_id
        self._options = options
        self._input_queue: asyncio.Queue = asyncio.Queue()
        self._task: Optional[asyncio.Task] = None
        self._client: Optional[Any] = None
        self.session_id: Optional[str] = None
        # Every output queue that has an in-flight consumer waiting on it. A
        # query's queue is registered the instant it is enqueued (in ``query``)
        # and deregistered once its terminal ``None`` sentinel has been pushed.
        # On fatal worker death we fan out a terminal signal to ALL of these so a
        # peer/queued query whose item never got serviced cannot hang forever.
        self._inflight_queues: set[asyncio.Queue] = set()

    async def start(self) -> None:
        """Spawn the background task that owns the SDK client."""
        if self._task is not None:
            return
        self._task = asyncio.create_task(
            self._run(), name=f"session-worker-{self.thread_id}"
        )
        # If the background task dies for any reason (including a path that does
        # not flow through the fatal-error branch, e.g. cancellation), make sure
        # every still-waiting consumer gets a terminal signal rather than
        # hanging on a queue nothing will ever drain.
        self._task.add_done_callback(self._on_task_done)

    def _fanout_terminal(self, exc: Exception) -> None:
        """Push WorkerError(exc) + the None sentinel to EVERY in-flight output
        queue, then clear the registry. Idempotent per queue: a queue is removed
        from the registry as soon as its own ``finally`` pushes its sentinel, so
        this never double-signals a queue that already terminated normally."""
        queues = list(self._inflight_queues)
        self._inflight_queues.clear()
        for q in queues:
            # ``put_nowait`` is safe: these are unbounded queues, and we are
            # off the consumer's await path.
            q.put_nowait(WorkerError(exc))
            q.put_nowait(None)

    def _on_task_done(self, task: "asyncio.Task") -> None:
        """Done-callback: if the worker task ended while consumers were still
        waiting (e.g. cancelled, or an exit path that bypassed the fatal-error
        fan-out), terminate them so they don't hang."""
        if not self._inflight_queues:
            return
        exc: Exception
        try:
            task_exc = task.exception()
        except asyncio.CancelledError:
            task_exc = None
        if task_exc is not None:
            exc = task_exc if isinstance(task_exc, Exception) else RuntimeError(str(task_exc))
        else:
            exc = RuntimeError(
                f"session worker for thread={self.thread_id} terminated "
                f"while a query was still in flight"
            )
        self._fanout_terminal(exc)

    def is_alive(self) -> bool:
        """Return True if the background task is running and able to serve queries.

        A worker whose ``_run`` task has finished (e.g. ``client.connect()``
        failed and the task fell through its ``finally``) can no longer drain
        the input queue, so reusing it would hang the next ``query()`` forever.
        Callers must treat a non-alive worker as dead and create a fresh one.
        """
        return self._task is not None and not self._task.done()

    async def _run(self) -> None:
        """Main loop — runs entirely inside one stable async context."""
        from claude_agent_sdk import ClaudeSDKClient, SystemMessage

        client = ClaudeSDKClient(options=self._options)
        self._client = client
        output_queue: Optional[asyncio.Queue] = None

        try:
            await client.connect()
            logger.debug(f"Session worker connected for thread={self.thread_id}")

            while True:
                item = await self._input_queue.get()
                if item is _SHUTDOWN:
                    break

                prompt, session_id, output_queue = item
                # ``output_queue`` is a loop-local Optional that is unconditionally
                # bound here (the ``_SHUTDOWN`` sentinel already broke out above),
                # so it is never None on the ``.put`` calls below. Narrow it for
                # the type checker (no runtime behavior change).
                assert output_queue is not None
                try:
                    await client.query(prompt, session_id=session_id)
                    async for msg in client.receive_response():
                        if isinstance(msg, SystemMessage):
                            data = getattr(msg, "data", {}) or {}
                            if getattr(msg, "subtype", "") == "init":
                                sid = data.get("session_id")
                                if sid:
                                    self.session_id = sid
                        await output_queue.put(msg)
                except Exception as exc:
                    logger.error(f"Session worker query error for thread={self.thread_id}: {exc}")
                    await output_queue.put(WorkerError(exc))
                finally:
                    await output_queue.put(None)
                    # This query terminated normally; drop it from the in-flight
                    # registry so a later fatal-death fan-out won't double-signal.
                    self._inflight_queues.discard(output_queue)

        except Exception as exc:
            logger.error(f"Session worker fatal error for thread={self.thread_id}: {exc}")
            # Fan the fatal error out to EVERY in-flight consumer — not just the
            # currently-dequeued one. A peer/queued query whose item never got
            # serviced (it is still sitting on the input queue, its output queue
            # already registered by ``query``) would otherwise hang forever on a
            # queue nothing drains. ``_fanout_terminal`` covers ``output_queue``
            # too (it is in the registry until its ``finally`` discards it).
            self._fanout_terminal(exc)
        finally:
            self._client = None
            await self._graceful_disconnect(client)
            logger.debug(f"Session worker disconnected for thread={self.thread_id}")

    @staticmethod
    async def _graceful_disconnect(client: Any) -> None:
        try:
            await client.disconnect()
        except Exception as exc:
            logger.debug(f"[SessionWorker] Graceful disconnect error (ignored): {exc}")

    async def query(
        self,
        prompt: str | AsyncIterable[dict[str, Any]],
        session_id: str = "default",
    ) -> AsyncIterator[Any]:
        """Send prompt to the worker and yield SDK Message objects."""
        output_queue: asyncio.Queue = asyncio.Queue()
        # Register the output queue in the in-flight set BEFORE enqueuing the
        # request, so that if the worker dies while this query is still queued
        # (never dequeued), the fatal-death fan-out still terminates it. The
        # worker's per-query ``finally`` (or the fan-out itself) deregisters it.
        self._inflight_queues.add(output_queue)
        await self._input_queue.put((prompt, session_id, output_queue))
        while True:
            item = await output_queue.get()
            if item is None:
                return
            if isinstance(item, WorkerError):
                raise item.exception
            yield item

    async def interrupt(self) -> None:
        """Forward an interrupt signal to the underlying SDK client."""
        if self._client is not None:
            try:
                await self._client.interrupt()
            except Exception as exc:
                logger.warning(f"Session worker interrupt failed: {exc}")

    async def stop(self) -> None:
        """Signal the worker to shut down and wait for it to finish."""
        if self._task is None:
            return
        await self._input_queue.put(_SHUTDOWN)
        try:
            await asyncio.wait_for(self._task, timeout=15.0)
        except asyncio.TimeoutError:
            self._task.cancel()
            with suppress(asyncio.CancelledError):
                await self._task
        self._task = None
