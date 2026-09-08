#!/usr/bin/env python
"""End-to-end tests for multimodal message support in ADK middleware.

These tests verify that multimodal content (images, documents) is correctly
converted and sent to Google Gemini models via the ADK middleware.

Tests in this module require GOOGLE_API_KEY to be set.
They make real API calls to Google Gemini and are skipped otherwise.
"""

import base64
import os
import struct
import zlib
from typing import List

import pytest

from ag_ui.core import (
    BaseEvent,
    DocumentInputContent,
    ImageInputContent,
    InputContentDataSource,
    InputContentUrlSource,
    RunAgentInput,
    TextInputContent,
    UserMessage,
)
from ag_ui_adk import ADKAgent
from ag_ui_adk.session_manager import SessionManager
from google.adk.agents import LlmAgent
from tests.constants import LIVE_TEST_MODEL

@pytest.fixture(autouse=True)
def setup_llmock(llmock_server):
    """Ensure LLMock is running when no real API key is set."""

DEFAULT_MODEL = LIVE_TEST_MODEL


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def collect_events(agent: ADKAgent, run_input: RunAgentInput) -> List[BaseEvent]:
    """Collect all events from running an agent."""
    events = []
    async for event in agent.run(run_input):
        events.append(event)
    return events


def get_event_types(events: List[BaseEvent]) -> List[str]:
    return [str(e.type) for e in events]


def extract_text_message(events: List[BaseEvent]) -> str:
    """Concatenate all TEXT_MESSAGE_CONTENT deltas from the event stream."""
    parts = []
    for e in events:
        if str(e.type) == "EventType.TEXT_MESSAGE_CONTENT":
            parts.append(e.delta)
    return "".join(parts)


def make_solid_color_png(r: int, g: int, b: int, width: int = 256, height: int = 256) -> bytes:
    """Create a valid PNG image of a solid colour.

    Returns raw PNG bytes (not base64-encoded).
    Default 256x256 to give the model enough pixels to recognise the colour.
    """

    def _chunk(chunk_type: bytes, data: bytes) -> bytes:
        c = chunk_type + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    header = b"\x89PNG\r\n\x1a\n"
    ihdr_data = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # 8-bit RGB
    ihdr = _chunk(b"IHDR", ihdr_data)

    # Build raw scanlines: filter byte (0) + RGB pixels per row
    row = b"\x00" + bytes([r, g, b]) * width
    raw = row * height
    idat = _chunk(b"IDAT", zlib.compress(raw))
    iend = _chunk(b"IEND", b"")

    return header + ihdr + idat + iend


# ---------------------------------------------------------------------------
# Pre-built test images (256x256 solid colours)
# ---------------------------------------------------------------------------

RED_PNG_BYTES = make_solid_color_png(255, 0, 0)
RED_PNG_B64 = base64.b64encode(RED_PNG_BYTES).decode("ascii")

