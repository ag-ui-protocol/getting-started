"""Unit tests for harness process pooling.

These run without a harness: process startup is faked so placement, capacity,
reaping and the SDK-compatibility guards can be tested in CI. The properties
that need a real harness -- isolation, cold resume, process death, parking --
live in ``test_harness_pool_live.py``.
"""

from __future__ import annotations

import asyncio
import copy

import pytest
from google.antigravity import Agent, LocalAgentConfig, LocalOpenAIAgentConfig
from google.antigravity.connections.local.local_connection import (
    LocalConnectionStrategy,
)
from google.antigravity.hooks import hook_runner as hook_runner_lib
from google.antigravity.hooks import policy
from google.antigravity.tools import tool_runner as tool_runner_lib

from ag_ui_antigravity.agent import (
    AntigravityAgent,
    _PooledLocalAgentConfig,
    _PooledResumableOpenAIConfig,
)
from ag_ui_antigravity.harness_pool import (
    HarnessPool,
    _HarnessProcess,
    HarnessPoolClosed,
    PooledStrategy,
    _partition_key,
    to_pooled,
)


class _FakeProcess:
    """Stands in for a booted harness. Mirrors what HarnessPool touches."""

    def __init__(self, key, capacity):
        self.key = key
        self.capacity = capacity
        self.leases = 0
        self.idle_since = None
        self.dead = asyncio.Event()
        self.terminated = False

    @property
    def has_capacity(self) -> bool:
        return not self.dead.is_set() and self.leases < self.capacity

    async def terminate(self) -> None:
        self.terminated = True
        self.dead.set()

    async def open_socket(self):  # pragma: no cover - live tests cover the real one
        raise AssertionError("fake process has no socket")

    def stderr_tail(self) -> str:
        return ""


@pytest.fixture
def fake_pool(monkeypatch):
    """A pool whose processes are fakes, so nothing is spawned."""
    started = []

    async def _start(*, binary_path, save_dir, env, capacity, boot_timeout):
        process = _FakeProcess(
            _partition_key(binary_path=binary_path, save_dir=save_dir, env=env),
            capacity,
        )
        started.append(process)
        return process

    monkeypatch.setattr(
        "ag_ui_antigravity.harness_pool._HarnessProcess.start", _start
    )
    return started


def _pool(**kwargs) -> HarnessPool:
    kwargs.setdefault("idle_grace_seconds", 1000)  # never reap mid-test
    return HarnessPool(**kwargs)


async def _acquire(pool, *, save_dir="/save", env=None, binary="/bin/harness"):
    return await pool.acquire(binary_path=binary, save_dir=save_dir, env=env)


# ----------------------------------------------------------------------
# The Agent.model_copy trap
# ----------------------------------------------------------------------


def test_pool_survives_deep_copy_by_identity():
    """``Agent.__init__`` deep-copies its config, which must not clone the pool.

    A cloned pool hands out leases on processes the original believes it owns,
    so every Agent silently gets its own process and pooling does nothing.
    """
    pool = _pool()
    assert copy.deepcopy(pool) is pool
    assert copy.copy(pool) is pool


def test_agent_construction_preserves_the_pool():
    """The regression test for the above, through the real SDK code path."""
    pool = _pool()
    config = _PooledLocalAgentConfig(
        harness_pool=pool, policies=[policy.allow_all()]
    )
    agent = Agent(config)
    # Agent stores config.model_copy(deep=True); the pool must come through
    # by identity or pooling is silently disabled.
    assert agent._config.harness_pool is pool


def test_adapter_reuses_one_save_dir_across_sessions():
    """``save_dir`` is fixed at process start, so it must be stable.

    Left to the SDK, each config calls ``tempfile.mkdtemp()``, which would put
    every session in its own pool partition (a process each) and break cold
    resume, which restores from ``conversation_id`` + ``save_dir``.
    """
    adapter = AntigravityAgent(model="m")
    first = adapter._resolved_save_dir()
    second = adapter._resolved_save_dir()
    assert first == second

    explicit = AntigravityAgent(model="m", save_dir="/tmp/explicit-save")
    assert explicit._resolved_save_dir() == "/tmp/explicit-save"


# ----------------------------------------------------------------------
# Partitioning
# ----------------------------------------------------------------------


