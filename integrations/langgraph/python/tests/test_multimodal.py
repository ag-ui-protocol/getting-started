"""
Tests for multimodal message conversion between AG-UI and LangChain formats.
"""

import json
import logging
import pathlib
import re
import unittest
import warnings
from datetime import datetime
from typing import NamedTuple
from ag_ui.core import (
    UserMessage,
    TextInputContent,
    ImageInputContent,
    AudioInputContent,
    VideoInputContent,
    DocumentInputContent,
    InputContentDataSource,
    InputContentUrlSource,
)
from ag_ui_langgraph.utils import BinaryInputContent
from langchain_core.messages import (
    AIMessage,
    HumanMessage,
    convert_to_openai_messages,
    is_data_content_block,
)

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
        agui_message = UserMessage.model_construct(
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
        agui_message = UserMessage.model_construct(
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

        # ENUMERATED, not negated. `assertNotIn("metadata", ...)` reads like a
        # guard but cannot fail for any input on this path: none of the three
        # blocks below is built by a branch that writes a `metadata` key at all,
        # so the loop passed whatever the converter did. The three `assertEqual`
        # calls that follow already pin every key of every block, which
        # constrains the output in both directions — a key gained (issue #2100's
        # top-level `metadata` object, which makes strict providers 400) and a
        # key lost.
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

        # An `audio` block, NOT `image_url`: providers validate the block kind,
        # so audio announced as an image is rejected outright. Base64 audio is
        # one of the two combinations the translator accepts — see
        # `test_emitted_audio_block_translates_for_openai`.
        self.assertEqual(len(lc_content), 1)
        self.assertEqual(
            lc_content[0],
            {
                "type": "audio",
                "base64": "SGVsbG8gV29ybGQ=",
                "mime_type": "audio/mp3",
            },
        )

    # ── Combinations deliberately LEFT on the legacy `image_url` path ────
    #
    # These are pinned decisions, not aspirations. For each one the standard
    # media block RAISES inside `convert_to_openai_data_block` (and throws in the
    # mirrored TypeScript adapter), so emitting it would turn the pre-existing
    # degraded request into a dead run. They stay on `image_url` until the
    # translators accept them — see
    # `test_refused_combinations_stay_off_the_standard_block_path`, which pins
    # both the throws and the fallback each one lands on.
    # Do not "finish the job" by flipping one of these without re-measuring.

    def test_agui_audio_url_source_stays_on_image_url(self):
        """Audio by URL keeps the legacy `image_url` block."""
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
        self.assertEqual(
            lc_content[0],
            {"type": "image_url", "image_url": {"url": "https://example.com/audio.mp3"}},
        )

    # ── VideoInputContent ───────────────────────────────────────────────

    def test_agui_video_url_source_stays_on_image_url(self):
        """Video by URL keeps the legacy `image_url` block."""
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
        self.assertEqual(
            lc_content[0],
            {"type": "image_url", "image_url": {"url": "https://example.com/video.mp4"}},
        )

    def test_agui_video_data_source_stays_on_image_url(self):
        """Video by inline data keeps the legacy `image_url` block."""
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
        self.assertEqual(
            lc_content[0],
            {"type": "image_url", "image_url": {"url": "data:video/mp4;base64,AAAA"}},
        )

    # ── DocumentInputContent ────────────────────────────────────────────

    def test_agui_document_url_source_stays_on_image_url(self):
        """Documents by URL keep the legacy `image_url` block.

        Fetching the bytes on the caller's behalf is not this adapter's job, so
        the URL keeps going out exactly as it always did.
        """
        content_list = [
            DocumentInputContent(
                type="document",
                source=InputContentUrlSource(
                    type="url",
                    value="https://example.com/doc.pdf",
                ),
                metadata={"filename": "doc.pdf"},
            ),
        ]

        lc_content = convert_agui_multimodal_to_langchain(content_list)

        self.assertEqual(len(lc_content), 1)
        self.assertEqual(
            lc_content[0],
            {"type": "image_url", "image_url": {"url": "https://example.com/doc.pdf"}},
        )

    def test_agui_legacy_binary_url_stays_on_image_url(self):
        """A legacy binary by URL keeps the legacy `image_url` block too."""
        content_list = [
            BinaryInputContent(
                type="binary",
                mime_type="application/pdf",
                url="https://example.com/legacy.pdf",
                filename="legacy.pdf",
            ),
        ]

        lc_content = convert_agui_multimodal_to_langchain(content_list)

        self.assertEqual(
            lc_content,
            [{"type": "image_url", "image_url": {"url": "https://example.com/legacy.pdf"}}],
        )

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

        # THE REGRESSION THIS FILE EXISTS TO CATCH. A PDF handed to a provider as
        # `image_url` — with `application/pdf` sitting inside the data URL — is
        # rejected on the block kind:
        #
        #     openai.BadRequestError: 400 - Invalid MIME type. Only image types
        #     are supported. (code: invalid_image_format)
        #
        # and the exception kills the run rather than degrading it.
        #
        # The filename is DERIVED from the MIME subtype because the item carried
        # none: langchain-core only warns about that, but the mirrored TypeScript
        # adapter's translator throws, so both runtimes substitute the same name.
        self.assertEqual(len(lc_content), 1)
        self.assertEqual(
            lc_content[0],
            {
                "type": "file",
                "base64": "JVBERi0xLjQK",
                "mime_type": "application/pdf",
                "filename": "attachment.pdf",
            },
        )

    def test_derived_filename_extensions(self):
        """THE SUBTYPE IS NOT THE EXTENSION.

        It coincides with one often enough that `mime.split("/")[1]` looks like a
        rule, and the rows below are where that rule was wrong: `text/plain` is
        not `.plain`, `audio/mpeg` is not `.mpeg`, `application/vnd.api+json` is
        not `.vnd.api`. The passthrough rows are here so the fix cannot be a
        lookup table that forgot the common case.

        Every row is duplicated in the TypeScript suite (`derives %s as %s`). A
        row that disagrees across the two is an attachment that reaches the
        provider under a different name depending on which runtime sent it — the
        class of bug this branch closes.
        """
        cases = [
            # Corrected by the extension map.
            ("text/plain", "attachment.txt"),
            ("text/markdown", "attachment.md"),
            ("audio/mpeg", "attachment.mp3"),
            ("application/msword", "attachment.doc"),
            ("application/vnd.ms-excel", "attachment.xls"),
            (
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "attachment.docx",
            ),
            (
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "attachment.xlsx",
            ),
            ("image/jpeg", "attachment.jpg"),
            # Structured-syntax suffix: the format is what follows the `+`.
            ("application/vnd.api+json", "attachment.json"),
            ("application/ld+json", "attachment.json"),
            # Registration tree stripped: `vnd.` / `prs.` / `x-` / `x.` are
            # NAMESPACES, and leaving one on turns a perfectly good extension
            # into an implausible one that falls back to `.bin`. These rows are
            # the only ones where the strip changes the answer —
            # `application/x-weird-thing` below is `.bin` with or without it —
            # so without them the strip is deletable with both suites green.
            ("application/x-tar", "attachment.tar"),
            ("application/vnd.rar", "attachment.rar"),
            ("application/prs.foo", "attachment.foo"),
            ("application/x.custom", "attachment.custom"),
            # Already right from the subtype, and must stay right.
            ("application/pdf", "attachment.pdf"),
            ("text/csv", "attachment.csv"),
            ("application/json", "attachment.json"),
            ("text/html", "attachment.html"),
            ("application/zip", "attachment.zip"),
            # Nothing plausible to extract: an unidentified byte stream is `.bin`.
            ("application/octet-stream", "attachment.bin"),
            ("application/x-weird-thing", "attachment.bin"),
            ("application/vnd.acme.internal-thing", "attachment.bin"),
            # Malformed. `a/b/c` has no subtype, and the middle segment is not
            # one — the two runtimes must not disagree about that.
            ("application/pdf/extra", "attachment.bin"),
            ("notamimetype", "attachment.bin"),
            # MIME types are case-insensitive (RFC 2045 §5.1), and parameters
            # are not part of the type's identity.
            ("TEXT/PLAIN", "attachment.txt"),
            ("text/plain; charset=utf-8", "attachment.txt"),
        ]

        for mime_type, expected in cases:
            with self.subTest(mime_type=mime_type):
                [block] = convert_agui_multimodal_to_langchain([
                    DocumentInputContent(
                        type="document",
                        source=InputContentDataSource(
                            type="data", value="JVBERi0xLjQK", mime_type=mime_type
                        ),
                    )
                ])
                self.assertEqual(block["filename"], expected)

    def test_empty_supplied_filename_is_treated_as_absent(self):
        """`""` is not a name the client chose, it is one it failed to send.

        Reading it as a value skips the derivation and emits a file block with NO
        filename — the one shape `@langchain/openai` throws on, which is why the
        mirrored TypeScript adapter had a dead run here. Both entry points are
        pinned: the typed `metadata.filename` and the legacy item's top-level
        `filename`.
        """
        typed, legacy = convert_agui_multimodal_to_langchain([
            DocumentInputContent(
                type="document",
                source=InputContentDataSource(
                    type="data", value="JVBERi0xLjQK", mime_type="application/pdf"
                ),
                metadata={"filename": ""},
            ),
            BinaryInputContent(
                type="binary",
                mime_type="application/pdf",
                data="JVBERi0xLjQK",
                filename="",
            ),
        ])

        self.assertEqual(typed["filename"], "attachment.pdf")
        self.assertEqual(legacy["filename"], "attachment.pdf")

    def test_derived_filename_does_not_come_back_as_user_supplied(self):
        """The outbound leg INVENTS a name for every filename-less document,
        because the provider translator needs one.

        If the return leg writes that name into AG-UI `metadata.filename`, the
        thread now asserts the user attached a file called `attachment.txt` — and
        because a supplied name always beats derivation, the invention is frozen
        into every later send. The invented name is exactly
        `_derive_filename(mime_type)`, so recomputing it identifies it. A REAL
        name is untouched, which is the other half.
        """
        emitted = convert_agui_multimodal_to_langchain([
            DocumentInputContent(
                type="document",
                source=InputContentDataSource(
                    type="data", value="aGk=", mime_type="text/plain"
                ),
            ),
            DocumentInputContent(
                type="document",
                source=InputContentDataSource(
                    type="data", value="aGk=", mime_type="text/plain"
                ),
                metadata={"filename": "notes.txt"},
            ),
        ])

        # Pinned: what goes OUT still carries the derived name, because dropping
        # it there is the failure this whole path exists to avoid.
        self.assertEqual(emitted[0]["filename"], "attachment.txt")

        derived, supplied = convert_langchain_multimodal_to_agui(emitted)
        self.assertIsNone(derived.metadata)
        self.assertEqual(derived.source.value, "aGk=")
        self.assertEqual(supplied.metadata, {"filename": "notes.txt"})

    def test_agui_document_filename_reaches_the_file_block(self):
        """A document's `metadata.filename` lands on the file block.

        A file block without a filename is degraded in both runtimes —
        langchain-core warns and drops the key, `@langchain/openai` throws — and
        `metadata: {filename}` is where AG-UI puts it: the client's own
        `backward-compatibility-0-0-47` middleware migrates the legacy
        `BinaryInputContent.filename` into exactly that shape.
        """
        content_list = [
            DocumentInputContent(
                type="document",
                source=InputContentDataSource(
                    type="data",
                    value="JVBERi0xLjQK",
                    mime_type="application/pdf",
                ),
                metadata={"filename": "invoice-q2.pdf"},
            ),
        ]

        lc_content = convert_agui_multimodal_to_langchain(content_list)

        self.assertEqual(lc_content[0]["filename"], "invoice-q2.pdf")
        # ENUMERATED, not negated. `assertNotIn("metadata", ...)` reads like a
        # guard but cannot fail: nothing in `_standard_media_block` writes a
        # `metadata` key, so it would pass for every input including a block
        # that lost its filename. Pinning the whole key set constrains the
        # output in both directions — a key gained (issue #2100's top-level
        # `metadata` object, which makes strict providers 400) and a key lost.
        # The TypeScript counterpart does the same with
        # `expect(Object.keys(content[1].metadata)).toEqual(["filename"])`.
        self.assertEqual(
            sorted(lc_content[0]), ["base64", "filename", "mime_type", "type"]
        )

    def test_document_survives_the_langchain_round_trip(self):
        """AG-UI -> LangChain -> AG-UI keeps the document a document.

        This is the MESSAGES_SNAPSHOT path. A block kind the return leg does not
        understand is an attachment that disappears from the thread on the next
        snapshot: the file was sent, the model read it, and a reopened thread
        shows a bare line of text.
        """
        original = [
            TextInputContent(type="text", text="Summarize this"),
            DocumentInputContent(
                type="document",
                source=InputContentDataSource(
                    type="data",
                    value="JVBERi0xLjQK",
                    mime_type="application/pdf",
                ),
                metadata={"filename": "invoice-q2.pdf"},
            ),
        ]

        round_tripped = convert_langchain_multimodal_to_agui(
            convert_agui_multimodal_to_langchain(original)
        )

        self.assertEqual(len(round_tripped), 2)
        self.assertIsInstance(round_tripped[1], DocumentInputContent)
        self.assertEqual(round_tripped[1].source.value, "JVBERi0xLjQK")
        self.assertEqual(round_tripped[1].source.mime_type, "application/pdf")
        self.assertEqual(round_tripped[1].metadata, {"filename": "invoice-q2.pdf"})

    def test_audio_survives_the_langchain_round_trip(self):
        """Same guard as the document round trip, for inline audio.

        This is the STANDARD BLOCK path. The modalities that ride `image_url`
        instead — video, and audio the provider's format enum cannot name — are
        covered by `TestModalitySurvivesImageUrlRoundTrip`.
        """
        original = [
            AudioInputContent(
                type="audio",
                source=InputContentDataSource(
                    type="data", value="SGVsbG8=", mime_type="audio/mp3"
                ),
            ),
        ]

        round_tripped = convert_langchain_multimodal_to_agui(
            convert_agui_multimodal_to_langchain(original)
        )

        self.assertIsInstance(round_tripped[0], AudioInputContent)
        self.assertEqual(round_tripped[0].source.mime_type, "audio/mp3")
        self.assertEqual(round_tripped[0].source.value, "SGVsbG8=")

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

    def test_langchain_plain_string_entries_preserved(self):
        """Test plain string entries survive conversion alongside structured blocks."""
        lc_content = ["hello", {"type": "text", "text": " world"}]

        agui_content = convert_langchain_multimodal_to_agui(lc_content)

        self.assertEqual(len(agui_content), 2)
        self.assertIsInstance(agui_content[0], TextInputContent)
        self.assertEqual(agui_content[0].text, "hello")
        self.assertIsInstance(agui_content[1], TextInputContent)
        self.assertEqual(agui_content[1].text, " world")

    def test_langchain_plain_string_interleaved_with_image_keeps_order(self):
        """Test plain strings keep their position among structured image blocks."""
        lc_content = [
            "before",
            {"type": "image_url", "image_url": {"url": "https://example.com/pic.png"}},
            "after",
        ]

        agui_content = convert_langchain_multimodal_to_agui(lc_content)

        self.assertEqual(len(agui_content), 3)
        self.assertIsInstance(agui_content[0], TextInputContent)
        self.assertEqual(agui_content[0].text, "before")
        self.assertIsInstance(agui_content[1], ImageInputContent)
        self.assertIsInstance(agui_content[1].source, InputContentUrlSource)
        self.assertEqual(agui_content[1].source.value, "https://example.com/pic.png")
        self.assertIsInstance(agui_content[2], TextInputContent)
        self.assertEqual(agui_content[2].text, "after")

    def test_langchain_plain_string_entries_preserved_verbatim(self):
        """Test plain string entries keep whitespace, case and non-ASCII characters."""
        lc_content = ["  Padded MixedCase  ", "\tGrüße 日本\n", "   "]

        agui_content = convert_langchain_multimodal_to_agui(lc_content)

        self.assertEqual(len(agui_content), 3)
        self.assertEqual(agui_content[0].text, "  Padded MixedCase  ")
        self.assertEqual(agui_content[1].text, "\tGrüße 日本\n")
        self.assertEqual(agui_content[2].text, "   ")

    def test_langchain_empty_string_entry_preserved(self):
        """Test an empty string entry still produces a text item."""
        lc_content = ["", {"type": "text", "text": "world"}]

        agui_content = convert_langchain_multimodal_to_agui(lc_content)

        self.assertEqual(len(agui_content), 2)
        self.assertIsInstance(agui_content[0], TextInputContent)
        self.assertEqual(agui_content[0].text, "")
        self.assertEqual(agui_content[1].text, "world")

    def test_langchain_bare_string_content_becomes_single_text_item(self):
        """Test a bare string content is treated as the whole content, not iterated."""
        agui_content = convert_langchain_multimodal_to_agui("hi there")

        self.assertEqual(len(agui_content), 1)
        self.assertIsInstance(agui_content[0], TextInputContent)
        self.assertEqual(agui_content[0].text, "hi there")

    def test_langchain_bare_string_content_preserved_verbatim(self):
        """Test a bare string keeps its padding, case and non-ASCII characters."""
        agui_content = convert_langchain_multimodal_to_agui("  Hallö Wörld  ")

        self.assertEqual(len(agui_content), 1)
        self.assertEqual(agui_content[0].text, "  Hallö Wörld  ")

    def test_langchain_bare_empty_string_content_becomes_single_text_item(self):
        """Test an empty bare string still yields one empty text item."""
        agui_content = convert_langchain_multimodal_to_agui("")

        self.assertEqual(len(agui_content), 1)
        self.assertIsInstance(agui_content[0], TextInputContent)
        self.assertEqual(agui_content[0].text, "")

    def test_langchain_non_list_content_yields_no_items(self):
        """Test non-list content is not walked element-wise into fabricated text."""
        # A stray dict must not be shredded into its key names, and no other
        # iterable may be traversed as if it were a list of content blocks.
        # Non-iterables yield [] too, where the pre-branch code raised TypeError.
        self.assertEqual(
            convert_langchain_multimodal_to_agui({"type": "text", "text": "x"}), []
        )
        self.assertEqual(convert_langchain_multimodal_to_agui(("a", "b")), [])
        self.assertEqual(convert_langchain_multimodal_to_agui({"a", "b"}), [])
        self.assertEqual(convert_langchain_multimodal_to_agui(None), [])

    def test_langchain_unconvertible_entries_are_skipped(self):
        """Test entries that are neither a string nor a dict are dropped, not raised on."""
        lc_content = ["keep", 5, None, ["nested"], {"type": "text", "text": "also keep"}]

        agui_content = convert_langchain_multimodal_to_agui(lc_content)

        self.assertEqual(len(agui_content), 2)
        self.assertEqual(agui_content[0].text, "keep")
        self.assertEqual(agui_content[1].text, "also keep")

    def test_langchain_unknown_block_type_is_not_fabricated_into_content(self):
        """Test an unrecognized content block is dropped, never fabricated into an item."""
        # An unknown block must not reach the image_url handler, which would mint an
        # ImageInputContent with an empty source. This asserts hollowness rather than
        # a count: if the converter is later taught langchain-core's standard blocks,
        # these should become real image and audio items — never sourceless ones.
        lc_content = [
            {"type": "text", "text": "look"},
            {"type": "image", "base64": "AAAA", "mime_type": "image/png"},
            {"type": "audio", "base64": "BBBB", "mime_type": "audio/wav"},
            {"no_type_key": True},
        ]

        agui_content = convert_langchain_multimodal_to_agui(lc_content)

        self.assertEqual(
            [c.text for c in agui_content if isinstance(c, TextInputContent)], ["look"]
        )
        for item in agui_content:
            if isinstance(item, ImageInputContent):
                self.assertTrue(item.source.value, f"sourceless media item: {item!r}")

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

        self.assertEqual(
            lc_content[2],
            {"type": "audio", "base64": "audiodata", "mime_type": "audio/wav"},
        )

        # Legacy, and an IMAGE — so it keeps the historical `image_url` shape.
        self.assertEqual(lc_content[3]["type"], "image_url")
        self.assertEqual(lc_content[3]["image_url"]["url"], "https://example.com/old.gif")

    def test_legacy_binary_pdf_becomes_a_file_block(self):
        """A legacy binary item splits on its MIME type, like the typed ones.

        `BinaryInputContent` is deprecated but still accepted, and a deprecated
        path that 400s is not meaningfully more supported than one that raises.
        Its typed `filename` goes straight onto the block.
        """
        content_list = [
            BinaryInputContent(
                type="binary",
                mime_type="application/pdf",
                data="JVBERi0xLjQK",
                filename="legacy-invoice.pdf",
            ),
        ]

        lc_content = convert_agui_multimodal_to_langchain(content_list)

        self.assertEqual(
            lc_content[0],
            {
                "type": "file",
                "base64": "JVBERi0xLjQK",
                "mime_type": "application/pdf",
                "filename": "legacy-invoice.pdf",
            },
        )

    def test_legacy_binary_id_only_keeps_the_reference_form(self):
        """An `id`-only legacy item carries no bytes and no URL.

        There is nothing to classify and nothing to attach, so it keeps the
        historical reference form rather than inventing a block shape.
        """
        content_list = [
            BinaryInputContent(
                type="binary",
                mime_type="application/pdf",
                id="file-abc123",
            ),
        ]

        lc_content = convert_agui_multimodal_to_langchain(content_list)

        self.assertEqual(
            lc_content[0],
            {"type": "image_url", "image_url": {"url": "file-abc123"}},
        )

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


class TestModalitySurvivesImageUrlRoundTrip(unittest.TestCase):
    """Modality survives the `image_url` round trip.

    `image_url` is the fallback block for every modality the outbound leg cannot
    send as a standard block — video always, audio outside the provider's format
    enum, and every URL-sourced item — so reading the block kind literally on the
    way back rewrote the thread: the user attached a video and MESSAGES_SNAPSHOT
    came back holding an image, permanently, for every later read.

    The MIME type inside the data URL is the recovery signal, and these tests pin
    BOTH halves: the type that comes back, and the fact that the block going out
    is byte-for-byte what it was (the outbound shape is provider-measured and must
    not move).

    Mirrors "modality survives the image_url round trip" in the TypeScript
    adapter's `utils.test.ts`. A divergence between the two is the class of bug
    this converter exists to fix.
    """

    def _round_trip(self, item):
        wire = convert_agui_multimodal_to_langchain([item])
        return wire[0], convert_langchain_multimodal_to_agui(wire)[0]

    def test_video_stays_a_video_across_the_round_trip(self):
        wire, content = self._round_trip(
            VideoInputContent(
                type="video",
                source=InputContentDataSource(
                    type="data", value="SGVsbG8=", mime_type="video/mp4"
                ),
                metadata={"filename": "clip.mp4"},
            )
        )

        # Unchanged on the wire: video still has no standard block that any
        # translator accepts, so it stays on `image_url` deliberately.
        self.assertEqual(
            wire,
            {"type": "image_url", "image_url": {"url": "data:video/mp4;base64,SGVsbG8="}},
        )
        self.assertIsInstance(content, VideoInputContent)
        self.assertEqual(content.source.value, "SGVsbG8=")
        self.assertEqual(content.source.mime_type, "video/mp4")

    def test_audio_the_provider_cannot_carry_stays_audio(self):
        # `audio/ogg` is outside `input_audio.format`, so it rides `image_url` too.
        wire, content = self._round_trip(
            AudioInputContent(
                type="audio",
                source=InputContentDataSource(
                    type="data", value="SGVsbG8=", mime_type="audio/ogg"
                ),
            )
        )

        self.assertEqual(
            wire,
            {"type": "image_url", "image_url": {"url": "data:audio/ogg;base64,SGVsbG8="}},
        )
        self.assertIsInstance(content, AudioInputContent)
        self.assertEqual(content.source.mime_type, "audio/ogg")

    def test_legacy_binary_video_stays_a_video(self):
        wire, content = self._round_trip(
            BinaryInputContent(type="binary", mime_type="video/mp4", data="SGVsbG8=")
        )

        self.assertEqual(
            wire,
            {"type": "image_url", "image_url": {"url": "data:video/mp4;base64,SGVsbG8="}},
        )
        self.assertIsInstance(content, VideoInputContent)
        self.assertEqual(content.source.mime_type, "video/mp4")

    def test_a_genuine_image_still_comes_back_an_image(self):
        _, content = self._round_trip(
            ImageInputContent(
                type="image",
                source=InputContentDataSource(
                    type="data", value="SGVsbG8=", mime_type="image/png"
                ),
            )
        )

        self.assertIsInstance(content, ImageInputContent)
        self.assertEqual(content.source.mime_type, "image/png")

    def test_a_non_media_mime_type_reads_as_a_document(self):
        """Nothing in this adapter emits a document as an `image_url` data URL,
        but a graph relaying its own content can, and `document` is what the
        legacy binary OUTBOUND leg calls the same MIME type. Symmetry, not
        guesswork."""
        content = convert_langchain_multimodal_to_agui(
            [{"type": "image_url", "image_url": {"url": "data:application/pdf;base64,JVBERi0="}}]
        )[0]

        self.assertIsInstance(content, DocumentInputContent)
        self.assertEqual(content.source.value, "JVBERi0=")
        self.assertEqual(content.source.mime_type, "application/pdf")

    def test_a_data_url_with_no_mime_type_stays_an_image(self):
        """Nothing to read, so the pre-existing default stands rather than a guess."""
        content = convert_langchain_multimodal_to_agui(
            [{"type": "image_url", "image_url": {"url": "data:;base64,SGVsbG8="}}]
        )[0]

        self.assertIsInstance(content, ImageInputContent)

    def test_a_mime_less_data_url_reads_as_the_image_png_its_own_fallback_names(self):
        """A ``data:`` URL always has a colon, so the ``":" in header`` gate never
        fell through for one — it extracted the EMPTY STRING and recorded that as
        the attachment's MIME type, while the docstring on
        `_agui_media_type_for_mime_type` claimed the ``image/png`` default applied
        to exactly this case. The mirrored TypeScript adapter already applies it.

        The media type is unaffected either way — `_agui_media_type_for_mime_type`
        answers ``image`` for both ``""`` and ``image/png`` — so this only stops an
        unusable MIME type from being written into the thread.

        Mirrors the TypeScript ``reads a MIME-less data URL as the image/png its
        own fallback names``.
        """
        [content] = convert_langchain_multimodal_to_agui(
            [{"type": "image_url", "image_url": {"url": "data:;base64,aGk="}}]
        )

        self.assertIsInstance(content, ImageInputContent)
        self.assertEqual(content.source.type, "data")
        self.assertEqual(content.source.value, "aGk=")
        self.assertEqual(content.source.mime_type, "image/png")

    def test_a_data_url_that_does_carry_a_mime_type_keeps_it(self):
        """The guard for the default above: it must not overwrite a real MIME
        type, and it must not disturb the modality recovery that reads it."""
        cases = [
            ("data:image/jpeg;base64,aGk=", ImageInputContent, "image/jpeg"),
            ("data:video/mp4;base64,aGk=", VideoInputContent, "video/mp4"),
            ("data:application/pdf;base64,aGk=", DocumentInputContent, "application/pdf"),
        ]

        for url, expected_class, expected_mime in cases:
            with self.subTest(url):
                [content] = convert_langchain_multimodal_to_agui(
                    [{"type": "image_url", "image_url": {"url": url}}]
                )

                self.assertIsInstance(content, expected_class)
                self.assertEqual(content.source.mime_type, expected_mime)

    def test_known_limit_a_url_sourced_video_comes_back_as_an_image(self):
        """Not an oversight — an `image_url` block carries ``{"url": …}`` and
        nothing else, so an https-hosted video arrives with no MIME type and no
        other modality signal. Adding a key to the block is what issue #2100 was
        about (providers 400 on unexpected keys inside a content block), and a
        file extension is not a signal on signed or extensionless CDN URLs. This
        test exists so the limit is visible and a future fix has to change it
        deliberately."""
        _, content = self._round_trip(
            VideoInputContent(
                type="video",
                source=InputContentUrlSource(
                    type="url", value="https://example.com/clip.mp4", mime_type="video/mp4"
                ),
            )
        )

        self.assertIsInstance(content, ImageInputContent)
        self.assertEqual(content.source.value, "https://example.com/clip.mp4")


class TestProviderBoundary(unittest.TestCase):
    """The EMITTED block, run down the real path to the provider payload.

    The tests above assert the SHAPE this converter emits. On their own that is
    the trap that lets a wrong shape ship: a converter and its tests agreeing on
    an invented schema look identical to a correct one. These take the emitted
    block and read what a provider would actually receive — no network, the
    conversion is a pure function.

    They go through `convert_to_openai_messages`, not
    `convert_to_openai_data_block`, ON PURPOSE. The real path gates translation
    behind `is_data_content_block` and only calls the translator for blocks that
    pass; a block that fails the gate is FORWARDED VERBATIM instead. Calling the
    translator directly skips the gate, so a shape the real path would never
    translate can still look translated in a test — see
    `test_js_native_spelling_is_forwarded_unrecognized_not_rejected` for the
    measurement that makes that concrete.
    """

    @staticmethod
    def _emit(item):
        """The block this converter actually puts on the wire for `item`."""
        blocks = convert_agui_multimodal_to_langchain([item])
        return blocks[0]

    @staticmethod
    def _provider_payload(block):
        """What an OpenAI-compatible provider actually receives for `block`.

        A block the gate rejects comes back out of here unchanged, so an
        equality assertion against the translated form catches that too.
        """
        [message] = convert_to_openai_messages([HumanMessage(content=[dict(block)])])
        return message["content"][0]

    def test_emitted_document_block_translates_for_openai(self):
        block = self._emit(
            DocumentInputContent(
                type="document",
                source=InputContentDataSource(
                    type="data", value="JVBERi0xLjQK", mime_type="application/pdf"
                ),
                metadata={"filename": "invoice-q2.pdf"},
            )
        )

        self.assertTrue(is_data_content_block(block))
        self.assertEqual(
            self._provider_payload(block),
            {
                "type": "file",
                "file": {
                    "file_data": "data:application/pdf;base64,JVBERi0xLjQK",
                    "filename": "invoice-q2.pdf",
                },
            },
        )

    def test_emitted_filename_less_document_carries_the_derived_name(self):
        """The derived filename is why this path can claim to work.

        langchain-core only warns when a file block has no filename, but the
        mirrored TypeScript adapter's translator THROWS. Both runtimes emit the
        same block, so both substitute the same name.
        """
        block = self._emit(
            DocumentInputContent(
                type="document",
                source=InputContentDataSource(
                    type="data", value="JVBERi0xLjQK", mime_type="application/pdf"
                ),
            )
        )

        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            translated = self._provider_payload(block)

        self.assertEqual(
            translated,
            {
                "type": "file",
                "file": {
                    "file_data": "data:application/pdf;base64,JVBERi0xLjQK",
                    "filename": "attachment.pdf",
                },
            },
        )
        # And langchain-core does not warn about the FILENAME, because the
        # converter supplied one. Measured with langchain-core 1.2.13: a file
        # block with no filename warns ("OpenAI may require a filename for file
        # uploads") and substitutes the literal `LC_AUTOGENERATED`.
        #
        # SCOPED to that warning rather than asserting the whole recorded list
        # is empty. `record=True` catches every warning raised anywhere under
        # the call, including a `DeprecationWarning` from a transitive
        # dependency that has nothing to do with this adapter — which would red
        # this test on a dependency bump and teach the next reader that the
        # assertion is noise.
        self.assertEqual(
            [str(w.message) for w in caught if "filename" in str(w.message).lower()],
            [],
        )

    def test_mime_less_document_names_its_bytes_octet_stream(self):
        """A document with no usable MIME type still has to name one.

        The translator supplies no default: it interpolates whatever `mime_type`
        it is handed straight into the data URL, so an empty one reached the
        provider as `data:;base64,…` — an omitted mediatype, which RFC 2397 §2
        DEFINES as `text/plain;charset=US-ASCII`. The part did not lack a type,
        it claimed the wrong one, and a PDF's bytes went out asserting they were
        ASCII text.

        Mirrors the TypeScript `names a document's bytes octet-stream at the
        provider when it has an %s`. That adapter parametrizes an ABSENT
        `mimeType` alongside the empty one; there is no absent case to
        parametrize here, because `InputContentDataSource.mime_type` is a
        required `str` that pydantic validates at this boundary — so the empty
        string is the only spelling of "no MIME type" that can reach this
        converter through the public API.
        """
        block = self._emit(
            DocumentInputContent(
                type="document",
                source=InputContentDataSource(type="data", value="aGk=", mime_type=""),
            )
        )

        self.assertEqual(
            self._provider_payload(block),
            {
                "type": "file",
                "file": {
                    # NOT `data:;base64,aGk=`.
                    "file_data": "data:application/octet-stream;base64,aGk=",
                    # The MIME type and the derived filename now agree about what
                    # the file is, which is the property that makes the round trip
                    # exact.
                    "filename": "attachment.bin",
                },
            },
        )

    def test_mime_less_image_is_not_retyped_as_a_document(self):
        """The `image_url` fallback path takes the OTHER answer, deliberately.

        `application/octet-stream` reads back as a DOCUMENT through
        `_agui_media_type_for_mime_type`, so substituting it on this path would
        silently retype a MIME-less image as a document on the next
        MESSAGES_SNAPSHOT. An omitted mediatype reads back as an image, which is
        what the item already was.

        Mirrors the TypeScript ``does not put the text `undefined` in the data
        URL for %s with no MIME type``.
        """
        cases = [
            (
                "typed image content",
                ImageInputContent(
                    type="image",
                    source=InputContentDataSource(
                        type="data", value="aGk=", mime_type=""
                    ),
                ),
            ),
            (
                "legacy binary content",
                BinaryInputContent(type="binary", mime_type="", data="aGk="),
            ),
        ]

        for name, item in cases:
            with self.subTest(name):
                block = self._emit(item)

                self.assertEqual(
                    self._provider_payload(block),
                    {"type": "image_url", "image_url": {"url": "data:;base64,aGk="}},
                )

                # And the round trip keeps it an IMAGE rather than promoting it
                # to the document the octet-stream substitution would have made
                # of it.
                [returned] = convert_langchain_multimodal_to_agui([block])
                self.assertIsInstance(returned, ImageInputContent)

    def test_every_filename_situation_reaches_the_provider(self):
        """The five filename situations an attachment can be in, each carried all
        the way to the payload: supplied; supplied-but-empty on a typed item;
        supplied-but-empty on a legacy binary item; absent with a MIME type
        `_FILENAME_EXTENSIONS` knows; absent with one it does not.

        langchain-core only WARNS about a nameless file block, so the assertion
        here is on the name that lands — but the mirrored TypeScript translator
        THROWS on the same block, which is what makes this load-bearing rather
        than cosmetic. Mirrored by the TypeScript
        `reaches OpenAI with a usable filename when it is %s`.
        """
        cases = [
            (
                "supplied",
                DocumentInputContent(
                    type="document",
                    source=InputContentDataSource(
                        type="data", value="aGk=", mime_type="application/pdf"
                    ),
                    metadata={"filename": "real.pdf"},
                ),
                "real.pdf",
            ),
            (
                "empty-string supplied, typed",
                DocumentInputContent(
                    type="document",
                    source=InputContentDataSource(
                        type="data", value="aGk=", mime_type="application/pdf"
                    ),
                    metadata={"filename": ""},
                ),
                "attachment.pdf",
            ),
            (
                "empty-string supplied, legacy binary",
                BinaryInputContent(
                    type="binary", mime_type="application/pdf", data="aGk=", filename=""
                ),
                "attachment.pdf",
            ),
            (
                "absent with a known MIME type",
                DocumentInputContent(
                    type="document",
                    source=InputContentDataSource(
                        type="data", value="aGk=", mime_type="text/plain"
                    ),
                ),
                "attachment.txt",
            ),
            (
                "absent with an unknown MIME type",
                DocumentInputContent(
                    type="document",
                    source=InputContentDataSource(
                        type="data", value="aGk=", mime_type="application/x-weird-thing"
                    ),
                ),
                "attachment.bin",
            ),
        ]

        for name, item, filename in cases:
            with self.subTest(situation=name):
                payload = self._provider_payload(self._emit(item))
                self.assertEqual(payload["type"], "file")
                self.assertEqual(payload["file"]["filename"], filename)

    def test_emitted_audio_block_translates_for_openai(self):
        block = self._emit(
            AudioInputContent(
                type="audio",
                source=InputContentDataSource(
                    type="data", value="SGVsbG8=", mime_type="audio/wav"
                ),
            )
        )

        self.assertTrue(is_data_content_block(block))
        self.assertEqual(
            self._provider_payload(block),
            {"type": "input_audio", "input_audio": {"data": "SGVsbG8=", "format": "wav"}},
        )

    def test_emitted_legacy_binary_document_translates_for_openai(self):
        block = self._emit(
            BinaryInputContent(
                type="binary",
                mime_type="application/pdf",
                data="JVBERi0xLjQK",
                filename="legacy-invoice.pdf",
            )
        )

        self.assertTrue(is_data_content_block(block))
        self.assertEqual(
            self._provider_payload(block),
            {
                "type": "file",
                "file": {
                    "file_data": "data:application/pdf;base64,JVBERi0xLjQK",
                    "filename": "legacy-invoice.pdf",
                },
            },
        )

    def test_emitted_legacy_binary_audio_translates_for_openai(self):
        block = self._emit(
            BinaryInputContent(
                type="binary", mime_type="audio/wav", data="SGVsbG8="
            )
        )

        self.assertTrue(is_data_content_block(block))
        self.assertEqual(
            self._provider_payload(block),
            {"type": "input_audio", "input_audio": {"data": "SGVsbG8=", "format": "wav"}},
        )

    # ── Audio MIME types ────────────────────────────────────────────────
    #
    # `input_audio.format` is an enum of exactly two values (`"wav" | "mp3"` in
    # the OpenAI SDK's own `ChatCompletionContentPartInputAudio.InputAudio`), and
    # this runtime derives it from `mime_type.split("/")[-1]`. So "audio, data
    # converts" was never true as stated — it was true of the `audio/wav` it was
    # measured on. These pin the real constraint, per spelling.

    def test_admitted_audio_mime_types_reach_the_provider(self):
        """Every audio spelling this converter ADMITS, and the part it produces.

        `audio/mpeg` is the load-bearing row: it is the IANA-registered type for
        MP3 and what a browser reports for a `.mp3`, and it is NOT what the
        provider's enum lists — so it only works because the converter rewrites
        the spelling to `audio/mp3` before emitting.

        The last three rows are the same defect in a different disguise: a MIME
        type is case-insensitive (RFC 2045 §5.1) and may carry parameters, and
        neither makes a supported format unsupported.
        """
        admitted = {
            "audio/wav": "wav",
            "audio/mp3": "mp3",
            "audio/mpeg": "mp3",
            "audio/x-wav": "wav",
            "audio/wave": "wav",
            "audio/vnd.wave": "wav",
            "AUDIO/MPEG": "mp3",
            "audio/WAV": "wav",
            "audio/mpeg; charset=binary": "mp3",
            "audio/wav; codecs=1": "wav",
        }

        for mime_type, expected_format in admitted.items():
            with self.subTest(mime_type):
                block = self._emit(
                    AudioInputContent(
                        type="audio",
                        source=InputContentDataSource(
                            type="data", value="SGVsbG8=", mime_type=mime_type
                        ),
                    )
                )

                self.assertTrue(is_data_content_block(block))
                self.assertEqual(
                    self._provider_payload(block),
                    {
                        "type": "input_audio",
                        "input_audio": {"data": "SGVsbG8=", "format": expected_format},
                    },
                )

    def test_admitted_legacy_binary_audio_mime_types_reach_the_provider(self):
        """The legacy `binary` path routes through the SAME gate.

        A divergence between the two paths would put the same clip on the wire
        two different ways depending on which client sent it.
        """
        admitted = {"audio/mpeg": "mp3", "audio/x-wav": "wav", "AUDIO/MPEG": "mp3"}

        for mime_type, expected_format in admitted.items():
            with self.subTest(mime_type):
                block = self._emit(
                    BinaryInputContent(
                        type="binary", mime_type=mime_type, data="SGVsbG8="
                    )
                )

                self.assertEqual(
                    self._provider_payload(block),
                    {
                        "type": "input_audio",
                        "input_audio": {"data": "SGVsbG8=", "format": expected_format},
                    },
                )

    def test_raw_audio_mpeg_would_send_an_invalid_format_enum(self):
        """Why the rewrite is not cosmetic, and why THIS runtime is the worse one.

        Hand the translator the type a client ACTUALLY sends for an MP3 and it
        does not raise — it takes the subtype verbatim and puts `"mpeg"` in a
        field whose only legal values are `"wav"` and `"mp3"`. The request leaves
        the process and the API rejects it, with nothing pointing back to this
        converter. The mirrored TypeScript adapter throws locally on the same
        block; a divergence like that is the class of bug this converter exists
        to fix, and normalizing the spelling before emitting removes it at the
        source.
        """
        raw = {"type": "audio", "base64": "SGVsbG8=", "mime_type": "audio/mpeg"}

        self.assertTrue(is_data_content_block(raw))
        self.assertEqual(
            self._provider_payload(raw),
            # No exception. That is the finding.
            {"type": "input_audio", "input_audio": {"data": "SGVsbG8=", "format": "mpeg"}},
        )

    def test_unsupported_audio_mime_types_stay_on_the_image_url_path(self):
        """Formats the provider's enum cannot name at all.

        Two assertions per row, and neither is enough alone: the converter really
        does keep these on `image_url`, and the standard block it declined to
        emit really would have carried a `format` the API rejects.
        """
        for mime_type in ("audio/ogg", "audio/aac", "audio/webm", "audio/flac", "audio/mp4"):
            with self.subTest(mime_type):
                emitted = self._emit(
                    AudioInputContent(
                        type="audio",
                        source=InputContentDataSource(
                            type="data", value="SGVsbG8=", mime_type=mime_type
                        ),
                    )
                )
                self.assertEqual(
                    emitted,
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:{mime_type};base64,SGVsbG8="},
                    },
                )
                # Degraded but ALIVE: the fallback reaches the wire without
                # raising, which is the whole premise of the narrow gate.
                self.assertEqual(self._provider_payload(emitted), emitted)

                # And the block NOT emitted would have sent an unusable enum.
                declined = {
                    "type": "audio",
                    "base64": "SGVsbG8=",
                    "mime_type": mime_type,
                }
                self.assertEqual(
                    self._provider_payload(declined)["input_audio"]["format"],
                    mime_type.split("/")[-1],
                )

    def test_unsupported_legacy_binary_audio_stays_on_the_image_url_path(self):
        for mime_type in ("audio/ogg", "audio/webm"):
            with self.subTest(mime_type):
                emitted = self._emit(
                    BinaryInputContent(
                        type="binary", mime_type=mime_type, data="SGVsbG8="
                    )
                )
                self.assertEqual(
                    emitted,
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:{mime_type};base64,SGVsbG8="},
                    },
                )

    def test_document_mime_type_is_not_rewritten(self):
        """The normalization is audio-only.

        A document carries its MIME type inside a `file_data` data URL, where no
        enum constrains it, so rewriting one there would corrupt a working path.
        """
        block = self._emit(
            DocumentInputContent(
                type="document",
                source=InputContentDataSource(
                    type="data", value="JVBERi0xLjQK", mime_type="application/vnd.ms-excel"
                ),
            )
        )

        self.assertEqual(
            self._provider_payload(block),
            {
                "type": "file",
                "file": {
                    "file_data": "data:application/vnd.ms-excel;base64,JVBERi0xLjQK",
                    # The MIME TYPE is untouched — `application/vnd.ms-excel`,
                    # verbatim, inside the data URL. The FILENAME is a separate
                    # decision: `.xls` is this type's extension, and
                    # `attachment.vnd.ms-excel` named a file `attachment` with
                    # an extension `.vnd`.
                    "filename": "attachment.xls",
                },
            },
        )

    def test_refused_combinations_stay_off_the_standard_block_path(self):
        """The other half of the decision, pinned to BOTH its halves.

        Each row is a combination this converter refuses to announce as a
        standard block, paired with the exception that is the reason why. Two
        assertions, because either one alone is weak:

        1. the converter really does keep that combination on `image_url` — this
           is what a well-meaning "finish the job" edit to `_STANDARD_BLOCK_TYPES`
           breaks, and pinning only the library behaviour would not notice;
        2. the standard block for it really does die, measured on the REAL path
           (`convert_to_openai_messages`) rather than by calling the translator
           past the `is_data_content_block` gate. All four of these DO pass that
           gate, so the gate is not what saves them — the raise is.

        If one of these ever stops raising, the corresponding row in
        `_STANDARD_BLOCK_TYPES` can be revisited. Not before.
        """
        refused = {
            "audio by url": (
                AudioInputContent(
                    type="audio",
                    source=InputContentUrlSource(
                        type="url", value="https://example.com/a.wav"
                    ),
                ),
                {"type": "audio", "url": "https://example.com/a.wav", "mime_type": "audio/wav"},
                "Key base64 is required for audio blocks",
            ),
            "video by base64": (
                VideoInputContent(
                    type="video",
                    source=InputContentDataSource(
                        type="data", value="AAA=", mime_type="video/mp4"
                    ),
                ),
                {"type": "video", "base64": "AAA=", "mime_type": "video/mp4"},
                "Block of type video is not supported",
            ),
            "video by url": (
                VideoInputContent(
                    type="video",
                    source=InputContentUrlSource(
                        type="url", value="https://example.com/v.mp4"
                    ),
                ),
                {"type": "video", "url": "https://example.com/v.mp4", "mime_type": "video/mp4"},
                "Block of type video is not supported",
            ),
            "file by url": (
                DocumentInputContent(
                    type="document",
                    source=InputContentUrlSource(
                        type="url", value="https://example.com/d.pdf"
                    ),
                    metadata={"filename": "d.pdf"},
                ),
                {
                    "type": "file",
                    "url": "https://example.com/d.pdf",
                    "mime_type": "application/pdf",
                    "filename": "d.pdf",
                },
                "does not support file URLs",
            ),
        }

        for name, (agui_item, standard_block, message) in refused.items():
            with self.subTest(name):
                self.assertEqual(self._emit(agui_item)["type"], "image_url")

                self.assertTrue(is_data_content_block(standard_block))
                with self.assertRaisesRegex(ValueError, message):
                    self._provider_payload(standard_block)

    # ── Data URLs, all the way to the wire ────────────────────────────────
    #
    # THE CLAIM THAT MATTERS for the data-URL rule, and it is only checkable
    # here. The adapter's own output for these inputs is a standard block, and a
    # standard block the translator then REJECTED would be strictly worse than
    # the `image_url` it replaced — a dead run instead of a bad request. So these
    # run the whole leg: an inbound block carrying a `data:` URL, through the
    # AG-UI item it becomes, back out through the converter, and into
    # `convert_to_openai_messages`.
    #
    # Before the data-URL rule both of these reached the provider as `image_url`
    # — a PDF and a WAV labelled as images, which is the failure this whole
    # change exists to fix, recreated by a url-SHAPED source that carried its
    # bytes inline all along.
    #
    # Mirrored in TypeScript by the two `carries a data-URL-backed …` tests in
    # `describe("provider boundary (@langchain/openai)")`.
    def test_a_data_url_backed_pdf_reaches_the_provider_as_a_file_part(self):
        agui = convert_langchain_multimodal_to_agui(
            [
                {
                    "type": "file",
                    "url": "data:application/pdf;base64,JVBERi0xLjQK",
                    "mime_type": "application/pdf",
                    "metadata": {"filename": "in.pdf"},
                }
            ]
        )

        # The AG-UI item the thread now holds says the bytes are INLINE, which is
        # where they really are. Pinned here as well as in the parity table
        # because it is the input to the leg below.
        self.assertEqual(
            agui,
            [
                DocumentInputContent(
                    source=InputContentDataSource(
                        type="data", value="JVBERi0xLjQK", mime_type="application/pdf"
                    ),
                    metadata={"filename": "in.pdf"},
                )
            ],
        )

        self.assertEqual(
            self._provider_payload(self._emit(agui[0])),
            {
                "type": "file",
                "file": {
                    "file_data": "data:application/pdf;base64,JVBERi0xLjQK",
                    "filename": "in.pdf",
                },
            },
        )

    def test_a_data_url_backed_wav_reaches_the_provider_as_input_audio(self):
        agui = convert_langchain_multimodal_to_agui(
            [{"type": "audio", "url": "data:audio/wav;base64,SGVsbG8=", "mime_type": "audio/wav"}]
        )

        self.assertEqual(
            agui,
            [
                AudioInputContent(
                    source=InputContentDataSource(
                        type="data", value="SGVsbG8=", mime_type="audio/wav"
                    )
                )
            ],
        )

        self.assertEqual(
            self._provider_payload(self._emit(agui[0])),
            {"type": "input_audio", "input_audio": {"data": "SGVsbG8=", "format": "wav"}},
        )

    def test_a_stored_url_source_holding_a_data_url_reaches_the_provider(self):
        """The outbound half on its own, for a url source that did NOT come from
        this adapter's inbound leg: a thread persisted before the data-URL rule
        existed still holds one, and so does client JSON that built it directly.
        """
        stored = {
            "PDF": (
                DocumentInputContent(
                    source=InputContentUrlSource(
                        type="url", value="data:application/pdf;base64,JVBERi0xLjQK"
                    ),
                    metadata={"filename": "in.pdf"},
                ),
                {
                    "type": "file",
                    "file": {
                        "file_data": "data:application/pdf;base64,JVBERi0xLjQK",
                        "filename": "in.pdf",
                    },
                },
            ),
            "WAV": (
                AudioInputContent(
                    source=InputContentUrlSource(
                        type="url", value="data:audio/wav;base64,SGVsbG8="
                    )
                ),
                {"type": "input_audio", "input_audio": {"data": "SGVsbG8=", "format": "wav"}},
            ),
            "legacy binary PDF": (
                BinaryInputContent(
                    mime_type="application/pdf",
                    url="data:application/pdf;base64,JVBERi0xLjQK",
                    filename="in.pdf",
                ),
                {
                    "type": "file",
                    "file": {
                        "file_data": "data:application/pdf;base64,JVBERi0xLjQK",
                        "filename": "in.pdf",
                    },
                },
            ),
        }

        for name, (item, expected) in stored.items():
            with self.subTest(name):
                self.assertEqual(self._provider_payload(self._emit(item)), expected)

    def test_a_url_the_data_url_rule_does_not_claim_still_reaches_image_url(self):
        """The other side of the rule, and the reason it is narrow.

        A REMOTE url must still reach the provider as `image_url`: the standard
        block for one RAISES inside `convert_to_openai_data_block`, so widening
        the rule to cover it would turn a degraded request into a dead run. The
        two data-URL spellings below are refused for their own reasons — see
        `_parse_base64_data_url`.
        """
        untouched = {
            "remote document": (
                DocumentInputContent(
                    source=InputContentUrlSource(
                        type="url", value="https://example.com/a.pdf"
                    )
                ),
                "https://example.com/a.pdf",
            ),
            "remote audio": (
                AudioInputContent(
                    source=InputContentUrlSource(
                        type="url", value="https://example.com/a.wav"
                    )
                ),
                "https://example.com/a.wav",
            ),
            "non-base64 data URL": (
                DocumentInputContent(
                    source=InputContentUrlSource(type="url", value="data:text/plain,hello")
                ),
                "data:text/plain,hello",
            ),
            "payload-less data URL": (
                DocumentInputContent(
                    source=InputContentUrlSource(
                        type="url", value="data:application/pdf;base64,"
                    )
                ),
                "data:application/pdf;base64,",
            ),
        }

        for name, (item, url) in untouched.items():
            with self.subTest(name):
                self.assertEqual(
                    self._provider_payload(self._emit(item)),
                    {"type": "image_url", "image_url": {"url": url}},
                )


