"""Tool approval — a *backend*-owned tool gated by the SDK's own approval API.

Unlike :mod:`human_in_the_loop` (a frontend-only tool with no server
implementation) and :mod:`backend_tool_rendering` (a server tool that always
runs), ``issue_refund`` here is real server-side logic that only runs after a
human approves it — the SDK's ``needs_approval=True`` mechanism
(``agents.tool.function_tool``), not an AG-UI concept.

Mechanically: when the model calls ``issue_refund``, the SDK stops the run
*before* the tool body executes and surfaces a ``ToolApprovalItem`` on
``result.interruptions``. That only becomes known once the stream is fully
drained — there is no mid-stream event for it — so it can't go through the
normal per-item translator dispatch the way ``MCPApprovalRequestItem`` does.
The example's run loop checks
``result.interruptions`` right after ``to_agui()`` finishes, and if any are
pending:

1. Serializes the paused run via ``result.to_state()`` and keeps it
   server-side, keyed by ``thread_id`` (an in-memory dict here — a real app
   would use a session store; this survives one process, not a restart).
2. Emits one ``CustomEvent(name="approval_request")`` carrying every
   interruption, as ``to_agui()``'s ``end_custom_event`` — right before
   ``RUN_FINISHED``, not after it. The client drops anything that arrives
   once a run is marked finished, so this has to land before that event,
   which means draining the raw SDK stream by hand first (interruptions
   aren't known until it's fully drained) instead of handing ``result``
   straight to ``to_agui()``.

The frontend renders Approve/Reject; either choice comes back as the next
``RunAgentInput.forwarded_props["approval"]`` (``{"call_id", "approve"}``).
The aggregate server looks up the stored state, calls ``state.approve()`` /
``state.reject()``, and resumes with ``Runner.run_streamed(agent, state)``
instead of starting fresh from ``translated.messages``.
"""

from __future__ import annotations

import logging
from typing import Any

from agents import Agent, Runner, function_tool
from fastapi import FastAPI
from fastapi.responses import StreamingResponse

from ag_ui.core import CustomEvent, EventType, RunAgentInput
from ag_ui.encoder import EventEncoder
from ag_ui_openai_agents import AGUITranslator
from ag_ui_openai_agents.engine import ClientToolPending
from .constants import DEFAULT_MODEL

logger = logging.getLogger(__name__)

# Fake order book — good enough to make "approved" visibly do something.
_ORDERS: dict[str, dict] = {
    "ORD-1001": {"amount": 49.99, "status": "paid"},
    "ORD-1002": {"amount": 129.50, "status": "paid"},
}


@function_tool(needs_approval=True)
def issue_refund(order_id: str) -> str:
    """Issue a full refund for an order. Requires human approval before running."""
    order = _ORDERS.get(order_id)
    if order is None:
        return f"No such order: {order_id}"
    order["status"] = "refunded"
    return f"Refunded ${order['amount']:.2f} for {order_id}."


def create_human_in_the_loop_approval_agent() -> Agent:
    return Agent(
        name="refund_assistant",
        model=DEFAULT_MODEL,
        instructions=(
            "You are a customer support assistant. When the user asks for a "
            "refund on an order, call issue_refund with that order id. "
            "Known orders: ORD-1001 ($49.99), ORD-1002 ($129.50). Don't ask "
            "for confirmation yourself — the approval happens outside the "
            "conversation before the tool runs."
        ),
        tools=[issue_refund],
    )


agent = create_human_in_the_loop_approval_agent()
app = FastAPI(title="Human in the loop approval AG-UI demo")
_translator = AGUITranslator()
_encoder = EventEncoder()
_pending_approvals: dict[str, object] = {}


def resolve_approval(
    store: dict[str, Any],
    thread_id: str,
    forwarded_props: Any,
) -> tuple[Any, Any, bool]:
    """Claim the paused run for this request when a matching decision arrived.

    Pops first: whoever gets here wins, so a double-clicked Approve can't
    resume the same run twice. Anything other than a decision that matches a
    pending interruption abandons the paused run and starts a fresh turn —
    the user moved on, and a thread should never be stuck waiting forever.

    ``approve`` has to be a real bool. Truthiness would read the string
    "false" as approval and run a refund the user declined, so a malformed
    decision is treated as no decision at all.

    Args:
        store: thread_id -> paused RunState.
        thread_id: The thread this request belongs to.
        forwarded_props: The request's forwarded_props.

    Returns:
        (pending_state, item, approve) to resume, or (None, None, False) to
        run the request fresh.
    """
    pending_state = store.pop(thread_id, None)
    if pending_state is None:
        return None, None, False

    decision = None
    if isinstance(forwarded_props, dict):
        decision = forwarded_props.get("approval")
    if not isinstance(decision, dict):
        return None, None, False

    approve = decision.get("approve")
    if not isinstance(approve, bool):
        return None, None, False

    item = next(
        (
            item
            for item in pending_state.get_interruptions()
            if getattr(item.raw_item, "call_id", None) == decision.get("call_id")
        ),
        None,
    )
    if item is None:
        return None, None, False
    return pending_state, item, approve


@app.post("/")
async def run(body: RunAgentInput) -> StreamingResponse:
    """Run or resume the approval-gated agent."""

    pending_state, item, approve = resolve_approval(
        _pending_approvals, body.thread_id, body.forwarded_props
    )

    async def stream():
        if item is not None:
            if approve:
                pending_state.approve(item)
            else:
                pending_state.reject(item)
            result = Runner.run_streamed(agent, pending_state)
        else:
            translated = _translator.to_openai(body)
            run_agent = agent
            if translated.tools:
                run_agent = run_agent.clone(tools=[*agent.tools, *translated.tools])
            result = Runner.run_streamed(
                run_agent, input=translated.messages, context=translated.context
            )

        # Collect as we go rather than in one comprehension: whatever streamed
        # before a mid-drain stop still has to reach the client. A client-owned
        # tool ends the run cleanly here; a real failure is kept and re-raised
        # from replay() below, so to_agui sees it and handles it the same way
        # it would on any other route.
        raw_events = []
        stream_error = None
        try:
            async for event in result.stream_events():
                raw_events.append(event)
        except ClientToolPending:
            pass
        except Exception as exc:
            stream_error = exc

        end_custom_event = None
        if stream_error is None and result.interruptions:
            _pending_approvals[body.thread_id] = result.to_state()
            end_custom_event = CustomEvent(
                type=EventType.CUSTOM,
                name="approval_request",
                value=[
                    {
                        "call_id": getattr(item.raw_item, "call_id", None),
                        "tool_name": item.tool_name,
                        "arguments": getattr(item.raw_item, "arguments", None),
                    }
                    for item in result.interruptions
                ],
            )

        async def replay():
            for event in raw_events:
                yield event
            if stream_error is not None:
                raise stream_error

        try:
            async for event in _translator.to_agui(
                replay(), body, end_custom_event=end_custom_event
            ):
                yield _encoder.encode(event)
        except Exception:
            # to_agui already sent RUN_ERROR before re-raising; log the real
            # traceback here rather than let it escape the response.
            logger.exception("Agent run failed")

    return StreamingResponse(stream(), media_type=_encoder.get_content_type())
