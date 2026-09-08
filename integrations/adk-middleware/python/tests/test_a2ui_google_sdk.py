"""Tests for the Google A2UI Agent SDK reuse (OSS-158).

Covers the slimmed glue module (``a2ui_google_sdk``): catalog normalization,
``render_catalog_instructions`` (the prompt-rendering reuse — including that it
survives the client's non-conformant catalog, unlike strict validation), and
``parse_and_fix``-based healing; plus the adapter behaviors that engage when a
catalog is present (Google-rendered prompt + healed args). Validation itself is
the toolkit's job and is exercised in ``test_a2ui_tool.py``.
"""

from __future__ import annotations

import asyncio
import json
from typing import AsyncGenerator

import pytest
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.genai import types

from ag_ui_adk import get_a2ui_tool, CONTEXT_STATE_KEY
from ag_ui_adk.a2ui_tool import A2UI_SCHEMA_CONTEXT_DESCRIPTION
from ag_ui_adk.a2ui_google_sdk import (
    heal_json_arg,
    normalize_catalog_dict,
    render_catalog_instructions,
)


def _envelope_text(result) -> str:
    """``run_async`` returns the envelope as a dict (ADK serializes it as the
    bare envelope JSON); re-serialize for tests that assert on that text."""
    return result if isinstance(result, str) else json.dumps(result)


CID = "https://a2ui.org/demos/dojo/dynamic_catalog.json"

# A clean inline catalog (loose types, no internal $refs).
CLEAN_CATALOG = {
    "catalogId": CID,
    "components": {
        "Row": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "component": {"const": "Row"},
                "children": {},
            },
            "required": ["id", "component", "children"],
        },
        "HotelCard": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "component": {"const": "HotelCard"},
                "name": {},
            },
            "required": ["id", "component", "name"],
        },
    },
}

# A NON-conformant catalog: component-rooted #/properties ref that dangles under the
# catalog root (mirrors the zod-extracted client catalog that breaks strict validation).
NONCONFORMANT_CATALOG = {
    "catalogId": CID,
    "components": {
        "HotelCard": {
            "allOf": [
                {"$ref": "common_types.json#/$defs/ComponentCommon"},
                {
                    "properties": {
                        "component": {"const": "HotelCard"},
                        "name": {"$ref": "#/properties/accessibility/properties/label"},
                    },
                    "required": ["component", "name"],
                },
            ]
        }
    },
}


# --------------------------------------------------------------------------- #
# normalize_catalog_dict
# --------------------------------------------------------------------------- #


def test_normalize_inline_dict_injects_default_id():
    out = normalize_catalog_dict(
        {"components": CLEAN_CATALOG["components"]}, default_catalog_id="cat://x"
    )
    assert out["catalogId"] == "cat://x" and "Row" in out["components"]


def test_normalize_existing_id_wins():
    assert (
        normalize_catalog_dict(CLEAN_CATALOG, default_catalog_id="cat://other")[
            "catalogId"
        ]
        == CID
    )


def test_normalize_json_string():
    assert (
        normalize_catalog_dict(json.dumps(CLEAN_CATALOG), default_catalog_id=None)[
            "catalogId"
        ]
        == CID
    )


def test_normalize_non_json_string_returns_none():
    assert (
        normalize_catalog_dict("Card, Text, Row", default_catalog_id="cat://x") is None
    )


def test_normalize_legacy_list_form():
    out = normalize_catalog_dict(
        [{"name": "HotelCard", "props": {"name": {"type": "string"}}}],
        default_catalog_id="cat://x",
    )
    assert out["catalogId"] == "cat://x" and "HotelCard" in out["components"]


def test_normalize_empty_returns_none():
    assert normalize_catalog_dict({}, default_catalog_id="cat://x") is None
    assert normalize_catalog_dict([], default_catalog_id="cat://x") is None


# --------------------------------------------------------------------------- #
# render_catalog_instructions
# --------------------------------------------------------------------------- #


def test_render_emits_schema_block_and_components_no_tag():
    instr = render_catalog_instructions(CLEAN_CATALOG, default_catalog_id=CID)
    assert instr is not None
    # Rendered as Google's schema block (markers), carrying the components — and
    # never the tag-delivery instruction (we don't use generate_system_prompt).
    assert "---BEGIN A2UI JSON SCHEMA---" in instr
    assert "HotelCard" in instr and "Row" in instr
    assert "<a2ui-json>" not in instr


