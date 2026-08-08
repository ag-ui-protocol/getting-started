"""Shares one Go ``localharness`` process between many conversations.

Why this exists
---------------
A harness process is configured twice, at two different moments, and almost
everything this integration varies per thread lands in the *second* one:

* ``InputConfig`` -- written to the process' stdin at ``Popen`` time, so it is
  fixed for the process' whole life: ``storage_directory`` (``save_dir``) and
  ``env``.
* ``HarnessConfig`` -- sent over the WebSocket in an
  ``InitializeConversationEvent``, once **per conversation**: tools, system
  instructions, model, capabilities, MCP servers, hooks, subagents,
  ``response_schema``, ``cascade_id`` -- and ``workspaces``, so per-thread
  filesystem isolation survives pooling intact.

So N conversations can share one process as long as they agree on
``(binary_path, save_dir, env)``, which is this pool's partition key.

Where this sits in the SDK
--------------------------
``google/antigravity/connections/README.md`` assigns process lifecycle to the
Connection layer: ``ConnectionStrategy`` "handles process management, transport
setup, authentication, and health checking specific to a backend type". So
pooling is implemented here by overriding ``__aenter__``/``__aexit__`` on a
strategy subclass and nothing else. ``Agent``, ``Conversation``,
``LocalConnection``, the event processor and tool/hook dispatch are all used
unmodified -- notably ``Agent.__aenter__``'s mandatory-safety guard, which we
therefore cannot accidentally drop.

Caveat worth knowing: no Google doc states that one process may host several
conversations. The wire protocol is shaped for it and ``LocalConnection`` takes
``process: Popen | None`` in its public constructor, but treat it as a capability
the harness has rather than a contract it owes us. ``max_conversations_per_process=1``
reproduces the old one-process-per-conversation behaviour and is the escape
hatch if a future SDK breaks this.
"""

from __future__ import annotations

import asyncio
import collections
import logging
import os
import platform
import struct
import time
from typing import Any, Deque, Dict, List, Optional, Tuple

import websockets
from google.antigravity.connections import connection
from google.antigravity.connections.local import event_processor, local_connection
from google.antigravity.connections.local.local_connection import (
    LocalConnectionStrategy,
)
from google.antigravity.proto import localharness_pb2
from google.protobuf import json_format

logger = logging.getLogger(__name__)

try:  # pragma: no cover - trivial
    from importlib.metadata import version as _pkg_version

    _SDK_VERSION = _pkg_version("google-antigravity")
except Exception:  # pragma: no cover - the harness only logs this
    _SDK_VERSION = "unknown"

_WS_CONNECT_ATTEMPTS = 5
_STDERR_TAIL_LINES = 40

PartitionKey = Tuple[str, str, Optional[Tuple[Tuple[str, str], ...]]]


class HarnessPoolClosed(RuntimeError):
    """Raised when a lease is requested from a pool that has been shut down."""


class HarnessProcessDied(RuntimeError):
    """Raised when the shared harness process exits underneath its conversations."""


def _partition_key(
    *, binary_path: str, save_dir: Optional[str], env: Optional[Dict[str, str]]
) -> PartitionKey:
    """Groups processes by everything that is fixed at ``Popen`` time.

    Conversations may only share a process when all three agree, because these
    are exactly the fields ``InputConfig`` and ``Popen`` consume. In this
    integration all three are instance-level constants on ``AntigravityAgent``,
    so there is one partition in practice -- keyed anyway so the invariant is
    structural rather than incidental.
    """
    env_key = tuple(sorted((str(k), str(v)) for k, v in env.items())) if env else None
    return (binary_path, save_dir or "", env_key)