def test_partition_key_separates_process_scoped_settings():
    base = dict(binary_path="/bin/h", save_dir="/s", env=None)
    assert _partition_key(**base) == _partition_key(**base)
    assert _partition_key(**{**base, "save_dir": "/other"}) != _partition_key(**base)
    assert _partition_key(**{**base, "binary_path": "/other"}) != _partition_key(**base)
    assert _partition_key(**{**base, "env": {"A": "1"}}) != _partition_key(**base)
    # Ordering of env must not create a spurious partition.
    assert _partition_key(
        binary_path="/bin/h", save_dir="/s", env={"A": "1", "B": "2"}
    ) == _partition_key(binary_path="/bin/h", save_dir="/s", env={"B": "2", "A": "1"})


async def test_different_save_dirs_do_not_share_a_process(fake_pool):
    pool = _pool()
    await _acquire(pool, save_dir="/one")
    await _acquire(pool, save_dir="/two")
    assert pool.stats()["processes"] == 2
    assert pool.stats()["partitions"] == 2


# ----------------------------------------------------------------------
# Placement and capacity
# ----------------------------------------------------------------------


async def test_conversations_share_one_process(fake_pool):
    pool = _pool(max_conversations_per_process=8)
    for _ in range(5):
        await _acquire(pool)
    assert pool.stats() == {
        "processes": 1,
        "conversations": 5,
        "max_conversations_per_process": 8,
        "partitions": 1,
    }


async def test_spills_to_a_new_process_at_capacity(fake_pool):
    pool = _pool(max_conversations_per_process=2)
    for _ in range(5):
        await _acquire(pool)
    assert pool.stats()["processes"] == 3  # 2 + 2 + 1
    assert pool.stats()["conversations"] == 5


async def test_max_one_per_process_is_supported(fake_pool):
    """The documented escape hatch back to one process per conversation."""
    pool = _pool(max_conversations_per_process=1)
    for _ in range(3):
        await _acquire(pool)
    assert pool.stats()["processes"] == 3
    assert pool.stats()["conversations"] == 3


def test_real_process_capacity_accounting():
    """Covers the real ``_HarnessProcess.has_capacity``.

    The fake above reimplements it, so the placement tests alone cannot catch a
    regression here -- a mutation removing the ``leases < capacity`` term left
    every other test in this file passing.
    """
    # __new__ so no subprocess is spawned and no background tasks are started.
    process = _HarnessProcess.__new__(_HarnessProcess)
    process.dead = asyncio.Event()
    process.capacity = 2
    process.leases = 0
    assert process.has_capacity
    process.leases = 1
    assert process.has_capacity
    process.leases = 2
    assert not process.has_capacity, "capacity must bound placement"
    process.leases = 0
    process.dead.set()
    assert not process.has_capacity, "a dead process must never be placed on"


def test_zero_capacity_is_rejected():
    with pytest.raises(ValueError, match="at least 1"):
        HarnessPool(max_conversations_per_process=0)


async def test_released_slot_is_reused(fake_pool):
    pool = _pool(max_conversations_per_process=1)
    lease = await _acquire(pool)
    await lease.release()
    await _acquire(pool)
    # The freed slot is taken rather than a second process booted.
    assert pool.stats()["processes"] == 1
    assert pool.stats()["conversations"] == 1


async def test_release_is_idempotent(fake_pool):
    """The strategy releases on both the error path and __aexit__."""
    pool = _pool()
    lease = await _acquire(pool)
    await lease.release()
    await lease.release()
    assert pool.stats()["conversations"] == 0


async def test_dead_process_is_not_handed_out(fake_pool):
    pool = _pool(max_conversations_per_process=8)
    lease = await _acquire(pool)
    fake_pool[0].dead.set()
    await lease.release()
    await _acquire(pool)
    assert len(fake_pool) == 2, "a dead process must not be reused"


# ----------------------------------------------------------------------
# Reaping and shutdown
# ----------------------------------------------------------------------


async def test_idle_process_is_reaped_after_the_grace_period(fake_pool):
    pool = HarnessPool(max_conversations_per_process=4, idle_grace_seconds=0.2)
    lease = await _acquire(pool)
    await lease.release()
    assert pool.stats()["processes"] == 1
    await asyncio.sleep(1.0)
    assert pool.stats()["processes"] == 0
    assert fake_pool[0].terminated
    await pool.shutdown()


