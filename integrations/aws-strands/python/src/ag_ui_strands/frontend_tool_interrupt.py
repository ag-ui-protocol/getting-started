"""Strict helpers for frontend tools parked in Strands native interrupts."""

from __future__ import annotations

from typing import Any, Mapping

FRONTEND_TOOL_INTERRUPT_NAME = "ag_ui_frontend_tool_wait"
FRONTEND_TOOL_RESPONSE_KEY = "__ag_ui_frontend_tool_response__"


def frontend_tool_reason(tool_use_id: str) -> dict[str, str]:
    """Tag a native interrupt with its canonical Strands tool-use ID."""
    if not isinstance(tool_use_id, str) or not tool_use_id.strip():
        raise ValueError("frontend tool-use ID must be non-blank")
    return {
        "name": FRONTEND_TOOL_INTERRUPT_NAME,
        "tool_use_id": tool_use_id,
    }


def parse_frontend_tool_reason(reason: Any) -> str:
    """Return the canonical tool-use ID from one exact frontend-wait tag."""
    if not isinstance(reason, Mapping) or set(reason) != {"name", "tool_use_id"}:
        raise ValueError("malformed frontend tool interrupt reason")
    if reason["name"] != FRONTEND_TOOL_INTERRUPT_NAME:
        raise ValueError("not a frontend tool interrupt")
    return frontend_tool_reason(reason["tool_use_id"])["tool_use_id"]


def frontend_tool_response_schema() -> dict[str, Any]:
    """The payload contract for one frontend tool answer.

    A waiting frontend tool is answered by an ordinary ``ToolMessage``, which
    the adapter translates into a resume entry carrying this shape. The schema
    exists so that translated entry is validated like any other.
    """
    return {
        "type": "object",
        "properties": {
            "content": {"type": "string"},
            "error": {"type": "boolean"},
        },
        "required": ["content"],
    }


def is_frontend_tool_interrupt(interrupt: Any) -> bool:
    """Classify only interrupts carrying this adapter's reserved name."""
    return getattr(interrupt, "name", None) == FRONTEND_TOOL_INTERRUPT_NAME


def index_frontend_tool_interrupts(agent: Any) -> dict[str, Any]:
    """Index tagged native interrupts by canonical tool-use ID, without mutation."""
    state = getattr(agent, "_interrupt_state", None)
    if state is None or getattr(state, "activated", False) is not True:
        return {}
    interrupts = getattr(state, "interrupts", None)
    if not isinstance(interrupts, Mapping):
        raise ValueError("malformed Strands interrupt checkpoint")

    indexed: dict[str, Any] = {}
    for interrupt_id, interrupt in interrupts.items():
        if not isinstance(interrupt_id, str) or not interrupt_id.strip():
            raise ValueError("malformed Strands interrupt ID")
        if getattr(interrupt, "id", None) != interrupt_id:
            raise ValueError("Strands interrupt key does not match its ID")
        if not is_frontend_tool_interrupt(interrupt):
            continue
        tool_use_id = parse_frontend_tool_reason(getattr(interrupt, "reason", None))
        if tool_use_id in indexed:
            raise ValueError(f"duplicate frontend tool-use ID: {tool_use_id}")
        indexed[tool_use_id] = interrupt
    return indexed


def wrap_frontend_tool_response(
    content: str, *, is_error: bool
) -> dict[str, dict[str, Any]]:
    """Wrap every result in a truthy envelope for Strands 1.15 compatibility."""
    if not isinstance(content, str) or not isinstance(is_error, bool):
        raise TypeError(
            "frontend tool response must contain string content and boolean error status"
        )
    return {
        FRONTEND_TOOL_RESPONSE_KEY: {
            "content": content,
            "is_error": is_error,
        }
    }


def unwrap_frontend_tool_response(value: Any) -> tuple[str, bool]:
    """Unwrap only the exact response envelope emitted by this adapter."""
    if not isinstance(value, Mapping) or set(value) != {FRONTEND_TOOL_RESPONSE_KEY}:
        raise ValueError("malformed frontend tool response envelope")
    response = value[FRONTEND_TOOL_RESPONSE_KEY]
    if not isinstance(response, Mapping) or set(response) != {"content", "is_error"}:
        raise ValueError("malformed frontend tool response envelope")
    content = response["content"]
    is_error = response["is_error"]
    if not isinstance(content, str) or not isinstance(is_error, bool):
        raise ValueError("malformed frontend tool response envelope")
    return content, is_error
