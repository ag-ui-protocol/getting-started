"""Reconcile frontend (proxy) tool results into a Strands ``SessionManager``.

Frontend tools are executed on the client, so server-side the proxy returns a
placeholder ``toolResult`` (``"Forwarded to client"``). The real result only
arrives on the next run inside ``RunAgentInput.messages``, keyed by the client's
wire ``tool_call_id`` — which differs from the native ``toolUseId`` Strands
persisted. The adapter records that wire->native mapping durably on the agent's
session state (see ``AG_UI_WIRE_MAP_STATE_KEY``), so this module can find the
persisted placeholder by native id and overwrite it with the real result.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping, Tuple

from .client_proxy_tool import PROXY_RESULT_PLACEHOLDER

# Key under which the adapter stores the ``{wire_tool_call_id: native_toolUseId}``
# map on the Strands agent's session state. Namespaced to avoid clashing with
# user-managed state keys.
AG_UI_WIRE_MAP_STATE_KEY = "__ag_ui_wire_to_native__"

# Key under which the adapter stores every ``toolUseId`` tool call metadata
# (name, args, input, strands_tool_id) on the Strands agent's session state.
# On a native-interrupt RESUME run Strands does not re-invoke the model for the
# interrupted tool, so no ``current_tool_use`` events fire and the in-run
# ``tool_calls_seen`` dict is empty when the ``toolResult`` arrives. Reading
# from this durable map at that point restores ``tool_name`` (and thus every
# ``tool_behaviors`` gate + the frontend-placeholder skip) for the resumed
# tool. Namespaced to avoid clashing with user-managed state keys.
AG_UI_TOOL_CALL_MAP_STATE_KEY = "__ag_ui_tool_call_map__"


def _supports_repository_reconciliation(session_manager: Any, agent: Any) -> bool:
    """Return whether the exact public repository rewrite API is available."""
    if session_manager is None:
        return False
    try:
        session_id = session_manager.session_id
        repository = session_manager.session_repository
        agent_id = agent.agent_id
        list_messages = getattr(repository, "list_messages", None)
        update_message = getattr(repository, "update_message", None)
    except Exception:  # noqa: BLE001 - unsafe/missing capability fails closed
        return False
    return (
        isinstance(session_id, str)
        and bool(session_id)
        and isinstance(agent_id, str)
        and bool(agent_id)
        and callable(list_messages)
        and callable(update_message)
    )

def resolve_native_ids(
    wire_to_native: Mapping[str, str],
    frontend_results: Iterable[Mapping[str, Any]],
) -> dict[str, Tuple[str, bool]]:
    """Map client frontend results to Strands-native ``toolUseId``s.

    Frontend tools are emitted under a fresh wire ``tool_call_id`` that differs
    from the native ``toolUseId`` Strands persists. ``wire_to_native`` is the
    durable map recorded at emission on the agent's session state and restored
    on a continuation run (works cross-process and for delta-only payloads,
    since it is keyed on the wire id the client always sends). Results whose
    wire id is not in the map are dropped — the caller then degrades to the
    legacy path rather than guessing.

    Args:
        wire_to_native: Map of wire ``tool_call_id`` -> native ``toolUseId``.
        frontend_results: Items with ``wire_id``, ``text`` and ``is_error``.

    Returns:
        Map of native ``toolUseId`` -> ``(real result text, is_error)``
        (unresolvable dropped). The flag travels with the text so the
        reconciled ``toolResult`` can carry the client's failure signal, not
        just its output.
    """
    resolved: dict[str, Tuple[str, bool]] = {}
    for result in frontend_results:
        native = wire_to_native.get(result.get("wire_id"))
        if native is not None:
            resolved[native] = (
                result.get("text", ""),
                bool(result.get("is_error")),
            )
    return resolved


def reconcile_frontend_tool_results(
    session_manager: Any,
    agent: Any,
    pending_results: Mapping[str, Tuple[str, bool]],
) -> set[str]:
    """Overwrite persisted placeholder ``toolResult`` blocks with real results.

    ``pending_results`` MUST be keyed by the Strands-native ``toolUseId`` (use
    :func:`resolve_native_ids` to translate client wire ids first).

    Args:
        session_manager: A Strands ``RepositorySessionManager`` (exposes
            ``session_id`` and ``session_repository``).
        agent: The Strands agent (exposes ``agent_id``).
        pending_results: Map of native ``toolUseId`` -> ``(real result text,
            is_error)``.

    Returns:
        The set of ``toolUseId``s whose pending result was already present or
        whose placeholder was corrected in any reconciliation surface.
    """
    session_id = session_manager.session_id
    agent_id = agent.agent_id
    repository = session_manager.session_repository

    corrected: set[str] = set()
    for session_message in repository.list_messages(session_id, agent_id):
        mutated: set[str] = set()
        matched = _correct_message(
            session_message.message, pending_results, mutated_ids=mutated
        )
        if mutated:
            repository.update_message(session_id, agent_id, session_message)
        corrected |= matched

    # Correct the agent's live in-memory history too, so a same-process
    # continuation run (and ``stream_async(None)``) sees the real result
    # rather than the placeholder.
    for message in getattr(agent, "messages", None) or []:
        corrected |= _correct_message(message, pending_results)

    # Once an interrupt is active, failure to correct its parked results must
    # reach the adapter so it can stop before Strands consumes the checkpoint.
    interrupt_state = getattr(agent, "_interrupt_state", None)
    if interrupt_state is not None and getattr(interrupt_state, "activated", False):
        tool_results = interrupt_state.context.get("tool_results")
        if tool_results:
            corrected |= _correct_all_tools(tool_results, pending_results)

    return corrected


def has_placeholder_results(messages: Iterable[Any], only_ids: Any = None) -> bool:
    """Return True if a matching ``toolResult`` is still the proxy stub.

    Used to gate the continuation stream: it is only safe to replay the native
    history to the model (``stream_async(None)``) when no relevant ``"Forwarded
    to client"`` placeholder remains to be fed to it.

    Args:
        messages: The native Strands history to scan.
        only_ids: If given, restrict the scan to ``toolResult`` blocks whose
            ``toolUseId`` is in this set — so stale placeholders from prior
            turns (e.g. intentionally-uncorrected void calls) don't count.
    """
    for message in messages or []:
        if not isinstance(message, dict):
            continue
        for block in message.get("content") or []:
            if not isinstance(block, dict):
                continue
            tool_result = block.get("toolResult")
            if not isinstance(tool_result, dict):
                continue
            if only_ids is not None and tool_result.get("toolUseId") not in only_ids:
                continue
            if _is_placeholder(tool_result.get("content")):
                return True
    return False


def active_proxy_placeholder_ids(agent: Any) -> set[str]:
    """Return ids for exact proxy placeholders parked by an active checkpoint."""
    interrupt_state = getattr(agent, "_interrupt_state", None)
    if interrupt_state is None or not getattr(interrupt_state, "activated", False):
        return set()
    context = getattr(interrupt_state, "context", None)
    if not isinstance(context, Mapping):
        return set()
    tool_results = context.get("tool_results")
    if not isinstance(tool_results, list):
        return set()

    return {
        tool_result["toolUseId"]
        for tool_result in tool_results
        if isinstance(tool_result, dict)
        and set(tool_result) == {"toolUseId", "status", "content"}
        and isinstance(tool_result["toolUseId"], str)
        and bool(tool_result["toolUseId"].strip())
        and tool_result["status"] == "success"
        and tool_result["content"] == [{"text": PROXY_RESULT_PLACEHOLDER}]
    }


def _correct_single_tool(
    tool_result,
    pending_results: Mapping[str, Tuple[str, bool]],
    *,
    mutated_ids: set[str] | None = None,
) -> str | None:
    """Reconcile a matching ToolResult dict and return its tool_use_id."""
    if not isinstance(tool_result, dict):
        return None

    tool_use_id = tool_result.get("toolUseId")
    if tool_use_id not in pending_results:
        return None

    text, is_error = pending_results[tool_use_id]
    expected_content = [{"text": text}]
    expected_status = "error" if is_error else "success"
    if (
        tool_result.get("status") == expected_status
        and tool_result.get("content") == expected_content
    ):
        return tool_use_id
    if _is_placeholder(tool_result.get("content")):
        tool_result["content"] = expected_content
        tool_result["status"] = expected_status
        if mutated_ids is not None:
            mutated_ids.add(tool_use_id)
        return tool_use_id


def _correct_all_tools(
    tool_results, pending_results: Mapping[str, Tuple[str, bool]]
) -> set[str]:
    """Reconcile matching ToolResult dicts in *tool_results* in place."""
    changed: set[str] = set()
    for tool_result in tool_results:
        tool_use_id = _correct_single_tool(tool_result, pending_results)
        if tool_use_id:
            changed.add(tool_use_id)
    return changed


def _correct_message(
    message: Any,
    pending_results: Mapping[str, Tuple[str, bool]],
    *,
    mutated_ids: set[str] | None = None,
) -> set[str]:
    """Reconcile matching ``toolResult`` blocks in *message* in place.

    Both the text and the status are rewritten: the placeholder was written by
    the proxy tool with a hardcoded ``"success"`` (see ``client_proxy_tool``),
    so leaving the status alone would assert a failed frontend tool to the
    model as a success.

    Returns the set of ``toolUseId``s whose block was already real or corrected.
    """
    if not isinstance(message, dict):
        return set()
    changed: set[str] = set()
    for block in message.get("content") or []:
        if not isinstance(block, dict):
            continue
        tool_result = block.get("toolResult")
        tool_use_id = _correct_single_tool(
            tool_result, pending_results, mutated_ids=mutated_ids
        )
        if tool_use_id:
            changed.add(tool_use_id)
    return changed


def _is_placeholder(content: Any) -> bool:
    """Return True if *content* is the proxy's ``"Forwarded to client"`` stub."""
    if not isinstance(content, list):
        return False
    return any(
        isinstance(block, dict) and block.get("text") == PROXY_RESULT_PLACEHOLDER
        for block in content
    )