async def test_busy_process_is_not_reaped(fake_pool):
    pool = HarnessPool(max_conversations_per_process=4, idle_grace_seconds=0.2)
    await _acquire(pool)  # never released
    await asyncio.sleep(1.0)
    assert pool.stats()["processes"] == 1
    assert not fake_pool[0].terminated
    await pool.shutdown()


async def test_shutdown_terminates_everything(fake_pool):
    pool = _pool(max_conversations_per_process=1)
    for _ in range(3):
        await _acquire(pool)
    await pool.shutdown()
    assert pool.stats()["processes"] == 0
    assert all(p.terminated for p in fake_pool)


async def test_acquire_after_shutdown_is_refused(fake_pool):
    pool = _pool()
    await pool.shutdown()
    with pytest.raises(HarnessPoolClosed):
        await _acquire(pool)


# ----------------------------------------------------------------------
# SDK compatibility guards
# ----------------------------------------------------------------------


def _build_strategy(config):
    return config.create_strategy(
        tool_runner=tool_runner_lib.ToolRunner(tools=[]),
        hook_runner=hook_runner_lib.HookRunner(),
    )


def test_both_shipped_strategies_are_poolable():
    """Pooling reproduces ``LocalConnectionStrategy.__aenter__``.

    If either config starts building a strategy that overrides it, the pooled
    path would skip real backend startup -- so this must fail loudly rather
    than silently stop sharing processes.
    """
    for config in (
        LocalAgentConfig(policies=[policy.allow_all()]),
        LocalOpenAIAgentConfig(
            model="m", base_url="http://x", policies=[policy.allow_all()]
        ),
    ):
        strategy = _build_strategy(config)
        assert isinstance(strategy, LocalConnectionStrategy)
        assert type(strategy).__aenter__ is LocalConnectionStrategy.__aenter__, (
            f"{type(strategy).__name__} now overrides __aenter__; harness "
            "pooling would skip its backend startup."
        )


def test_harness_config_is_still_buildable_and_polymorphic():
    """Pooling calls ``_build_harness_config`` and clears ``cascade_id``."""
    native = _build_strategy(LocalAgentConfig(policies=[policy.allow_all()]))
    openai = _build_strategy(
        LocalOpenAIAgentConfig(
            model="m", base_url="http://x", policies=[policy.allow_all()]
        )
    )
    for strategy in (native, openai):
        config = strategy._build_harness_config()
        assert hasattr(config, "cascade_id")
        config.ClearField("cascade_id")
        assert config.cascade_id == ""
    # The OpenAI path must keep its own override, or pooling would send the
    # wrong model wiring.
    assert type(openai)._build_harness_config is not (
        LocalConnectionStrategy._build_harness_config
    )


def test_pooled_configs_return_a_pooled_strategy():
    pool = _pool()
    for config in (
        _PooledLocalAgentConfig(harness_pool=pool, policies=[policy.allow_all()]),
        _PooledResumableOpenAIConfig(
            model="m",
            base_url="http://x",
            harness_pool=pool,
            policies=[policy.allow_all()],
        ),
    ):
        strategy = _build_strategy(config)
        assert isinstance(strategy, PooledStrategy)
        assert strategy._pool is pool
        # Delegation must reach the wrapped strategy's own attributes.
        assert strategy.inner is not None
        assert strategy._binary_path


def test_to_pooled_rejects_a_foreign_strategy():
    class NotLocal:
        pass

    with pytest.raises(RuntimeError, match="LocalConnectionStrategy"):
        to_pooled(NotLocal(), pool=_pool())


def test_to_pooled_rejects_a_strategy_with_its_own_startup():
    """``LiteRTConnectionStrategy`` is exactly this case: it boots a server."""

    class CustomStartup(LocalConnectionStrategy):
        async def __aenter__(self) -> None:  # pragma: no cover - never run
            pass

    strategy = CustomStartup(
        tool_runner=tool_runner_lib.ToolRunner(tools=[]),
        hook_runner=hook_runner_lib.HookRunner(),
    )
    with pytest.raises(RuntimeError, match="overrides __aenter__"):
        to_pooled(strategy, pool=_pool())