BLUE_PNG_BYTES = make_solid_color_png(0, 0, 255)
BLUE_PNG_B64 = base64.b64encode(BLUE_PNG_BYTES).decode("ascii")


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestMultimodalE2E:
    """E2E tests that send multimodal content to a live Gemini model."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    def _make_agent(self, instruction: str) -> ADKAgent:
        llm_agent = LlmAgent(
            name="multimodal_test_agent",
            model=DEFAULT_MODEL,
            instruction=instruction,
        )
        return ADKAgent(
            adk_agent=llm_agent,
            app_name="multimodal_test_app",
            user_id="test_user",
            use_in_memory_services=True,
        )

    # ---- Inline base64 image tests ----------------------------------------

    @pytest.mark.asyncio
    async def test_image_inline_data_recognized(self):
        """Send a solid-red PNG via inline base64 and verify the model sees an image."""
        agent = self._make_agent(
            "You are an image analysis assistant. "
            "When the user sends an image, describe what you see. "
            "Include the colour. Keep your answer to one sentence."
        )

        run_input = RunAgentInput(
            thread_id="e2e_img_inline_1",
            run_id="run_1",
            messages=[
                UserMessage(
                    id="msg_1",
                    role="user",
                    content=[
                        TextInputContent(text="Describe this image."),
                        ImageInputContent(
                            source=InputContentDataSource(
                                value=RED_PNG_B64,
                                mime_type="image/png",
                            ),
                        ),
                    ],
                ),
            ],
            context=[],
            state={},
            tools=[],
            forwarded_props={},
        )

        events = await collect_events(agent, run_input)
        event_types = get_event_types(events)

        assert "EventType.RUN_STARTED" in event_types
        assert "EventType.RUN_FINISHED" in event_types
        assert "EventType.RUN_ERROR" not in event_types

        # The model received the image and produced a non-empty response.
        response = extract_text_message(events)
        assert len(response) > 0, "Model produced no text response for the image"

        await agent.close()

    @pytest.mark.asyncio
    async def test_two_inline_images_both_acknowledged(self):
        """Send two images and verify the model acknowledges receiving two."""
        agent = self._make_agent(
            "You are an image analysis assistant. "
            "The user will send two images. For each image, state the number "
            "(first or second) and its dominant colour. Be brief."
        )

        run_input = RunAgentInput(
            thread_id="e2e_img_compare",
            run_id="run_1",
            messages=[
                UserMessage(
                    id="msg_1",
                    role="user",
                    content=[
                        TextInputContent(text="Describe each of these two images."),
                        ImageInputContent(
                            source=InputContentDataSource(
                                value=RED_PNG_B64,
                                mime_type="image/png",
                            ),
                        ),
                        ImageInputContent(
                            source=InputContentDataSource(
                                value=BLUE_PNG_B64,
                                mime_type="image/png",
                            ),
                        ),
                    ],
                ),
            ],
            context=[],
            state={},
            tools=[],
            forwarded_props={},
        )

        events = await collect_events(agent, run_input)
        event_types = get_event_types(events)

        assert "EventType.RUN_STARTED" in event_types
        assert "EventType.RUN_FINISHED" in event_types
        assert "EventType.RUN_ERROR" not in event_types

        # Model should mention both images in some way.
        response = extract_text_message(events).lower()
        assert len(response) > 0, "Model produced no text response"
        # Check that it references two distinct things (first/second, 1/2, both, etc.)
        has_two_refs = (
            ("first" in response and "second" in response)
            or ("1" in response and "2" in response)
            or "both" in response
            or "two" in response
        )
        assert has_two_refs, f"Model didn't acknowledge two images: {response!r}"

        await agent.close()

    # ---- URL-based document test ------------------------------------------

    @pytest.mark.asyncio
    async def test_document_url_source(self):
        """Send a PDF via HTTPS URL and verify the model can read it.

        Uses the publicly available RFC 2549 PDF from IETF — a well-known
        humorous RFC about IP over Avian Carriers with Quality of Service.
        """
        agent = self._make_agent(
            "You are a document analysis assistant. "
            "The user will provide a document. Summarize what the document "
            "is about in one sentence."
        )

        run_input = RunAgentInput(
            thread_id="e2e_doc_url_1",
            run_id="run_1",
            messages=[
                UserMessage(
                    id="msg_1",
                    role="user",
                    content=[
                        TextInputContent(text="What is this document about?"),
                        DocumentInputContent(
                            source=InputContentUrlSource(
                                value="https://www.rfc-editor.org/rfc/rfc2549.txt",
                                mime_type="text/plain",
                            ),
                        ),
                    ],
                ),
            ],
            context=[],
            state={},
            tools=[],
            forwarded_props={},
        )

        events = await collect_events(agent, run_input)
        event_types = get_event_types(events)

        assert "EventType.RUN_STARTED" in event_types
        assert "EventType.RUN_FINISHED" in event_types
        assert "EventType.RUN_ERROR" not in event_types

        response = extract_text_message(events).lower()
        assert len(response) > 0, "Model produced no text response for the document"
        # RFC 2549 is about IP over Avian Carriers (pigeons)
        has_relevant_content = any(
            word in response
            for word in ["avian", "carrier", "pigeon", "bird", "ip", "network", "qos", "quality"]
        )
        assert has_relevant_content, (
            f"Model response doesn't reference the RFC content: {response!r}"
        )

        await agent.close()

    # ---- Mixed content tests ----------------------------------------------

    @pytest.mark.asyncio
    async def test_mixed_text_and_image_color_stripes(self):
        """Verify multimodal works by sending an image with distinct colour stripes.

        Creates a 256x256 image with three horizontal stripes: red, white, blue
        (the French flag). The model must identify the pattern to prove it
        processed the visual content alongside the text prompt.
        """
        width, height = 256, 256
        stripe_h = height // 3

        raw = b""
        for y in range(height):
            raw += b"\x00"  # PNG filter byte
            if y < stripe_h:
                raw += bytes([0, 0, 255]) * width      # blue
            elif y < stripe_h * 2:
                raw += bytes([255, 255, 255]) * width   # white
            else:
                raw += bytes([255, 0, 0]) * width       # red

        def _chunk(chunk_type: bytes, data: bytes) -> bytes:
            c = chunk_type + data
            return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

        png = (
            b"\x89PNG\r\n\x1a\n"
            + _chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + _chunk(b"IDAT", zlib.compress(raw))
            + _chunk(b"IEND", b"")
        )
        stripes_b64 = base64.b64encode(png).decode("ascii")

        agent = self._make_agent(
            "You are an image analysis assistant. "
            "Describe images accurately and concisely."
        )

        run_input = RunAgentInput(
            thread_id="e2e_mixed_stripes",
            run_id="run_1",
            messages=[
                UserMessage(
                    id="msg_1",
                    role="user",
                    content=[
                        TextInputContent(
                            text="This image has horizontal colour stripes. "
                            "List the colours of the stripes from top to bottom, "
                            "separated by commas."
                        ),
                        ImageInputContent(
                            source=InputContentDataSource(
                                value=stripes_b64,
                                mime_type="image/png",
                            ),
                        ),
                    ],
                ),
            ],
            context=[],
            state={},
            tools=[],
            forwarded_props={},
        )

        events = await collect_events(agent, run_input)
        event_types = get_event_types(events)

        assert "EventType.RUN_STARTED" in event_types
        assert "EventType.RUN_FINISHED" in event_types
        assert "EventType.RUN_ERROR" not in event_types

        response = extract_text_message(events).lower()
        # The image has blue, white, red stripes — the model should mention
        # at least two of the three to prove it actually saw the image.
        colours_found = sum(1 for c in ["blue", "white", "red"] if c in response)
        assert colours_found >= 2, (
            f"Expected at least 2 of blue/white/red in response, got: {response!r}"
        )

        await agent.close()