class _HarnessProcess:
    """One ``localharness`` process, plus the conversations leased against it."""

    def __init__(
        self,
        *,
        process: asyncio.subprocess.Process,
        port: int,
        api_key: str,
        key: PartitionKey,
        capacity: int,
    ):
        self._process = process
        self._port = port
        self._api_key = api_key
        self.key = key
        self.capacity = capacity
        self.leases = 0
        self.idle_since: Optional[float] = time.monotonic()
        self.dead = asyncio.Event()
        # Only the *tail* is kept: the harness is chatty and this exists to
        # explain a crash, not to mirror its whole log.
        self._stderr_tail: Deque[str] = collections.deque(maxlen=_STDERR_TAIL_LINES)
        self._host: Optional[str] = None
        self._stderr_task = asyncio.create_task(self._drain_stderr())
        self._monitor_task = asyncio.create_task(self._monitor())

    # ------------------------------------------------------------------
    # Boot
    # ------------------------------------------------------------------

    @classmethod
    async def start(
        cls,
        *,
        binary_path: str,
        save_dir: Optional[str],
        env: Optional[Dict[str, str]],
        capacity: int,
        boot_timeout: float,
    ) -> "_HarnessProcess":
        """Boots a harness and completes its stdin/stdout config handshake.

        Mirrors ``LocalConnectionStrategy.__aenter__``, with one deliberate
        difference: this uses asyncio subprocesses so booting a process never
        blocks the event loop while other conversations are streaming. The SDK
        does the same reads synchronously.
        """
        env_map = {str(k): str(v) for k, v in (env or {}).items()}
        merged_env = {**os.environ, **env_map} if env is not None else None

        input_config = localharness_pb2.InputConfig(
            storage_directory=save_dir or "",
            client_info=localharness_pb2.ClientInfo(
                language="python",
                version=_SDK_VERSION,
                language_version=platform.python_version(),
                os=platform.system().lower(),
                os_version=platform.release(),
            ),
            env=env_map,
        )

        process = await asyncio.create_subprocess_exec(
            binary_path,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=merged_env,
        )
        try:
            blob = input_config.SerializeToString()
            # 4-byte little-endian length prefix, then the serialized config.
            process.stdin.write(struct.pack("<I", len(blob)) + blob)
            await process.stdin.drain()
            # stdin deliberately stays open: closing it tells the Go main loop
            # to exit, which is how shutdown is signalled.

            async def _read_output_config() -> localharness_pb2.OutputConfig:
                raw_len = await process.stdout.readexactly(4)
                (length,) = struct.unpack("<I", raw_len)
                out = localharness_pb2.OutputConfig()
                out.ParseFromString(await process.stdout.readexactly(length))
                return out

            output_config = await asyncio.wait_for(
                _read_output_config(), timeout=boot_timeout
            )
        except BaseException as exc:
            stderr = await cls._drain_now(process)
            process.kill()
            await process.wait()
            raise RuntimeError(
                f"The Antigravity harness failed to start ({binary_path}). "
                f"Stderr: {stderr}"
            ) from exc

        logger.info(
            "Started a pooled Antigravity harness on port %d (capacity %d)",
            output_config.port,
            capacity,
        )
        return cls(
            process=process,
            port=output_config.port,
            api_key=output_config.api_key,
            key=_partition_key(binary_path=binary_path, save_dir=save_dir, env=env),
            capacity=capacity,
        )

    @staticmethod
    async def _drain_now(process: asyncio.subprocess.Process) -> str:
        """Best-effort stderr read for a boot failure message."""
        if process.stderr is None:
            return ""
        try:
            data = await asyncio.wait_for(process.stderr.read(), timeout=2)
            return data.decode("utf-8", "replace").strip()
        except (asyncio.TimeoutError, Exception):  # pragma: no cover - diagnostics
            return ""

    # ------------------------------------------------------------------
    # Sockets
    # ------------------------------------------------------------------

    async def open_socket(self) -> Any:
        """Opens one WebSocket to this process, for one conversation.

        Retries with the SDK's own shape: ``localhost`` first, ``127.0.0.1`` as
        a fallback (some environments do not resolve ``localhost``), with
        exponential backoff, because a freshly booted harness needs a moment to
        start listening.
        """
        if self.dead.is_set():
            raise HarnessProcessDied(
                "The shared Antigravity harness process is no longer running."
            )
        hosts = [self._host] if self._host else ["localhost", "127.0.0.1"]
        last: Optional[BaseException] = None
        for attempt in range(_WS_CONNECT_ATTEMPTS):
            for host in hosts:
                try:
                    ws = await websockets.connect(
                        f"ws://{host}:{self._port}/",
                        additional_headers={"x-goog-api-key": self._api_key},
                        max_size=None,
                    )
                except (OSError, websockets.WebSocketException) as exc:
                    last = exc
                else:
                    self._host = host
                    return ws
            await asyncio.sleep(0.1 * (2**attempt))
        raise HarnessProcessDied(
            f"Could not open a WebSocket to the pooled harness on port "
            f"{self._port} after {_WS_CONNECT_ATTEMPTS} attempts. "
            f"Stderr tail: {self.stderr_tail()}"
        ) from last

    # ------------------------------------------------------------------
    # Health
    # ------------------------------------------------------------------

    async def _drain_stderr(self) -> None:
        """Owns the process' stderr.

        The unpooled path ends with ``connection._start_stderr_reader(...)``, so
        one connection drains it. With N conversations there is no owning
        connection, so the pool must -- otherwise harness diagnostics vanish
        exactly when a crash needs explaining.
        """
        if self._process.stderr is None:  # pragma: no cover - always a pipe here
            return
        try:
            while True:
                line = await self._process.stderr.readline()
                if not line:
                    return
                text = line.decode("utf-8", "replace").rstrip()
                self._stderr_tail.append(text)
                logger.debug("[harness:%d] %s", self._port, text)
        except asyncio.CancelledError:
            raise
        except Exception:  # pragma: no cover - diagnostics must never crash us
            logger.debug("Stopped reading harness stderr", exc_info=True)

    async def _monitor(self) -> None:
        """Marks the process dead the moment it exits.

        Conversations learn about it through their own closed WebSocket, but the
        pool must stop placing new leases here regardless.
        """
        try:
            code = await self._process.wait()
        except asyncio.CancelledError:
            raise
        self.dead.set()
        if self.leases:
            logger.error(
                "The pooled Antigravity harness on port %d exited (code %s) with "
                "%d live conversation(s). Stderr tail: %s",
                self._port,
                code,
                self.leases,
                self.stderr_tail(),
            )
        else:
            logger.info(
                "The pooled Antigravity harness on port %d exited (code %s)",
                self._port,
                code,
            )

    def stderr_tail(self) -> str:
        return " | ".join(self._stderr_tail)

    @property
    def has_capacity(self) -> bool:
        return not self.dead.is_set() and self.leases < self.capacity

    # ------------------------------------------------------------------
    # Teardown
    # ------------------------------------------------------------------

    async def terminate(self) -> None:
        """Stops the process the way the SDK does: close stdin, then escalate."""
        for task in (self._monitor_task, self._stderr_task):
            task.cancel()
        if self._process.returncode is None:
            try:
                if self._process.stdin is not None:
                    self._process.stdin.close()
            except Exception:  # pragma: no cover - already-broken pipe
                logger.debug("Could not close harness stdin", exc_info=True)
            try:
                await asyncio.wait_for(self._process.wait(), timeout=5)
            except asyncio.TimeoutError:
                self._process.terminate()
                try:
                    await asyncio.wait_for(self._process.wait(), timeout=1)
                except asyncio.TimeoutError:
                    self._process.kill()
                    await self._process.wait()
        self.dead.set()
        for task in (self._monitor_task, self._stderr_task):
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass


