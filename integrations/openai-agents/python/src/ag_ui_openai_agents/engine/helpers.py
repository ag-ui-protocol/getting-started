"""Internal helpers shared by both translator directions.

These are deliberately tiny, side-effect-free, and dependency-light so they
can be reused by either translator without coupling them.
"""

import json
import logging
import uuid
from typing import Any

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# ID generation
# ---------------------------------------------------------------------------

def new_message_id() -> str:
    """Generate a fresh AG-UI message id (msg_<hex>)."""
    return f"msg_{uuid.uuid4().hex}"


def new_reasoning_id() -> str:
    """Generate a fresh reasoning id (rs_<hex>, matching the wire prefix)."""
    return f"rs_{uuid.uuid4().hex}"


def new_tool_call_id() -> str:
    """Generate a fresh tool call id (call_<hex>)."""
    return f"call_{uuid.uuid4().hex}"


def new_tool_result_id(call_id: str) -> str:
    """Derive the tool result message id (<call_id>-result).

    Deterministic — the wire has no id on function_call_output, so the
    result id is derived from the call_id it answers. Hyphen never
    appears in wire ids, marking the suffix as ours.

    Args:
        call_id: The tool call id being answered.

    Returns:
        The derived result message id.
    """
    return f"{call_id}-result"


# ---------------------------------------------------------------------------
# Polymorphic attribute / value reading
# ---------------------------------------------------------------------------

def read_attr(obj: Any, name: str) -> Any:
    """Read a field from a pydantic model or a dict — whichever we got.

    The SDK and AG-UI both hand us a mix of dicts and pydantic objects
    depending on whether something has been through JSON serialization
    yet. This shields callers from caring.

    Args:
        obj: A pydantic model, a dict, or None.
        name: The field/key name to read.

    Returns:
        The field value, or None if obj is None or the field is missing.
    """
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def to_string(value: Any) -> str:
    """Best-effort stringification for tool outputs and content payloads.

    Args:
        value: Any value — string, None, or JSON-serializable object.

    Returns:
        A string representation, empty string for None.
    """
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    # Pydantic models are a common tool return type; serialize their fields
    # rather than falling through to an opaque quoted repr via default=str.
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        try:
            value = model_dump()
        except Exception as exc:  # noqa: BLE001 — never let stringification raise
            logger.debug("model_dump() failed during stringification: %s", exc)
    try:
        return json.dumps(value, default=str)
    except (TypeError, ValueError):
        return str(value)


__all__ = [
    "new_message_id",
    "new_reasoning_id",
    "new_tool_call_id",
    "new_tool_result_id",
    "read_attr",
    "to_string",
]
