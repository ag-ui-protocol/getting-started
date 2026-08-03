"""A stand-in for a real out-of-process session store.

Every read and write crosses a serialization boundary, so the agent can never
observe an unpersisted in-place mutation through a record it handed the store.
The write log makes the persistence points of a run directly assertable.
"""

from dataclasses import asdict

from ag_ui_claude_managed_agents.types import SessionRecord


class RecordingSessionStore:
    """A `SessionStore` that snapshots every record it stores."""

    def __init__(self) -> None:
        self._records: dict[str, dict] = {}
        self.writes: list[tuple[str, SessionRecord]] = []
        """Every record written, in order, as an independent snapshot."""
        self.deletes: list[str] = []
        self.set_error: BaseException | None = None
        """When set, `set` raises this instead of writing."""

    def get(self, thread_id: str) -> SessionRecord | None:
        stored = self._records.get(thread_id)
        return None if stored is None else SessionRecord(**stored)

    def set(self, thread_id: str, record: SessionRecord) -> None:
        if self.set_error is not None:
            raise self.set_error
        snapshot = asdict(record)
        self._records[thread_id] = snapshot
        self.writes.append((thread_id, SessionRecord(**snapshot)))

    def delete(self, thread_id: str) -> None:
        self._records.pop(thread_id, None)
        self.deletes.append(thread_id)

    def keys(self) -> list[str]:
        """The keys currently holding a record."""
        return list(self._records)