def _as_typescript_wire_block(block):
    """Re-spell a block THIS package emits into the one the TypeScript adapter
    puts on the wire for the same AG-UI item.

    Both adapters emit the same block; they differ only in field NAMES. Python
    uses langchain-core's spelling (`base64`, top-level `filename`); the
    TypeScript half uses the `source_type` family (`source_type` + `data`,
    `metadata.filename`) — see `standardMediaBlock` in
    `integrations/langgraph/typescript/src/utils.ts`.

    Only the names are rewritten here. Every VALUE comes from this package's own
    converter, so the cross-runtime tests below are driven by what Python
    actually emits today rather than by a literal someone typed once and that
    silently stops matching. The remaining hand-maintained part is this mapping
    itself, which is four lines and sits next to the file it mirrors.
    """
    wire = {
        "type": block["type"],
        "source_type": "base64",
        "data": block["base64"],
        "mime_type": block["mime_type"],
    }
    if "filename" in block:
        wire["metadata"] = {"filename": block["filename"]}
    return wire


class TestCrossRuntimeWireShape(unittest.TestCase):
    """One AG-UI item, out through PYTHON and back in through the TYPESCRIPT
    wire shape, using THIS package's converters on both legs.

    These two adapters implement one protocol and can front the same LangGraph
    server, so the block one emits has to be both translatable for the provider
    AND readable by the other one's return leg. Nothing else in either test
    suite covers that seam, and it is where this PR's first two rounds went
    wrong: each half was verified against its own runtime only.

    Asserting a hand-copied TypeScript literal against `langchain_core` alone
    would not cover it — that exercises the library, not this package. The round
    trips below call `convert_agui_multimodal_to_langchain` on the way out and
    `convert_langchain_multimodal_to_agui` on the way back, with
    `_as_typescript_wire_block` standing in for the sibling runtime in between.
    """

    def test_document_survives_the_cross_runtime_round_trip(self):
        """AG-UI -> Python outbound -> TS wire shape -> Python return leg.

        The inbound half is the shape the sibling runtime actually produces
        (`source_type` + `data` + `metadata.filename`), which Python's return leg
        used to drop on the floor — an attachment that vanishes from a reopened
        thread.
        """
        original = DocumentInputContent(
            type="document",
            source=InputContentDataSource(
                type="data", value="JVBERi0xLjQK", mime_type="application/pdf"
            ),
            metadata={"filename": "invoice-q2.pdf"},
        )

        [emitted] = convert_agui_multimodal_to_langchain([original])
        wire = _as_typescript_wire_block(emitted)

        # The sibling runtime's spelling still reaches the provider correctly …
        self.assertTrue(is_data_content_block(wire))
        [message] = convert_to_openai_messages([HumanMessage(content=[dict(wire)])])
        self.assertEqual(
            message["content"],
            [
                {
                    "type": "file",
                    "file": {
                        "file_data": "data:application/pdf;base64,JVBERi0xLjQK",
                        "filename": "invoice-q2.pdf",
                    },
                }
            ],
        )

        # … and this package's return leg rebuilds the item it started as.
        [returned] = convert_langchain_multimodal_to_agui([wire])
        self.assertIsInstance(returned, DocumentInputContent)
        self.assertIsInstance(returned.source, InputContentDataSource)
        self.assertEqual(returned.source.value, original.source.value)
        self.assertEqual(returned.source.mime_type, original.source.mime_type)
        self.assertEqual(returned.metadata, {"filename": "invoice-q2.pdf"})

    def test_audio_survives_the_cross_runtime_round_trip(self):
        """Same seam, for inline audio — which translates to `input_audio`
        rather than `file`, so it exercises a different translator branch."""
        original = AudioInputContent(
            type="audio",
            source=InputContentDataSource(
                type="data", value="SGVsbG8=", mime_type="audio/wav"
            ),
            metadata={"filename": "clip.wav"},
        )

        [emitted] = convert_agui_multimodal_to_langchain([original])
        wire = _as_typescript_wire_block(emitted)

        self.assertTrue(is_data_content_block(wire))
        [message] = convert_to_openai_messages([HumanMessage(content=[dict(wire)])])
        self.assertEqual(
            message["content"],
            [{"type": "input_audio", "input_audio": {"data": "SGVsbG8=", "format": "wav"}}],
        )

        [returned] = convert_langchain_multimodal_to_agui([wire])
        self.assertIsInstance(returned, AudioInputContent)
        self.assertIsInstance(returned.source, InputContentDataSource)
        self.assertEqual(returned.source.value, original.source.value)
        self.assertEqual(returned.source.mime_type, original.source.mime_type)
        self.assertEqual(returned.metadata, {"filename": "clip.wav"})

    def test_mpeg_audio_survives_the_cross_runtime_round_trip_as_mp3(self):
        """The normalized spelling is what crosses the seam — in BOTH directions.

        An MP3 arrives as `audio/mpeg`, which neither runtime can put on the wire
        under that name. The converter rewrites it to `audio/mp3` once, on the way
        out, so the sibling runtime's translator accepts it (it throws on
        `audio/mpeg`) and this runtime's produces the same `format` value rather
        than an invalid one.

        The visible consequence, pinned here rather than left to be discovered: a
        round trip through MESSAGES_SNAPSHOT reports the attachment as
        `audio/mp3`, not the `audio/mpeg` the client sent. The rewrite is between
        two spellings of one format, so the bytes and the format are unchanged —
        only the name is, and only to the one the provider recognises.
        """
        original = AudioInputContent(
            type="audio",
            source=InputContentDataSource(
                type="data", value="SGVsbG8=", mime_type="audio/mpeg"
            ),
            metadata={"filename": "podcast.mp3"},
        )

        [emitted] = convert_agui_multimodal_to_langchain([original])
        self.assertEqual(emitted["mime_type"], "audio/mp3")

        wire = _as_typescript_wire_block(emitted)
        self.assertTrue(is_data_content_block(wire))
        [message] = convert_to_openai_messages([HumanMessage(content=[dict(wire)])])
        self.assertEqual(
            message["content"],
            [{"type": "input_audio", "input_audio": {"data": "SGVsbG8=", "format": "mp3"}}],
        )

        [returned] = convert_langchain_multimodal_to_agui([wire])
        self.assertIsInstance(returned, AudioInputContent)
        self.assertEqual(returned.source.value, original.source.value)
        self.assertEqual(returned.source.mime_type, "audio/mp3")
        self.assertEqual(returned.metadata, {"filename": "podcast.mp3"})

    # ── The return leg reads all three vocabularies ────────────────────
    #
    # `convert_langchain_multimodal_to_agui` builds the user message inside
    # MESSAGES_SNAPSHOT. A vocabulary it cannot read is an attachment that
    # vanishes from a reopened thread — the file was sent, the model read it,
    # and the thread shows a bare line of text. It used to read only shape 2
    # (LangChain Python), so every base64 media block the TypeScript adapter
    # sends was dropped outright.

    def test_every_standard_block_kind_comes_back_as_its_own_media_type(self):
        """EVERY block kind the return leg claims to understand, not just `file`.

        The map behind this is what keeps a non-image attachment in a reopened
        thread: a kind missing from it matches no branch of the converter at
        all, so the block is not converted, not warned about and not dropped
        loudly — it is simply absent from the next MESSAGES_SNAPSHOT, which is
        what the thread permanently becomes.

        The `image` row is the one that had no test of its own. It was
        incidentally exercised elsewhere, which is not the same thing: deleting
        the row raised a `KeyError` somewhere unrelated, while RETYPING it —
        mapping `image` to `DocumentInputContent` — left the whole suite green.

        Mirrored in the TypeScript suite by
        `brings a standard %s block back as AG-UI %s content`.
        """
        cases = [
            ("audio", "audio/wav", AudioInputContent),
            ("video", "video/mp4", VideoInputContent),
            ("image", "image/png", ImageInputContent),
            ("file", "application/pdf", DocumentInputContent),
        ]

        for block_type, mime_type, agui_class in cases:
            with self.subTest(block_type=block_type):
                agui_content = convert_langchain_multimodal_to_agui([
                    {
                        "type": block_type,
                        "source_type": "base64",
                        "data": "QUJD",
                        "mime_type": mime_type,
                    },
                ])

                self.assertEqual(len(agui_content), 1)
                self.assertIsInstance(agui_content[0], agui_class)
                self.assertEqual(agui_content[0].source.value, "QUJD")
                self.assertEqual(agui_content[0].source.mime_type, mime_type)

    def test_js_native_base64_block_is_read(self):
        """Shape 1, base64: native LangChain.js — `data` + `mimeType`."""
        agui_content = convert_langchain_multimodal_to_agui([
            {
                "type": "file",
                "data": "JVBERi0xLjQK",
                "mimeType": "application/pdf",
                "metadata": {"filename": "invoice-q2.pdf"},
            },
        ])

        self.assertEqual(len(agui_content), 1)
        self.assertIsInstance(agui_content[0], DocumentInputContent)
        self.assertIsInstance(agui_content[0].source, InputContentDataSource)
        self.assertEqual(agui_content[0].source.value, "JVBERi0xLjQK")
        self.assertEqual(agui_content[0].source.mime_type, "application/pdf")
        self.assertEqual(agui_content[0].metadata, {"filename": "invoice-q2.pdf"})

    def test_js_native_url_block_is_read(self):
        """Shape 1, url: native LangChain.js — `url` + `mimeType`."""
        agui_content = convert_langchain_multimodal_to_agui([
            {
                "type": "audio",
                "url": "https://example.com/clip.wav",
                "mimeType": "audio/wav",
                "metadata": {"filename": "clip.wav"},
            },
        ])

        self.assertEqual(len(agui_content), 1)
        self.assertIsInstance(agui_content[0], AudioInputContent)
        self.assertIsInstance(agui_content[0].source, InputContentUrlSource)
        self.assertEqual(agui_content[0].source.value, "https://example.com/clip.wav")
        self.assertEqual(agui_content[0].source.mime_type, "audio/wav")
        self.assertEqual(agui_content[0].metadata, {"filename": "clip.wav"})

    def test_python_native_base64_block_is_read(self):
        """Shape 2, base64: LangChain Python — `base64` + top-level `filename`."""
        agui_content = convert_langchain_multimodal_to_agui([
            {
                "type": "file",
                "base64": "JVBERi0xLjQK",
                "mime_type": "application/pdf",
                "filename": "invoice-q2.pdf",
            },
        ])

        self.assertEqual(len(agui_content), 1)
        self.assertIsInstance(agui_content[0], DocumentInputContent)
        self.assertIsInstance(agui_content[0].source, InputContentDataSource)
        self.assertEqual(agui_content[0].source.value, "JVBERi0xLjQK")
        self.assertEqual(agui_content[0].source.mime_type, "application/pdf")
        self.assertEqual(agui_content[0].metadata, {"filename": "invoice-q2.pdf"})

    def test_python_native_url_block_is_read(self):
        """Shape 2, url: LangChain Python — `url` + `mime_type`."""
        agui_content = convert_langchain_multimodal_to_agui([
            {
                "type": "video",
                "url": "https://example.com/demo.mp4",
                "mime_type": "video/mp4",
                "filename": "demo.mp4",
            },
        ])

        self.assertEqual(len(agui_content), 1)
        self.assertIsInstance(agui_content[0], VideoInputContent)
        self.assertIsInstance(agui_content[0].source, InputContentUrlSource)
        self.assertEqual(agui_content[0].source.value, "https://example.com/demo.mp4")
        self.assertEqual(agui_content[0].source.mime_type, "video/mp4")
        self.assertEqual(agui_content[0].metadata, {"filename": "demo.mp4"})

    # Shape 3, base64 (the `source_type` family the TypeScript adapter emits) is
    # covered by `test_document_survives_the_cross_runtime_round_trip` above,
    # which builds it from this package's own outbound leg instead of a literal.

    def test_ts_emitted_url_block_is_read_back_into_agui(self):
        """Shape 3, url: the `source_type` family, URL variant."""
        agui_content = convert_langchain_multimodal_to_agui([
            {
                "type": "file",
                "source_type": "url",
                "url": "https://example.com/invoice-q2.pdf",
                "mime_type": "application/pdf",
                "metadata": {"filename": "invoice-q2.pdf"},
            },
        ])

        self.assertEqual(len(agui_content), 1)
        self.assertIsInstance(agui_content[0], DocumentInputContent)
        self.assertIsInstance(agui_content[0].source, InputContentUrlSource)
        self.assertEqual(
            agui_content[0].source.value, "https://example.com/invoice-q2.pdf"
        )
        self.assertEqual(agui_content[0].source.mime_type, "application/pdf")
        self.assertEqual(agui_content[0].metadata, {"filename": "invoice-q2.pdf"})

    def test_filename_falls_back_to_metadata_name_and_title(self):
        """`metadata.name` / `metadata.title` are the other spellings the
        provider translators read, so the return leg must not lose them."""
        by_name, by_title = convert_langchain_multimodal_to_agui([
            {
                "type": "file",
                "source_type": "base64",
                "data": "JVBERi0xLjQK",
                "mime_type": "application/pdf",
                "metadata": {"name": "named.pdf"},
            },
            {
                "type": "file",
                "source_type": "base64",
                "data": "JVBERi0xLjQK",
                "mime_type": "application/pdf",
                "metadata": {"title": "titled.pdf"},
            },
        ])

        self.assertEqual(by_name.metadata, {"filename": "named.pdf"})
        self.assertEqual(by_title.metadata, {"filename": "titled.pdf"})

    def test_empty_filename_falls_through_to_name_and_title(self):
        """An EMPTY `metadata.filename` must not shadow the spellings behind it.

        This reader always scanned for the first non-empty string; the mirrored
        TypeScript adapter used a `??` chain, which falls through on
        null/undefined only, so an empty `filename` stopped it dead and threw
        away the name `metadata.name` was carrying. Pinned on both sides so they
        cannot drift apart again.
        """
        by_name, by_title = convert_langchain_multimodal_to_agui([
            {
                "type": "file",
                "source_type": "base64",
                "data": "JVBERi0xLjQK",
                "mime_type": "application/pdf",
                "metadata": {"filename": "", "name": "report.pdf", "title": "Q2"},
            },
            {
                "type": "file",
                "source_type": "base64",
                "data": "JVBERi0xLjQK",
                "mime_type": "application/pdf",
                "metadata": {"filename": "", "name": "", "title": "from-title.pdf"},
            },
        ])

        self.assertEqual(by_name.metadata, {"filename": "report.pdf"})
        self.assertEqual(by_title.metadata, {"filename": "from-title.pdf"})

    def test_base64_block_without_mime_type_is_not_dropped(self):
        """AG-UI's data source REQUIRES a MIME type; a malformed block degrades
        to the least wrong one rather than losing the attachment."""
        agui_content = convert_langchain_multimodal_to_agui([
            {"type": "file", "source_type": "base64", "data": "JVBERi0xLjQK"},
        ])

        self.assertEqual(len(agui_content), 1)
        self.assertEqual(agui_content[0].source.mime_type, "application/octet-stream")
        self.assertIsNone(agui_content[0].metadata)

    def test_reference_only_block_is_still_dropped(self):
        """A block that names provider-side storage carries no bytes and no URL,
        and AG-UI's typed classes have nowhere to put that."""
        agui_content = convert_langchain_multimodal_to_agui([
            {"type": "file", "source_type": "id", "id": "file-abc123"},
            {"type": "file", "fileId": "file-abc123"},
        ])

        self.assertEqual(agui_content, [])

    def test_js_native_spelling_is_forwarded_unrecognized_not_rejected(self):
        """Why neither adapter emits LangChain.js's native field names.

        An earlier version of this test called `convert_to_openai_data_block`
        directly, saw a `ValueError`, and concluded Python REJECTS that shape.
        That verdict came from calling PAST the gate the real path uses, and it
        is wrong for three of the four modalities. Measured with langchain-core
        1.2.13 through `convert_to_openai_messages`, on
        `{type, data, mimeType, metadata.filename}`:

            file   is_data_content_block -> False, forwarded VERBATIM
            audio  is_data_content_block -> False, forwarded VERBATIM
            video  is_data_content_block -> False, forwarded VERBATIM
            image  is_data_content_block -> False, raises ("Unrecognized
                   content block … does not have a 'source' or 'image' key")

        Silently forwarded is not better than rejected, it is worse: the run
        does not die here with a stack trace naming the block, it dies at the
        provider on a content block nobody in this repo emitted deliberately.
        Which is the actual reason the spelling matters — not that Python
        refuses it, but that Python does not RECOGNIZE it.
        """
        [emitted] = convert_agui_multimodal_to_langchain([
            DocumentInputContent(
                type="document",
                source=InputContentDataSource(
                    type="data", value="JVBERi0xLjQK", mime_type="application/pdf"
                ),
                metadata={"filename": "invoice-q2.pdf"},
            )
        ])

        # The spelling this package emits is recognized, and translated.
        self.assertTrue(is_data_content_block(emitted))
        [message] = convert_to_openai_messages([HumanMessage(content=[dict(emitted)])])
        self.assertEqual(
            message["content"],
            [
                {
                    "type": "file",
                    "file": {
                        "file_data": "data:application/pdf;base64,JVBERi0xLjQK",
                        "filename": "invoice-q2.pdf",
                    },
                }
            ],
        )

        # The SAME payload under LangChain.js's native names is not recognized,
        # and goes to the provider untouched. Built from `emitted` so it tracks
        # whatever this package emits rather than a frozen literal.
        js_native = {
            "type": emitted["type"],
            "data": emitted["base64"],
            "mimeType": emitted["mime_type"],
            "metadata": {"filename": emitted["filename"]},
        }
        self.assertFalse(is_data_content_block(js_native))
        [message] = convert_to_openai_messages([HumanMessage(content=[dict(js_native)])])
        self.assertEqual(message["content"], [js_native])


