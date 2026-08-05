"""
Tests for multimodal message conversion between AG-UI and LangChain formats.
"""

import unittest
from ag_ui.core import (
    UserMessage,
    TextInputContent,
    BinaryInputContent,
    ImageInputContent,
    AudioInputContent,
    VideoInputContent,
    DocumentInputContent,
    InputContentDataSource,
    InputContentUrlSource,
)
from langchain_core.messages import HumanMessage

from ag_ui_langgraph.utils import (
    agui_messages_to_langchain,
    langchain_messages_to_agui,
    convert_agui_multimodal_to_langchain,
    convert_langchain_multimodal_to_agui,
    flatten_user_content,
)


class TestMultimodalConversion(unittest.TestCase):
    """Test multimodal message conversion between AG-UI and LangChain."""

    def test_agui_text_only_to_langchain(self):
        """Test converting a text-only AG-UI message to LangChain."""
        agui_message = UserMessage(
            id="test-1",
            role="user",
            content="Hello, world!"
        )

        lc_messages = agui_messages_to_langchain([agui_message])

        self.assertEqual(len(lc_messages), 1)
        self.assertIsInstance(lc_messages[0], HumanMessage)
        self.assertEqual(lc_messages[0].content, "Hello, world!")
        self.assertEqual(lc_messages[0].id, "test-1")

    # ── BinaryInputContent backwards compatibility ──────────────────────

    def test_agui_binary_url_to_langchain(self):
        """Test converting BinaryInputContent with URL to LangChain (backwards compat)."""
        agui_message = UserMessage(
            id="test-2",
            role="user",
            content=[
                TextInputContent(type="text", text="What's in this image?"),
                BinaryInputContent(
                    type="binary",
                    mime_type="image/jpeg",
                    url="https://example.com/photo.jpg"
                ),
            ]
        )

        lc_messages = agui_messages_to_langchain([agui_message])

        self.assertEqual(len(lc_messages), 1)
        self.assertIsInstance(lc_messages[0], HumanMessage)
        self.assertIsInstance(lc_messages[0].content, list)
        self.assertEqual(len(lc_messages[0].content), 2)

        # Check text content
        self.assertEqual(lc_messages[0].content[0]["type"], "text")
        self.assertEqual(lc_messages[0].content[0]["text"], "What's in this image?")

        # Check image content
        self.assertEqual(lc_messages[0].content[1]["type"], "image_url")
        self.assertEqual(
            lc_messages[0].content[1]["image_url"]["url"],
            "https://example.com/photo.jpg"
        )

    def test_agui_binary_data_to_langchain(self):
        """Test converting BinaryInputContent with base64 data to LangChain (backwards compat)."""
        agui_message = UserMessage(
            id="test-3",
            role="user",
            content=[
                TextInputContent(type="text", text="Analyze this"),
                BinaryInputContent(
                    type="binary",
                    mime_type="image/png",
                    data="iVBORw0KGgoAAAANSUhEUgAAAAUA",
                    filename="test.png"
                ),
            ]
        )

        lc_messages = agui_messages_to_langchain([agui_message])

        self.assertEqual(len(lc_messages), 1)
        self.assertIsInstance(lc_messages[0].content, list)
        self.assertEqual(len(lc_messages[0].content), 2)

        # Check that data URL is properly formatted
        image_content = lc_messages[0].content[1]
        self.assertEqual(image_content["type"], "image_url")
        self.assertTrue(
            image_content["image_url"]["url"].startswith("data:image/png;base64,")
        )

    # ── ImageInputContent ───────────────────────────────────────────────

    def test_agui_image_url_source_to_langchain(self):
        """Test converting ImageInputContent with URL source to LangChain."""
        agui_message = UserMessage(
            id="test-img-url",
            role="user",
            content=[
                TextInputContent(type="text", text="Describe this image"),
                ImageInputContent(
                    type="image",
                    source=InputContentUrlSource(
                        type="url",
                        value="https://example.com/photo.jpg",
                    ),
                ),
            ]
        )

        lc_messages = agui_messages_to_langchain([agui_message])

        self.assertEqual(len(lc_messages), 1)
        content = lc_messages[0].content
        self.assertIsInstance(content, list)
        self.assertEqual(len(content), 2)
        self.assertEqual(content[1]["type"], "image_url")
        self.assertEqual(content[1]["image_url"]["url"], "https://example.com/photo.jpg")

    def test_agui_image_data_source_to_langchain(self):
        """Test converting ImageInputContent with data source to LangChain."""
        agui_message = UserMessage(
            id="test-img-data",
            role="user",
            content=[
                ImageInputContent(
                    type="image",
                    source=InputContentDataSource(
                        type="data",
                        value="iVBORw0KGgoAAAANSUhEUgAAAAUA",
                        mime_type="image/png",
                    ),
                ),
            ]
        )

        lc_messages = agui_messages_to_langchain([agui_message])

        content = lc_messages[0].content
        self.assertEqual(len(content), 1)
        self.assertEqual(content[0]["type"], "image_url")
        self.assertEqual(
            content[0]["image_url"]["url"],
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA"
        )

    def test_agui_input_metadata_not_leaked_to_langchain_blocks(self):
        """AG-UI InputContent metadata must NOT be attached to the LangChain
        content blocks handed to the model.

        Attaching a top-level ``metadata`` key produces a non-standard content
        block (e.g. ``{"type": "image_url", "image_url": {...}, "metadata": {...}}``)
        that strict OpenAI-compatible providers reject with a 400
        ("Unexpected keys in a message content image dict"), aborting the run.
        The block must carry only spec-compliant keys. See issue #2100.
        """
        content_list = [
            TextInputContent(
                type="text",
                text="Describe this image",
                metadata={"source": "prompt"},
            ),
            ImageInputContent(
                type="image",
                source=InputContentUrlSource(
                    type="url",
                    value="https://example.com/photo.jpg",
                ),
                metadata={"provider_hint": "vision"},
            ),
            BinaryInputContent(
                type="binary",
                mime_type="image/png",
                url="https://example.com/legacy.png",
                metadata={"legacy": True},
            ),
        ]

        lc_content = convert_agui_multimodal_to_langchain(content_list)

        # No block leaks a top-level "metadata" key into the model payload.
        for block in lc_content:
            self.assertNotIn("metadata", block)

        # Blocks remain spec-compliant and otherwise unchanged.
        self.assertEqual(lc_content[0], {"type": "text", "text": "Describe this image"})
        self.assertEqual(
            lc_content[1],
            {"type": "image_url", "image_url": {"url": "https://example.com/photo.jpg"}},
        )
        self.assertEqual(
            lc_content[2],
            {"type": "image_url", "image_url": {"url": "https://example.com/legacy.png"}},
        )

    # ── AudioInputContent ───────────────────────────────────────────────

    def test_agui_audio_url_source_to_langchain(self):
        """Test converting AudioInputContent with URL source to LangChain."""
        content_list = [
            AudioInputContent(
                type="audio",
                source=InputContentUrlSource(
                    type="url",
                    value="https://example.com/audio.mp3",
                ),
            ),
        ]

        lc_content = convert_agui_multimodal_to_langchain(content_list)

        self.assertEqual(len(lc_content), 1)
        self.assertEqual(lc_content[0]["type"], "image_url")
        self.assertEqual(lc_content[0]["image_url"]["url"], "https://example.com/audio.mp3")

    def test_agui_audio_data_source_to_langchain(self):
        """Test converting AudioInputContent with data source to LangChain."""
        content_list = [
            AudioInputContent(
                type="audio",
                source=InputContentDataSource(
                    type="data",
                    value="SGVsbG8gV29ybGQ=",
                    mime_type="audio/mp3",
                ),
            ),
        ]

        lc_content = convert_agui_multimodal_to_langchain(content_list)

        self.assertEqual(len(lc_content), 1)
        self.assertEqual(lc_content[0]["type"], "image_url")
        self.assertEqual(
            lc_content[0]["image_url"]["url"],
            "data:audio/mp3;base64,SGVsbG8gV29ybGQ="
        )

    # ── VideoInputContent ───────────────────────────────────────────────

    def test_agui_video_url_source_to_langchain(self):
        """Test converting VideoInputContent with URL source to LangChain."""
        content_list = [
            VideoInputContent(
                type="video",
                source=InputContentUrlSource(
                    type="url",
                    value="https://example.com/video.mp4",
                ),
            ),
        ]

        lc_content = convert_agui_multimodal_to_langchain(content_list)

        self.assertEqual(len(lc_content), 1)
        self.assertEqual(lc_content[0]["type"], "image_url")
        self.assertEqual(lc_content[0]["image_url"]["url"], "https://example.com/video.mp4")

    def test_agui_video_data_source_to_langchain(self):
        """Test converting VideoInputContent with data source to LangChain."""
        content_list = [
            VideoInputContent(
                type="video",
                source=InputContentDataSource(
                    type="data",
                    value="AAAA",
                    mime_type="video/mp4",
                ),
            ),
        ]

        lc_content = convert_agui_multimodal_to_langchain(content_list)

        self.assertEqual(len(lc_content), 1)
        self.assertEqual(lc_content[0]["type"], "image_url")
        self.assertEqual(
            lc_content[0]["image_url"]["url"],
            "data:video/mp4;base64,AAAA"
        )

    # ── DocumentInputContent ────────────────────────────────────────────

    def test_agui_document_url_source_to_langchain(self):
        """Test converting DocumentInputContent with URL source to LangChain."""
        content_list = [
            DocumentInputContent(
                type="document",
                source=InputContentUrlSource(
                    type="url",
                    value="https://example.com/doc.pdf",
                ),
            ),
        ]

        lc_content = convert_agui_multimodal_to_langchain(content_list)

        self.assertEqual(len(lc_content), 1)
        self.assertEqual(lc_content[0]["type"], "image_url")
        self.assertEqual(lc_content[0]["image_url"]["url"], "https://example.com/doc.pdf")

    def test_agui_document_data_source_to_langchain(self):
        """Test converting DocumentInputContent with data source to LangChain."""
        content_list = [
            DocumentInputContent(
                type="document",
                source=InputContentDataSource(
                    type="data",
                    value="JVBERi0xLjQK",
                    mime_type="application/pdf",
                ),
            ),
        ]

        lc_content = convert_agui_multimodal_to_langchain(content_list)

        self.assertEqual(len(lc_content), 1)
        self.assertEqual(lc_content[0]["type"], "image_url")
        self.assertEqual(
            lc_content[0]["image_url"]["url"],
            "data:application/pdf;base64,JVBERi0xLjQK"
        )

    # ── LangChain to AG-UI (new types) ─────────────────────────────────

    def test_langchain_image_url_to_agui_produces_image_input_content(self):
        """Test converting LangChain image_url with regular URL to AG-UI produces ImageInputContent."""
        lc_content = [
            {"type": "text", "text": "What do you see?"},
            {
                "type": "image_url",
                "image_url": {"url": "https://example.com/image.jpg"}
            },
        ]

        agui_content = convert_langchain_multimodal_to_agui(lc_content)

        self.assertEqual(len(agui_content), 2)
        self.assertIsInstance(agui_content[0], TextInputContent)
        self.assertEqual(agui_content[0].text, "What do you see?")

        self.assertIsInstance(agui_content[1], ImageInputContent)
        self.assertIsInstance(agui_content[1].source, InputContentUrlSource)
        self.assertEqual(agui_content[1].source.value, "https://example.com/image.jpg")

    def test_langchain_data_url_to_agui_produces_image_input_content(self):
        """Test converting LangChain data URL to AG-UI produces ImageInputContent with data source."""
        lc_content = [
            {
                "type": "image_url",
                "image_url": {"url": "data:image/png;base64,iVBORw0KGgo"}
            },
        ]

        agui_content = convert_langchain_multimodal_to_agui(lc_content)

        self.assertEqual(len(agui_content), 1)
        self.assertIsInstance(agui_content[0], ImageInputContent)
        self.assertIsInstance(agui_content[0].source, InputContentDataSource)
        self.assertEqual(agui_content[0].source.mime_type, "image/png")
        self.assertEqual(agui_content[0].source.value, "iVBORw0KGgo")

    def test_langchain_jpeg_data_url_to_agui(self):
        """Test converting LangChain JPEG data URL to AG-UI."""
        lc_content = [
            {
                "type": "image_url",
                "image_url": {"url": "data:image/jpeg;base64,/9j/4AAQ"}
            },
        ]

        agui_content = convert_langchain_multimodal_to_agui(lc_content)

        self.assertEqual(len(agui_content), 1)
        self.assertIsInstance(agui_content[0], ImageInputContent)
        self.assertIsInstance(agui_content[0].source, InputContentDataSource)
        self.assertEqual(agui_content[0].source.mime_type, "image/jpeg")
        self.assertEqual(agui_content[0].source.value, "/9j/4AAQ")

    # ── Round-trip tests ────────────────────────────────────────────────

    def test_round_trip_langchain_url_to_agui_and_back(self):
        """Test round-trip: LangChain image_url -> AG-UI ImageInputContent -> LangChain image_url."""
        original_lc = [
            {"type": "text", "text": "Look at this"},
            {"type": "image_url", "image_url": {"url": "https://example.com/pic.png"}},
        ]

        agui_content = convert_langchain_multimodal_to_agui(original_lc)
        result_lc = convert_agui_multimodal_to_langchain(agui_content)

        self.assertEqual(len(result_lc), 2)
        self.assertEqual(result_lc[0]["type"], "text")
        self.assertEqual(result_lc[0]["text"], "Look at this")
        self.assertEqual(result_lc[1]["type"], "image_url")
        self.assertEqual(result_lc[1]["image_url"]["url"], "https://example.com/pic.png")

    def test_round_trip_langchain_data_url_to_agui_and_back(self):
        """Test round-trip: LangChain data URL -> AG-UI ImageInputContent -> LangChain data URL."""
        original_lc = [
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,abc123"}},
        ]

        agui_content = convert_langchain_multimodal_to_agui(original_lc)
        result_lc = convert_agui_multimodal_to_langchain(agui_content)

        self.assertEqual(len(result_lc), 1)
        self.assertEqual(result_lc[0]["type"], "image_url")
        self.assertEqual(
            result_lc[0]["image_url"]["url"],
            "data:image/png;base64,abc123"
        )

    # ── Mixed content types ─────────────────────────────────────────────

    def test_mixed_content_types_to_langchain(self):
        """Test converting a mix of new typed content and legacy BinaryInputContent."""
        content_list = [
            TextInputContent(type="text", text="Multi-media message"),
            ImageInputContent(
                type="image",
                source=InputContentUrlSource(type="url", value="https://example.com/img.jpg"),
            ),
            AudioInputContent(
                type="audio",
                source=InputContentDataSource(type="data", value="audiodata", mime_type="audio/wav"),
            ),
            BinaryInputContent(
                type="binary",
                mime_type="image/gif",
                url="https://example.com/old.gif",
            ),
        ]

        lc_content = convert_agui_multimodal_to_langchain(content_list)

        self.assertEqual(len(lc_content), 4)
        self.assertEqual(lc_content[0]["type"], "text")
        self.assertEqual(lc_content[0]["text"], "Multi-media message")

        self.assertEqual(lc_content[1]["type"], "image_url")
        self.assertEqual(lc_content[1]["image_url"]["url"], "https://example.com/img.jpg")

        self.assertEqual(lc_content[2]["type"], "image_url")
        self.assertEqual(lc_content[2]["image_url"]["url"], "data:audio/wav;base64,audiodata")

        self.assertEqual(lc_content[3]["type"], "image_url")
        self.assertEqual(lc_content[3]["image_url"]["url"], "https://example.com/old.gif")

    # ── flatten_user_content ────────────────────────────────────────────

    def test_flatten_multimodal_content(self):
        """Test flattening multimodal content to plain text."""
        content = [
            TextInputContent(type="text", text="Hello"),
            BinaryInputContent(
                type="binary",
                mime_type="image/jpeg",
                url="https://example.com/image.jpg"
            ),
            TextInputContent(type="text", text="World"),
        ]

        flattened = flatten_user_content(content)

        self.assertIn("Hello", flattened)
        self.assertIn("World", flattened)
        self.assertIn("[Binary content: https://example.com/image.jpg]", flattened)

    def test_flatten_with_filename(self):
        """Test flattening binary content with filename."""
        content = [
            TextInputContent(type="text", text="Check this file"),
            BinaryInputContent(
                type="binary",
                mime_type="application/pdf",
                url="https://example.com/doc.pdf",
                filename="report.pdf"
            ),
        ]

        flattened = flatten_user_content(content)

        self.assertIn("Check this file", flattened)
        self.assertIn("[Binary content: report.pdf]", flattened)

    def test_flatten_image_input_content(self):
        """Test flattening ImageInputContent to plain text."""
        content = [
            TextInputContent(type="text", text="Here is an image"),
            ImageInputContent(
                type="image",
                source=InputContentUrlSource(type="url", value="https://example.com/img.jpg"),
            ),
        ]

        flattened = flatten_user_content(content)

        self.assertIn("Here is an image", flattened)
        self.assertIn("[Image: https://example.com/img.jpg]", flattened)

    def test_flatten_image_data_source(self):
        """Test flattening ImageInputContent with data source."""
        content = [
            ImageInputContent(
                type="image",
                source=InputContentDataSource(type="data", value="abc", mime_type="image/png"),
            ),
        ]

        flattened = flatten_user_content(content)
        self.assertIn("[Image: image/png]", flattened)

    def test_flatten_audio_input_content(self):
        """Test flattening AudioInputContent to plain text."""
        content = [
            AudioInputContent(
                type="audio",
                source=InputContentUrlSource(type="url", value="https://example.com/a.mp3"),
            ),
        ]

        flattened = flatten_user_content(content)
        self.assertIn("[Audio: https://example.com/a.mp3]", flattened)

    def test_flatten_video_input_content(self):
        """Test flattening VideoInputContent to plain text."""
        content = [
            VideoInputContent(
                type="video",
                source=InputContentUrlSource(type="url", value="https://example.com/v.mp4"),
            ),
        ]

        flattened = flatten_user_content(content)
        self.assertIn("[Video: https://example.com/v.mp4]", flattened)

    def test_flatten_document_input_content(self):
        """Test flattening DocumentInputContent to plain text."""
        content = [
            DocumentInputContent(
                type="document",
                source=InputContentUrlSource(type="url", value="https://example.com/doc.pdf"),
            ),
        ]

        flattened = flatten_user_content(content)
        self.assertIn("[Document: https://example.com/doc.pdf]", flattened)

    def test_flatten_document_data_source(self):
        """Test flattening DocumentInputContent with data source."""
        content = [
            DocumentInputContent(
                type="document",
                source=InputContentDataSource(type="data", value="pdf-data", mime_type="application/pdf"),
            ),
        ]

        flattened = flatten_user_content(content)
        self.assertIn("[Document: application/pdf]", flattened)

    def test_flatten_string_content(self):
        """Test flattening plain string content."""
        self.assertEqual(flatten_user_content("Hello"), "Hello")

    def test_flatten_none_content(self):
        """Test flattening None content."""
        self.assertEqual(flatten_user_content(None), "")

    # ── BinaryInputContent guard ─────────────────────────────────────────

    def test_binary_content_malformed_is_dropped(self):
        """Test that a BinaryInputContent with no url, data, or id is dropped.

        Uses model_construct to bypass Pydantic validation, simulating a
        malformed object that reaches the conversion function.
        """
        binary_item = BinaryInputContent.model_construct(
            type="binary",
            mime_type="image/png",
            url=None,
            data=None,
            id=None,
        )

        content_list = [
            TextInputContent(type="text", text="Keep me"),
            binary_item,
        ]

        lc_content = convert_agui_multimodal_to_langchain(content_list)

        # Only the text item should remain; the malformed binary is dropped
        self.assertEqual(len(lc_content), 1)
        self.assertEqual(lc_content[0]["type"], "text")
        self.assertEqual(lc_content[0]["text"], "Keep me")

    # ── convert helpers direct tests ────────────────────────────────────

    def test_convert_agui_multimodal_to_langchain_helper(self):
        """Test the convert_agui_multimodal_to_langchain helper with BinaryInputContent."""
        agui_content = [
            TextInputContent(type="text", text="Test text"),
            BinaryInputContent(
                type="binary",
                mime_type="image/png",
                url="https://example.com/test.png"
            ),
        ]

        lc_content = convert_agui_multimodal_to_langchain(agui_content)

        self.assertEqual(len(lc_content), 2)
        self.assertEqual(lc_content[0]["type"], "text")
        self.assertEqual(lc_content[0]["text"], "Test text")
        self.assertEqual(lc_content[1]["type"], "image_url")
        self.assertEqual(lc_content[1]["image_url"]["url"], "https://example.com/test.png")

    def test_convert_langchain_multimodal_to_agui_helper(self):
        """Test the convert_langchain_multimodal_to_agui helper function."""
        lc_content = [
            {"type": "text", "text": "Test text"},
            {"type": "image_url", "image_url": {"url": "https://example.com/test.png"}},
        ]

        agui_content = convert_langchain_multimodal_to_agui(lc_content)

        self.assertEqual(len(agui_content), 2)
        self.assertIsInstance(agui_content[0], TextInputContent)
        self.assertEqual(agui_content[0].text, "Test text")
        self.assertIsInstance(agui_content[1], ImageInputContent)
        self.assertIsInstance(agui_content[1].source, InputContentUrlSource)
        self.assertEqual(agui_content[1].source.value, "https://example.com/test.png")


if __name__ == "__main__":
    unittest.main()
