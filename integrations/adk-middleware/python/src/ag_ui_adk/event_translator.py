# src/event_translator.py

"""Event translator for converting ADK events to AG-UI protocol events."""

import dataclasses
from collections.abc import Iterable, Mapping
from typing import AsyncGenerator, Optional, Dict, Any, List
import uuid

from google.genai import types

from ag_ui.core import (
    BaseEvent, EventType,
    TextMessageStartEvent, TextMessageContentEvent, TextMessageEndEvent,
    ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent,
    ToolCallResultEvent, StateSnapshotEvent, StateDeltaEvent,
    CustomEvent, Message, UserMessage, AssistantMessage, ToolMessage, ReasoningMessage,
    ToolCall, FunctionCall,
    ImageInputContent, AudioInputContent, VideoInputContent,
    DocumentInputContent, InputContentUrlSource, TextInputContent,
    ReasoningStartEvent, ReasoningEndEvent,
    ReasoningMessageStartEvent, ReasoningMessageContentEvent, ReasoningMessageEndEvent,
    ReasoningEncryptedValueEvent,
)
import json
from google.adk.events import Event as ADKEvent

from .config import PredictStateMapping, normalize_predict_state
from .serialization import serialize_tool_args

import logging
logger = logging.getLogger(__name__)

# Backwards-compatible thought support detection
# The part.thought attribute may not exist in older versions of google-genai
_THOUGHT_SUPPORT_CHECKED = False
_HAS_THOUGHT_SUPPORT = False

def _check_thought_support() -> bool:
    """Check if the google-genai SDK supports the part.thought attribute.

    Returns:
        True if thought support is available, False otherwise.
    """
    global _THOUGHT_SUPPORT_CHECKED, _HAS_THOUGHT_SUPPORT
    if not _THOUGHT_SUPPORT_CHECKED:
        try:
            # Check if Part class has 'thought' in its model fields (Pydantic)
            # or as a regular attribute
            if hasattr(types.Part, 'model_fields'):
                _HAS_THOUGHT_SUPPORT = 'thought' in types.Part.model_fields
            else:
                # Fallback: check if thought is a known attribute
                _HAS_THOUGHT_SUPPORT = hasattr(types.Part, 'thought')

            if _HAS_THOUGHT_SUPPORT:
                logger.info("Thought support detected in google-genai SDK; thoughts will be emitted as REASONING events")
            else:
                logger.info("Thought support not available in google-genai SDK; thoughts will be treated as regular text")
        except Exception as e:
            logger.warning(f"Error checking thought support: {e}; assuming no support")
            _HAS_THOUGHT_SUPPORT = False
        _THOUGHT_SUPPORT_CHECKED = True
    return _HAS_THOUGHT_SUPPORT


def _file_data_to_media_part(file_data):
    """Convert an ADK file_data part to the right AG-UI media content type.

    Dispatches on MIME type prefix: image/* → ImageInputContent,
    audio/* → AudioInputContent, video/* → VideoInputContent,
    everything else (documents, text, etc.) → DocumentInputContent.
    Returns None when file_uri is missing.
    """
    uri = getattr(file_data, "file_uri", None)
    if not uri:
        return None
    mime = getattr(file_data, "mime_type", None) or ""
    source = InputContentUrlSource(value=uri, mimeType=mime or None)
    if mime.startswith("image/"):
        return ImageInputContent(source=source)
    if mime.startswith("audio/"):
        return AudioInputContent(source=source)
    if mime.startswith("video/"):
        return VideoInputContent(source=source)
    return DocumentInputContent(source=source)


def _coerce_tool_response(value: Any, _visited: Optional[set[int]] = None) -> Any:
    """Recursively convert arbitrary tool responses into JSON-serializable structures."""

    if isinstance(value, (str, int, float, bool)) or value is None:
        return value

    if isinstance(value, (bytes, bytearray, memoryview)):
        try:
            return value.decode()  # type: ignore[union-attr]
        except Exception:
            return list(value)

    if _visited is None:
        _visited = set()

    obj_id = id(value)
    if obj_id in _visited:
        return str(value)

    _visited.add(obj_id)
    try:
        if dataclasses.is_dataclass(value) and not isinstance(value, type):
            return {
                field.name: _coerce_tool_response(getattr(value, field.name), _visited)
                for field in dataclasses.fields(value)
            }

        if hasattr(value, "_asdict") and callable(getattr(value, "_asdict")):
            try:
                return {
                    str(k): _coerce_tool_response(v, _visited)
                    for k, v in value._asdict().items()  # type: ignore[attr-defined]
                }
            except Exception:
                pass

        for method_name in ("model_dump", "to_dict"):
            method = getattr(value, method_name, None)
            if callable(method):
                try:
                    dumped = method()
                except TypeError:
                    try:
                        dumped = method(exclude_none=False)
                    except Exception:
                        continue
                except Exception:
                    continue

                return _coerce_tool_response(dumped, _visited)

        if isinstance(value, Mapping):
            return {
                str(k): _coerce_tool_response(v, _visited)
                for k, v in value.items()
            }

        if isinstance(value, (list, tuple, set, frozenset)):
            return [_coerce_tool_response(item, _visited) for item in value]

        if isinstance(value, Iterable):
            try:
                return [_coerce_tool_response(item, _visited) for item in list(value)]
            except TypeError:
                pass

        try:
            obj_vars = vars(value)
        except TypeError:
            obj_vars = None

        if obj_vars:
            coerced = {
                key: _coerce_tool_response(val, _visited)
                for key, val in obj_vars.items()
                if not key.startswith("_")
            }
            if coerced:
                return coerced

        return str(value)
    finally:
        _visited.discard(obj_id)

def _serialize_tool_response(response: Any) -> str:
    """Serialize a tool response into a JSON string."""

    try:
        coerced = _coerce_tool_response(response)
        return json.dumps(coerced, ensure_ascii=False)
    except Exception as exc:
        logger.warning("Failed to coerce tool response to JSON: %s", exc, exc_info=True)
        try:
            return json.dumps(str(response), ensure_ascii=False)
        except Exception:
            logger.warning("Failed to stringify tool response; returning empty string.")
            return json.dumps("", ensure_ascii=False)