class TestOutboundDispatchAdmitsAndResolvesByTheSameRule(unittest.TestCase):
    """What the outbound loop LETS IN and what it then DOES with it have to be
    decided by one rule.

    The media branch is entered by `isinstance`, which is subclass-tolerant by
    definition. If the modality is then resolved by exact class identity, the two
    halves disagree for exactly the inputs `isinstance` was chosen to accept: a
    subclass passes the gate, misses the lookup, and silently falls through to
    the legacy `image_url` form — which for a document is the provider 400
    ("Invalid MIME type. Only image types are supported") this whole path exists
    to avoid. Subclassing a pydantic content model is ordinary: it is how an
    application attaches its own fields to an attachment.
    """

    def _emit(self, item):
        [block] = convert_agui_multimodal_to_langchain([item])
        return block

    def test_subclassed_media_item_keeps_its_own_modality(self):
        """A subclass gets the block its BASE class would have got."""

        class TenantAudioInputContent(AudioInputContent):
            pass

        class TenantDocumentInputContent(DocumentInputContent):
            pass

        audio = self._emit(
            TenantAudioInputContent(
                source=InputContentDataSource(
                    type="data", value="SGVsbG8=", mime_type="audio/wav"
                ),
            )
        )
        self.assertEqual(
            audio,
            {"type": "audio", "base64": "SGVsbG8=", "mime_type": "audio/wav"},
        )
        self.assertTrue(is_data_content_block(audio))

        document = self._emit(
            TenantDocumentInputContent(
                source=InputContentDataSource(
                    type="data", value="JVBERi0xLjQK", mime_type="application/pdf"
                ),
                metadata={"filename": "report.pdf"},
            )
        )
        self.assertEqual(
            document,
            {
                "type": "file",
                "base64": "JVBERi0xLjQK",
                "mime_type": "application/pdf",
                "filename": "report.pdf",
            },
        )
        self.assertTrue(is_data_content_block(document))

    def test_subclassed_media_item_the_converter_refuses_still_falls_back(self):
        """Subclass tolerance is not a licence to emit a standard block for a
        combination the translator rejects.

        Image and video have no row in `_STANDARD_BLOCK_TYPES`, so a subclass of
        either must land on `image_url` exactly as its base class does — the
        subclass fix must not turn "no row" into "some row".
        """

        class TenantImageInputContent(ImageInputContent):
            pass

        class TenantVideoInputContent(VideoInputContent):
            pass

        self.assertEqual(
            self._emit(
                TenantImageInputContent(
                    source=InputContentDataSource(
                        type="data", value="iVBOR", mime_type="image/png"
                    ),
                )
            ),
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBOR"}},
        )
        self.assertEqual(
            self._emit(
                TenantVideoInputContent(
                    source=InputContentDataSource(
                        type="data", value="AAA=", mime_type="video/mp4"
                    ),
                )
            ),
            {"type": "image_url", "image_url": {"url": "data:video/mp4;base64,AAA="}},
        )

    def test_subclassed_audio_the_provider_cannot_carry_falls_back(self):
        """The MIME gate applies to a subclass too: `audio/ogg` has no `format`
        enum value, so it keeps `image_url` rather than killing the run."""

        class TenantAudioInputContent(AudioInputContent):
            pass

        self.assertEqual(
            self._emit(
                TenantAudioInputContent(
                    source=InputContentDataSource(
                        type="data", value="T2dn", mime_type="audio/ogg"
                    ),
                )
            ),
            {"type": "image_url", "image_url": {"url": "data:audio/ogg;base64,T2dn"}},
        )

    def test_flattened_subclassed_media_keeps_its_modality_label(self):
        """`flatten_user_content` had the SAME split rule — `isinstance` gate,
        `type(item)` label lookup — so a subclassed attachment flattened to the
        generic `[Media: …]` instead of `[Audio: …]`.

        This is the text a model sees when the graph cannot take multimodal
        content, so the label is the only description of the attachment it gets.
        """

        class TenantAudioInputContent(AudioInputContent):
            pass

        class TenantDocumentInputContent(DocumentInputContent):
            pass

        source = InputContentDataSource(
            type="data", value="SGVsbG8=", mime_type="audio/wav"
        )
        self.assertEqual(
            flatten_user_content([TenantAudioInputContent(source=source)]),
            flatten_user_content([AudioInputContent(source=source)]),
        )
        self.assertEqual(
            flatten_user_content([TenantAudioInputContent(source=source)]),
            "[Audio: audio/wav]",
        )

        pdf = InputContentUrlSource(type="url", value="https://example.com/d.pdf")
        self.assertEqual(
            flatten_user_content([TenantDocumentInputContent(source=pdf)]),
            "[Document: https://example.com/d.pdf]",
        )

    def test_unrecognized_content_item_is_dropped_with_a_warning(self):
        """An item matching no branch fell out of the loop with no trace at all.

        Its neighbours in the same loop already log `Dropping ...` when they
        cannot convert something, so the one case that drops the item ENTIRELY
        was the only one that left the operator nothing to search for.
        """

        class SomeFutureContent:
            pass

        with self.assertLogs("ag_ui_langgraph.utils", level="WARNING") as captured:
            emitted = convert_agui_multimodal_to_langchain(
                [TextInputContent(text="hello"), SomeFutureContent()]
            )

        self.assertEqual(emitted, [{"type": "text", "text": "hello"}])
        self.assertIn("Dropping", captured.output[0])
        self.assertIn("SomeFutureContent", captured.output[0])


