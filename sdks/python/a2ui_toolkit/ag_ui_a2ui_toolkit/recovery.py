"""A2UI error-recovery loop (OSS-162) — Python port of ``recovery.ts``.

Synchronous to match the synchronous LangGraph tool. The toolkit cannot
bind/invoke a model, so the adapter supplies ``invoke_subagent`` (its model call)
and ``build_envelope`` (its prepared create/update context); this module owns the
validate→retry loop using the SAME ``validate_a2ui_components`` the middleware
uses, so the tool's retry decision and the middleware's paint decision agree.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Optional

from .validate import validate_a2ui_components

# Default attempt cap (initial try + retries). Configurable per call.
MAX_A2UI_ATTEMPTS = 3

# Activity type the middleware/client use for the recovery status channel.
A2UI_RECOVERY_ACTIVITY_TYPE = "a2ui_recovery"

_NO_TOOL_CALL_ERROR = {
    "code": "empty_components",
    "path": "components",
    "message": "Sub-agent did not call render_a2ui",
}


def format_validation_errors(errors: list[dict[str, str]]) -> str:
    """Render structured errors as a compact, model-readable list."""
    return "\n".join(f"- [{e['code']}] {e['path']}: {e['message']}" for e in errors)


def augment_prompt_with_validation_errors(prompt: str, errors: list[dict[str, str]]) -> str:
    """Append a fix-it block describing the prior attempt's errors. No-op when empty."""
    if not errors:
        return prompt
    return (
        f"{prompt}\n\n## Previous attempt was invalid — fix these and regenerate:\n"
        f"{format_validation_errors(errors)}\n"
    )


def _wrap_recovery_exhausted_envelope(max_attempts: int, attempts: list[dict[str, Any]]) -> str:
    return json.dumps(
        {
            "error": f"Failed to generate valid A2UI after {max_attempts} attempt(s)",
            "code": "a2ui_recovery_exhausted",
            "attempts": attempts,
        }
    )


def run_a2ui_generation_with_recovery(
    *,
    base_prompt: str,
    invoke_subagent: Callable[[str, int], Optional[dict[str, Any]]],
    build_envelope: Callable[[dict[str, Any]], str],
    catalog: Optional[dict[str, Any]] = None,
    config: Optional[dict[str, Any]] = None,
    on_attempt: Optional[Callable[[dict[str, Any]], None]] = None,
) -> dict[str, Any]:
    """Drive the validate→retry loop.

    Returns ``{"envelope", "attempts", "ok"}``: the validated operations envelope
    on success, or a structured ``a2ui_recovery_exhausted`` envelope once the cap
    is hit. Never retries an attempt whose components validated.
    """
    max_attempts = (config or {}).get("maxAttempts", MAX_A2UI_ATTEMPTS)
    attempts: list[dict[str, Any]] = []
    last_errors: list[dict[str, str]] = []

    for attempt in range(1, max_attempts + 1):
        prompt = augment_prompt_with_validation_errors(base_prompt, last_errors)
        args = invoke_subagent(prompt, attempt)

        if not args:
            record = {"attempt": attempt, "ok": False, "errors": [_NO_TOOL_CALL_ERROR]}
            attempts.append(record)
            if on_attempt:
                on_attempt(record)
            last_errors = record["errors"]
            continue

        raw_components = args.get("components")
        components = raw_components if isinstance(raw_components, list) else []
        raw_data = args.get("data")
        data = raw_data if isinstance(raw_data, dict) else {}
        result = validate_a2ui_components(components=components, data=data, catalog=catalog)
        record = {"attempt": attempt, "ok": result["valid"], "errors": result["errors"]}
        attempts.append(record)
        if on_attempt:
            on_attempt(record)

        if result["valid"]:
            return {"envelope": build_envelope(args), "attempts": attempts, "ok": True}
        last_errors = result["errors"]

    return {"envelope": _wrap_recovery_exhausted_envelope(max_attempts, attempts), "attempts": attempts, "ok": False}