class EventTranslator:
    """Translates Google ADK events to AG-UI protocol events.

    This class handles the conversion between the two event systems,
    managing streaming sequences and maintaining event consistency.
    """

    def __init__(
        self,
        predict_state: Optional[Iterable[PredictStateMapping]] = None,
        client_emitted_tool_call_ids: Optional[set] = None,
        client_tool_names: Optional[set] = None,
        is_resumable: bool = False,
        streaming_function_call_arguments: bool = False,
        output_schema_agent_names: Optional[set] = None,
    ):
        """Initialize the event translator.

        Args:
            predict_state: Optional configuration for predictive state updates.
                When provided, the translator will emit PredictState CustomEvents
                for matching tool calls, enabling the UI to show state changes
                in real-time as tool arguments are streamed.
            client_emitted_tool_call_ids: Optional shared set of tool call IDs that
                ClientProxyTool has already emitted TOOL_CALL events for. When provided,
                the translator will skip emitting duplicate events for these IDs.
            client_tool_names: Optional set of tool names that are handled by
                ClientProxyTool. When provided, the translator will skip emitting
                TOOL_CALL events for these tool names, since the proxy tool will
                emit its own events during execution. This prevents duplicate
                emissions when ADK assigns different IDs across LRO and confirmed events.
            output_schema_agent_names: Optional set of agent names whose text output
                should be suppressed from the chat UI. When an ADK event's author
                matches one of these names, text content is not emitted as
                TextMessageEvents. This prevents structured output from
                output_schema agents (e.g. classifiers in Workflow pipelines)
                from leaking into user-visible messages. (GitHub #1390)
        """
        # Agent names with output_schema — suppress their text from the chat UI (GitHub #1390)
        self._output_schema_agent_names: set[str] = output_schema_agent_names if output_schema_agent_names is not None else set()
        # Whether the agent uses ADK's native resumability (ResumabilityConfig).
        # When True, ClientProxyTool handles tool call emission and the translator
        # must skip client tool names to avoid duplicates.
        self._is_resumable = is_resumable
        # Shared set of tool call IDs already emitted by ClientProxyTool
        self._client_emitted_tool_call_ids = client_emitted_tool_call_ids if client_emitted_tool_call_ids is not None else set()
        # Set of tool names handled by ClientProxyTool — translator skips these entirely
        self._client_tool_names = client_tool_names if client_tool_names is not None else set()
        # Set of tool call IDs that this translator has already emitted events for.
        # Shared with ClientProxyTool so it can skip duplicate emissions.
        self.emitted_tool_call_ids: set[str] = set()
        # Track tool call IDs for consistency
        self._active_tool_calls: Dict[str, str] = {}  # Tool call ID -> Tool call ID (for consistency)
        # Track streaming message state
        self._streaming_message_id: Optional[str] = None  # Current streaming message ID
        self._is_streaming: bool = False  # Whether we're currently streaming a message
        self._current_stream_text: str = ""  # Accumulates text for the active stream
        self._last_streamed_text: Optional[str] = None  # Snapshot of most recently streamed text
        self._last_streamed_run_id: Optional[str] = None  # Run identifier for the last streamed text
        self.long_running_tool_ids: List[str] = []  # Track the long running tool IDs
        # Maps LRO function call name → list of IDs we emitted to the client.
        # Used to build a remap when the final (non-partial) event arrives
        # with a different ID for the same logical function call.
        # A list is used because the same tool can be called multiple times
        # in parallel (e.g. 5 concurrent create_item calls).
        self.lro_emitted_ids_by_name: Dict[str, List[str]] = {}
        # This ledger doubles as the high-water mark for replay suppression in
        # translate_lro_function_calls: ADK can replay the same logical LRO call
        # across several events (streaming chunk, aggregated partial, persisted
        # final) with a different ID each time (#1168); any same-name call whose
        # position within its event does not exceed len(ledger[name]) is a
        # replay and is suppressed. ClientProxyTool consults the same ledger to
        # suppress its own cross-path twin (see client_proxy_tool.py).

        # Track reasoning message streaming state (for thought parts)
        self._is_reasoning: bool = False  # Whether we're currently in a reasoning block
        self._is_streaming_reasoning: bool = False  # Whether we're streaming reasoning content
        self._current_reasoning_text: str = ""  # Accumulates reasoning text for the active stream
        self._current_reasoning_message_id: Optional[str] = None  # Current reasoning message ID

        # Predictive state configuration
        self._predict_state_mappings = normalize_predict_state(predict_state)
        self._predict_state_by_tool: Dict[str, List[PredictStateMapping]] = {}
        for mapping in self._predict_state_mappings:
            if mapping.tool not in self._predict_state_by_tool:
                self._predict_state_by_tool[mapping.tool] = []
            self._predict_state_by_tool[mapping.tool].append(mapping)
        self._emitted_predict_state_for_tools: set[str] = set()  # Track which tools have had PredictState emitted
        self._emitted_confirm_for_tools: set[str] = set()  # Track which tools have had confirm_changes emitted
        # Track tool call IDs we've already emitted a REASONING_ENCRYPTED_VALUE for,
        # so partial/non-partial replays of the same function call don't duplicate it.
        self._emitted_signature_tool_call_ids: set[str] = set()

        # Track tool call IDs that are associated with predictive state tools
        # We suppress TOOL_CALL_RESULT events for these since the frontend handles
        # state updates via the predictive state mechanism
        self._predictive_state_tool_call_ids: set[str] = set()

        # Deferred confirm_changes events - these must be emitted LAST, right before RUN_FINISHED
        # to ensure the frontend shows the confirmation dialog with buttons enabled
        self._deferred_confirm_events: List[BaseEvent] = []

        # Streaming function call arguments state (Mode A)
        # When enabled, partial events carrying streaming FC chunks from Gemini 3+
        # are translated into incremental TOOL_CALL_START/ARGS/END events.
        self._streaming_fc_args_enabled = streaming_function_call_arguments
        # Stable tool_call_id generated for the active streaming FC.
        # Each partial chunk gets a different ID from ADK, so we generate one
        # on the first chunk and reuse it for all subsequent AG-UI events.
        self._active_streaming_fc_id: Optional[str] = None
        # Tool name for the active streaming FC (set on first chunk).
        self._active_streaming_fc_name: Optional[str] = None
        # JSON paths that have had their opening JSON emitted (for closing at end).
        self._streaming_fc_open_paths: List[str] = []
        # JSON paths that have already had their key prefix emitted.
        self._streaming_fc_started_paths: set[str] = set()
        # Tool names that were fully streamed (for suppressing final aggregated event).
        self._completed_streaming_fc_names: set[str] = set()
        # Last completed streaming FC name/id — used for one-shot suppression of
        # the next confirmed event with this name, then cleared.
        self._last_completed_streaming_fc_name: Optional[str] = None
        self._last_completed_streaming_fc_id: Optional[str] = None
        # Maps confirmed (non-partial) FC id → streaming FC id, so that
        # TOOL_CALL_RESULT uses the same ID the client saw in TOOL_CALL_START.
        self._confirmed_to_streaming_id: Dict[str, str] = {}
        # Tool names that opted into deferred TOOL_CALL_END via stream_tool_call=True.
        self._streaming_lro_tool_names: set[str] = {
            m.tool for m in self._predict_state_mappings if m.stream_tool_call
        }

    def get_and_clear_deferred_confirm_events(self) -> List[BaseEvent]:
        """Get and clear any deferred confirm_changes events.

        These events must be emitted right before RUN_FINISHED to ensure
        the frontend's confirmation dialog works correctly.

        Returns:
            List of deferred events (may be empty)
        """
        events = self._deferred_confirm_events
        self._deferred_confirm_events = []
        return events

    def has_deferred_confirm_events(self) -> bool:
        """Check if there are any deferred confirm_changes events.

        Returns:
            True if there are deferred events waiting to be emitted
        """
        return len(self._deferred_confirm_events) > 0

    async def translate(
        self, 
        adk_event: ADKEvent,
        thread_id: str,
        run_id: str
    ) -> AsyncGenerator[BaseEvent, None]:
        """Translate an ADK event to AG-UI protocol events.
        
        Args:
            adk_event: The ADK event to translate
            thread_id: The AG-UI thread ID
            run_id: The AG-UI run ID
            
        Yields:
            One or more AG-UI protocol events
        """
        try:
            # Check ADK streaming state using proper methods
            is_partial = getattr(adk_event, 'partial', False)
            turn_complete = getattr(adk_event, 'turn_complete', False)
            
            # Check if this is the final response (contains complete message - skip to avoid duplication)
            is_final_response = False
            if hasattr(adk_event, 'is_final_response') and callable(adk_event.is_final_response):
                is_final_response = adk_event.is_final_response()
            elif hasattr(adk_event, 'is_final_response'):
                is_final_response = adk_event.is_final_response
            
            # Determine action based on ADK streaming pattern
            should_send_end = turn_complete and not is_partial

            # Skip user events (already in the conversation)
            if hasattr(adk_event, 'author') and adk_event.author == "user":
                logger.debug("Skipping user event")
                return

            # Handle text content
            # --- THIS IS THE RESTORED LINE ---
            if adk_event.content and hasattr(adk_event.content, 'parts') and adk_event.content.parts:
                async for event in self._translate_text_content(
                    adk_event, thread_id, run_id
                ):
                    yield event
            
            # Handle streaming function calls from partial events (Mode A)
            if self._streaming_fc_args_enabled and is_partial and hasattr(adk_event, 'get_function_calls'):
                function_calls = adk_event.get_function_calls()
                if function_calls:
                    try:
                        lro_ids = set(getattr(adk_event, 'long_running_tool_ids', []) or [])
                    except Exception:
                        lro_ids = set()
                    for func_call in function_calls:
                        fc_id = getattr(func_call, 'id', None)
                        if fc_id in lro_ids or fc_id in self._client_emitted_tool_call_ids:
                            continue
                        async for event in self._translate_streaming_function_call(func_call):
                            yield event

            # Handle complete (non-partial) function calls
            if hasattr(adk_event, 'get_function_calls') and not is_partial:
                function_calls = adk_event.get_function_calls()
                if function_calls:
                    # Filter out long-running tool calls; those are handled by translate_lro_function_calls
                    try:
                        lro_ids = set(getattr(adk_event, 'long_running_tool_ids', []) or [])
                    except Exception:
                        lro_ids = set()

                    # Also exclude tool calls already emitted via translate_lro_function_calls
                    # (self.long_running_tool_ids tracks IDs across events, while lro_ids
                    # is per-event and may be empty on the confirmed/non-partial replay)
                    # and tool calls already emitted by ClientProxyTool
                    all_lro_ids = lro_ids | set(self.long_running_tool_ids)

                    non_lro_calls = [
                        fc for fc in function_calls
                        if getattr(fc, 'id', None) not in all_lro_ids
                        and getattr(fc, 'id', None) not in self._client_emitted_tool_call_ids
                        and getattr(fc, 'name', None) not in self._client_tool_names
                        and getattr(fc, 'name', None) != self._last_completed_streaming_fc_name
                    ]

                    # Map confirmed FC ids to streaming FC ids for result remapping
                    if self._last_completed_streaming_fc_name:
                        for fc in function_calls:
                            fc_name = getattr(fc, 'name', None)
                            fc_id = getattr(fc, 'id', None)
                            if fc_name == self._last_completed_streaming_fc_name and fc_id and self._last_completed_streaming_fc_id:
                                self._confirmed_to_streaming_id[fc_id] = self._last_completed_streaming_fc_id
                        self._last_completed_streaming_fc_name = None
                        self._last_completed_streaming_fc_id = None

                    if non_lro_calls:
                        logger.debug(f"ADK function calls detected (non-LRO, non-streamed): {len(non_lro_calls)} of {len(function_calls)} total")
                        # CRITICAL FIX: End any active text message stream before starting tool calls
                        # Per AG-UI protocol: TEXT_MESSAGE_END must be sent before TOOL_CALL_START
                        async for event in self.force_close_streaming_message():
                            yield event

                        # Yield only non-LRO function call events
                        async for event in self._translate_function_calls(non_lro_calls):
                            yield event

                    # Emit REASONING_ENCRYPTED_VALUE for thought signatures attached to
                    # function_call parts. Gemini attaches the signature to the tool call
                    # part (not the thought-text part), so the reasoning path above never
                    # sees it. Runs for both LRO and non-LRO calls present in this event.
                    async for event in self._translate_function_call_signatures(adk_event):
                        yield event

            # Handle function responses and yield the tool response event
            # this is essential for scenerios when user has to render function response at frontend
            if hasattr(adk_event, 'get_function_responses'):
                function_responses = adk_event.get_function_responses()
                if function_responses:
                    # Function responses should be emmitted to frontend so it can render the response as well
                    async for event in self._translate_function_response(function_responses):
                        yield event
                    
            
            # Handle state changes
            if hasattr(adk_event, 'actions') and adk_event.actions:
                if hasattr(adk_event.actions, 'state_delta') and adk_event.actions.state_delta:
                    yield self._create_state_delta_event(
                        adk_event.actions.state_delta, thread_id, run_id
                    )

                if hasattr(adk_event.actions, 'state_snapshot'):
                    state_snapshot = adk_event.actions.state_snapshot
                    if state_snapshot is not None:
                        yield self._create_state_snapshot_event(state_snapshot)
                
            
            # Handle custom events or metadata
            if hasattr(adk_event, 'custom_data') and adk_event.custom_data:
                yield CustomEvent(
                    type=EventType.CUSTOM,
                    name="adk_metadata",
                    value=adk_event.custom_data
                )
                
        except Exception as e:
            logger.error(f"Error translating ADK event: {e}", exc_info=True)
            # Don't yield error events here - let the caller handle errors

    async def translate_text_only(
        self,
        adk_event: ADKEvent,
        thread_id: str,
        run_id: str
    ) -> AsyncGenerator[BaseEvent, None]:
        """Translate only text content from ADK event, ignoring function calls.

        Used when an event contains both text and LRO function calls,
        to ensure text is emitted before the LRO tool call events.
        (GitHub #906)

        Args:
            adk_event: The ADK event containing text content
            thread_id: The AG-UI thread ID
            run_id: The AG-UI run ID

        Yields:
            Text message events (START, CONTENT, END)
        """
        if adk_event.content and hasattr(adk_event.content, 'parts') and adk_event.content.parts:
            async for event in self._translate_text_content(
                adk_event, thread_id, run_id
            ):
                yield event

    async def _translate_text_content(
        self,
        adk_event: ADKEvent,
        thread_id: str,
        run_id: str
    ) -> AsyncGenerator[BaseEvent, None]:
        """Translate text content from ADK event to AG-UI text message events.
        
        Args:
            adk_event: The ADK event containing text content
            thread_id: The AG-UI thread ID
            run_id: The AG-UI run ID
            
        Yields:
            Text message events (START, CONTENT, END)
        """
        
        # Check for is_final_response *before* checking for text.
        # An empty final response is a valid stream-closing signal.
        is_final_response = False
        if hasattr(adk_event, 'is_final_response') and callable(adk_event.is_final_response):
            is_final_response = adk_event.is_final_response()
        elif hasattr(adk_event, 'is_final_response'):
            is_final_response = adk_event.is_final_response
        
        # Extract text from all parts, separating thought parts from regular text
        text_parts = []
        thought_parts = []
        thought_signatures: List[Optional[bytes]] = []
        has_thought_support = _check_thought_support()

        # The check for adk_event.content.parts happens in the main translate method
        for part in adk_event.content.parts:
            if not part.text:  # Note: part.text == "" is False
                continue

            # Check if this is a thought part (backwards-compatible)
            # Use `is True` to handle Mock objects in tests and ensure we only
            # treat parts as thoughts when thought is explicitly set to True
            is_thought = False
            if has_thought_support:
                thought_value = getattr(part, 'thought', None)
                is_thought = thought_value is True

            if is_thought:
                thought_parts.append(part.text)
                # Capture thought_signature if available (opaque bytes for encrypted reasoning)
                sig = getattr(part, 'thought_signature', None)
                thought_signatures.append(sig)
            else:
                text_parts.append(part.text)

        # Handle thought parts first (emit REASONING events).
        # When a reasoning stream was opened by partial=True chunks, ADK emits
        # a final aggregated event with partial=False re-containing the full
        # thought text — re-emitting it would duplicate the reasoning block.
        # Mirror the text dedup below (was_already_streaming and not is_partial):
        # only skip when an active reasoning stream is being aggregated.
        # Do NOT skip when no reasoning stream is open: StreamingMode.NONE
        # yields a single partial=False event that carries the only copy.
        was_already_reasoning = self._is_streaming_reasoning
        is_partial = getattr(adk_event, 'partial', False)
        if thought_parts and not (was_already_reasoning and not is_partial):
            async for event in self._translate_reasoning_content(thought_parts, thought_signatures):
                yield event

        # Suppress user-visible text from agents with output_schema configured.
        # Their text content is structured output intended for inter-agent data
        # transfer (e.g. a classifier returning "CHAT"), not for the chat UI.
        # Reasoning/thought parts above are still emitted. (GitHub #1390)
        author = getattr(adk_event, 'author', None)
        if author and author in self._output_schema_agent_names:
            logger.debug(
                "Suppressing text from output_schema agent %r", author
            )
            return

        # If no text AND it's not a final response, we can safely skip.
        # Otherwise, we must continue to process the final_response signal.
        if not text_parts and not is_final_response:
            # If we only had thought parts and this is not final, close any active reasoning
            # but don't return yet if we need to handle final response
            return

        combined_text = "".join(text_parts)

        # Handle is_final_response BEFORE the empty text early return.
        # An empty final response is a valid stream-closing signal that must close
        # any active stream, even if there's no new text content.
        if is_final_response:
            # This is the final, complete message event.

            # Close any active thinking stream first
            async for event in self._close_reasoning_stream():
                yield event

            # Case 1: A text stream is actively running. We must close it.
            if self._is_streaming and self._streaming_message_id:
                logger.info("⏭️ Final response event received. Closing active stream.")

                if self._current_stream_text:
                    # Save the complete streamed text for de-duplication
                    self._last_streamed_text = self._current_stream_text
                    self._last_streamed_run_id = run_id
                self._current_stream_text = ""

                end_event = TextMessageEndEvent(
                    type=EventType.TEXT_MESSAGE_END,
                    message_id=self._streaming_message_id
                )
                yield end_event

                self._streaming_message_id = None
                self._is_streaming = False
                logger.info("🏁 Streaming completed via final response")
                return # We are done.

            # Case 2: No stream is active.
            # Check for duplicates from a *previous* stream in this *same run*.
            # We use two checks:
            # 1. Exact match - handles normal delta streaming where accumulated
            #    text equals the final consolidated message
            # 2. Suffix match - handles LLMs that send accumulated text in each
            #    chunk (not deltas), where _last_streamed_text will be concatenated
            #    chunks ending with the final text (GitHub #400)
            is_duplicate = False
            if self._last_streamed_run_id == run_id and self._last_streamed_text is not None:
                if combined_text == self._last_streamed_text:
                    is_duplicate = True
                elif self._last_streamed_text.endswith(combined_text):
                    is_duplicate = True

            if is_duplicate:
                logger.info(
                    "⏭️ Skipping final response event (duplicate content detected from finished stream)"
                )
                # Clean up state as this is still the terminal signal for text.
                self._current_stream_text = ""
                self._last_streamed_text = None
                self._last_streamed_run_id = None
                return

            if not combined_text:
                logger.info("⏭️ Final response contained no text; nothing to emit")
                self._current_stream_text = ""
                self._last_streamed_text = None
                self._last_streamed_run_id = None
                return

            # Fall through to the normal emission path to send the consolidated
            # START/CONTENT/END trio for non-streaming final responses.

        # Early return for empty text (non-final responses only).
        # Final responses with empty text are handled above to close active streams.
        if not combined_text:
            return

        # Use proper ADK streaming detection (handle None values)
        is_partial = getattr(adk_event, 'partial', False)
        turn_complete = getattr(adk_event, 'turn_complete', False)

        # Handle None values: if a turn is complete or a final chunk arrives, end streaming
        has_finish_reason = bool(getattr(adk_event, 'finish_reason', None))
        should_send_end = (
            (turn_complete and not is_partial)
            or (is_final_response and not is_partial)
            or (has_finish_reason and self._is_streaming)
        )

        # Track if we were already streaming before this event (for consolidated message detection)
        was_already_streaming = self._is_streaming

        # Handle streaming logic (if not is_final_response)
        if not self._is_streaming:
            # Close any active thinking stream before starting regular text
            # (transition from thinking to response)
            async for event in self._close_reasoning_stream():
                yield event

            # Start of new message - emit START event
            self._streaming_message_id = str(uuid.uuid4())
            self._is_streaming = True
            self._current_stream_text = ""

            start_event = TextMessageStartEvent(
                type=EventType.TEXT_MESSAGE_START,
                message_id=self._streaming_message_id,
                role="assistant"
            )
            yield start_event

        # Emit content with consolidated message detection (GitHub #742)
        # When streaming, ADK sends incremental deltas with partial=True, then a final
        # consolidated message with partial=False containing all the text. If we were
        # already streaming and receive a consolidated message (partial=False), we skip
        # it to avoid duplicating already-streamed content.
        # Note: We check was_already_streaming (not _is_streaming) to allow the first
        # event of a non-streaming response (partial=False) to emit content normally.
        if combined_text:
            # Skip consolidated messages during active streaming
            if was_already_streaming and not is_partial:
                logger.info(
                    "⏭️ Skipping consolidated text (partial=False during active stream)"
                )
            else:
                self._current_stream_text += combined_text
                content_event = TextMessageContentEvent(
                    type=EventType.TEXT_MESSAGE_CONTENT,
                    message_id=self._streaming_message_id,
                    delta=combined_text
                )
                yield content_event
        
        # If turn is complete and not partial, emit END event
        if should_send_end:
            end_event = TextMessageEndEvent(
                type=EventType.TEXT_MESSAGE_END,
                message_id=self._streaming_message_id
            )
            yield end_event

            # Reset streaming state
            if self._current_stream_text:
                self._last_streamed_text = self._current_stream_text
                self._last_streamed_run_id = run_id
            self._current_stream_text = ""
            self._streaming_message_id = None
            self._is_streaming = False
            logger.info("🏁 Streaming completed, state reset")

    async def _translate_reasoning_content(
        self,
        thought_parts: List[str],
        thought_signatures: Optional[List[Optional[bytes]]] = None,
    ) -> AsyncGenerator[BaseEvent, None]:
        """Translate thought parts to AG-UI REASONING events.

        This method emits REASONING_START, REASONING_MESSAGE_START/CONTENT/END,
        and tracks reasoning state for proper stream management. When thought_signatures
        are present, emits REASONING_ENCRYPTED_VALUE events for each signature.

        Args:
            thought_parts: List of thought text strings to emit
            thought_signatures: Optional list of opaque signatures (bytes) for each
                thought part, used for encrypted reasoning (e.g., Gemini thought signatures).

        Yields:
            Reasoning events (REASONING_START, REASONING_MESSAGE_START/CONTENT/END,
            REASONING_ENCRYPTED_VALUE)
        """
        if not thought_parts:
            return

        combined_thought = "".join(thought_parts)
        if not combined_thought:
            return

        # Start reasoning block if not already in one
        if not self._is_reasoning:
            self._is_reasoning = True
            self._current_reasoning_message_id = str(uuid.uuid4())
            yield ReasoningStartEvent(
                type=EventType.REASONING_START,
                message_id=self._current_reasoning_message_id,
            )
            logger.debug("🧠 Started reasoning block")

        # Start reasoning message if not already streaming
        if not self._is_streaming_reasoning:
            self._is_streaming_reasoning = True
            self._current_reasoning_text = ""
            if not self._current_reasoning_message_id:
                self._current_reasoning_message_id = str(uuid.uuid4())
            yield ReasoningMessageStartEvent(
                type=EventType.REASONING_MESSAGE_START,
                message_id=self._current_reasoning_message_id,
                role="reasoning",
            )
            logger.debug("🧠 Started reasoning message")

        # Emit reasoning content
        self._current_reasoning_text += combined_thought
        yield ReasoningMessageContentEvent(
            type=EventType.REASONING_MESSAGE_CONTENT,
            message_id=self._current_reasoning_message_id,
            delta=combined_thought,
        )
        logger.debug(f"🧠 Emitted reasoning content: {len(combined_thought)} chars")

        # Emit encrypted value events for thought signatures
        if thought_signatures and self._current_reasoning_message_id:
            import base64
            for sig in thought_signatures:
                if sig is not None:
                    encrypted_value = base64.b64encode(sig).decode("ascii") if isinstance(sig, (bytes, bytearray)) else str(sig)
                    yield ReasoningEncryptedValueEvent(
                        type=EventType.REASONING_ENCRYPTED_VALUE,
                        subtype="message",
                        entity_id=self._current_reasoning_message_id,
                        encrypted_value=encrypted_value,
                    )
                    logger.debug("🧠 Emitted reasoning encrypted value (thought signature)")

    async def _close_reasoning_stream(self) -> AsyncGenerator[BaseEvent, None]:
        """Close any active reasoning stream.

        This should be called when transitioning from reasoning to regular output,
        or when the response is finalized.

        Yields:
            REASONING_MESSAGE_END and REASONING_END events if needed
        """
        if self._is_streaming_reasoning:
            yield ReasoningMessageEndEvent(
                type=EventType.REASONING_MESSAGE_END,
                message_id=self._current_reasoning_message_id or "",
            )
            self._is_streaming_reasoning = False
            self._current_reasoning_text = ""
            logger.debug("🧠 Closed reasoning message")

        if self._is_reasoning:
            yield ReasoningEndEvent(
                type=EventType.REASONING_END,
                message_id=self._current_reasoning_message_id or "",
            )
            self._is_reasoning = False
            self._current_reasoning_message_id = None
            logger.debug("🧠 Closed reasoning block")

    async def translate_lro_function_calls(self,adk_event: ADKEvent)-> AsyncGenerator[BaseEvent, None]:
        """Translate long running function calls from ADK event to AG-UI tool call events.

        Args:
            adk_event: The ADK event containing function calls

        Yields:
            Tool call events (START, ARGS, END)
        """

        if adk_event.content and adk_event.content.parts:
            lro_ids = set(adk_event.long_running_tool_ids or [])
            # High-water-mark dedupe across REPLAYED events. Under SSE streaming
            # ADK can deliver the same logical LRO call several times — a
            # streaming chunk (partial=True), an aggregated partial, and the
            # persisted final (partial=False) — and assigns a *different* ID to
            # each replay (#1168), so the ID-based guard below cannot recognize
            # them as the same call and a duplicate TOOL_CALL trio renders the
            # HITL card twice in the dojo. Instead, count same-name LRO calls
            # positionally WITHIN this event: the Nth same-name call in an event
            # is a replay if we already emitted >= N calls for that name in this
            # run (the FIFO pairing _extract_lro_id_remap also uses). Genuinely
            # parallel same-name calls arrive as multiple parts of ONE event, so
            # they exceed the high-water mark and still emit individually. A
            # second model turn calling the same tool again cannot occur within
            # this runner stream — LRO pauses the invocation — so a same-name
            # reappearance in a LATER event is always a replay.
            seen_in_event: Dict[str, int] = {}
            for i, part in enumerate(adk_event.content.parts):
                if part.function_call:
                    fc = part.function_call
                    if getattr(fc, 'id', None) in lro_ids \
                      and fc.id not in self.emitted_tool_call_ids:
                        position = seen_in_event.get(fc.name, 0) + 1
                        seen_in_event[fc.name] = position
                        already_emitted = len(self.lro_emitted_ids_by_name.get(fc.name, []))
                        if position <= already_emitted:
                            # Replay of the position-th call — already emitted
                            # (under a different ID); suppress the duplicate.
                            continue
                    # Emit whenever the FC is LRO and hasn't already been emitted
                    # — by ClientProxyTool (1.18+ when ADK invokes the proxy) or
                    # by a previous call to this method (SSE streams an LRO event
                    # twice: once partial=True, once partial=False). The proxy's
                    # own dedupe guard (client_proxy_tool.py
                    # _translator_emitted_tool_call_ids) keeps emission idempotent
                    # in the opposite direction. On ADK <1.18 the resumable
                    # first-turn flow returns before invoking the proxy
                    # (base_llm_flow.py pause-early-return), so the translator is
                    # the only emitter. See issue #1536.
                    if fc.id in lro_ids \
                      and fc.id not in self._client_emitted_tool_call_ids \
                      and fc.id not in self.emitted_tool_call_ids:
                        self.long_running_tool_ids.append(fc.id)
                        if fc.name not in self.lro_emitted_ids_by_name:
                            self.lro_emitted_ids_by_name[fc.name] = []
                        self.lro_emitted_ids_by_name[fc.name].append(fc.id)
                        yield ToolCallStartEvent(
                            type=EventType.TOOL_CALL_START,
                            tool_call_id=fc.id,
                            tool_call_name=fc.name,
                            parent_message_id=None
                        )
                        if hasattr(fc, 'args') and fc.args:
                            args_str = serialize_tool_args(fc.args)
                            yield ToolCallArgsEvent(
                                type=EventType.TOOL_CALL_ARGS,
                                tool_call_id=fc.id,
                                delta=args_str
                            )

                        # Emit TOOL_CALL_END
                        yield ToolCallEndEvent(
                            type=EventType.TOOL_CALL_END,
                            tool_call_id=fc.id
                        )

                        # Record so ClientProxyTool can skip duplicate emission
                        self.emitted_tool_call_ids.add(fc.id)

                        # Clean up tracking
                        self._active_tool_calls.pop(fc.id, None)
    
    async def _translate_function_call_signatures(
        self,
        adk_event: ADKEvent,
    ) -> AsyncGenerator[BaseEvent, None]:
        """Emit REASONING_ENCRYPTED_VALUE for thought signatures on function_call parts.

        Gemini attaches ``thought_signature`` (the encrypted chain-of-thought that
        led to a tool call) to the ``function_call`` part rather than to the
        thought-text part. The thought-text path in ``_translate_reasoning_content``
        therefore never sees it, and the encrypted reasoning would be dropped.

        This emits a ``ReasoningEncryptedValueEvent`` with ``subtype="tool-call"``
        keyed by the tool call id, mirroring the ``subtype="message"`` emission for
        thought-text signatures. Deduplicated per tool call id so partial/non-partial
        replays of the same function call don't emit it twice.

        Args:
            adk_event: The ADK event whose parts may carry function-call signatures.

        Yields:
            ReasoningEncryptedValueEvent for each function_call part with a signature.
        """
        import base64

        content = getattr(adk_event, "content", None)
        parts = getattr(content, "parts", None) if content is not None else None
        if not parts:
            return

        for part in parts:
            func_call = getattr(part, "function_call", None)
            sig = getattr(part, "thought_signature", None)
            # thought_signature is always opaque bytes when present; anything else
            # (e.g. None, or an unset attribute) means there is no signature.
            if func_call is None or not isinstance(sig, (bytes, bytearray)):
                continue

            tool_call_id = getattr(func_call, "id", None)
            if (
                not isinstance(tool_call_id, str)
                or not tool_call_id
                or tool_call_id in self._emitted_signature_tool_call_ids
            ):
                continue
            self._emitted_signature_tool_call_ids.add(tool_call_id)

            encrypted_value = base64.b64encode(sig).decode("ascii")
            yield ReasoningEncryptedValueEvent(
                type=EventType.REASONING_ENCRYPTED_VALUE,
                subtype="tool-call",
                entity_id=tool_call_id,
                encrypted_value=encrypted_value,
            )
            logger.debug(
                "🧠 Emitted reasoning encrypted value (tool-call signature) for %s",
                tool_call_id,
            )

    async def _translate_function_calls(
        self,
        function_calls: list[types.FunctionCall],
    ) -> AsyncGenerator[BaseEvent, None]:
        """Translate function calls from ADK event to AG-UI tool call events.

        Args:
            adk_event: The ADK event containing function calls
            function_calls: List of function calls from the event
            thread_id: The AG-UI thread ID
            run_id: The AG-UI run ID

        Yields:
            Tool call events (START, ARGS, END) and optionally PredictState CustomEvent
        """
        # Since we're not tracking streaming messages, use None for parent message
        parent_message_id = None

        for func_call in function_calls:
            tool_call_id = getattr(func_call, 'id', str(uuid.uuid4()))
            tool_name = func_call.name

            # Check if this tool call ID already exists
            if tool_call_id in self._active_tool_calls:
                logger.warning(f"⚠️  DUPLICATE TOOL CALL! Tool call ID {tool_call_id} (name: {tool_name}) already exists in active calls!")

            # Track the tool call
            self._active_tool_calls[tool_call_id] = tool_call_id

            # Check if this tool has predictive state configuration
            # Emit PredictState CustomEvent BEFORE the tool call events
            if tool_name in self._predict_state_by_tool:
                # Track this tool call ID so we can suppress its TOOL_CALL_RESULT event
                # The frontend handles state updates via the predictive state mechanism
                self._predictive_state_tool_call_ids.add(tool_call_id)

                if tool_name not in self._emitted_predict_state_for_tools:
                    mappings = self._predict_state_by_tool[tool_name]
                    predict_state_payload = [mapping.to_payload() for mapping in mappings]
                    logger.debug(f"Emitting PredictState CustomEvent for tool '{tool_name}': {predict_state_payload}")
                    yield CustomEvent(
                        type=EventType.CUSTOM,
                        name="PredictState",
                        value=predict_state_payload,
                    )
                    self._emitted_predict_state_for_tools.add(tool_name)

            # Emit TOOL_CALL_START
            yield ToolCallStartEvent(
                type=EventType.TOOL_CALL_START,
                tool_call_id=tool_call_id,
                tool_call_name=tool_name,
                parent_message_id=parent_message_id
            )

            # Emit TOOL_CALL_ARGS if we have arguments
            if hasattr(func_call, 'args') and func_call.args:
                args_str = serialize_tool_args(func_call.args)

                yield ToolCallArgsEvent(
                    type=EventType.TOOL_CALL_ARGS,
                    tool_call_id=tool_call_id,
                    delta=args_str
                )

            # Emit TOOL_CALL_END
            yield ToolCallEndEvent(
                type=EventType.TOOL_CALL_END,
                tool_call_id=tool_call_id
            )

            # Record so ClientProxyTool can skip duplicate emission
            self.emitted_tool_call_ids.add(tool_call_id)

            # Clean up tracking
            self._active_tool_calls.pop(tool_call_id, None)

            # Check if we should emit confirm_changes tool call after this tool
            # This follows the pattern used by LangGraph, CrewAI, and server-starter-all-features
            # where the backend uses a "local" tool (e.g., write_document_local) and
            # then emits confirm_changes to trigger the frontend confirmation UI
            #
            # IMPORTANT: We DEFER these events to be emitted right before RUN_FINISHED.
            # If we emit them immediately, subsequent events (TOOL_CALL_RESULT, TEXT_MESSAGE, etc.)
            # can cause the frontend to transition the confirm_changes status away from "executing",
            # which disables the confirmation dialog buttons.
            if tool_name in self._predict_state_by_tool and tool_name not in self._emitted_confirm_for_tools:
                mappings = self._predict_state_by_tool[tool_name]
                # Check if any mapping has emit_confirm_tool=True
                should_emit_confirm = any(m.emit_confirm_tool for m in mappings)
                if should_emit_confirm:
                    confirm_tool_call_id = str(uuid.uuid4())
                    logger.debug(f"Deferring confirm_changes tool call events after '{tool_name}' (will emit before RUN_FINISHED)")

                    # Store events for later emission (right before RUN_FINISHED)
                    self._deferred_confirm_events.append(ToolCallStartEvent(
                        type=EventType.TOOL_CALL_START,
                        tool_call_id=confirm_tool_call_id,
                        tool_call_name="confirm_changes",
                        parent_message_id=parent_message_id
                    ))

                    self._deferred_confirm_events.append(ToolCallArgsEvent(
                        type=EventType.TOOL_CALL_ARGS,
                        tool_call_id=confirm_tool_call_id,
                        delta="{}"
                    ))

                    self._deferred_confirm_events.append(ToolCallEndEvent(
                        type=EventType.TOOL_CALL_END,
                        tool_call_id=confirm_tool_call_id
                    ))

                    self._emitted_confirm_for_tools.add(tool_name)

    async def _translate_streaming_function_call(
        self,
        func_call: Any,
    ) -> AsyncGenerator[BaseEvent, None]:
        """Translate a streaming function call chunk to AG-UI tool call events.

        With google-adk >= 1.24.0 and stream_function_call_arguments=True,
        Gemini 3+ models send function call arguments as incremental chunks:

        1. First chunk:  name="tool", will_continue=True, partial_args=None/[]
        2. Middle chunks: name=None, partial_args=[PartialArg(...)], will_continue=True
        3. End marker:   name=None, partial_args=None, will_continue=None/False
        4. Final (aggregated): name="tool", args={...}, partial=False (handled by translate())

        Each partial chunk gets a DIFFERENT ID from ADK. We generate a stable
        tool_call_id on the first chunk and reuse it for all AG-UI events.

        Args:
            func_call: A FunctionCall from a partial ADK event.

        Yields:
            TOOL_CALL_START, TOOL_CALL_ARGS (incremental JSON), TOOL_CALL_END
        """
        tool_name = getattr(func_call, 'name', None)
        partial_args = getattr(func_call, 'partial_args', None)
        will_continue = getattr(func_call, 'will_continue', None)

        # --- First chunk: has name + will_continue ---
        if tool_name and will_continue and self._active_streaming_fc_id is None:
            self._active_streaming_fc_id = str(uuid.uuid4())
            self._active_streaming_fc_name = tool_name
            self._streaming_fc_open_paths = []
            self._streaming_fc_started_paths = set()

            # Close any active text message stream before tool calls
            async for event in self.force_close_streaming_message():
                yield event

            # Emit PredictState if configured for this tool
            if tool_name in self._predict_state_by_tool:
                self._predictive_state_tool_call_ids.add(self._active_streaming_fc_id)
                if tool_name not in self._emitted_predict_state_for_tools:
                    mappings = self._predict_state_by_tool[tool_name]
                    predict_state_payload = [m.to_payload() for m in mappings]
                    yield CustomEvent(
                        type=EventType.CUSTOM,
                        name="PredictState",
                        value=predict_state_payload,
                    )
                    self._emitted_predict_state_for_tools.add(tool_name)

            # Emit TOOL_CALL_START
            yield ToolCallStartEvent(
                type=EventType.TOOL_CALL_START,
                tool_call_id=self._active_streaming_fc_id,
                tool_call_name=tool_name,
                parent_message_id=None,
            )
            self.emitted_tool_call_ids.add(self._active_streaming_fc_id)
            logger.debug(f"Streaming FC started: tool={tool_name}, id={self._active_streaming_fc_id}")
            return

        # --- No active streaming FC — skip stray chunks ---
        if self._active_streaming_fc_id is None:
            return

        tool_call_id = self._active_streaming_fc_id

        # --- Continuation chunks: emit partial_args as TOOL_CALL_ARGS deltas ---
        if partial_args:
            for partial_arg in partial_args:
                string_value = getattr(partial_arg, 'string_value', None)
                if string_value is None:
                    continue
                json_path = getattr(partial_arg, 'json_path', None) or ''

                if json_path and json_path not in self._streaming_fc_started_paths:
                    # First occurrence of this json_path: emit JSON key prefix
                    key = json_path.lstrip('$.')
                    # Build opening: {"key": "escaped_start...
                    # We use json.dumps for proper key quoting, then append escaped value
                    escaped_value = json.dumps(string_value)[1:-1]  # strip wrapping quotes
                    delta = '{' + json.dumps(key) + ': "' + escaped_value
                    self._streaming_fc_started_paths.add(json_path)
                    self._streaming_fc_open_paths.append(json_path)
                elif string_value:
                    # Continuation: just the escaped string fragment
                    delta = json.dumps(string_value)[1:-1]  # strip wrapping quotes
                else:
                    continue

                if delta:
                    yield ToolCallArgsEvent(
                        type=EventType.TOOL_CALL_ARGS,
                        tool_call_id=tool_call_id,
                        delta=delta,
                    )

        # --- End marker: no partial_args, will_continue is None/False ---
        if not partial_args and not will_continue:
            resolved_name = self._active_streaming_fc_name

            # Close any open JSON paths with closing quote + brace
            if self._streaming_fc_open_paths:
                yield ToolCallArgsEvent(
                    type=EventType.TOOL_CALL_ARGS,
                    tool_call_id=tool_call_id,
                    delta='"}',
                )

            # Determine if TOOL_CALL_END should be deferred (streaming LRO)
            should_defer_end = (
                resolved_name in self._streaming_lro_tool_names
                if resolved_name else False
            )

            if not should_defer_end:
                yield ToolCallEndEvent(
                    type=EventType.TOOL_CALL_END,
                    tool_call_id=tool_call_id,
                )

            # Record completion for duplicate suppression
            if resolved_name:
                self._completed_streaming_fc_names.add(resolved_name)
                self._last_completed_streaming_fc_name = resolved_name
                self._last_completed_streaming_fc_id = tool_call_id

            logger.debug(f"Streaming FC ended: tool={resolved_name}, id={tool_call_id}")

            # Reset active streaming state
            self._active_streaming_fc_id = None
            self._active_streaming_fc_name = None
            self._streaming_fc_open_paths = []
            self._streaming_fc_started_paths = set()

    async def _translate_function_response(
        self,
        function_response: list[types.FunctionResponse],
    ) -> AsyncGenerator[BaseEvent, None]:
        """Translate function calls from ADK event to AG-UI tool call events.

        Args:
            adk_event: The ADK event containing function calls
            function_response: List of function response from the event

        Yields:
            Tool result events (only for tool_call_ids not in long_running_tool_ids
            and not associated with predictive state tools)
        """

        for func_response in function_response:

            tool_call_id = getattr(func_response, 'id', str(uuid.uuid4()))

            # Remap tool_call_id if this is a confirmed response for a streamed FC
            if tool_call_id in self._confirmed_to_streaming_id:
                tool_call_id = self._confirmed_to_streaming_id[tool_call_id]

            # Skip TOOL_CALL_RESULT for long-running tools (handled by frontend)
            if tool_call_id in self.long_running_tool_ids:
                logger.debug(f"Skipping ToolCallResultEvent for long-running tool: {tool_call_id}")
                continue

            # Skip TOOL_CALL_RESULT for predictive state tools
            # The frontend handles state updates via the predictive state mechanism,
            # and emitting a result event causes "No function call event found" errors
            if tool_call_id in self._predictive_state_tool_call_ids:
                logger.debug(f"Skipping ToolCallResultEvent for predictive state tool: {tool_call_id}")
                continue

            yield ToolCallResultEvent(
                message_id=str(uuid.uuid4()),
                type=EventType.TOOL_CALL_RESULT,
                tool_call_id=tool_call_id,
                content=_serialize_tool_response(func_response.response)
            )
  
    def _create_state_delta_event(
        self,
        state_delta: Dict[str, Any],
        thread_id: str,
        run_id: str
    ) -> StateDeltaEvent:
        """Create a state delta event from ADK state changes.
        
        Args:
            state_delta: The state changes from ADK
            thread_id: The AG-UI thread ID
            run_id: The AG-UI run ID
            
        Returns:
            A StateDeltaEvent
        """
        # Convert to JSON Patch format (RFC 6902)
        # Use "add" operation which works for both new and existing paths
        patches = []
        for key, value in state_delta.items():
            patches.append({
                "op": "add",
                "path": f"/{key}",
                "value": value
            })
        
        return StateDeltaEvent(
            type=EventType.STATE_DELTA,
            delta=patches
        )
    
    def _create_state_snapshot_event(
        self,
        state_snapshot: Dict[str, Any],
    ) -> StateSnapshotEvent:
        """Create a state snapshot event from ADK state changes.
        
        Args:
            state_snapshot: The state changes from ADK
            
        Returns:
            A StateSnapshotEvent
        """
 
        return StateSnapshotEvent(
            type=EventType.STATE_SNAPSHOT,
            snapshot=state_snapshot
        )
    
    async def force_close_streaming_message(self) -> AsyncGenerator[BaseEvent, None]:
        """Force close any open streaming message.
        
        This should be called before ending a run to ensure proper message termination.
        
        Yields:
            TEXT_MESSAGE_END event if there was an open streaming message
        """
        if self._is_streaming and self._streaming_message_id:
            logger.warning(f"🚨 Force-closing unterminated streaming message: {self._streaming_message_id}")

            end_event = TextMessageEndEvent(
                type=EventType.TEXT_MESSAGE_END,
                message_id=self._streaming_message_id
            )
            yield end_event

            # Reset streaming state
            self._current_stream_text = ""
            self._streaming_message_id = None
            self._is_streaming = False
            logger.info("🔄 Streaming state reset after force-close")

    def reset(self):
        """Reset the translator state.

        This should be called between different conversation runs
        to ensure clean state.
        """
        self._active_tool_calls.clear()
        self._streaming_message_id = None
        self._is_streaming = False
        self._current_stream_text = ""
        self._last_streamed_text = None
        self._last_streamed_run_id = None
        self.long_running_tool_ids.clear()
        self.lro_emitted_ids_by_name.clear()
        self._emitted_predict_state_for_tools.clear()
        self._emitted_confirm_for_tools.clear()
        self._predictive_state_tool_call_ids.clear()
        self._emitted_signature_tool_call_ids.clear()
        self._deferred_confirm_events.clear()
        # Reset reasoning state
        self._is_reasoning = False
        self._is_streaming_reasoning = False
        self._current_reasoning_text = ""
        self._current_reasoning_message_id = None
        # Reset streaming FC args state
        self._active_streaming_fc_id = None
        self._active_streaming_fc_name = None
        self._streaming_fc_open_paths.clear()
        self._streaming_fc_started_paths.clear()
        self._completed_streaming_fc_names.clear()
        self._last_completed_streaming_fc_name = None
        self._last_completed_streaming_fc_id = None
        self._confirmed_to_streaming_id.clear()
        logger.debug("Reset EventTranslator state (including streaming, thinking, and streaming FC state)")