class HarnessLease:
    """One conversation's claim on a slot of a shared harness process."""

    def __init__(self, pool: "HarnessPool", process: _HarnessProcess):
        self._pool = pool
        self._process = process
        self._released = False

    @property
    def process_dead(self) -> asyncio.Event:
        return self._process.dead

    async def open_socket(self) -> Any:
        return await self._process.open_socket()

    def stderr_tail(self) -> str:
        return self._process.stderr_tail()

    async def release(self) -> None:
        """Returns the slot. Idempotent: the strategy releases on both paths."""
        if self._released:
            return
        self._released = True
        await self._pool._release(self._process)


class HarnessPool:
    """Hands out conversation slots on shared ``localharness`` processes."""

    def __init__(
        self,
        *,
        max_conversations_per_process: int = 8,
        idle_grace_seconds: float = 30.0,
        boot_timeout_seconds: float = 60.0,
    ):
        """Creates a pool.

        Args:
          max_conversations_per_process: Slots per process. Chosen for blast
            radius -- one dead process takes every conversation on it -- not for
            memory, where the ceiling is far higher. ``1`` reproduces
            one-process-per-conversation.
          idle_grace_seconds: How long a process with no conversations is kept
            before being reaped, so a burst of short sessions does not thrash
            process startup.
        """
        if max_conversations_per_process < 1:
            raise ValueError(
                "max_conversations_per_process must be at least 1, got "
                f"{max_conversations_per_process}"
            )
        self._capacity = max_conversations_per_process
        self._idle_grace = idle_grace_seconds
        self._boot_timeout = boot_timeout_seconds
        self._lock = asyncio.Lock()
        self._processes: Dict[PartitionKey, List[_HarnessProcess]] = {}
        self._closed = False
        self._reaper: Optional[asyncio.Task] = None

    # A pool is a handle on live OS processes, so copying one is never
    # meaningful -- the copy would hand out leases on processes the original
    # believes it owns. This is not hypothetical: ``Agent.__init__`` runs
    # ``config.model_copy(deep=True)``, which silently gave every Agent its own
    # pool and defeated pooling entirely until these were added.
    def __copy__(self) -> "HarnessPool":
        return self

    def __deepcopy__(self, memo: Dict[int, Any]) -> "HarnessPool":
        memo[id(self)] = self
        return self

    # ------------------------------------------------------------------
    # Leases
    # ------------------------------------------------------------------

    async def acquire(
        self,
        *,
        binary_path: str,
        save_dir: Optional[str] = None,
        env: Optional[Dict[str, str]] = None,
    ) -> HarnessLease:
        """Places a conversation on a process with a free slot, booting if none."""
        if self._closed:
            raise HarnessPoolClosed("The Antigravity harness pool is shut down.")
        key = _partition_key(binary_path=binary_path, save_dir=save_dir, env=env)
        async with self._lock:
            bucket = self._processes.setdefault(key, [])
            # Drop any process that died since we last looked before placing.
            bucket[:] = [p for p in bucket if not p.dead.is_set()]
            process = next((p for p in bucket if p.has_capacity), None)
            if process is None:
                process = await _HarnessProcess.start(
                    binary_path=binary_path,
                    save_dir=save_dir,
                    env=env,
                    capacity=self._capacity,
                    boot_timeout=self._boot_timeout,
                )
                bucket.append(process)
            process.leases += 1
            process.idle_since = None
            self._ensure_reaper()
            return HarnessLease(self, process)

    async def _release(self, process: _HarnessProcess) -> None:
        async with self._lock:
            process.leases = max(0, process.leases - 1)
            if process.leases == 0:
                process.idle_since = time.monotonic()
                if process.dead.is_set():
                    self._forget(process)

    def _forget(self, process: _HarnessProcess) -> None:
        bucket = self._processes.get(process.key)
        if bucket and process in bucket:
            bucket.remove(process)
        if bucket is not None and not bucket:
            self._processes.pop(process.key, None)

    # ------------------------------------------------------------------
    # Reaping
    # ------------------------------------------------------------------

    def _ensure_reaper(self) -> None:
        if self._reaper is None or self._reaper.done():
            self._reaper = asyncio.create_task(self._reap_loop())

    async def _reap_loop(self) -> None:
        # Half the grace period, floored only enough to avoid a busy loop --
        # a higher floor would silently override a short configured grace.
        interval = max(0.1, self._idle_grace / 2)
        while not self._closed:
            try:
                await asyncio.sleep(interval)
                await self._reap_once()
            except asyncio.CancelledError:
                raise
            except Exception:  # pragma: no cover - a reap failure must not kill the loop
                logger.exception("Error reaping idle Antigravity harnesses")

    async def _reap_once(self) -> None:
        now = time.monotonic()
        doomed: List[_HarnessProcess] = []
        async with self._lock:
            for bucket in list(self._processes.values()):
                for process in list(bucket):
                    if process.leases:
                        continue
                    if process.dead.is_set() or (
                        process.idle_since is not None
                        and now - process.idle_since > self._idle_grace
                    ):
                        self._forget(process)
                        doomed.append(process)
        for process in doomed:
            await process.terminate()
        if doomed:
            logger.info("Reaped %d idle Antigravity harness process(es)", len(doomed))

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def shutdown(self) -> None:
        """Terminates every process, including ones still holding conversations."""
        self._closed = True
        if self._reaper is not None:
            self._reaper.cancel()
            try:
                await self._reaper
            except (asyncio.CancelledError, Exception):
                pass
            self._reaper = None
        async with self._lock:
            processes = [p for bucket in self._processes.values() for p in bucket]
            self._processes.clear()
        for process in processes:
            await process.terminate()

    def stats(self) -> Dict[str, Any]:
        processes = [p for bucket in self._processes.values() for p in bucket]
        return {
            "processes": len(processes),
            "conversations": sum(p.leases for p in processes),
            "max_conversations_per_process": self._capacity,
            "partitions": len(self._processes),
        }


