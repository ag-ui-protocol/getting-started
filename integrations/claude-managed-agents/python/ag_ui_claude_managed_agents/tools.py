"""Turn AG-UI and backend tool definitions into managed-agent custom tools."""

import json
import re
from collections.abc import Sequence
from typing import Any

from .constants import TOOL_DESCRIPTION_MAX_LENGTH, TOOL_NAME_MAX_LENGTH

_NAME_PATTERN = re.compile(rf"[A-Za-z0-9_-]{{1,{TOOL_NAME_MAX_LENGTH}}}")
_INVALID_CHAR = re.compile(r"[^A-Za-z0-9_-]")


def normalize_tool_name(name: str) -> str:
    """Managed Agents tool names allow only [A-Za-z0-9_-], max 128 chars.

    Distinct names can normalize to the same value (e.g. "search web" and
    "search_web"); callers key tools by normalized name and let the last one win.
    """
    if _NAME_PATTERN.fullmatch(name):
        return name
    return _INVALID_CHAR.sub("_", name)[:TOOL_NAME_MAX_LENGTH] or "tool"


def _input_schema(parameters: Any) -> dict[str, Any]:
    """The AG-UI tool's JSON Schema, as a managed-agent input schema.

    The caller's schema is passed through whole: `$defs`, `$ref`, `oneOf`,
    `additionalProperties`, per-property descriptions and any other keyword
    survive. Copying only `properties` and `required` used to drop the rest --
    which silently invalidated every `$ref` whose `$defs` went with it -- so
    anything the API accepts must reach it intact.

    `type` is the one field forced: the API accepts object input schemas only.
    """
    if not isinstance(parameters, dict):
        return {"type": "object", "properties": {}}
    return {**parameters, "type": "object"}


def custom_tool_from(tool: Any) -> dict[str, Any]:
    """An AG-UI (frontend) or backend tool definition -> managed-agent custom tool.

    Accepts anything with `name`, `description`, and `parameters` attributes.
    """
    name = tool.name
    description = getattr(tool, "description", None)
    return {
        "type": "custom",
        "name": normalize_tool_name(name),
        "description": (description or f"Tool {name}")[:TOOL_DESCRIPTION_MAX_LENGTH],
        "input_schema": _input_schema(getattr(tool, "parameters", None)),
    }


def tools_fingerprint(tools: Sequence[Any]) -> str:
    """Canonical representation used to detect any change to a session's tool list.

    Fingerprints whatever list is actually registered on the session -- base
    tools included, not just the custom ones -- because an override session's
    list is a full replacement frozen at the last update: a Console edit to the
    agent's own tools changes what the session should hold without changing any
    custom tool.
    """
    return json.dumps(
        list(tools), sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str
    )