def _translate_function_calls_to_tool_calls(function_calls: List[Any]) -> List[ToolCall]:
    """Convert ADK function calls to AG-UI ToolCall format.

    Args:
        function_calls: List of ADK function call objects

    Returns:
        List of AG-UI ToolCall objects
    """
    tool_calls = []
    for fc in function_calls:
        tool_call = ToolCall(
            id=fc.id if hasattr(fc, 'id') and fc.id else str(uuid.uuid4()),
            type="function",
            function=FunctionCall(
                name=fc.name,
                arguments=serialize_tool_args(fc.args) if hasattr(fc, 'args') and fc.args else "{}"
            )
        )
        tool_calls.append(tool_call)
    return tool_calls


def _is_thought_part(part: Any) -> bool:
    """Check if a content part is a thought/reasoning part.

    Returns False when the google-genai SDK lacks thought support.
    """
    if not _check_thought_support():
        return False
    thought_value = getattr(part, 'thought', None)
    return thought_value is True


def adk_events_to_messages(events: List[ADKEvent]) -> List[Message]:
    """Convert ADK session events to AG-UI Message list.

    This function extracts complete messages from ADK events, filtering out
    partial/streaming events and converting to the appropriate AG-UI message types.

    Thought parts (Part.thought=True) are separated from regular text and emitted
    as ReasoningMessage objects so the client can render them distinctly instead of
    leaking internal model reasoning into the visible chat history.

    Args:
        events: List of ADK events from a session (session.events)

    Returns:
        List of AG-UI Message objects representing the conversation history
    """
    messages: List[Message] = []

    for event in events:
        # Skip events without content
        if not hasattr(event, 'content') or event.content is None:
            continue

        # Skip partial/streaming events - we only want complete messages
        if hasattr(event, 'partial') and event.partial:
            continue

        content = event.content

        # Skip events without parts
        if not hasattr(content, 'parts') or not content.parts:
            continue

        # Separate thought parts from regular text parts
        text_content = ""
        thinking_content = ""
        for part in content.parts:
            if not hasattr(part, 'text') or not part.text:
                continue
            if _is_thought_part(part):
                thinking_content += part.text
            else:
                text_content += part.text

        # Get function calls and responses
        function_calls = event.get_function_calls() if hasattr(event, 'get_function_calls') else []
        function_responses = event.get_function_responses() if hasattr(event, 'get_function_responses') else []

        # Determine the author/role
        author = getattr(event, 'author', None)
        event_id = getattr(event, 'id', None) or str(uuid.uuid4())

        # Handle function responses as ToolMessages
        if function_responses:
            for fr in function_responses:
                tool_message = ToolMessage(
                    id=str(uuid.uuid4()),
                    role="tool",
                    content=_serialize_tool_response(fr.response) if hasattr(fr, 'response') else "",
                    tool_call_id=fr.id if hasattr(fr, 'id') and fr.id else str(uuid.uuid4())
                )
                messages.append(tool_message)
            continue

        # Skip events with no meaningful content
        if not text_content and not thinking_content and not function_calls:
            continue

        # Handle user messages - exclude thought parts entirely
        if author == "user":
            if not text_content:
                continue
            media_parts = [
                part_obj
                for p in content.parts
                if getattr(p, "file_data", None)
                for part_obj in [_file_data_to_media_part(p.file_data)]
                if part_obj is not None
            ]
            user_content: object = (
                [TextInputContent(text=text_content)] + media_parts
                if media_parts else text_content
            )
            user_message = UserMessage(
                id=event_id,
                role="user",
                content=user_content,
            )
            messages.append(user_message)

        # Handle assistant/model messages
        # Note: ADK agents set author to the agent's name (e.g., "my_agent"),
        # not "model". We treat any non-"user" author as an assistant message.
        else:
            # Emit reasoning as a separate ReasoningMessage before the assistant message
            if thinking_content:
                reasoning_message = ReasoningMessage(
                    id=f"{event_id}-reasoning",
                    role="reasoning",
                    content=thinking_content
                )
                messages.append(reasoning_message)

            # Convert function calls to tool calls if present
            tool_calls = _translate_function_calls_to_tool_calls(function_calls) if function_calls else None

            # Only emit assistant message if there is visible content or tool calls
            if text_content or tool_calls:
                assistant_name = (
                    author
                    if isinstance(author, str) and author != "model"
                    else None
                )
                assistant_message = AssistantMessage(
                    id=event_id,
                    role="assistant",
                    name=assistant_name,
                    content=text_content if text_content else None,
                    tool_calls=tool_calls
                )
                messages.append(assistant_message)

    return messages