# ----------------------------------------------------------------------
# The strategy seam
# ----------------------------------------------------------------------


class PooledStrategy(connection.ConnectionStrategy):
    """A ``ConnectionStrategy`` that shares a harness process instead of owning one.

    This replaces only the backend *lifecycle* -- the two methods whose
    documented job it is -- and delegates everything else to the strategy the
    SDK built. Config translation, the event processor, tool and hook dispatch,
    ``Agent``, ``Conversation`` and ``LocalConnection`` are all used unmodified.

    A wrapper rather than a subclass for two reasons: ``create_strategy``
    constructs its strategy inline with fifteen keyword arguments, and forking
    that list here would silently drift on an SDK upgrade; and CPython refuses
    ``__class__`` assignment between these classes ("object layout differs"), so
    repointing an already-built strategy is not available either.
    """

    def __init__(
        self, inner: Any, *, pool: HarnessPool, init_timeout: float = 60.0
    ):
        self._inner = inner
        self._pool = pool
        self._init_timeout = init_timeout
        self._lease: Optional[HarnessLease] = None

    def __getattr__(self, name: str) -> Any:
        # Only reached for attributes this wrapper does not define.
        return getattr(self._inner, name)

    @property
    def inner(self) -> Any:
        return self._inner

    @property
    def debug_config(self) -> Any:
        return self._inner.debug_config

    def connect(self) -> Any:
        return self._inner.connect()

    async def __aenter__(self) -> None:
        inner = self._inner
        inner._validate_connection()
        # Polymorphic on purpose: the OpenAI strategy overrides this.
        harness_config = inner._build_harness_config()
        if not inner._conversation_id:
            # An empty cascade_id tells the harness to mint a new conversation.
            harness_config.ClearField("cascade_id")

        lease = await self._pool.acquire(
            binary_path=inner._binary_path,
            save_dir=inner._save_dir,
            env=inner._env,
        )
        self._lease = lease
        ws = None
        try:
            ws = await lease.open_socket()
            await ws.send(
                json_format.MessageToJson(
                    localharness_pb2.InitializeConversationEvent(config=harness_config)
                )
            )
            raw = await asyncio.wait_for(ws.recv(), timeout=self._init_timeout)
            out = localharness_pb2.OutputEvent()
            json_format.Parse(raw, out)
            response = out.initialize_conversation_response
            # Rehydrates history for cold resume. preserving_proto_field_name
            # and the LocalConnectionStep hop are how the SDK does it; getting
            # either wrong breaks resume in a way fresh-conversation tests miss.
            initial_history = [
                event_processor.LocalConnectionStep.from_dict(
                    json_format.MessageToDict(step, preserving_proto_field_name=True)
                )
                for step in response.history
            ]
        except BaseException as exc:
            # The unpooled path calls process.kill() here. Doing that would
            # destroy every sibling conversation on this process.
            if ws is not None:
                try:
                    await asyncio.wait_for(ws.close(), timeout=1)
                except (asyncio.TimeoutError, Exception):
                    pass
            self._lease = None
            await lease.release()
            if isinstance(exc, Exception):
                raise RuntimeError(
                    "Failed to initialize a conversation on the pooled "
                    f"Antigravity harness. Stderr tail: {lease.stderr_tail()}"
                ) from exc
            raise

        # Set on the inner strategy so its own connect() keeps working.
        inner._connection = local_connection.LocalConnection(
            process=None,  # pooled: this connection must not own the process
            ws=ws,
            tool_runner=inner._tool_runner,
            hook_runner=inner._hook_runner,
            initial_history=initial_history,
            env=inner._env,
            debug_config=inner._debug_config,
        )
        # No _start_stderr_reader: stderr is process-wide and the pool drains it.

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        inner = self._inner
        try:
            if getattr(inner, "_connection", None) is not None:
                # Closes this conversation's WebSocket only, because process is
                # None -- LocalConnection.disconnect() guards every process
                # operation on it.
                await inner._connection.disconnect()
                inner._connection = None
        finally:
            lease, self._lease = self._lease, None
            if lease is not None:
                await lease.release()


