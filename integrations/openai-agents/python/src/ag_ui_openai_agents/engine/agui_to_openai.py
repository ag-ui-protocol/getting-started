"""Translate AG-UI request data into OpenAI Agents SDK input types."""

import logging
from typing import Any, Iterable

from agents import FunctionTool, RunContextWrapper, TResponseInputItem

from ag_ui.core import (
    ActivityMessage,
    AssistantMessage,
    AudioInputContent,
    BinaryInputContent,
    Context,
    DeveloperMessage,
    DocumentInputContent,
    ImageInputContent,
    Message,
    ReasoningMessage,
    RunAgentInput,
    SystemMessage,
    TextInputContent,
    Tool as AGUITool,
    ToolMessage,
    UserMessage,
    VideoInputContent,
)
from .helpers import read_attr, to_string
from .types import ClientToolPending, TranslatedInput

logger = logging.getLogger(__name__)


class AGUIToOpenAITranslator:
    """Map AG-UI request data to OpenAI Agents SDK input types.

    This stateless inbound engine powers ``AGUITranslator.to_openai()``.
    Its public ``translate_*`` methods are mapping-level override points for
    applications that need to customize individual conversions.

    Example:
        Public translator:

            translated_input = AGUITranslator().to_openai(run_input)
            result = Runner.run_streamed(
                agent.clone(tools=agent.tools + translated_input.tools),
                input=translated_input.messages,
            )

        Advanced per-item mapping:

            translator = AGUIToOpenAITranslator()
            translated_message = translator.translate_user_message(message)
    """

    # ─────────────────────────────────────────────────────────────────────
    # LEVEL 1 — Complete request translation
    # ─────────────────────────────────────────────────────────────────────

    def translate(self, run_input: RunAgentInput) -> TranslatedInput:
        """Translate a complete AG-UI request for the OpenAI Agents SDK.

        Converts message history and client-declared tools while preserving
        the request identifiers, state, context, forwarded props, and resume
        entries in a ``TranslatedInput`` result.

        Context and resume entries pass through unchanged. Context is not
        automatically added to model input; use ``translate_context()`` when
        the model should receive it.

        Args:
            run_input: The incoming AG-UI RunAgentInput.

        Returns:
            OpenAI Agents SDK inputs and preserved AG-UI request metadata.
        """
        # Read defensively — older RunAgentInput versions lack the field, the
        # same reason parent_run_id below uses getattr (see types.py resume doc).
        resume = getattr(run_input, "resume", None)
        return TranslatedInput(
            thread_id=run_input.thread_id,
            run_id=run_input.run_id,
            parent_run_id=getattr(run_input, "parent_run_id", None),
            messages=self.translate_messages(run_input.messages or []),
            tools=self.translate_tools(run_input.tools or []),
            state=run_input.state,
            context=list(run_input.context or []),
            forwarded_props=run_input.forwarded_props,
            resume=list(resume) if resume else None,
        )

    # ─────────────────────────────────────────────────────────────────────
    # LEVEL 2 — Collection translation
    # ─────────────────────────────────────────────────────────────────────

    def translate_messages(
        self,
        messages: Iterable[Message],
    ) -> list[TResponseInputItem]:
        """Translate message history into OpenAI Agents SDK input items.

        Args:
            messages: AG-UI messages to translate.

        Returns:
            Flattened SDK input-item list in the original history order.
        """
        items = []
        for message in messages:
            items.extend(self.translate_message(message))
        return items

    def translate_tools(
        self,
        tools: Iterable[AGUITool],
    ) -> list[FunctionTool]:
        """Translate tools declared in ``RunAgentInput.tools``.

        Each client-declared definition becomes an OpenAI Agents SDK ``FunctionTool`` proxy.
        These are request tools, not historical ``ToolMessage`` instances.

        Args:
            tools: Client-declared tools from the AG-UI request.

        Returns:
            One SDK ``FunctionTool`` proxy per request tool.
        """
        return [self.translate_tool(tool) for tool in tools]

    def translate_context(
        self,
        items: Iterable[Context],
    ) -> str:
        """Render AG-UI context as text that callers may add to model input.

        This method does not inject context automatically. Each non-empty
        item is rendered as one ``description: value`` line.

        Example:
            prompt = "You are helpful."
            ctx = translator.translate_context(translated_input.context)
            if ctx:
                prompt = f"{prompt}\\n\\nContext:\\n{ctx}"

        Args:
            items: AG-UI context items.

        Returns:
            Rendered text block, or an empty string when input is empty.
        """
        lines = [
            f"{item.description}: {item.value}"
            for item in items
            if item.description and item.value
        ]
        return "\n".join(lines)

    # ─────────────────────────────────────────────────────────────────────
    # LEVEL 3a — Message translation
    # ─────────────────────────────────────────────────────────────────────

    def translate_message(self, message: Message) -> list[dict[str, Any]]:
        """Dispatch one AG-UI message to its type-specific translator.

        One message may produce multiple SDK input items; for example, an
        ``AssistantMessage`` may contain text and multiple tool calls.

        Args:
            message: An AG-UI message of any supported type.

        Returns:
            Zero or more OpenAI Agents SDK input items.
        """
        if isinstance(message, SystemMessage):
            return [self.translate_system_message(message)]
        if isinstance(message, DeveloperMessage):
            return [self.translate_developer_message(message)]
        if isinstance(message, UserMessage):
            item = self.translate_user_message(message)
            return [item] if item is not None else []
        if isinstance(message, ReasoningMessage):
            item = self.translate_reasoning_message(message)
            return [item] if item is not None else []
        if isinstance(message, AssistantMessage):
            return self.translate_assistant_message(message)
        if isinstance(message, ToolMessage):
            return [self.translate_tool_message(message)]
        if isinstance(message, ActivityMessage):
            item = self.translate_activity_message(message)
            return [item] if item is not None else []
        logger.warning("Unknown AG-UI message type: %s", type(message).__name__)
        return []

    def translate_system_message(self, message: SystemMessage) -> dict[str, Any]:
        """Translate an AG-UI system prompt into an SDK input item.

        Args:
            message: The AG-UI system message.

        Returns:
            {"type": "message", "role": "system", ...}
        """
        return {
            "type": "message",
            "role": "system",
            "content": [{"type": "input_text", "text": message.content or ""}],
        }

    def translate_developer_message(self, message: DeveloperMessage) -> dict[str, Any]:
        """Translate an AG-UI developer prompt into an SDK input item.

        Args:
            message: The AG-UI developer message.

        Returns:
            {"type": "message", "role": "developer", ...}
        """
        return {
            "type": "message",
            "role": "developer",
            "content": [{"type": "input_text", "text": message.content or ""}],
        }

    def translate_user_message(self, message: UserMessage) -> dict[str, Any] | None:
        """Translate an AG-UI user turn into an SDK input item.

        Content may be text or a list of typed multimodal parts. A message
        whose parts are all unsupported (e.g. video-only) is dropped whole —
        sending a message with empty content would be rejected by the API.

        Args:
            message: The AG-UI user message.

        Returns:
            {"type": "message", "role": "user", "content": [...]}, or None
            when nothing in the message could be translated.
        """
        content = self.translate_content(message.content)
        if not content:
            logger.debug(
                "Dropping UserMessage id=%s: no translatable content parts",
                message.id,
            )
            return None
        return {
            "type": "message",
            "role": "user",
            "content": content,
        }

    def translate_reasoning_message(
        self,
        message: ReasoningMessage,
    ) -> dict[str, Any] | None:
        """Translate replayable AG-UI reasoning into an SDK input item.

        Reasoning is replayed only when ``encrypted_value`` is available.
        Plaintext-only reasoning is dropped because it cannot restore the
        model's reasoning state.

        Args:
            message: The AG-UI reasoning message.

        Returns:
            A reasoning input item, or ``None`` when replay is unavailable.
        """
        if not message.encrypted_value:
            logger.debug(
                "Dropping ReasoningMessage id=%s: no encrypted_value to re-ingest",
                message.id,
            )
            return None
        return {
            "type": "reasoning",
            "id": message.id,
            "encrypted_content": message.encrypted_value,
            # Omit the summary entry entirely when there's no text — some backends
            # reject a summary_text with an empty string.
            "summary": (
                [{"type": "summary_text", "text": message.content}]
                if message.content
                else []
            ),
        }

    def translate_assistant_message(
        self,
        message: AssistantMessage,
    ) -> list[dict[str, Any]]:
        """Translate an assistant turn into SDK message and function-call items.

        Assistant text becomes an input message, while each requested tool
        invocation becomes a separate function-call item.

        Args:
            message: The AG-UI assistant message.

        Returns:
            Optional text message item followed by one function_call
            item per tool call.
        """
        items: list[dict[str, Any]] = []
        text = message.content or ""
        if text:
            # Keep prior assistant text as an EasyInputMessageParam (role+content).
            # Do NOT add type="message" here: that reroutes it through the SDK's
            # output-message converter instead of the EasyInputMessage path.
            items.append(
                {
                    "role": "assistant",
                    "content": text,
                }
            )
        for tool_call in message.tool_calls or []:
            items.append(
                {
                    "type": "function_call",
                    "call_id": tool_call.id,
                    "name": tool_call.function.name,
                    "arguments": tool_call.function.arguments or "",
                }
            )
        return items

    def translate_tool_message(self, message: ToolMessage) -> dict[str, Any]:
        """Translate an AG-UI tool result into an SDK function-call output.

        Args:
            message: The AG-UI tool message.

        Returns:
            {"type": "function_call_output", ...}
        """
        # Surface an error-only tool result: a ToolMessage may report failure in
        # `error` with empty content (read defensively — the field is newer).
        # Without this the model receives a blank output and cannot recover.
        return {
            "type": "function_call_output",
            "call_id": message.tool_call_id,
            "output": message.content or getattr(message, "error", None) or "",
        }

    def translate_activity_message(
        self,
        message: ActivityMessage,
    ) -> dict[str, Any] | None:
        """Drop an AG-UI activity message by default.

        Neither Responses nor Chat Completions has an equivalent model-input
        item. Subclasses may override this mapping for application-specific
        activity that should be included in model input.

        Args:
            message: The AG-UI activity message.

        Returns:
            Always ``None`` in the default implementation.
        """
        logger.debug(
            "Dropping ActivityMessage id=%s activity_type=%s",
            message.id,
            message.activity_type,
        )
        return None

    # ─────────────────────────────────────────────────────────────────────
    # LEVEL 3b — Client tool translation
    # ─────────────────────────────────────────────────────────────────────

    def translate_tool(self, tool: AGUITool) -> FunctionTool:
        """Wrap a client-declared AG-UI tool as an SDK ``FunctionTool``.

        The proxy's invocation handler raises ClientToolPending so the
        outer run loop can pause the SDK and hand control back to the
        client. Client schemas remain non-strict because they are supplied
        externally and may not follow the OpenAI strict-schema subset.

        Args:
            tool: The AG-UI client-declared tool.

        Returns:
            An SDK FunctionTool proxy for the tool.
        """
        schema = self._ensure_object_schema(tool.parameters)

        async def on_invoke_tool(
            ctx: RunContextWrapper[Any],
            arguments_json: str,
        ) -> str:
            call_id = getattr(ctx, "tool_call_id", None) or ""
            raise ClientToolPending(
                tool_name=tool.name,
                tool_call_id=call_id,
                arguments=arguments_json or "",
            )

        return FunctionTool(
            name=tool.name,
            description=tool.description or "",
            params_json_schema=schema,
            on_invoke_tool=on_invoke_tool,
            strict_json_schema=False,
        )

    # ─────────────────────────────────────────────────────────────────────
    # LEVEL 3c — Content-part translation (multimodal)
    # ─────────────────────────────────────────────────────────────────────

    def translate_content(self, content: Any) -> list[dict[str, Any]]:
        """Translate a message content field (str or list of parts) to input parts.

        A string is wrapped as a single input_text part. A list has each part
        passed through translate_content_part; parts that translate to None
        are dropped, so an all-unsupported list (e.g. video-only) comes back
        empty rather than stringified. Anything else is best-effort
        stringified.

        Args:
            content: The message's content field.

        Returns:
            List of Responses-API input parts; empty when every part was
            unsupported.
        """
        if isinstance(content, str):
            # Empty string carries nothing: return no parts so translate_user_message
            # drops the turn instead of sending an empty content part the API rejects.
            return [{"type": "input_text", "text": content}] if content else []
        if isinstance(content, list):
            parts: list[dict[str, Any]] = []
            for part in content:
                converted = self.translate_content_part(part)
                if converted is not None:
                    parts.append(converted)
            return parts
        text = to_string(content)
        return [{"type": "input_text", "text": text}] if text else []

    def translate_content_part(self, part: Any) -> dict[str, Any] | None:
        """Dispatch one content part to its per-type translator.

        Args:
            part: A single typed or dict-shaped content part.

        Returns:
            The translated input part, or None if unsupported.
        """
        if isinstance(part, TextInputContent):
            return self.translate_text_content(part)
        if isinstance(part, ImageInputContent):
            return self.translate_image_content(part)
        if isinstance(part, AudioInputContent):
            return self.translate_audio_content(part)
        if isinstance(part, VideoInputContent):
            return self.translate_video_content(part)
        if isinstance(part, DocumentInputContent):
            return self.translate_document_content(part)
        if isinstance(part, BinaryInputContent):
            return self.translate_binary_content(part)
        # Support dict-shaped parts passed directly to the mapping API.
        return self._dispatch_dict_content_part(part)

    def translate_text_content(self, part: TextInputContent) -> dict[str, Any]:
        """Translate a TextInputContent part.

        Args:
            part: The AG-UI text content part.

        Returns:
            {"type": "input_text", "text": ...}
        """
        return {"type": "input_text", "text": part.text or ""}

    def translate_image_content(
        self,
        part: ImageInputContent,
    ) -> dict[str, Any] | None:
        """Translate an ImageInputContent part.

        URL sources pass through unchanged. Data sources become base64
        data URLs. OpenAI requires a detail level, so AG-UI images use
        ``auto``.

        Args:
            part: The AG-UI image content part.

        Returns:
            {"type": "input_image", "image_url": ..., "detail": "auto"},
            or None if the source has no usable value.
        """
        url = self._data_source_to_url(part.source)
        if url is None:
            return None
        return self._image_input(url)

    def translate_audio_content(
        self,
        part: AudioInputContent,
    ) -> dict[str, Any] | None:
        """Translate an AudioInputContent part.

        OpenAI accepts base64 audio through Chat Completions with an
        audio-capable model; Responses does not accept audio input. URL audio
        sources are unsupported and are dropped.

        Args:
            part: The AG-UI audio content part.

        Returns:
            {"type": "input_audio", "input_audio": {...}}, or None if
            unsupported.
        """
        source_type = read_attr(part.source, "type")
        value = read_attr(part.source, "value")
        mime = read_attr(part.source, "mime_type")
        if not value or source_type != "data":
            logger.debug("Dropping audio part: only data sources are supported")
            return None
        audio_format = self._audio_format_from_mime(mime)
        if audio_format is None:
            logger.debug("Dropping audio part: unsupported format %s", mime)
            return None
        return {
            "type": "input_audio",
            "input_audio": {
                "data": value,
                "format": audio_format,
            },
        }

    def translate_video_content(
        self,
        part: VideoInputContent,
    ) -> dict[str, Any] | None:
        """Translate a VideoInputContent part — dropped by default.

        Neither Responses nor Chat Completions has a native video input part.
        Override this in a subclass to use a placeholder or extract frames.

        Args:
            part: The AG-UI video content part.

        Returns:
            Always None.
        """
        logger.debug("Dropping video part: OpenAI model inputs do not accept video")
        return None

    def translate_document_content(
        self,
        part: DocumentInputContent,
    ) -> dict[str, Any] | None:
        """Translate a DocumentInputContent part.

        URL sources use file_url; data sources use file_data (base64).

        Args:
            part: The AG-UI document content part.

        Returns:
            {"type": "input_file", ...}, or None if no usable value.
        """
        source_type = read_attr(part.source, "type")
        value = read_attr(part.source, "value")
        mime = read_attr(part.source, "mime_type")
        if not value:
            return None
        if source_type == "url":
            return {"type": "input_file", "file_url": value}
        if source_type == "data":
            # The Responses API requires a filename alongside base64 file_data;
            # DocumentInputContent carries none, so synthesize one from the mime
            # subtype (mirrors _binary_as_file).
            subtype = (mime or "application/octet-stream").split("/")[-1] or "bin"
            return {
                "type": "input_file",
                "filename": f"document.{subtype}",
                "file_data": f"data:{mime or 'application/octet-stream'};base64,{value}",
            }
        return None

    def translate_binary_content(
        self,
        part: BinaryInputContent,
    ) -> dict[str, Any] | None:
        """Translate the deprecated BinaryInputContent catch-all by mime type.

        This legacy AG-UI type predates dedicated image, audio, video, and
        document parts. Image and audio mime types use their matching SDK
        shapes; all remaining mime types are represented as files.

        Args:
            part: The AG-UI binary content part.

        Returns:
            The translated input part, or None if unsupported.
        """
        mime = part.mime_type or "application/octet-stream"

        if mime.startswith("image/"):
            return self._binary_as_image(part)
        if mime.startswith("audio/"):
            return self._binary_as_audio(part, mime)
        # Treat anything else (pdf, text, application/*) as a file.
        return self._binary_as_file(part, mime)

    # ─────────────────────────────────────────────────────────────────────
    # LEVEL 4 — Internal helpers
    # ─────────────────────────────────────────────────────────────────────

    @staticmethod
    def _ensure_object_schema(parameters: Any) -> dict[str, Any]:
        """Normalize a possibly-empty tool parameter spec into a JSON Schema object.

        The OpenAI Agents SDK expects every function tool's schema to be a
        JSON Schema object. AG-UI tools sometimes ship parameter-less
        specs as None or {}; those get coerced to an empty-but-valid
        object. A spec that declares real fields but omits the optional
        top-level "type" keeps its fields — only the missing key is added.

        Args:
            parameters: The tool's raw parameter spec.

        Returns:
            A valid JSON Schema object.
        """
        if not isinstance(parameters, dict) or not parameters:
            return {"type": "object", "properties": {}, "additionalProperties": True}
        if "type" not in parameters:
            return {**parameters, "type": "object"}
        return parameters

    @staticmethod
    def _data_source_to_url(source: Any) -> str | None:
        """Render an image source as the URL string used by the Agents SDK.

        Both SDK transports accept URL sources and base64 data URLs.

        Args:
            source: The content part's source object.

        Returns:
            The resolved URL string, or None if there's no usable value.
        """
        if source is None:
            return None
        source_type = read_attr(source, "type")
        value = read_attr(source, "value")
        if not value:
            return None
        if source_type == "url":
            return value
        if source_type == "data":
            mime = read_attr(source, "mime_type") or "application/octet-stream"
            return f"data:{mime};base64,{value}"
        return None

    @staticmethod
    def _audio_format_from_mime(mime: str | None) -> str | None:
        """Map a mime type to the format expected for Chat Completions audio.

        Chat Completions only accepts "wav" and "mp3" for input audio, so
        anything else maps to None and the caller drops the part — sending
        e.g. "ogg" would get the whole request rejected.

        Args:
            mime: The audio mime type, or None.

        Returns:
            "wav" or "mp3", or None for unsupported formats. A missing mime
            defaults to "wav".
        """
        if not mime:
            return "wav"
        # Strip any parameters (e.g. "audio/wav; codecs=1") and whitespace before
        # matching, so a parameterized-but-valid content type isn't dropped.
        subtype = mime.split("/", 1)[-1].split(";", 1)[0].strip().lower()
        # Same audio, lots of names for it — fold the common ones together.
        if subtype in ("mpeg", "mpeg3", "mp3"):
            return "mp3"
        if subtype in ("x-wav", "wav", "wave"):
            return "wav"
        return None

    def _dispatch_dict_content_part(
        self,
        part: Any,
    ) -> dict[str, Any] | None:
        """Best-effort dispatch for dict-shaped content parts (loose typing).

        Sometimes content arrives as raw dicts rather than pydantic
        objects (e.g. when callers hand-craft inputs). The type field
        is sniffed and routed.

        Args:
            part: A dict-shaped (or duck-typed) content part.

        Returns:
            The translated input part, or None if unsupported.
        """
        part_type = read_attr(part, "type")
        if part_type == "text":
            text = read_attr(part, "text")
            if text is None:
                return None
            return {"type": "input_text", "text": text}
        if part_type == "image":
            url = self._data_source_to_url(read_attr(part, "source"))
            return self._image_input(url) if url else None
        # Don't recognize it — skip it rather than guess.
        logger.warning("Ignoring unsupported input content type: %s", part_type)
        return None

    # -- Helpers for translate_binary_content, split out to keep it readable

    def _binary_as_image(self, part: BinaryInputContent) -> dict[str, Any] | None:
        if part.url:
            return self._image_input(part.url)
        if part.data:
            mime = part.mime_type or "application/octet-stream"
            return self._image_input(f"data:{mime};base64,{part.data}")
        return None

    @staticmethod
    def _image_input(url: str) -> dict[str, Any]:
        """Build an OpenAI image input with the required detail level."""
        return {"type": "input_image", "image_url": url, "detail": "auto"}

    def _binary_as_audio(
        self,
        part: BinaryInputContent,
        mime: str,
    ) -> dict[str, Any] | None:
        if not part.data:
            logger.debug("Dropping binary audio: URL-only audio not supported")
            return None
        audio_format = self._audio_format_from_mime(mime)
        if audio_format is None:
            logger.debug("Dropping binary audio: unsupported format %s", mime)
            return None
        return {
            "type": "input_audio",
            "input_audio": {
                "data": part.data,
                "format": audio_format,
            },
        }

    def _binary_as_file(
        self,
        part: BinaryInputContent,
        mime: str,
    ) -> dict[str, Any] | None:
        if part.url:
            return {"type": "input_file", "file_url": part.url}
        if part.data:
            # The Responses API requires a filename alongside base64 file_data;
            # synthesize one from the mime subtype when the part carries none.
            subtype = mime.split("/")[-1] or "bin"
            return {
                "type": "input_file",
                "filename": part.filename or f"file.{subtype}",
                "file_data": f"data:{mime};base64,{part.data}",
            }
        return None


__all__ = [
    "AGUIToOpenAITranslator",
]