class TestMalformedGraphContentDegrades(unittest.TestCase):
    """The return leg tolerates what the graph actually sends.

    Everything here converts LangChain content that a graph produced back into
    AG-UI. That direction has a property the outbound one does not: it builds the
    user message INSIDE `MESSAGES_SNAPSHOT`, so an exception raised on one bad
    block does not degrade that block — it escapes the whole conversion and the
    client is handed no messages at all. One malformed value from the graph
    loses the entire thread.

    So every case below asserts the same two things: the conversion does not
    raise, and the blocks around the bad one survive.

    An earlier revision of this docstring said "the TypeScript adapter already
    skips these". It did not. Measured by running the 16 inputs this class
    exercises through `langchainMessagesToAgui` at `8d53261c4` (the commit before
    `a2a24afab`, which wrote the malformed-input contract into both files) and
    again after:

      * ``{"image_url": {"url": 42}}`` — TypeScript RAISED
        ``TypeError: imageUrl.startsWith is not a function`` out of the whole
        message-list conversion. Not skipped: the client got no messages at all.
      * ``{"type": "text", "text": {...}}`` — TypeScript emitted it VERBATIM into
        ``TextInputContent.text``, where it failed schema validation downstream.
        Not skipped either.
      * the other eleven — TypeScript did skip them, but SILENTLY: zero warnings,
        where this runtime logged one. Skipping and announcing a drop are two
        different behaviours and the runtimes agreed on only the first.
      * the two non-string ``mime_type`` cases — TypeScript already matched.

    What is true NOW: as of `a2a24afab` all sixteen agree on the value returned,
    on what was dropped, and on a drop being logged. Keeping them agreeing is not
    this docstring's job — it is
    `../../cross-runtime-parity-cases.json`, the shared table both suites read
    (see `TestCrossRuntimeParityTable`), which fails when either runtime moves
    alone.
    """

    # ── the `image_url` payload ──────────────────────────────────────────

    def test_null_image_url_payload_is_dropped_instead_of_raising(self):
        """`{"image_url": null}` used to hit `None.startswith` and take the
        entire message list down with it."""
        with self.assertLogs("ag_ui_langgraph.utils", level="WARNING") as logs:
            agui_content = convert_langchain_multimodal_to_agui([
                {"type": "image_url", "image_url": None},
            ])

        self.assertEqual(agui_content, [])
        self.assertIn("Dropping image_url block", logs.output[0])

    def test_non_string_non_dict_image_url_payload_is_dropped(self):
        """A payload of the wrong TYPE carries no url either, and `startswith`
        is just as absent from an int or a list as it is from None."""
        for payload in (42, [], ["https://example.com/a.png"], True):
            with self.subTest(payload=payload):
                with self.assertLogs("ag_ui_langgraph.utils", level="WARNING"):
                    self.assertEqual(
                        convert_langchain_multimodal_to_agui([
                            {"type": "image_url", "image_url": payload},
                        ]),
                        [],
                    )

    def test_payload_yielding_an_empty_url_is_dropped_not_emitted(self):
        """The quiet half of the defect. These did not raise — they minted an
        `ImageInputContent` whose url is `""`, i.e. an attachment pointing at
        nothing, with no warning that anything was wrong."""
        for payload in ({}, {"url": None}, {"url": ""}, {"url": 42}, ""):
            with self.subTest(payload=payload):
                with self.assertLogs("ag_ui_langgraph.utils", level="WARNING"):
                    self.assertEqual(
                        convert_langchain_multimodal_to_agui([
                            {"type": "image_url", "image_url": payload},
                        ]),
                        [],
                    )

    def test_image_url_block_with_no_payload_at_all_is_dropped(self):
        with self.assertLogs("ag_ui_langgraph.utils", level="WARNING"):
            self.assertEqual(
                convert_langchain_multimodal_to_agui([{"type": "image_url"}]),
                [],
            )

    def test_usable_image_url_payloads_still_convert(self):
        """The other side of the guard: what IS usable must keep working — the
        `{"url": …}` shape, the bare string both runtimes also accept, and the
        data-URL parse underneath both."""
        by_dict, bare_string, data_url = convert_langchain_multimodal_to_agui([
            {"type": "image_url", "image_url": {"url": "https://example.com/a.png"}},
            {"type": "image_url", "image_url": "https://example.com/b.png"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KGgo"}},
        ])

        self.assertEqual(by_dict.source.value, "https://example.com/a.png")
        self.assertEqual(bare_string.source.value, "https://example.com/b.png")
        self.assertEqual(data_url.source.value, "iVBORw0KGgo")
        self.assertEqual(data_url.source.mime_type, "image/png")

    def test_a_malformed_block_does_not_take_down_the_messages_around_it(self):
        """The reason this matters at all.

        `convert_langchain_multimodal_to_agui` is called from
        `langchain_messages_to_agui`, which builds the whole `MESSAGES_SNAPSHOT`.
        An exception on the middle message is not a lost attachment, it is a lost
        conversation — so assert the neighbours survive, not merely that the bad
        block is skipped.
        """
        with self.assertLogs("ag_ui_langgraph.utils", level="WARNING"):
            messages = langchain_messages_to_agui([
                HumanMessage(id="m1", content="before"),
                HumanMessage(
                    id="m2",
                    content=[
                        {"type": "text", "text": "look at this"},
                        {"type": "image_url", "image_url": None},
                    ],
                ),
                HumanMessage(id="m3", content="after"),
            ])

        self.assertEqual([m.id for m in messages], ["m1", "m2", "m3"])
        self.assertEqual(messages[0].content, "before")
        self.assertEqual(messages[2].content, "after")
        # The surviving text of the message that carried the bad block, too.
        self.assertEqual([c.text for c in messages[1].content], ["look at this"])

    # ── the same defect elsewhere on the return leg ──────────────────────

    def test_non_string_text_block_is_dropped(self):
        """`TextInputContent.text` is a `str`; a block whose `text` is not one
        raised a ValidationError out of the whole list."""
        with self.assertLogs("ag_ui_langgraph.utils", level="WARNING") as logs:
            agui_content = convert_langchain_multimodal_to_agui([
                {"type": "text", "text": None},
                {"type": "text", "text": {"nested": "block"}},
                {"type": "text", "text": "survivor"},
            ])

        self.assertEqual([c.text for c in agui_content], ["survivor"])
        self.assertEqual(len(logs.output), 2)
        self.assertIn("Dropping text block", logs.output[0])

    def test_non_string_mime_type_does_not_abort_the_conversion(self):
        """A media block's MIME type is read off the wire the same way its
        filename is, and a non-string one is treated as absent rather than
        handed to a source class that requires `str | None`."""
        by_url, by_data = convert_langchain_multimodal_to_agui([
            {"type": "image", "url": "https://example.com/a.png", "mime_type": {"a": 1}},
            {"type": "audio", "base64": "QUJD", "mime_type": 123},
        ])

        self.assertEqual(by_url.source.value, "https://example.com/a.png")
        self.assertIsNone(by_url.source.mime_type)
        # The documented fallback for a data block that arrives without a type.
        self.assertEqual(by_data.source.mime_type, "application/octet-stream")
        self.assertEqual(by_data.source.value, "QUJD")

    def test_non_string_encrypted_reasoning_content_is_ignored(self):
        """`ReasoningMessage.encrypted_value` is `str | None`. A provider block
        carrying something else has nothing round-trippable in it, and must not
        cost the snapshot the messages around it."""
        messages = langchain_messages_to_agui([
            AIMessage(
                id="a1",
                content=[
                    {
                        "type": "reasoning",
                        "summary": [{"text": "because X"}],
                        "encrypted_content": {"blob": "not-a-string"},
                    }
                ],
            ),
        ])

        reasoning, assistant = messages
        self.assertEqual(reasoning.content, "because X")
        self.assertIsNone(reasoning.encrypted_value)
        self.assertEqual(assistant.id, "a1")

    def test_non_string_reasoning_summary_text_is_skipped(self):
        """A summary part whose `text` is not text joined into a `TypeError`."""
        messages = langchain_messages_to_agui([
            AIMessage(
                id="a1",
                content=[
                    {
                        "type": "reasoning",
                        "summary": [{"text": {"nested": 1}}, {"text": "readable"}],
                    }
                ],
            ),
        ])

        self.assertEqual(messages[0].content, "readable")

    def test_unserializable_tool_call_arguments_do_not_abort_the_snapshot(self):
        """Tool-call `args` is `dict[str, Any]`, so a graph can put a datetime in
        it; a bare `json.dumps` raised and lost every message in the snapshot
        over one argument."""
        messages = langchain_messages_to_agui([
            HumanMessage(id="m1", content="before"),
            AIMessage(
                id="a1",
                content="",
                tool_calls=[
                    {
                        "id": "tc1",
                        "name": "book",
                        "args": {"when": datetime(2026, 1, 2, 3, 4, 5)},
                    }
                ],
            ),
        ])

        self.assertEqual([m.id for m in messages], ["m1", "a1"])
        self.assertEqual(
            messages[1].tool_calls[0].function.arguments,
            '{"when": "2026-01-02T03:04:05"}',
        )


class _ConverterOutcome(NamedTuple):
    """What one converter call did, in the three terms the contract is written in."""

    content: list
    warnings: list


def _run_converter(direction, content):
    """Drive one converter and capture every warning it emitted.

    `assertLogs` cannot express "and nothing was logged" without a second API, and
    the contract's second rule is a COUNT ("logged, once"), not a presence check —
    so the records are captured directly and counted.
    """
    logger = logging.getLogger("ag_ui_langgraph.utils")
    records = []

    class _Capture(logging.Handler):
        def emit(self, record):
            records.append(record)

    handler = _Capture()
    previous_level, previous_propagate = logger.level, logger.propagate
    logger.addHandler(handler)
    logger.setLevel(logging.DEBUG)
    logger.propagate = False
    try:
        if direction == "inbound":
            converted = convert_langchain_multimodal_to_agui(content)
        else:
            converted = convert_agui_multimodal_to_langchain(content)
    finally:
        logger.removeHandler(handler)
        logger.setLevel(previous_level)
        logger.propagate = previous_propagate

    return _ConverterOutcome(
        list(converted),
        [r.getMessage() for r in records if r.levelno >= logging.WARNING],
    )


# A module prefix on a log line, e.g. ``[convert_agui_multimodal_to_langchain] ``.
#
# Stripped before the drop rule is applied, NOT matched around. This runtime's
# ``record.getMessage()`` carries no prefix and the TypeScript adapter prefixes
# every `console.warn` line with the emitting function, and that difference is
# the whole reason the two parity harnesses ended up enforcing DIFFERENT rules:
# TypeScript had loosened to a substring match (``/Dropping /``, matching
# anywhere in the line) while this side kept ``startswith("Dropping ")``, and
# both comments claimed the ``startswith`` rule. A line that MENTIONS
# "Dropping " somewhere in its prose without being a drop announcement counted
# there and not here. Normalize the prefix away, then apply the one rule on the
# one form.
_LOG_MODULE_PREFIX = re.compile(r"^\[[^\]]*\]\s*")


def _count_drop_logs(warnings):
    """Rule 2 of the malformed-input contract: warnings that BEGIN "Dropping ",
    once the runtime's own module prefix is removed.

    The rest of the prose legitimately differs between the runtimes (``int`` vs
    ``number``, ``dict`` vs ``object``), so asserting it would fail on wording
    rather than on behaviour. Kept byte-identical to the TypeScript harness's
    ``countDropLogs``.
    """
    return sum(
        1
        for line in warnings
        if _LOG_MODULE_PREFIX.sub("", line).startswith("Dropping ")
    )


class TestMalformedInputContract(unittest.TestCase):
    """THE MALFORMED-INPUT CONTRACT.

    The three rules written above the two converters in ``ag_ui_langgraph/utils.py``
    (and above their mirror images in the TypeScript adapter's ``utils.ts``): DROP
    NEVER RAISE, EVERY DROP IS LOGGED, ONE BAD ITEM COSTS ONLY ITSELF. Every test
    here asserts one of those three on one branch, and every one has a named
    counterpart in the TypeScript suite's ``describe("the malformed-input
    contract")`` — because the defect these exist to catch is a fix landing in one
    runtime and not the other. `cross-runtime-parity-cases.json`, read by
    `TestCrossRuntimeParityTable` below, is the same claim made as data.

    The distinction the second rule turns on: a DROP is logged, a KEPT block is
    not. An assertion on the return value alone cannot tell a logged drop from a
    silent one, which is how every past divergence here survived review.
    """

    def _inbound(self, content):
        return _run_converter("inbound", content)

    def _outbound(self, content):
        return _run_converter("outbound", content)

    # ── rule 1: the `image_url` payload ──────────────────────────────────
    def test_non_string_url_is_dropped_instead_of_raising(self):
        """``{"url": 42}`` is truthy, so a raw read handed a NUMBER to
        ``startswith("data:")`` and raised out of the loop that builds the whole
        MESSAGES_SNAPSHOT — the client got no messages at all, over one
        attachment."""
        outcome = self._inbound([{"type": "image_url", "image_url": {"url": 42}}])

        self.assertEqual(outcome.content, [])
        self.assertEqual(len(outcome.warnings), 1)
        self.assertIn(
            "Dropping image_url block: no usable url in its dict payload",
            outcome.warnings[0],
        )

    def test_every_unusable_image_url_payload_logs_exactly_one_drop(self):
        """The QUIET half of the same defect: these never raised, they minted an
        ``ImageInputContent`` whose url is ``""`` — an attachment pointing at
        nothing — or dropped the block with nothing said."""
        payloads = [
            ("a non-string url", {"url": 42}),
            ("an empty url", {"url": ""}),
            ("a null url", {"url": None}),
            ("a dict url", {"url": {}}),
            ("a None payload", None),
            ("a numeric payload", 42),
            ("a boolean payload", True),
            ("a list payload", []),
            ("a url wrapped in a list", ["https://example.com/a.png"]),
            ("a dict with no url key", {}),
            ("an empty bare string", ""),
        ]
        for name, payload in payloads:
            with self.subTest(payload=name):
                outcome = self._inbound(
                    [{"type": "image_url", "image_url": payload}]
                )
                self.assertEqual(outcome.content, [])
                self.assertEqual(len(outcome.warnings), 1)
                self.assertIn("Dropping image_url block", outcome.warnings[0])

    def test_image_url_block_with_no_payload_key_logs_one_drop(self):
        outcome = self._inbound([{"type": "image_url"}])

        self.assertEqual(outcome.content, [])
        self.assertEqual(
            outcome.warnings,
            ["Dropping image_url block: no usable url in its NoneType payload"],
        )

    # ── rule 3 ───────────────────────────────────────────────────────────
    def test_blocks_on_either_side_of_an_unreadable_image_url_survive(self):
        """Why rule 1 is worth a rule: the raise did not degrade one attachment,
        it discarded the two text blocks beside it as well."""
        outcome = self._inbound([
            {"type": "text", "text": "before"},
            {"type": "image_url", "image_url": {"url": 42}},
            {"type": "text", "text": "after"},
        ])

        self.assertEqual([c.text for c in outcome.content], ["before", "after"])
        self.assertEqual(len(outcome.warnings), 1)

    def test_every_other_message_survives_one_unreadable_block(self):
        with self.assertLogs("ag_ui_langgraph.utils", level="WARNING"):
            messages = langchain_messages_to_agui([
                HumanMessage(id="m1", content="before"),
                HumanMessage(
                    id="m2",
                    content=[{"type": "image_url", "image_url": {"url": 42}}],
                ),
                HumanMessage(id="m3", content="after"),
            ])

        self.assertEqual([m.id for m in messages], ["m1", "m2", "m3"])
        self.assertEqual(messages[0].content, "before")
        self.assertEqual(messages[2].content, "after")

    # ── rule 1 + 2: the inbound text branch ──────────────────────────────
    def test_non_string_text_blocks_are_dropped_and_logged(self):
        """``TextInputContent.text`` is a ``str``; anything else raised a
        ValidationError that aborted the whole message list. The mirrored
        TypeScript branch was gated on TRUTHINESS instead, which emitted a truthy
        non-string VERBATIM and failed schema validation downstream."""
        for text, described in [
            (42, "int"),
            ({"a": 1}, "dict"),
            (None, "NoneType"),
            (["x"], "list"),
            (True, "bool"),
        ]:
            with self.subTest(text=described):
                outcome = self._inbound([{"type": "text", "text": text}])
                self.assertEqual(outcome.content, [])
                self.assertEqual(
                    outcome.warnings,
                    [f"Dropping text block: text is {described}, not a string"],
                )

    def test_blocks_on_either_side_of_an_unusable_text_block_survive(self):
        outcome = self._inbound([
            {"type": "text", "text": "before"},
            {"type": "text", "text": 42},
            {"type": "text", "text": "after"},
        ])

        self.assertEqual([c.text for c in outcome.content], ["before", "after"])
        self.assertEqual(len(outcome.warnings), 1)

    def test_empty_and_absent_text_are_kept_and_say_nothing(self):
        """The other end of the TypeScript truthiness gate: an empty text is a
        block THIS runtime keeps, and the TypeScript one dropped silently — a
        rule-2 violation on a block that is not malformed at all. ``""`` is the
        value, not a drop, so there must be no warning either."""
        for name, block in [
            ("present but empty", {"type": "text", "text": ""}),
            ("absent", {"type": "text"}),
        ]:
            with self.subTest(text=name):
                outcome = self._inbound([block])
                self.assertEqual([c.text for c in outcome.content], [""])
                self.assertEqual(outcome.warnings, [])

    # ── rule 2: the drops with no branch of their own ────────────────────
    def test_unrecognised_inbound_blocks_are_logged(self):
        """A block matching NO branch fell out of the loop leaving nothing behind
        — no content item and no log — while this converter's own docstring
        claimed such a block "is SKIPPED AND LOGGED". It was skipped; it was never
        logged.

        The last two also pin rule 1: an unhashable ``type`` raised
        ``TypeError: unhashable type`` out of the whole snapshot, where the
        TypeScript adapter's ``Map`` lookup simply answered ``undefined``.
        """
        blocks = [
            ("a kind langchain-core adds later", {"type": "totally_unknown"}),
            ("no type key at all", {"foo": "bar"}),
            ("an empty type", {"type": ""}),
            ("a numeric type", {"type": 7}),
            ("a None type", {"type": None}),
            ("a list type", {"type": []}),
            ("a dict type", {"type": {}}),
        ]
        for name, block in blocks:
            with self.subTest(block=name):
                outcome = self._inbound([block])
                self.assertEqual(outcome.content, [])
                self.assertEqual(len(outcome.warnings), 1)
                self.assertIn(
                    "Dropping unsupported content block of type", outcome.warnings[0]
                )

    def test_blocks_beside_an_unhashable_type_survive(self):
        outcome = self._inbound([
            {"type": "text", "text": "before"},
            {"type": []},
            {"type": "text", "text": "after"},
        ])

        self.assertEqual([c.text for c in outcome.content], ["before", "after"])
        self.assertEqual(len(outcome.warnings), 1)

    def test_non_dict_entries_are_dropped_and_logged(self):
        """``.get`` on one of these would raise out of the whole message list, so
        the loop never called it — but it said nothing either."""
        for entry, described in [
            (None, "NoneType"),
            (7, "int"),
            (True, "bool"),
            (["x"], "list"),
        ]:
            with self.subTest(entry=described):
                outcome = self._inbound([entry])
                self.assertEqual(outcome.content, [])
                self.assertEqual(
                    outcome.warnings,
                    [f"Dropping content block: not a dict ({described})"],
                )

    # ── recovering a payload the first key failed to carry ───────────────
    def test_base64_is_read_when_data_is_present_but_unusable(self):
        """``item.get("data") or item.get("base64")`` short-circuits on anything
        TRUTHY, so a non-string ``data`` stopped the read dead and the perfectly
        good ``base64`` behind it was never reached — the whole attachment was
        dropped, while the TypeScript reader recovered it."""
        for data, described in [(42, "int"), ({"x": 1}, "dict"), (True, "bool"), ("", "empty str")]:
            with self.subTest(data=described):
                outcome = self._inbound([
                    {"type": "image", "data": data, "base64": "QUJD", "mime_type": "image/png"}
                ])
                self.assertEqual(len(outcome.content), 1)
                self.assertEqual(outcome.content[0].source.value, "QUJD")
                self.assertEqual(outcome.content[0].source.mime_type, "image/png")
                self.assertEqual(outcome.warnings, [])

    def test_url_is_read_when_data_is_present_but_unusable(self):
        outcome = self._inbound([
            {"type": "image", "data": 42, "url": "https://example.com/a.png"}
        ])

        self.assertEqual(len(outcome.content), 1)
        self.assertEqual(outcome.content[0].source.type, "url")
        self.assertEqual(outcome.content[0].source.value, "https://example.com/a.png")
        self.assertEqual(outcome.warnings, [])

    def test_empty_mime_type_falls_through_to_the_spelling_behind_it(self):
        """A block carrying BOTH key spellings, the first one empty, must not lose
        its real MIME type and arrive as ``application/octet-stream``. Mirrors the
        TypeScript suite's "keeps mime_type when mimeType is the empty string",
        which had no counterpart here — exactly the asymmetry that lets a fix land
        in one runtime and not the other."""
        for name, first in [("empty", ""), ("non-string", 42)]:
            with self.subTest(mimeType=name):
                outcome = self._inbound([
                    {
                        "type": "file",
                        "mimeType": first,
                        "mime_type": "application/pdf",
                        "base64": "JVBERi0xLjQK",
                    }
                ])
                self.assertEqual(outcome.content[0].source.mime_type, "application/pdf")
                self.assertEqual(outcome.warnings, [])

    def test_unreadable_media_blocks_are_dropped_and_logged(self):
        blocks = [
            ("a non-string url", {"type": "image", "url": 42}),
            ("an empty url", {"type": "image", "url": ""}),
            ("every payload key empty", {"type": "audio", "data": "", "base64": "", "url": ""}),
            ("no payload key at all", {"type": "image"}),
        ]
        for name, block in blocks:
            with self.subTest(block=name):
                outcome = self._inbound([block])
                self.assertEqual(outcome.content, [])
                self.assertEqual(len(outcome.warnings), 1)
                self.assertIn("no data, base64 or url to carry back", outcome.warnings[0])

    # ── the modality carried inside an image_url data URL ────────────────
    def test_modality_is_recovered_from_the_data_url_mime_type(self):
        """``image_url`` is the fallback block for every modality the outbound leg
        cannot send as a standard block, so the MIME type inside its data URL is
        the only remaining modality signal on the way back. Reading it wrong
        retypes the attachment in MESSAGES_SNAPSHOT permanently.

        The four ``image`` rows are the malformed-MIME guard. Without it they read
        as DOCUMENTS — the major-type lookup misses and the fallback is
        ``document`` — so a MIME-less image would come back as a file. A string
        that is not ``major/subtype`` carries no modality at all.
        """
        cases = [
            ("an uppercase major type", "VIDEO/MP4", VideoInputContent, "VIDEO/MP4"),
            ("a mixed-case major type", "Audio/WAV", AudioInputContent, "Audio/WAV"),
            ("a padded major type", " video/mp4", VideoInputContent, " video/mp4"),
            # The data URL's own `;` separator takes the parameters off before the
            # MIME type is ever read, so the recorded type is the bare one.
            ("parameters", "video/mp4;codecs=avc1", VideoInputContent, "video/mp4"),
            ("an unknown major type", "application/pdf", DocumentInputContent, "application/pdf"),
            ("no slash at all", "noslash", ImageInputContent, "noslash"),
            ("an empty subtype", "video/", ImageInputContent, "video/"),
            ("an empty major type", "/mp4", ImageInputContent, "/mp4"),
            ("nothing but a slash", "/", ImageInputContent, "/"),
            # Everything after the FIRST slash is the subtype, so `a/b/c` IS
            # major/subtype and takes the lookup, unlike the four above.
            ("a third segment", "a/b/c", DocumentInputContent, "a/b/c"),
        ]
        for name, mime, expected_class, recorded in cases:
            with self.subTest(mime=name):
                outcome = self._inbound([
                    {"type": "image_url", "image_url": {"url": f"data:{mime};base64,QUJD"}}
                ])
                self.assertEqual(len(outcome.content), 1)
                self.assertIsInstance(outcome.content[0], expected_class)
                self.assertEqual(outcome.content[0].source.mime_type, recorded)
                self.assertEqual(outcome.content[0].source.value, "QUJD")

    # ── the same three rules on the outbound leg ─────────────────────────
    #
    # These converters do not receive the same thing in the two runtimes.
    # TypeScript reads client JSON that nothing validates; this one reads
    # pydantic-validated AG-UI content objects, so an item that cannot pass
    # validation never becomes a typed content object and arrives as the raw dict
    # it was — which lands in the terminal `else`. The two runtimes therefore
    # reach some of these drops through DIFFERENT branches while producing the
    # same outcome, and that is what `cross-runtime-parity-cases.json` asserts.
    def test_unrecognised_outbound_items_are_logged(self):
        for name, item in [
            ("a type added to the AG-UI union later", {"type": "totally_unknown"}),
            ("no type key at all", {"foo": "bar"}),
            ("an item that is not a content object", None),
        ]:
            with self.subTest(item=name):
                outcome = self._outbound([item])
                self.assertEqual(outcome.content, [])
                self.assertEqual(len(outcome.warnings), 1)
                self.assertIn(
                    "Dropping unsupported content item of type", outcome.warnings[0]
                )

    def test_a_non_string_text_item_is_dropped_not_forwarded(self):
        """``TextInputContent`` cannot hold a non-string ``text`` — pydantic
        rejects it — so such an item reaches this converter as a raw dict and is
        dropped by the terminal ``else``. The mirrored TypeScript converter has no
        validation in front of it and needs an explicit guard on the same value,
        which is why it logs a different message for the same outcome."""
        for text in (42, {"a": 1}, None):
            with self.subTest(text=type(text).__name__):
                with self.assertRaises(Exception):
                    TextInputContent(type="text", text=text)

                outcome = self._outbound([{"type": "text", "text": text}])
                self.assertEqual(outcome.content, [])
                self.assertEqual(len(outcome.warnings), 1)

    def test_items_on_either_side_of_an_unconvertible_outbound_item_survive(self):
        outcome = self._outbound([
            TextInputContent(type="text", text="before"),
            {"type": "totally_unknown"},
            TextInputContent(type="text", text="after"),
        ])

        self.assertEqual(
            outcome.content,
            [{"type": "text", "text": "before"}, {"type": "text", "text": "after"}],
        )
        self.assertEqual(len(outcome.warnings), 1)

    def test_a_well_formed_outbound_array_converts_silently(self):
        """The other side of every guard above: what IS usable must still convert,
        and must do it SILENTLY. A guard that logs on good input is a guard that
        trains an operator to ignore the log."""
        outcome = self._outbound([
            TextInputContent(type="text", text="hello"),
            ImageInputContent(
                type="image",
                source=InputContentUrlSource(type="url", value="https://example.com/a.png"),
            ),
        ])

        self.assertEqual(
            outcome.content,
            [
                {"type": "text", "text": "hello"},
                {"type": "image_url", "image_url": {"url": "https://example.com/a.png"}},
            ],
        )
        self.assertEqual(outcome.warnings, [])

    def test_an_empty_url_source_is_dropped_not_emitted(self):
        """``_media_source_to_url`` returns the url VERBATIM, so an empty one comes
        back as ``""``. Emitting it would put an ``image_url`` block pointing at
        nothing on the provider request; the caller's truthiness check is what
        stops it, and the TypeScript ``if (url)`` is the line that must agree.

        ``InputContentUrlSource(value="")`` passes validation — ``value`` is a
        required ``str``, and the empty string is one — so this is reachable from
        a real client, not a constructed impossibility."""
        outcome = self._outbound([
            ImageInputContent(
                type="image", source=InputContentUrlSource(type="url", value="")
            )
        ])

        self.assertEqual(outcome.content, [])
        self.assertEqual(
            outcome.warnings,
            ["Dropping ImageInputContent content: source could not be converted to URL"],
        )

    # ── one metadata key, outbound ───────────────────────────────────────
    def test_only_metadata_filename_is_read_outbound(self):
        """The INBOUND reader scans ``filename`` then ``name`` then ``title``,
        because those are the spellings langchain-core's translators read. The
        OUTBOUND writer must NOT: ``metadata.filename`` is the one documented
        field of the block, and widening the read here would put a name on the
        wire that the AG-UI item never claimed was a filename. The TypeScript
        ``filenameFromMetadata`` reads the same single key."""
        outcome = self._outbound([
            DocumentInputContent(
                type="document",
                source=InputContentDataSource(
                    type="data", value="aGk=", mime_type="application/pdf"
                ),
                metadata={"name": "from-name.pdf", "title": "from-title.pdf"},
            )
        ])

        self.assertEqual(
            outcome.content,
            [
                {
                    "type": "file",
                    "base64": "aGk=",
                    "mime_type": "application/pdf",
                    # DERIVED, not `from-name.pdf`.
                    "filename": "attachment.pdf",
                }
            ],
        )
        self.assertEqual(outcome.warnings, [])

    # ── rule 1 on the TYPED media path ───────────────────────────────────
    #
    # ``model_construct``, not the validating constructor: AG-UI's source class
    # declares ``mime_type: str``, so pydantic refuses a non-string at the
    # boundary — but it refuses it only where a caller went THROUGH validation.
    # A content object built around it, or a subclass, reaches this converter
    # carrying whatever it was given, and the converter's own comments already
    # accept that (see `_media_source_to_url`, which documents the
    # ``model_construct``-with-``None`` case). Before this change the read was
    # ``or ""`` and ``.split`` raised an AttributeError out of the whole
    # message-list conversion — rule 1 — on typed audio, typed document AND the
    # legacy binary branch, while the mirrored TypeScript adapter dropped
    # cleanly on two of the three.
    def _unvalidated_media(self, cls, kind, mime_type, value="QUJD"):
        return cls.model_construct(
            type=kind,
            source=InputContentDataSource.model_construct(
                type="data", value=value, mime_type=mime_type
            ),
            metadata=None,
        )

    def test_a_non_string_mime_type_on_typed_audio_does_not_raise(self):
        for label, mime_type in [
            ("a number", 42),
            ("a dict", {}),
            ("a list", []),
            ("True", True),
            ("None", None),
        ]:
            with self.subTest(label):
                outcome = self._outbound(
                    [self._unvalidated_media(AudioInputContent, "audio", mime_type)]
                )

                # An unusable MIME type is an absent one: no audio format is
                # named, so the item keeps the `image_url` fallback with an
                # OMITTED mediatype. Not `data:42;base64,` or `data:None;base64,`
                # — those interpolations wrote a media type the client never sent
                # into the thread, and diverged from TypeScript, which produced
                # `data:;base64,QUJD` for every one of these.
                self.assertEqual(
                    outcome.content,
                    [{"type": "image_url", "image_url": {"url": "data:;base64,QUJD"}}],
                )
                self.assertEqual(outcome.warnings, [])

    def test_a_non_string_mime_type_on_a_typed_document_does_not_raise(self):
        """The document path reached `_derive_filename` with the same value and
        raised there. `application/octet-stream` is this file's answer for
        unidentified bytes, and `attachment.bin` is the name that agrees with
        it — which is what the TypeScript adapter already produced."""
        outcome = self._outbound(
            [self._unvalidated_media(DocumentInputContent, "document", 42)]
        )

        self.assertEqual(
            outcome.content,
            [{
                "type": "file",
                "base64": "QUJD",
                "mime_type": "application/octet-stream",
                "filename": "attachment.bin",
            }],
        )
        self.assertEqual(outcome.warnings, [])

    def test_a_non_string_mime_type_on_a_legacy_binary_item_does_not_raise(self):
        """The legacy branch read ``item.mime_type or ""`` where the mirrored
        TypeScript branch read through its non-empty-string helper — and the
        comment explaining why was already on the TypeScript side."""
        outcome = self._outbound([
            BinaryInputContent.model_construct(
                type="binary", data="QUJD", url=None, id=None, mime_type=42, filename=None
            )
        ])

        self.assertEqual(
            outcome.content,
            [{"type": "image_url", "image_url": {"url": "data:;base64,QUJD"}}],
        )
        self.assertEqual(outcome.warnings, [])

    def test_items_beside_a_typed_audio_item_with_a_non_string_mime_survive(self):
        """Rule 3. The raise cost both neighbours, not just the attachment."""
        outcome = self._outbound([
            TextInputContent(type="text", text="before"),
            self._unvalidated_media(AudioInputContent, "audio", 42),
            TextInputContent(type="text", text="after"),
        ])

        self.assertEqual(
            [block["type"] for block in outcome.content],
            ["text", "image_url", "text"],
        )
        self.assertEqual(
            [b["text"] for b in outcome.content if b["type"] == "text"],
            ["before", "after"],
        )

    # ── rule 1 + 2: a data URL with no payload ───────────────────────────
    def test_a_data_url_with_no_payload_is_dropped_and_logged(self):
        """Kept before this change as an attachment whose ``value`` is the EMPTY
        STRING — an item pointing at nothing, written into the thread and read
        back on every later open. `_read_incoming_media_block` already dropped an
        empty ``data``/``base64`` on the standard-block path; this branch was the
        one place that did not."""
        for label, url in [
            ("no comma at all", "data:image/png;base64"),
            ("nothing after the comma", "data:image/png;base64,"),
            ("no mediatype and no payload", "data:;base64,"),
            ("nothing but the scheme", "data:"),
            ("a mediatype and nothing else", "data:image/png"),
        ]:
            with self.subTest(label):
                outcome = self._inbound([{"type": "image_url", "image_url": {"url": url}}])

                self.assertEqual(outcome.content, [])
                self.assertEqual(len(outcome.warnings), 1)
                self.assertIn(
                    "Dropping image_url block: data URL carries no payload",
                    outcome.warnings[0],
                )

    def test_blocks_beside_a_payload_less_data_url_survive(self):
        outcome = self._inbound([
            {"type": "text", "text": "before"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64"}},
            {"type": "text", "text": "after"},
        ])

        self.assertEqual([item.text for item in outcome.content], ["before", "after"])
        self.assertEqual(len(outcome.warnings), 1)

    def test_a_data_url_with_several_commas_keeps_its_whole_payload(self):
        """The payload is everything after the FIRST comma (RFC 2397 §3). This
        runtime already read it that way; the TypeScript one used
        ``split(",", 2)`` and silently truncated at the second comma, so the two
        disagreed on exactly this line."""
        outcome = self._inbound([
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,QUJD,EXTRA"}}
        ])

        self.assertEqual(len(outcome.content), 1)
        self.assertEqual(outcome.content[0].source.value, "QUJD,EXTRA")
        self.assertEqual(outcome.content[0].source.mime_type, "image/png")

    # ── rules 1+2 on the OUTBOUND payload ────────────────────────────────
    #
    # The contract landed on the inbound leg first and the outbound source
    # payload was still read without checking it, which broke rule 2 in the
    # direction that reaches the provider: an item whose ``value`` was ``None``, a
    # number or the empty string was neither dropped nor logged — it was EMITTED,
    # as ``base64: None`` on a standard media block, as ``data:image/png;base64,
    # None`` inside an ``image_url``, or as a bare ``image_url: {"url": 42}``. The
    # model then answers about an attachment it never received, and there is no
    # line in the log to explain it. Every emission point on this leg is covered
    # below: the standard media block, the data-URL construction, and the legacy
    # binary path.
    #
    # ``model_construct`` throughout, for the reason the block above
    # `_unvalidated_media` gives: AG-UI's source class declares ``value: str``, so
    # pydantic refuses ``None`` and a non-string at the boundary — but only where
    # a caller went THROUGH validation. Measured 2026-08-25 on pydantic 2.12.5 /
    # ag-ui-protocol 0.1.19, all three routes THE MALFORMED-INPUT CONTRACT
    # declares in scope reach this converter with a real typed object carrying a
    # refused payload: ``model_construct``, plain attribute assignment (the source
    # models do not set ``validate_assignment``) and ``model_copy(update=…)``,
    # which pydantic documents as unvalidated. The EMPTY STRING needs none of
    # them — the schema accepts it outright.
    _UNUSABLE_PAYLOADS = [
        ("None", None),
        ("the empty string", ""),
        ("a number", 42),
        ("a bool", True),
        ("a dict", {}),
        ("a list", []),
    ]

    _MEDIA_EMISSION_POINTS = [
        (DocumentInputContent, "document", "application/pdf", "the file standard block"),
        (AudioInputContent, "audio", "audio/wav", "the audio standard block"),
        (ImageInputContent, "image", "image/png", "the image_url data URL"),
        (VideoInputContent, "video", "video/mp4", "the image_url data URL"),
    ]

    def test_an_unusable_data_payload_is_dropped_and_logged_once(self):
        for cls, kind, mime_type, emission_point in self._MEDIA_EMISSION_POINTS:
            for label, value in self._UNUSABLE_PAYLOADS:
                with self.subTest(kind=kind, emits=emission_point, payload=label):
                    outcome = self._outbound(
                        [self._unvalidated_media(cls, kind, mime_type, value=value)]
                    )

                    self.assertEqual(outcome.content, [])
                    self.assertEqual(
                        outcome.warnings,
                        [
                            f"Dropping {cls.__name__} content: source could not "
                            "be converted to URL"
                        ],
                    )

    def test_an_unusable_url_source_payload_is_dropped_and_logged_once(self):
        """``{}`` is the one that DIVERGED rather than merely leaking: falsy here
        and truthy in the TypeScript adapter, so the same item was dropped by this
        runtime and kept by the other. Both drop it now."""
        for label, value in self._UNUSABLE_PAYLOADS:
            with self.subTest(payload=label):
                outcome = self._outbound([
                    ImageInputContent.model_construct(
                        type="image",
                        source=InputContentUrlSource.model_construct(type="url", value=value),
                        metadata=None,
                    )
                ])

                self.assertEqual(outcome.content, [])
                self.assertEqual(
                    outcome.warnings,
                    [
                        "Dropping ImageInputContent content: source could not be "
                        "converted to URL"
                    ],
                )

    def test_an_unusable_legacy_binary_payload_is_dropped_and_logged_once(self):
        for label, mime_type, payload in [
            ("data", "application/pdf", {"data": 42}),
            ("data", "audio/wav", {"data": None}),
            ("data", "image/png", {"data": {}}),
            ("url", "image/png", {"url": 42}),
            ("url", "application/pdf", {"url": []}),
            ("id", "image/png", {"id": 42}),
            ("id", "image/png", {"id": True}),
        ]:
            with self.subTest(key=label, mime_type=mime_type):
                outcome = self._outbound([
                    BinaryInputContent.model_construct(
                        type="binary",
                        mime_type=mime_type,
                        url=payload.get("url"),
                        data=payload.get("data"),
                        id=payload.get("id"),
                        filename=None,
                    )
                ])

                self.assertEqual(outcome.content, [])
                self.assertEqual(
                    outcome.warnings,
                    ["Dropping BinaryInputContent item: no url, data, or id provided"],
                )

    def test_an_absent_legacy_mime_type_reads_like_a_null_one(self):
        """``mime_type`` is the ONE field on ``BinaryInputContent`` with no
        default, so it is the one that can be ABSENT rather than null:
        ``model_construct`` fills ``id`` / ``url`` / ``data`` / ``filename`` in
        from their defaults and has nothing to fill in here, and pydantic's
        ``__getattr__`` raises ``AttributeError`` for a field never set.

        The branch read it as a plain attribute BEFORE the guard that collapses a
        bad value, so the read raised out of the whole message-list conversion —
        rule 1 — while the very same item carrying ``mime_type=None`` was already
        handled. Absent and null must be one behaviour, and the null one is
        already pinned: ``data:;base64,…``, the same string
        ``_media_source_to_url`` builds for a source with no MIME type."""
        absent = BinaryInputContent.model_construct(type="binary", data="QUJD")
        self.assertFalse(hasattr(absent, "mime_type"))

        outcome = self._outbound([absent])

        self.assertEqual(
            outcome.content,
            [{"type": "image_url", "image_url": {"url": "data:;base64,QUJD"}}],
        )
        self.assertEqual(outcome.warnings, [])
        # Not merely "some sensible output" — the SAME output as the null and the
        # non-string spellings of "no MIME type", which is the property that makes
        # this a collapse rather than a third behaviour.
        for label, mime_type in [("null", None), ("non-string", 42)]:
            with self.subTest(spelling=label):
                self.assertEqual(
                    self._outbound([
                        BinaryInputContent.model_construct(
                            type="binary", mime_type=mime_type, data="QUJD"
                        )
                    ]).content,
                    outcome.content,
                )

    def test_an_absent_legacy_mime_type_with_no_payload_is_dropped_and_logged_once(self):
        """The half of the same defect that was a REGRESSION, not a pre-existing
        hole. This branch reads the MIME type early, for the modality split, and
        that read sits in front of the ``no url, data, or id`` guard — so an item
        with nothing to send raised here where it used to fall straight into the
        guard and be dropped. One warning, no raise, nothing emitted."""
        item = BinaryInputContent.model_construct(type="binary")
        self.assertFalse(hasattr(item, "mime_type"))

        outcome = self._outbound([item])

        self.assertEqual(outcome.content, [])
        self.assertEqual(
            outcome.warnings,
            ["Dropping BinaryInputContent item: no url, data, or id provided"],
        )

    def test_items_and_messages_around_a_legacy_item_with_no_mime_type_survive(self):
        """Rule 3 for the absent MIME type specifically: an ``AttributeError``
        raised from the middle of this loop is not a degraded attachment, it is a
        thread with no messages in it. The text on either side, the good
        attachment beside it, and the messages before and after.

        The CARRYING message is built with ``model_construct`` too, and has to be:
        ``UserMessage`` re-runs ``BinaryInputContent``'s ``validate_source`` over
        the content list, so a validated message could not hold this item. That is
        the same bypass family the contract already declares in scope, applied one
        level up."""
        with self.assertLogs("ag_ui_langgraph.utils", level="WARNING") as logs:
            messages = agui_messages_to_langchain([
                UserMessage(id="m1", role="user", content="before message"),
                UserMessage.model_construct(
                    id="m2",
                    role="user",
                    content=[
                        TextInputContent(type="text", text="before"),
                        BinaryInputContent.model_construct(type="binary"),
                        BinaryInputContent(
                            type="binary", mime_type="application/pdf", data="aGk="
                        ),
                        TextInputContent(type="text", text="after"),
                    ],
                ),
                UserMessage(id="m3", role="user", content="after message"),
            ])

        self.assertEqual([m.id for m in messages], ["m1", "m2", "m3"])
        self.assertEqual(messages[0].content, "before message")
        self.assertEqual(messages[2].content, "after message")
        self.assertEqual(
            messages[1].content,
            [
                {"type": "text", "text": "before"},
                {
                    "type": "file",
                    "base64": "aGk=",
                    "mime_type": "application/pdf",
                    "filename": "attachment.pdf",
                },
                {"type": "text", "text": "after"},
            ],
        )
        self.assertEqual(len(logs.output), 1)
        self.assertIn(
            "Dropping BinaryInputContent item: no url, data, or id provided",
            logs.output[0],
        )

    def test_an_unusable_legacy_url_does_not_shadow_a_usable_data_payload(self):
        """An unusable payload is an ABSENT payload — the rule this file already
        applies to a MIME type and to a filename. ``url`` outranks ``data`` only
        when there IS a url; a ``url`` of 42 is not one, so the bytes that are
        really there go out instead of the item being lost with them."""
        outcome = self._outbound([
            BinaryInputContent.model_construct(
                type="binary", mime_type="image/png", url=42, data="QUJD", id=None, filename=None
            )
        ])

        self.assertEqual(
            outcome.content,
            [{"type": "image_url", "image_url": {"url": "data:image/png;base64,QUJD"}}],
        )
        self.assertEqual(outcome.warnings, [])

    def test_the_other_two_bypass_routes_are_dropped_the_same_way(self):
        """`model_construct` is not the only way a refused payload gets here, and
        a guard that only covered it would be a guard written to its test. Plain
        attribute assignment and ``model_copy(update=…)`` are named by the
        contract and both were measured to reach this converter."""
        good = InputContentDataSource(
            type="data", value="aGk=", mime_type="application/pdf"
        )

        assigned = DocumentInputContent(type="document", source=good.model_copy())
        assigned.source.value = None

        copied = DocumentInputContent(type="document", source=good).model_copy(
            update={"source": good.model_copy(update={"value": 42})}
        )

        for label, item in [("attribute assignment", assigned), ("model_copy", copied)]:
            with self.subTest(route=label):
                outcome = self._outbound([item])

                self.assertEqual(outcome.content, [])
                self.assertEqual(
                    outcome.warnings,
                    [
                        "Dropping DocumentInputContent content: source could not "
                        "be converted to URL"
                    ],
                )

    def test_items_and_messages_around_an_unusable_payload_survive(self):
        """Rule 3, and the reason rule 1 is written the way it is. This converter
        builds a whole provider request: the cost of getting one attachment wrong
        must be that one attachment. Asserted, not assumed — the text on either
        side, the GOOD attachment beside it, and the messages before and after."""
        with self.assertLogs("ag_ui_langgraph.utils", level="WARNING") as logs:
            messages = agui_messages_to_langchain([
                UserMessage(id="m1", role="user", content="before message"),
                UserMessage(
                    id="m2",
                    role="user",
                    content=[
                        TextInputContent(type="text", text="before"),
                        self._unvalidated_media(
                            DocumentInputContent, "document", "application/pdf", value=None
                        ),
                        DocumentInputContent(
                            type="document",
                            source=InputContentDataSource(
                                type="data", value="aGk=", mime_type="application/pdf"
                            ),
                        ),
                        TextInputContent(type="text", text="after"),
                    ],
                ),
                UserMessage(id="m3", role="user", content="after message"),
            ])

        self.assertEqual([m.id for m in messages], ["m1", "m2", "m3"])
        self.assertEqual(messages[0].content, "before message")
        self.assertEqual(messages[2].content, "after message")
        self.assertEqual(
            messages[1].content,
            [
                {"type": "text", "text": "before"},
                {
                    "type": "file",
                    "base64": "aGk=",
                    "mime_type": "application/pdf",
                    "filename": "attachment.pdf",
                },
                {"type": "text", "text": "after"},
            ],
        )
        self.assertEqual(len(logs.output), 1)
        self.assertIn(
            "Dropping DocumentInputContent content: source could not be converted to URL",
            logs.output[0],
        )

    def test_the_payload_check_reads_what_the_data_url_rule_produced(self):
        """The sibling rule normalizes a ``data:`` URL into inline data BEFORE the
        block is chosen. The payload check must read the bytes that come out of
        that parse, not the url string it came from — checking the wrong one would
        push every data-URL-sourced attachment back onto ``image_url``, which is
        the defect that rule exists to remove."""
        outcome = self._outbound([
            DocumentInputContent(
                type="document",
                source=InputContentUrlSource(
                    type="url", value="data:application/pdf;base64,JVBERi0="
                ),
            ),
            AudioInputContent(
                type="audio",
                source=InputContentUrlSource(type="url", value="data:audio/wav;base64,QUJD"),
            ),
            BinaryInputContent(
                type="binary",
                mime_type="application/pdf",
                url="data:application/pdf;base64,JVBERi0=",
            ),
        ])

        self.assertEqual(
            outcome.content,
            [
                {
                    "type": "file",
                    "base64": "JVBERi0=",
                    "mime_type": "application/pdf",
                    "filename": "attachment.pdf",
                },
                {"type": "audio", "base64": "QUJD", "mime_type": "audio/wav"},
                {
                    "type": "file",
                    "base64": "JVBERi0=",
                    "mime_type": "application/pdf",
                    "filename": "attachment.pdf",
                },
            ],
        )
        self.assertEqual(outcome.warnings, [])

    # ── the KNOWN LIMIT on `_OPENAI_AUDIO_MIME_TYPES` ────────────────────
    def test_a_normalized_audio_mime_type_is_stable_across_a_second_send(self):
        """The normalization is visible in the thread: a client that sent
        ``audio/mpeg`` reads ``audio/mp3`` back. Left that way deliberately — see
        the KNOWN LIMIT on `_OPENAI_AUDIO_MIME_TYPES` for why the
        `_supplied_filename` treatment does not transfer. What makes it
        acceptable is that it does not DRIFT: the value the return leg records
        re-normalizes to itself, so every later send carries the identical MIME
        type and the modality survives. This test is that property."""
        first = self._outbound([
            AudioInputContent(
                type="audio",
                source=InputContentDataSource(
                    type="data", value="QUJD", mime_type="audio/mpeg"
                ),
            )
        ])
        self.assertEqual(
            first.content,
            [{"type": "audio", "base64": "QUJD", "mime_type": "audio/mp3"}],
        )

        read_back = self._inbound(first.content)
        self.assertEqual(len(read_back.content), 1)
        self.assertIsInstance(read_back.content[0], AudioInputContent)
        self.assertEqual(read_back.content[0].source.mime_type, "audio/mp3")

        second = self._outbound(read_back.content)
        self.assertEqual(second.content, first.content)


class TestOverridableCallsOnOffWireValues(unittest.TestCase):
    """Rule 1 of the malformed-input contract, for values that are the RIGHT
    type but not the built-in one.

    A `str`/`dict` arriving off the wire may be a SUBCLASS, and every method
    the converter calls on it — ``strip``, ``startswith``, ``split``, ``get``
    — is overridable. An override that raises escapes the whole
    MESSAGES_SNAPSHOT, which is the failure the contract's first rule exists
    to prevent, reached through a door an ``isinstance`` check holds open.

    These cases live here rather than in ``cross-runtime-parity-cases.json``
    because a subclass is not expressible in JSON, and because they are
    Python-only: TypeScript strings and objects are primitives with no
    equivalent hazard. The converter answers them by normalizing through the
    BASE operations (``str.strip``, ``dict.get``), which both bypass the
    override and return a built-in, so everything downstream is a built-in
    method on a built-in value.
    """

    def test_str_subclass_that_raises_from_its_overrides_still_converts(self):
        class Hostile(str):
            def strip(self, *args):
                raise RuntimeError("strip exploded")

            def startswith(self, *args):
                raise RuntimeError("startswith exploded")

            def split(self, *args, **kwargs):
                raise RuntimeError("split exploded")

        agui_content = convert_langchain_multimodal_to_agui([
            {"type": "image_url", "image_url": Hostile("  data:image/png;base64,QUJD  ")},
        ])

        self.assertEqual(len(agui_content), 1)
        self.assertIsInstance(agui_content[0].source, InputContentDataSource)
        self.assertEqual(agui_content[0].source.value, "QUJD")
        self.assertEqual(agui_content[0].source.mime_type, "image/png")

    def test_str_subclass_in_the_nested_url_slot_still_converts(self):
        class Hostile(str):
            def strip(self, *args):
                raise RuntimeError("strip exploded")

        agui_content = convert_langchain_multimodal_to_agui([
            {"type": "image_url", "image_url": {"url": Hostile("https://example.com/a.png")}},
        ])

        self.assertEqual(len(agui_content), 1)
        self.assertEqual(agui_content[0].source.value, "https://example.com/a.png")

    def test_dict_subclass_that_raises_from_get_still_converts(self):
        class Hostile(dict):
            def get(self, *args, **kwargs):
                raise RuntimeError("get exploded")

        agui_content = convert_langchain_multimodal_to_agui([
            {"type": "image_url", "image_url": Hostile(url="https://example.com/a.png")},
        ])

        self.assertEqual(len(agui_content), 1)
        self.assertEqual(agui_content[0].source.value, "https://example.com/a.png")

    def test_a_hostile_subclass_costs_only_its_own_block(self):
        """Rule 3: even when the hostile value is unusable, the blocks around
        it convert."""
        class Hostile(str):
            def strip(self, *args):
                raise RuntimeError("strip exploded")

        agui_content = convert_langchain_multimodal_to_agui([
            {"type": "text", "text": "before"},
            {"type": "image_url", "image_url": {"url": Hostile("   ")}},
            {"type": "text", "text": "after"},
        ])

        self.assertEqual([c.text for c in agui_content], ["before", "after"])


class TestCrossRuntimeParityTable(unittest.TestCase):
    """The cross-runtime parity table — the mechanism that makes DRIFT fail a test.

    This adapter exists twice — once here, once in the TypeScript ``utils.ts`` —
    implementing one contract as two independent bodies of code. Three review
    rounds found the same class of defect fixed on one side and not mirrored to
    the other; nothing in either suite could see it, because each runtime pinned
    behaviour the other left unpinned, so every divergence survived until a human
    read both files side by side.

    ``integrations/langgraph/cross-runtime-parity-cases.json`` is the shared table
    both suites read. It is the single source of truth for the CASES and for the
    EXPECTED OUTCOME: a case added there is picked up by this suite and by the
    TypeScript ``describe("cross-runtime parity table")`` with no edit to either.
    There is deliberately no second list to keep in sync — hand-mirroring is the
    exact failure this exists to prevent.

    Read the ``readme`` array at the top of that file before adding a case.
    """

    TABLE_PATH = (
        pathlib.Path(__file__).resolve().parents[2] / "cross-runtime-parity-cases.json"
    )

    @classmethod
    def setUpClass(cls):
        cls.table = json.loads(cls.TABLE_PATH.read_text())

    _CLASS_BY_TYPE = {
        "text": TextInputContent,
        "binary": BinaryInputContent,
        "image": ImageInputContent,
        "audio": AudioInputContent,
        "video": VideoInputContent,
        "document": DocumentInputContent,
    }

    @classmethod
    def _build_outbound_item(cls, item, unvalidated=False):
        """Turn a table item into whatever THIS converter would really receive.

        The table records outbound inputs as plain JSON, because the TypeScript
        converter reads exactly that. This one reads pydantic-validated content
        objects, so each item is built into its declared class. An item that
        cannot pass validation is passed through as the raw dict it is — which is
        also what production does with one, since an item that fails validation
        never becomes a typed content object.

        ``unvalidated`` builds with ``model_construct`` instead, for a case marked
        ``pythonBuild: "unvalidated"`` in the shared table. Without it a malformed
        payload can never reach the TYPED branch here — the item fails validation,
        arrives as a raw dict and lands in the terminal ``else``, so a case named
        after the media guard would be asserting something else entirely. The
        marker is not a way around the schema for its own sake: ``model_construct``
        is one of the three routes THE MALFORMED-INPUT CONTRACT declares in scope
        (with plain attribute assignment and ``model_copy(update=…)``; all three
        are reachable, all three were measured, and all three produce a REAL typed
        content object carrying a payload the schema would have refused).
        `test_unvalidated_cases_are_exactly_the_ones_that_need_the_marker` keeps
        the marker honest in both directions.
        """
        if not isinstance(item, dict):
            return item
        content_class = cls._CLASS_BY_TYPE.get(item.get("type"))
        if content_class is None:
            return item
        kwargs = dict(item)
        source = kwargs.get("source")
        if isinstance(source, dict):
            source_class = (
                InputContentDataSource
                if source.get("type") == "data"
                else InputContentUrlSource
            )
            if unvalidated:
                kwargs["source"] = source_class.model_construct(**source)
            else:
                try:
                    kwargs["source"] = source_class(**source)
                except Exception:
                    return item
        if unvalidated:
            return content_class.model_construct(**kwargs)
        try:
            return content_class(**kwargs)
        except Exception:
            return item

    @classmethod
    def _build_outbound_content(cls, case):
        """Every item of one outbound case, built the way that case asks for."""
        return [
            cls._build_outbound_item(item, case.get("pythonBuild") == "unvalidated")
            for item in case["content"]
        ]

    @staticmethod
    def _canonical(direction, items):
        """Project this runtime's output onto the table's neutral vocabulary.

        SHAPE ONLY. The two runtimes emit the same content under deliberately
        different keys — see `_standard_media_block` and its TypeScript
        counterpart — and that difference is documented, not drift. Everything
        else survives the projection: a different VALUE, a different survivor, or
        a different count still fails. Nothing here inspects the input, so no case
        can be normalized into agreement.

        ``sourceType`` is the RECOGNITION MARKER, and it is projected rather than
        dropped. It is the key that makes a translator see the block as inline
        base64 media at all: here the ``base64`` key itself (measured on
        langchain-core 1.2.13, ``is_data_content_block`` returns ``True`` on
        ``"base64" in block``), in TypeScript ``source_type: "base64"``
        (``@langchain/core``'s ``isDataContentBlock`` tests for ``source_type``
        and nothing else). Deleting that key from either emitted block sends the
        provider a block its translator does not recognize as media — the failure
        the outbound design exists to prevent — and while it was projected away
        this table could not see it happen. On THIS side the marker and the
        payload are the same key, so the projection restates ``data``; on the
        TypeScript side they are two keys and this is the only thing pinning the
        marker.
        """
        if direction == "inbound":
            kinds = {
                "ImageInputContent": "image",
                "AudioInputContent": "audio",
                "VideoInputContent": "video",
                "DocumentInputContent": "document",
            }
            canonical = []
            for item in items:
                if isinstance(item, TextInputContent):
                    canonical.append({"kind": "text", "text": item.text})
                    continue
                metadata = item.metadata if isinstance(item.metadata, dict) else {}
                canonical.append({
                    "kind": kinds[type(item).__name__],
                    "source": item.source.type,
                    "value": item.source.value,
                    "mimeType": getattr(item.source, "mime_type", None) or None,
                    "filename": metadata.get("filename") or None,
                })
            return canonical

        canonical = []
        for block in items:
            kind = block.get("type")
            if kind == "text":
                canonical.append({"kind": "text", "text": block.get("text")})
            elif kind == "image_url":
                canonical.append(
                    {"kind": "image_url", "url": block.get("image_url", {}).get("url")}
                )
            else:
                canonical.append({
                    "kind": "standard",
                    "blockType": kind,
                    "sourceType": block.get("source_type")
                    or ("base64" if "base64" in block else None),
                    "data": block.get("base64"),
                    "mimeType": block.get("mime_type") or None,
                    "filename": block.get("filename") or None,
                })
        return canonical

    def _outcome_of(self, case):
        """Run one case and reduce it to the outcome triple the table records.

        ``dropped`` IS MEASURED, NOT DERIVED. It used to be
        ``len(content) - len(kept)``, which is arithmetic on ``kept``: it could
        not fail unless ``kept`` had already failed, so the table's third axis was
        one axis with two names. Here each input item is removed in turn and the
        converter re-run: an item whose removal leaves the output the same LENGTH
        produced nothing, and that is what "dropped" means. It is a measurement of
        the item, not of the list, so it fails on its own — a run that drops one
        item while emitting a second block for another nets to the right length
        and is caught here. Blind spot, stated because it is real: two items that
        convert identically are indistinguishable by this method (removing either
        shortens the output by one), so provenance between duplicates is not
        pinned.

        A RAISE is reported here rather than allowed to escape as a bare
        traceback: rule 1 of the malformed-input contract is that no case in this
        table may raise in either runtime, so a raise is a parity failure with a
        name, not an accident of the harness.
        """
        content = case["content"]
        if case["direction"] == "outbound":
            content = self._build_outbound_content(case)
        try:
            outcome = _run_converter(case["direction"], content)
            dropped = sum(
                1
                for index in range(len(content))
                if len(
                    _run_converter(
                        case["direction"],
                        [c for other, c in enumerate(content) if other != index],
                    ).content
                )
                == len(outcome.content)
            )
        except Exception as exc:  # noqa: BLE001
            raise self.failureException(
                f"{self._report(case)}"
                f"  This runtime RAISED {type(exc).__name__}: {exc}\n"
                "  Rule 1 of the malformed-input contract is DROP, NEVER RAISE — no\n"
                "  case in the shared table may raise in either runtime, and the other\n"
                "  one does not raise on this input.\n"
            ) from exc
        return {
            "kept": self._canonical(case["direction"], outcome.content),
            "dropped": dropped,
            "loggedDrops": _count_drop_logs(outcome.warnings),
        }

    @staticmethod
    def _report(case):
        """The failure header.

        A bare boolean is useless to whoever hits this: it has to say which case,
        what the shared table says both runtimes must produce, and why the case is
        in the table at all.
        """
        return (
            f'\ncross-runtime parity case "{case["id"]}" '
            f'({case["direction"]}, {case["axis"]})\n'
            f'  why: {case["why"]}\n'
            f'  input: {json.dumps(case["content"])}\n'
            "  This runtime (Python) disagrees with cross-runtime-parity-cases.json,\n"
            "  which records the outcome BOTH adapters must produce and which the\n"
            "  TypeScript adapter produces today. Fix the runtime that is wrong — do\n"
            "  not split the expectation.\n"
        )

    def _assert_case(self, case):
        self.assertEqual(
            case["expect"],
            self._outcome_of(case),
            self._report(case)
            + "  `first` above is the shared table; `second` is this runtime.\n",
        )

    def test_the_shared_table_is_readable_and_non_empty(self):
        """A path typo or a truncated file would otherwise turn every parity
        assertion below into zero assertions, silently."""
        directions = {c["direction"] for c in self.table["cases"]}
        self.assertEqual(directions, {"inbound", "outbound"})
        self.assertGreater(len(self.table["cases"]), 0)

    def test_inbound_cases_match_the_shared_table(self):
        cases = [c for c in self.table["cases"] if c["direction"] == "inbound"]
        self.assertGreater(len(cases), 0)
        for case in cases:
            with self.subTest(case=case["id"]):
                self._assert_case(case)

    def test_outbound_cases_match_the_shared_table(self):
        cases = [c for c in self.table["cases"] if c["direction"] == "outbound"]
        self.assertGreater(len(cases), 0)
        for case in cases:
            with self.subTest(case=case["id"]):
                self._assert_case(case)

    def test_outbound_cases_record_what_this_runtime_actually_builds(self):
        """`pythonBuilds` is the branch each outbound item really reaches, pinned.

        The outcome triple cannot see a case CHANGE BRANCH: eleven of the twelve
        outbound malformed cases failed pydantic validation and collapsed onto the
        single terminal ``else``, so a case named after a text guard or a media
        guard was not exercising one here at all, and nothing said so. Recording
        what the harness builds each item into — a content class, or ``dict`` /
        ``NoneType`` for an item no class accepts — makes that visible, and
        asserting it means a schema change that silently moves a case onto a
        different branch fails instead of hiding behind an unchanged outcome.
        """
        cases = [c for c in self.table["cases"] if c["direction"] == "outbound"]
        self.assertGreater(len(cases), 0)
        for case in cases:
            with self.subTest(case=case["id"]):
                self.assertIn(
                    "pythonBuilds",
                    case,
                    f'{self._report(case)}'
                    "  Every outbound case records what this runtime builds each item\n"
                    "  into. Add `pythonBuilds` to the shared table for this case.\n",
                )
                self.assertEqual(
                    case["pythonBuilds"],
                    [type(item).__name__ for item in self._build_outbound_content(case)],
                    f'{self._report(case)}'
                    "  `pythonBuilds` in the shared table no longer matches what this\n"
                    "  runtime builds. A content class changed what it accepts, so this\n"
                    "  case now reaches a DIFFERENT branch than the one it was written\n"
                    "  for — re-read the case before updating the field.\n",
                )

    @classmethod
    def _refused_by_validation(cls, case):
        """Does the VALIDATING route refuse at least one item of this case?

        That is the property both markers turn on: an item declaring a type this
        runtime has a class for, which the class then refuses to build. Such an
        item cannot reach the branch its case is named after through the ordinary
        route — it arrives as a raw dict and lands in the terminal ``else``. The
        case must then say which of the two things it is: a branch only TypeScript
        has (`/ts-only/`) or one reached here through a documented
        validation-bypassing route (`pythonBuild: "unvalidated"`).

        Deliberately measured against `_build_outbound_item` WITHOUT the
        ``unvalidated`` flag even for a case that carries it — the question is what
        the schema does, not what the harness was asked to do.
        """
        return any(
            isinstance(item, dict)
            and item.get("type") in cls._CLASS_BY_TYPE
            and not isinstance(
                cls._build_outbound_item(item),
                cls._CLASS_BY_TYPE[item["type"]],
            )
            for item in case["content"]
        )

    def test_ts_only_marks_exactly_the_cases_that_name_a_branch_python_misses(self):
        """The `ts-only` segment in an id is a claim, so it is checked.

        A case whose item declares a type this runtime HAS a class for, and which
        that class then refuses to validate, names a branch it never reaches here
        THROUGH THE VALIDATING ROUTE: it arrives as a raw dict and lands in the
        terminal ``else``. Those cases carry `/ts-only/` in their id — unless they
        carry `pythonBuild: "unvalidated"`, which builds the item around validation
        precisely so the named branch IS reached here; that is the other half of
        the same claim and it is checked in the test below. The check runs both
        ways — an unmarked case may not have the property and a marked case must —
        so the id cannot drift away from the behaviour the way the table's own
        harnesses did.
        """
        for case in self.table["cases"]:
            if case["direction"] != "outbound":
                continue
            names_a_branch_python_misses = self._refused_by_validation(
                case
            ) and case.get("pythonBuild") != "unvalidated"
            with self.subTest(case=case["id"]):
                self.assertEqual(
                    "/ts-only/" in case["id"],
                    names_a_branch_python_misses,
                    f'{self._report(case)}'
                    "  An id carrying `/ts-only/` claims the named branch is reached in\n"
                    "  TypeScript only, because this runtime cannot validate the item\n"
                    "  into the class its `type` names. That claim and the behaviour no\n"
                    "  longer agree — rename the case or rebuild it, but do not leave a\n"
                    "  name that misdescribes what it covers.\n",
                )

    def test_unvalidated_cases_are_exactly_the_ones_that_need_the_marker(self):
        """`pythonBuild: "unvalidated"` is a claim too, and it is checked both ways.

        A case carries it to say: the malformed value under test is one AG-UI's
        schema refuses, so the only way this runtime reaches the TYPED branch the
        case is named after is a validation-bypassing route — ``model_construct``
        here, and the contract also names plain attribute assignment and
        ``model_copy(update=…)``. Unmarked, such a case would silently collapse
        onto the terminal ``else`` and assert nothing about the branch in its name.

        The reverse matters just as much. A case whose value the schema ACCEPTS —
        an empty-string payload is one, measured: ``InputContentDataSource(type=
        "data", value="", mime_type="application/pdf")`` constructs — must NOT
        carry the marker, because the ordinary validated route already reaches the
        branch and bypassing validation there would hide the fact that production
        gets here without any bypass at all.

        It is also EXCLUSIVE with `/ts-only/`. Both markers answer the same
        question — "the schema refuses this item, so what does this runtime do
        with it?" — and they give opposite answers: `/ts-only/` says the branch is
        never reached here and the case asserts the terminal ``else`` instead,
        `unvalidated` says the branch IS reached, around validation. A case
        claiming both describes nothing.
        """
        marked = set()
        for case in self.table["cases"]:
            if case["direction"] != "outbound":
                continue
            with self.subTest(case=case["id"]):
                self.assertIn(
                    case.get("pythonBuild", "validated"),
                    ("validated", "unvalidated"),
                    f'{self._report(case)}'
                    "  `pythonBuild` may only be `unvalidated`; anything else is a typo\n"
                    "  this harness would otherwise ignore.\n",
                )
                if case.get("pythonBuild") != "unvalidated":
                    # The other direction — a case that NEEDS the marker and does
                    # not carry it — is what
                    # `test_ts_only_marks_exactly_the_cases_that_name_a_branch_python_misses`
                    # already fails on: without the marker it must be `/ts-only/`.
                    continue
                self.assertTrue(
                    self._refused_by_validation(case),
                    f'{self._report(case)}'
                    "  `pythonBuild: \"unvalidated\"` claims the schema refuses at least\n"
                    "  one item of this case, so the typed branch is only reachable here\n"
                    "  around validation. The schema now ACCEPTS every item, so the\n"
                    "  marker is doing nothing but hiding the stronger statement: drop\n"
                    "  it and let the validated route reach the branch.\n",
                )
                self.assertNotIn(
                    "/ts-only/",
                    case["id"],
                    f'{self._report(case)}'
                    "  A case cannot be both `/ts-only/` (the branch is never reached in\n"
                    "  Python) and `unvalidated` (the branch IS reached, around\n"
                    "  validation). Pick the one that is true.\n",
                )
                marked.add(case["id"])

        # The marker exists to be used; a table with none of them means the
        # mechanism was removed and every payload case quietly went back to
        # asserting the terminal `else`.
        self.assertGreater(len(marked), 0)


if __name__ == "__main__":
    unittest.main()