def to_pooled(strategy: Any, *, pool: HarnessPool) -> PooledStrategy:
    """Wraps a freshly built strategy so it shares a process.

    Refuses anything whose startup we would be bypassing. Two checks, both
    deliberate:

    * it must be a ``LocalConnectionStrategy`` (the OpenAI strategy subclasses
      it), since the pooled path reproduces exactly that class' handshake;
    * it must not override ``__aenter__``, because that would mean it does
      backend setup this wrapper knows nothing about. ``LiteRTConnectionStrategy``
      is precisely that case -- it boots an OpenAI server first.
    """
    if not isinstance(strategy, LocalConnectionStrategy):
        raise RuntimeError(
            "google-antigravity changed which connection strategy it builds: "
            f"expected a LocalConnectionStrategy, got {type(strategy).__name__}. "
            "Harness pooling reproduces that class' startup handshake, so it "
            "cannot safely pool this one. Re-check harness_pool.py."
        )
    if type(strategy).__aenter__ is not LocalConnectionStrategy.__aenter__:
        raise RuntimeError(
            f"{type(strategy).__name__} overrides __aenter__, so it performs "
            "backend startup that harness pooling would silently skip. Pool "
            "this strategy only after reproducing that startup, or construct "
            "the agent with max_conversations_per_process=1."
        )
    return PooledStrategy(strategy, pool=pool)
