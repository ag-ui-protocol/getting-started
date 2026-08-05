"""Shared limits."""

TOOL_RESULT_MAX_CHARS = 4000
"""Tool results can be large; the UI only needs a readable prefix."""

SEARCH_RESULT_PREVIEW_CHARS = 300
"""Search result bodies can be long; show only a readable prefix."""

TOOL_NAME_MAX_LENGTH = 128
"""Managed Agents tool names allow only [A-Za-z0-9_-], up to this many chars."""

TOOL_DESCRIPTION_MAX_LENGTH = 4096
"""Tool descriptions are capped by the API at 1-4096 characters."""

IN_MEMORY_SESSION_STORE_MAX_ENTRIES = 10_000
"""How many thread-to-session mappings the default in-memory store keeps.

Thread ids are client-supplied, so the map has to be bounded; past this the
least-recently-used mapping is evicted and that thread starts a fresh session on
its next run."""

PARKED_RETRY_DELAYS_S: tuple[float, ...] = (0.15, 0.3, 0.6, 1.0, 1.5, 2.0)
"""Backoff for re-posting follow-up messages while a session finishes
un-parking (an asynchronous transition after a tool result). Six retries
after the first attempt: seven attempts total."""

DEFAULT_TURN_TIMEOUT_S = 5 * 60.0
"""Interrupt a turn that runs longer than this unless configured otherwise."""

BEST_EFFORT_SEND_TIMEOUT_S = 15.0
"""Bound on best-effort sends that must survive the run's own cancellation
(tool results, confirmations): long enough for a healthy API call, short
enough that a stalled connection cannot hold the thread's run gate open."""
