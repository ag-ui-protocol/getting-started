"""Shared model-turn bookkeeping for the A2UI demo flows.

Both A2UI demos loop the model over its own tool results, so both face the same
three questions each turn: which forwarded frontend tools this flow is willing to
let the client answer, which of the turn's tool calls can be answered at all, and
what to persist for the ones that cannot. Kept here so the fixed-schema and
subagent-driven turns cannot drift apart.
"""

import logging

logger = logging.getLogger("ag_ui_crewai")


def _action_name(action):
    """The function name of one forwarded frontend tool, or ``None`` when the
    entry is not a well-formed function-tool schema."""
    if not isinstance(action, dict):
        return None
    function = action.get("function")
    if not isinstance(function, dict):
        return None
    name = function.get("name")
    return name if isinstance(name, str) and name else None


def frontend_tool_names(actions) -> list[str]:
    """Names of the frontend tools forwarded on this run (``copilotkit.actions``).
    The client executes these and sends the result back on the next run."""
    return [name for name in (_action_name(a) for a in actions or []) if name]


def resolve_client_tools(actions, *, backend_names=(), drop_names=()):
    """Split the forwarded frontend tools into ``(offered, client_names)``: the
    entries to keep on the model's tool list, and the names the client is allowed
    to answer.

    Two forwarded names are NOT the client's to answer, even though the frontend
    sent them:

    - one this flow SWAPPED OUT (``drop_names``). The a2ui middleware forwards its
      render proxy and auto-injection replaces it with the generate tool, so the
      proxy is not on the model's tool list at all. Treating a call to it as
      client-owned would end the run with that call intact and let the client
      paint the surface directly, skipping the validate/retry recovery loop the
      generate tool exists to run. With no injection there is nothing to drop and
      the same proxy stays a perfectly ordinary frontend tool.
    - one a backend tool of this flow already owns. The model can only be offered
      one tool per name, and the backend half is the half that executes it, so the
      backend takes precedence and the frontend action is dropped from the tool
      list. Logged rather than resolved silently: the forwarded action is dead
      either way, which is a wiring bug worth seeing.

    An entry with no readable name is left on the tool list untouched: it can
    neither collide nor be answered by name.
    """
    drop = set(drop_names or ())
    backend = set(backend_names or ())
    offered, client_names, shadowed = [], set(), set()
    for action in actions or []:
        name = _action_name(action)
        if name is None:
            offered.append(action)
            continue
        if name in drop:
            continue
        if name in backend:
            shadowed.add(name)
            continue
        offered.append(action)
        client_names.add(name)
    if shadowed:
        logger.warning(
            "Frontend tool(s) %s share a name with a backend tool of this flow; "
            "the backend tool wins and the frontend action will never be called. "
            "Rename one side.",
            ", ".join(sorted(shadowed)),
        )
    return offered, client_names


def sort_tool_calls(tool_calls, *, backend_names, client_names):
    """Sort one model turn's tool calls into ``(backend, client, orphan)``.

    ``backend`` this flow executes; ``client`` the frontend answers on the next
    run; ``orphan`` names neither side knows (a hallucinated tool, or one this
    flow swapped out), so nothing will ever answer them. Each bucket holds
    ``(index, call)`` pairs indexed into ``tool_calls``, so a caller can drop the
    orphans from the assistant message positionally.
    """
    backend, client, orphan = [], [], []
    for index, call in enumerate(tool_calls):
        name = call.function.name
        if name in backend_names:
            backend.append((index, call))
        elif name in client_names:
            client.append((index, call))
        else:
            orphan.append((index, call))
    if orphan:
        logger.warning(
            "Model called %s, which neither this flow nor the frontend can run; "
            "dropping the call rather than persisting it unanswered",
            ", ".join(call.function.name for _, call in orphan),
        )
    return backend, client, orphan


def append_assistant_message(state, response, message, *, drop_indexes=()):
    """Persist the streamed assistant message, minus the tool calls at
    ``drop_indexes``.

    Stamps the streamed message id onto the persisted message so the terminal
    MESSAGES_SNAPSHOT updates it in place instead of re-appending it (a fresh id
    would re-anchor the tool-call chip AFTER the already-streamed surface
    activity, dropping the tool card to the end).

    A dropped call is one nothing will answer. Persisting it would leave an
    assistant ``tool_calls`` entry with no matching ``role="tool"`` result, and
    the chat-completions API rejects that on every later run of the thread (the
    Responses channel drops such calls for the same reason).

    Returns the persisted dict, or ``None`` when there was nothing to persist:
    every tool call was dropped, or the turn was empty to begin with (a stream
    that produced no text and no call at all). ``content`` and ``tool_calls`` are
    the only payload the stream helpers put on an assistant message - reasoning is
    streamed as its own message - so a turn with neither carries nothing, and
    persisting it would replay an empty assistant message to the model on every
    later run of the thread.
    """
    assistant = message.model_dump()
    stream_id = getattr(response, "id", None)
    if stream_id:
        assistant["id"] = stream_id
    if drop_indexes:
        assistant["tool_calls"] = [
            call
            for index, call in enumerate(assistant.get("tool_calls") or [])
            if index not in drop_indexes
        ] or None
    if not assistant.get("tool_calls") and not assistant.get("content"):
        return None
    state["messages"].append(assistant)
    return assistant