def test_render_includes_common_types_definitions_when_referenced():
    # A catalog that references common types (like the real zod-extracted client
    # catalog) gets the canonical common-types DEFINITIONS bundled into the prompt —
    # the definitions the injected catalog only references. That's the reuse value.
    instr = render_catalog_instructions(NONCONFORMANT_CATALOG, default_catalog_id=CID)
    assert instr is not None
    assert "Common Types Schema" in instr


def test_render_survives_nonconformant_catalog():
    # Strict validation chokes on this; rendering just serializes, so it must NOT.
    instr = render_catalog_instructions(NONCONFORMANT_CATALOG, default_catalog_id=CID)
    assert instr is not None and "HotelCard" in instr


def test_render_unusable_source_returns_none():
    assert (
        render_catalog_instructions("Card, Text, Row", default_catalog_id=CID) is None
    )
    assert render_catalog_instructions({}, default_catalog_id=CID) is None


def test_render_is_cached():
    a = render_catalog_instructions(CLEAN_CATALOG, default_catalog_id=CID)
    b = render_catalog_instructions(CLEAN_CATALOG, default_catalog_id=CID)
    assert a is b


# --------------------------------------------------------------------------- #
# heal_json_arg
# --------------------------------------------------------------------------- #


def test_heal_smart_quotes_and_trailing_comma():
    assert heal_json_arg(
        "[{“id”:“root”,“component”:“Text”,“text”:“Hi”,}]", expect="list"
    ) == [{"id": "root", "component": "Text", "text": "Hi"}]


def test_heal_dict_unwraps_single_object():
    assert heal_json_arg("{}", expect="dict") == {}
    assert heal_json_arg('{"items":[1,2]}', expect="dict") == {"items": [1, 2]}


def test_heal_hard_failure_raises():
    with pytest.raises(ValueError):
        heal_json_arg("[{not valid", expect="list")


# --------------------------------------------------------------------------- #
# Adapter end-to-end: render into prompt + healing
# --------------------------------------------------------------------------- #


class _RenderLlm(BaseLlm):
    """Yields one ``render_a2ui`` call with ``args``; records the prompt it saw."""

    args: dict = {}
    prompts: list = []

    async def generate_content_async(
        self, llm_request, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        try:
            self.prompts.append(llm_request.contents[-1].parts[0].text)
        except (AttributeError, IndexError, TypeError):
            self.prompts.append(None)
        yield LlmResponse(
            content=types.Content(
                role="model",
                parts=[
                    types.Part(
                        function_call=types.FunctionCall(
                            name="render_a2ui", args=self.args
                        )
                    )
                ],
            ),
            partial=False,
            turn_complete=True,
        )


class _Ctx:
    def __init__(self, state=None):
        self.state = state if state is not None else {}


@pytest.mark.asyncio
async def test_client_catalog_is_google_rendered_into_prompt():
    model = _RenderLlm(
        model="m",
        args={
            "surfaceId": "s",
            "components": [{"id": "root", "component": "HotelCard", "name": "Ritz"}],
        },
    )
    tool = get_a2ui_tool({"model": model, "default_catalog_id": CID})
    tool.event_queue = asyncio.Queue()
    state = {
        CONTEXT_STATE_KEY: [
            {
                "description": A2UI_SCHEMA_CONTEXT_DESCRIPTION,
                "value": json.dumps(CLEAN_CATALOG),
            }
        ]
    }
    await tool.run_async(args={"intent": "create"}, tool_context=_Ctx(state=state))
    prompt = model.prompts[0]
    # The client catalog was rendered via Google's schema block (markers prove it
    # wasn't dumped raw), carrying the components — and without the tag instruction.
    assert "---BEGIN A2UI JSON SCHEMA---" in prompt
    assert "HotelCard" in prompt
    assert "<a2ui-json>" not in prompt


@pytest.mark.asyncio
async def test_freeform_string_args_are_healed_and_committed():
    # Gemini returns components as a JSON STRING with smart quotes + trailing comma.
    model = _RenderLlm(
        model="m",
        args={
            "surfaceId": "s",
            "components": "[{“id”:“root”,“component”:“Text”,“text”:“Hi”,}]",
        },
    )
    tool = get_a2ui_tool({"model": model})
    tool.event_queue = asyncio.Queue()
    result = await tool.run_async(args={"intent": "create"}, tool_context=_Ctx())
    assert "a2ui_operations" in _envelope_text(result)
    env = json.loads(_envelope_text(result))
    comps = next(
        op["updateComponents"]["components"]
        for op in env["a2ui_operations"]
        if "updateComponents" in op
    )
    assert comps[0]["component"] == "Text" and comps[0]["id"] == "root"
