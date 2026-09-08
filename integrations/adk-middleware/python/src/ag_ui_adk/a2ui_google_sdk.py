"""Google A2UI Agent SDK reuse for the ADK adapter (OSS-158).

Reuses the two parts of Google's ``a2ui-agent-sdk`` that are independent of its
(strict, conformance-grade) validator and therefore safe to use with the
client-supplied catalog as-is:

  - ``render_catalog_instructions`` — the prompt/catalog rendering half of
    ``A2uiSchemaManager.generate_system_prompt`` (``get_selected_catalog`` +
    ``catalog.render_as_llm_instructions``). It serializes the catalog — including
    the bundled v0.9 server-to-client envelope and the **common-types
    definitions** the client-injected catalog only *references* — into a prompt
    block, so the sub-agent sees what ``{path: …}`` bindings, ``{event: …}`` actions
    and ``DynamicString`` actually are. It does NOT resolve ``$ref``\\s, so it
    tolerates the client's (non-conformant) zod-extracted catalog; on any failure
    it returns ``None`` and the caller falls back to the raw catalog text.
  - ``heal_json_arg`` — ``parse_and_fix`` healing (smart quotes, trailing commas,
    single-object wrap) for Gemini's free-form JSON-string ``components``/``data``.

NOTE: the strict ``A2uiValidator`` is deliberately NOT used. The client-injected
catalog is a zod-extracted representation whose component-rooted ``$ref``\\s don't
resolve under a strict resolver, and authoring a separate conformant catalog
server-side drifts from what the client renders. So validation stays with the
toolkit's structural/lenient validator (parity with the LangGraph A2UI demos);
catalog conformance is tracked as a separate upstream (web_core / CopilotKit) item.

IMPORT DISCIPLINE: imports ONLY the A2A-free subset of ``a2ui`` (``a2ui.schema``,
``a2ui.parser``, ``a2ui.basic_catalog``) — never ``a2ui.a2a``, ``a2ui.adk``, or
``a2a``. Enforced by ``tests/test_a2ui_import_hygiene.py``.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Optional

from a2ui.parser.payload_fixer import parse_and_fix
from a2ui.schema.catalog import CatalogConfig
from a2ui.schema.catalog_provider import A2uiCatalogProvider
from a2ui.schema.common_modifiers import remove_strict_validation
from a2ui.schema.constants import VERSION_0_9
from a2ui.schema.manager import A2uiSchemaManager

logger = logging.getLogger("ag_ui_adk")

# Server-to-client messages the adapter emits (toolkit ``assemble_ops`` →
# createSurface / updateComponents / updateDataModel). Pruning the rendered prompt
# catalog to these keeps it lean (drops deleteSurface). v0.9 ``server_to_client.json``
# ``$defs`` keys.
_PROMPT_ALLOWED_MESSAGES: tuple[str, ...] = (
    "CreateSurfaceMessage",
    "UpdateComponentsMessage",
    "UpdateDataModelMessage",
)

_DEFAULT_JSON_SCHEMA = "https://json-schema.org/draft/2020-12/schema"


class _InMemoryCatalogProvider(A2uiCatalogProvider):
    """Serves a catalog dict already held in memory (the client-injected catalog)."""

    def __init__(self, schema: dict[str, Any]) -> None:
        self._schema = schema

    def load(self) -> dict[str, Any]:
        return self._schema


def normalize_catalog_dict(
    source: Any, *, default_catalog_id: Optional[str]
) -> Optional[dict[str, Any]]:
    """Coerce a host-supplied catalog into the inline v0.9 catalog dict shape
    ``{"catalogId": str, "components": {name: json-schema}}``.

    Accepts a dict carrying ``components``; a JSON string of one; or the legacy
    middleware ``A2UIComponentSchema[]`` list ``[{name, props/properties}]``.
    ``catalogId`` is filled from ``default_catalog_id`` when absent. Returns
    ``None`` for anything unusable (empty components, wrong types, unparseable
    string).
    """
    if isinstance(source, str):
        try:
            source = json.loads(source)
        except (ValueError, TypeError):
            return None

    if isinstance(source, dict):
        components = source.get("components")
        if not isinstance(components, dict) or not components:
            return None
        catalog_id = source.get("catalogId") or default_catalog_id
        if not catalog_id:
            return None
        out = dict(source)
        out["catalogId"] = catalog_id
        out.setdefault("$schema", _DEFAULT_JSON_SCHEMA)
        return out

    if isinstance(source, list):
        components = {}
        for item in source:
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            if not isinstance(name, str) or not name:
                continue
            comp = item.get("properties") or item.get("props") or {}
            components[name] = comp if isinstance(comp, dict) else {}
        if not components or not default_catalog_id:
            return None
        return {
            "$schema": _DEFAULT_JSON_SCHEMA,
            "catalogId": default_catalog_id,
            "components": components,
        }

    return None


# Building the SchemaManager + rendering is non-trivial and the same catalog recurs
# across every run; memoize the rendered text per (canonical source, default id).
_RENDER_CACHE: dict[Any, Optional[str]] = {}


def render_catalog_instructions(
    source: Any, *, default_catalog_id: Optional[str]
) -> Optional[str]:
    """Render a host-supplied catalog into a prompt schema block via Google's
    ``render_as_llm_instructions`` (server-to-client envelope + common-types
    definitions + catalog components).

    This is render-only: it never resolves ``$ref``\\s, so it tolerates the client's
    non-conformant zod-extracted catalog. Returns the rendered text, or ``None`` if
    the catalog can't be normalized/built (the caller then falls back to the raw
    catalog text — today's behavior).
    """
    normalized = normalize_catalog_dict(source, default_catalog_id=default_catalog_id)
    if normalized is None:
        return None
    try:
        key = json.dumps(normalized, sort_keys=True)
    except (TypeError, ValueError):
        key = None
    if key is not None and key in _RENDER_CACHE:
        return _RENDER_CACHE[key]

    try:
        manager = A2uiSchemaManager(
            version=VERSION_0_9,
            catalogs=[
                CatalogConfig(
                    name="ag-ui-adk-inline",
                    provider=_InMemoryCatalogProvider(normalized),
                )
            ],
            schema_modifiers=[remove_strict_validation],
        )
        catalog = manager.get_selected_catalog().with_pruning(
            allowed_messages=list(_PROMPT_ALLOWED_MESSAGES)
        )
        instructions = catalog.render_as_llm_instructions()
    except Exception as e:  # noqa: BLE001 — render is best-effort; degrade to raw
        logger.warning(
            "Could not render the A2UI catalog via the SDK; falling back to the "
            "raw catalog text in the prompt: %s",
            e,
        )
        instructions = None

    if key is not None:
        _RENDER_CACHE[key] = instructions
    return instructions


def heal_json_arg(value: str, *, expect: str) -> Any:
    """Heal + parse Gemini's free-form JSON-string ``components``/``data`` arg via
    the SDK's ``parse_and_fix`` (smart quotes, trailing commas, single-object→list
    wrap).

    ``expect="list"`` returns the healed list; ``expect="dict"`` unwraps
    ``parse_and_fix``'s single-element list back to the object it wrapped. Raises
    ``ValueError`` on a hard parse failure or when ``expect="dict"`` but the payload
    isn't a single JSON object.
    """
    parsed = parse_and_fix(value)  # always a list (single objects are wrapped)
    if expect == "list":
        return parsed
    if isinstance(parsed, list) and len(parsed) == 1 and isinstance(parsed[0], dict):
        return parsed[0]
    if isinstance(parsed, dict):  # defensive — parse_and_fix returns a list
        return parsed
    raise ValueError("expected a single JSON object")
