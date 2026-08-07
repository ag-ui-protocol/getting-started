"""Thread-to-session stores."""

from collections import OrderedDict
from copy import deepcopy

from .constants import IN_MEMORY_SESSION_STORE_MAX_ENTRIES
from .types import SessionRecord


class InMemorySessionStore:
    """In-memory thread-to-session store. Mappings are lost on restart.

    Bounded: thread ids come from the client, so an unbounded dict is a memory
    leak an untrusted caller controls. Once `max_entries` is reached the
    least-recently-used mapping is dropped -- which costs that thread its
    history (the next run starts a fresh session), so a deployment that cannot
    afford that should supply a persistent store instead.
    """

    def __init__(self, max_entries: int = IN_MEMORY_SESSION_STORE_MAX_ENTRIES) -> None:
        if max_entries < 1:
            raise ValueError("max_entries must be a positive integer")
        self._max_entries = max_entries
        self._records: OrderedDict[str, SessionRecord] = OrderedDict()

    def get(self, key: str) -> SessionRecord | None:
        record = self._records.get(key)
        if record is None:
            return None
        self._records.move_to_end(key)
        # Hand out a copy: the agent mutates records in place between
        # persists, so an aliased record would make an unpersisted mutation
        # indistinguishable from a persisted one — and a dropped write would
        # only surface against a real out-of-process store.
        return deepcopy(record)

    def set(self, key: str, record: SessionRecord) -> None:
        self._records[key] = deepcopy(record)
        self._records.move_to_end(key)
        while len(self._records) > self._max_entries:
            self._records.popitem(last=False)

    def delete(self, key: str) -> None:
        self._records.pop(key, None)

    def __len__(self) -> int:
        """How many mappings are currently held."""
        return len(self._records)
