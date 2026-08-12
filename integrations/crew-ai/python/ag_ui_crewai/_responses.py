"""OpenAI Responses-API streaming channel for the CrewAI AG-UI bridge.

``copilotkit_stream`` streams litellm chat-completions, which carries no
reasoning content for OpenAI's reasoning models: OpenAI exposes reasoning
summaries ONLY through the Responses API. ``copilotkit_responses`` opens that
stream instead, and ``copilotkit_stream`` consumes it through the same
``Bridged*`` emission path, so REASONING_* / TEXT_MESSAGE_CHUNK /
TOOL_CALL_CHUNK reach BOTH transports (legacy bus listener and StreamFrame)
unchanged.

This module owns the two pure conversions the channel needs, plus the
entrypoint:

* ``chat_messages_to_responses_input`` -- flow-state messages (chat-completions
  shape: ``role`` / ``content`` / ``tool_calls`` / ``tool_call_id``) onto
  Responses ``input`` items (``function_call`` / ``function_call_output``).
* ``chat_tools_to_responses_tools`` -- nested ``{"type": "function",
  "function": {...}}`` tool specs onto the Responses flat shape.

Availability is a pair of RUNTIME CAPABILITY PROBES, never a litellm version or
model-name comparison: ``responses_channel_available()`` answers whether the
channel can be used at all (see its docstring for the two probes), and callers
fall back to chat-completions when it cannot.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, AsyncIterator, Dict, Iterable, List, Optional, Set, Tuple

from pydantic import ValidationError

from ._capabilities import (
    CAPABILITIES,
    ResponsesAPIStreamingIteratorBase,
    responses_entrypoint,
    responses_event_modelling,
)
from ._responses_events import event_role, is_load_bearing

_LOGGER = logging.getLogger(__name__)

# Cap on events skipped for being unparseable in one stream. Past this the stream
# is not "one odd event that costs nothing" but something systemically wrong, and
# reporting it beats silently returning an empty message.
_MAX_SKIPPED_EVENTS = 50

#: Roles a Responses ``input`` message item accepts verbatim.
_INPUT_MESSAGE_ROLES = frozenset({"user", "assistant", "system", "developer"})

#: litellm 1.63-1.67 raise ``ValueError("Unknown event type: <type>")`` from their
#: event-type lookup for a type they have no model for (newer builds answer with
#: their extras-allowing catch-all model instead). Matched case-insensitively on
#: the ORIGINAL message so the captured type is the one litellm wrote, and
#: anchored on the colon so a message that names no type does not read as one.
_UNKNOWN_EVENT_TYPE_RE = re.compile(r"unknown event type\s*:\s*(\S+)", re.IGNORECASE)
_UNKNOWN_EVENT_TYPE_MARKER_RE = re.compile(r"unknown event type", re.IGNORECASE)

# What to do with a per-event parse failure.
#: This event costs nothing this bridge maps: log it and keep reading.
_SKIP = "skip"
#: This event carried content or the stream's outcome: report it.
_SURFACE = "surface"
#: The event cannot be identified at all, so it cannot be shown harmless.
_UNATTRIBUTABLE = "unattributable"
#: This litellm build has no model for an event type the bridge must read, which
#: is a property of the BUILD rather than of this event.
_UNREADABLE_TYPE = "unreadable_type"
#: Not litellm's event parsing at all: leave it alone.
_PROPAGATE = "propagate"


def _classify_parse_failure(exc: ValueError) -> Tuple[str, str]:
    """Decide the fate of one event that failed to parse, and name what failed.

    Parsing is what failed, so there is no event object to read a ``type`` off.
    Two signals remain, and each is turned into that event's ROLE for this bridge
    (``_responses_events.EVENT_ROLES``) instead of being judged against a list of
    types or model names maintained here:

    * ``pydantic.ValidationError`` -- litellm had a model for the type and could
      not build it. ``title`` is that model's name, and litellm's OWN event-type
      to model registry maps it back onto a role
      (``ResponsesEventModelling.model_roles``). A load-bearing role surfaces; a
      role whose loss costs nothing this bridge maps is skipped; a model that
      registry does not attribute to any type this bridge reads means nothing
      this bridge maps was lost, so it is skipped too. When the registry could
      not be resolved at all, nothing can be attributed and the failure is
      reported rather than assumed harmless.
    * a plain ``ValueError`` carrying litellm's "Unknown event type: <type>"
      lookup failure -- the type is in the message. A type this bridge never
      reads costs nothing to skip. A type it reads means THIS BUILD cannot read
      this channel: reported as the build fact it is, not as a corrupt event.
      A message that names no type cannot be judged either way.

    Anything else that merely happens to be a ``ValueError`` is not litellm's
    event parsing (``json.JSONDecodeError`` from a truncated SSE frame is a
    ``ValueError`` too) and propagates untouched.

    Returns ``(disposition, subject)``, where ``subject`` names the model or the
    event type for the log line or the error message.
    """
    if isinstance(exc, ValidationError):
        modelling = responses_event_modelling()
        role = modelling.model_roles.get(exc.title)
        if role is None:
            if not modelling.resolver_available:
                return _UNATTRIBUTABLE, exc.title
            return _SKIP, exc.title
        return (_SURFACE if is_load_bearing(role) else _SKIP), exc.title

    message = str(exc)
    match = _UNKNOWN_EVENT_TYPE_RE.search(message)
    if match is None:
        if _UNKNOWN_EVENT_TYPE_MARKER_RE.search(message):
            # litellm's lookup failure with no type in it: nothing identifies
            # the event, so it cannot be shown harmless to drop.
            return _UNATTRIBUTABLE, message
        return _PROPAGATE, message
    # Strip quotes/punctuation a future litellm might wrap the type in
    # (``Unknown event type: 'response.output_text.delta'``): only the ends are
    # stripped, so the dotted type survives, and a load-bearing type is still
    # recognised instead of silently downgraded to a harmless skip.
    event_type = match.group(1).strip("\"'`.,;:!?()[]{}<>")
    role = event_role(event_type)
    if role is None:
        return _SKIP, event_type
    if is_load_bearing(role):
        return _UNREADABLE_TYPE, event_type
    # One reasoning-summary delta costs a gap in the visible trace but leaves
    # the replay item and answer intact. Builds that cannot model the reasoning
    # channel at all are declared unavailable by the capability probe.
    return _SKIP, event_type


#: Roles whose content rides ``input_text`` / ``input_image`` parts. ``assistant``
#: is deliberately absent: see ``_assistant_content_text``.
_INPUT_PART_ROLES = frozenset({"user", "system", "developer"})


def responses_channel_available() -> bool:
    """Whether the OpenAI Responses streaming channel can be used.

    Two runtime capability probes, never a litellm version compare and never a
    model-name branch:

    * litellm exposes a callable ``aresponses`` entrypoint to open the stream, and
    * litellm can MODEL every Responses event type this bridge must read. litellm
      1.63-1.67 (inside this package's declared ``litellm>=1.60.2`` floor) raise
      ``ValueError("Unknown event type: <type>")`` for a type they have no model
      for, and on those builds the reasoning-summary deltas this bridge must read
      are exactly those types (the answer text delta still models). Reasoning is a
      REQUIRED role, so the channel reports unavailable there and callers degrade
      to chat-completions -- which still carries the text -- rather than failing
      once per turn on a reasoning trace we advertised as working.

    False means callers must stay on chat-completions.
    """
    return CAPABILITIES.responses_api_available


def is_responses_stream(response: Any) -> bool:
    """Whether ``response`` is an ASYNC litellm Responses-API streaming iterator.

    Async-iterability is checked FIRST, for both branches. litellm's
    ``SyncResponsesAPIStreamingIterator`` subclasses the very same
    ``BaseResponsesAPIStreamingIterator`` the async iterator does, so an
    isinstance-only branch would accept a sync stream that the async driver
    (``iter_responses_events`` calls ``__aiter__``) cannot consume. Requiring
    ``__aiter__`` up front also keeps this branch and the duck-typed one from
    disagreeing about what qualifies.

    Past that gate: an isinstance check against the resolved base class, falling
    back to duck-typing (the iterator's own ``_process_chunk``) so a litellm that
    relocates the class still works.
    """
    if not hasattr(response, "__aiter__"):
        return False
    base = ResponsesAPIStreamingIteratorBase
    if base is not None and isinstance(response, base):
        return True
    return hasattr(response, "_process_chunk")


def is_sync_responses_stream(response: Any) -> bool:
    """Whether ``response`` is a SYNCHRONOUS Responses-API streaming iterator.

    The exact complement of ``is_responses_stream`` over Responses iterators:
    something recognisably a Responses stream that has no ``__aiter__``. Kept as
    its own predicate so a caller who reached for the sync entrypoint gets told
    which entrypoint to use instead of a generic "unsupported type".

    Same two branches, same async-iterability gate first, so the two predicates
    cannot both answer True.
    """
    if hasattr(response, "__aiter__"):
        return False
    base = ResponsesAPIStreamingIteratorBase
    if base is not None and isinstance(response, base):
        return True
    return hasattr(response, "__iter__") and hasattr(response, "_process_chunk")


async def iter_responses_events(response: Any) -> AsyncIterator[Any]:
    """Yield Responses stream events, skipping one that costs nothing to lose.

    litellm validates each event against its own typed models, so a single event
    can fail to parse and raise straight out of ``__anext__``, which would void
    the whole turn: no reasoning, no answer, just a RUN_ERROR. Whether that is
    the right outcome depends entirely on WHICH event it was, so each failure is
    attributed to the role that event plays for this bridge
    (``_responses_events``) and:

    * an event whose loss costs nothing this bridge maps is SKIPPED with a
      warning: stream bookkeeping (``response.created`` /
      ``response.in_progress``, whose fields all have fallbacks), one
      reasoning-summary delta (a gap in a trace, with replay identity, the answer,
      and the outcome intact), and any event of a type this bridge never reads.
    * an event carrying reasoning continuation state, answer text, a tool call's
      identity or arguments, or the stream's outcome is REPORTED as a
      ``RuntimeError`` the drivers' exception taxonomy surfaces. Dropping one
      loses replayability/content or turns a failed stream into an empty assistant
      message with no failure recorded.
    * a failure that cannot be attributed to any event is reported too: it cannot
      be shown harmless, so it is not assumed to be.
    * litellm having NO model for a type this bridge must read is reported as the
      BUILD fact it is (the channel cannot be read on this build), not as a
      corrupt event. ``responses_channel_available()`` reports such a build
      unavailable, so callers that probe it degrade to chat-completions instead
      of reaching here at all.

    Transport failures, cancellation and any other non-parse error propagate
    untouched.

    EVERY skip counts against ``_MAX_SKIPPED_EVENTS``, so a stream that is
    unreadable end to end raises rather than quietly yielding an empty turn.
    """
    iterator = response.__aiter__()
    skipped = 0
    while True:
        try:
            event = await iterator.__anext__()
        except StopAsyncIteration:
            return
        except ValueError as exc:
            # Both litellm parse failures are ValueErrors: pydantic's
            # ValidationError subclasses it, and the unknown-event-type lookup
            # raises it directly. Transport errors (httpx, ConnectionError) and
            # asyncio.CancelledError are not ValueErrors and never land here.
            disposition, subject = _classify_parse_failure(exc)
            if disposition == _PROPAGATE:
                raise
            if disposition == _UNREADABLE_TYPE:
                raise RuntimeError(
                    "The installed litellm has no model for the OpenAI Responses "
                    f"stream event type {subject!r}, which this bridge reads for "
                    "reasoning continuation, answer text, tool-call arguments or "
                    "the stream's outcome, so this stream cannot be read on this "
                    "build. Probe "
                    "responses_channel_available() and stream over "
                    "chat-completions instead, or upgrade litellm."
                ) from exc
            if disposition == _SURFACE:
                raise RuntimeError(
                    "An OpenAI Responses stream event this bridge reads for "
                    "reasoning continuation, answer text, tool-call arguments or "
                    f"the stream's outcome failed to parse ({subject}); skipping "
                    "it would drop replay state, content or the stream's outcome "
                    "in silence"
                ) from exc
            if disposition == _UNATTRIBUTABLE:
                raise RuntimeError(
                    f"An OpenAI Responses stream event failed to parse ({subject}) "
                    "and nothing identifies which event it was, so it cannot be "
                    "shown harmless to skip: dropping one that carried reasoning "
                    "continuation, answer text, tool-call arguments or the "
                    "stream's outcome would lose it in silence"
                ) from exc
            skipped += 1
            if skipped > _MAX_SKIPPED_EVENTS:
                raise RuntimeError(
                    f"OpenAI Responses stream is unreadable: more than "
                    f"{_MAX_SKIPPED_EVENTS} events failed to parse"
                ) from exc
            _LOGGER.warning(
                "Skipping an unparseable Responses stream event (%s, %d so far): "
                "it carries nothing this bridge maps. %s",
                subject,
                skipped,
                exc,
            )
            continue
        if event is not None:
            yield event


def chat_tools_to_responses_tools(tools: Optional[Iterable[Any]]) -> Optional[List[dict]]:
    """Flatten chat-completions tool specs onto the Responses tool shape.

    Chat-completions nests the schema under ``function``; Responses puts
    ``name`` / ``description`` / ``parameters`` at the top level. A spec already
    in the flat shape passes through, so a caller may mix both.
    """
    if not tools:
        return None

    flattened: List[dict] = []
    for tool in tools:
        if not isinstance(tool, dict):
            _LOGGER.warning("Skipping non-dict tool spec of type %r", type(tool).__name__)
            continue
        function = tool.get("function")
        if not isinstance(function, dict):
            if function is not None:
                _LOGGER.warning(
                    "Tool spec has a non-dict 'function' (%s); passing it through "
                    "unflattened: %r",
                    type(function).__name__,
                    tool,
                )
            # Already flat (or a built-in Responses tool such as web_search).
            flattened.append(tool)
            continue
        name = function.get("name")
        if not name:
            _LOGGER.warning("Skipping tool spec with no function name: %r", tool)
            continue
        flattened.append(
            {
                "type": "function",
                "name": name,
                "description": function.get("description") or "",
                "parameters": function.get("parameters")
                or {"type": "object", "properties": {}},
                # Responses defaults ``strict`` to True, which rejects schemas
                # the chat-completions shape happily accepts (no
                # additionalProperties:false, optional keys). Opt out so a tool
                # spec written for chat-completions keeps working verbatim.
                "strict": False,
            }
        )
    return flattened or None


def _message_field(message: Any, key: str) -> Any:
    """Read ``key`` off a message that may be a dict or an object."""
    if isinstance(message, dict):
        return message.get(key)
    return getattr(message, key, None)


def _as_json_text(value: Any, *, what: str) -> str:
    """Serialise a non-string value as the JSON text a Responses field carries.

    ``str()`` would hand the model a Python repr (single quotes, ``None`` /
    ``True``) that no JSON parser accepts, the hazard the
    ``backend_tool_rendering`` example documents for crewai tool returns. Values
    JSON cannot express fall back to ``str()``, and that fallback is logged where
    it happens rather than travelling silently.
    """
    try:
        return json.dumps(value, default=str)
    except (TypeError, ValueError) as exc:
        _LOGGER.warning(
            "Falling back to str() for %s: it is not JSON-serialisable (%s)", what, exc
        )
        return str(value)


def _content_parts_to_responses(content: List[Any]) -> List[dict]:
    """Convert multimodal content blocks onto Responses input parts.

    Only for the roles in ``_INPUT_PART_ROLES``: an assistant message takes
    ``_assistant_content_text`` instead.
    """
    parts: List[dict] = []
    for item in content:
        if not isinstance(item, dict):
            _LOGGER.warning(
                "Dropping non-dict content part of type %r", type(item).__name__
            )
            continue
        item_type = item.get("type")
        if item_type == "text":
            text = item.get("text", "")
            if not isinstance(text, str):
                _LOGGER.warning(
                    "Serialising non-string text content part (%s)", type(text).__name__
                )
                text = _as_json_text(text, what="a text content part")
            parts.append({"type": "input_text", "text": text})
        elif item_type == "image_url":
            image_url = item.get("image_url")
            url = image_url.get("url") if isinstance(image_url, dict) else image_url
            if isinstance(url, str) and url:
                # ``detail`` is required on a Responses input-image part; "auto"
                # is the value the API defaults to, so carrying it changes
                # nothing about what the model sees.
                parts.append(
                    {"type": "input_image", "image_url": url, "detail": "auto"}
                )
            else:
                _LOGGER.warning("Dropping image_url part with no url")
        else:
            _LOGGER.warning(
                "Dropping content part the Responses input does not carry: %r",
                item_type,
            )
    return parts


def _assistant_content_text(content: List[Any]) -> str:
    """Collapse assistant content blocks onto the string content an item takes.

    An assistant message in the Responses ``input`` cannot carry ``input_*``
    parts: the only assistant content parts that exist are ``output_text`` and
    ``refusal``, and those live on an output-message item keyed by a real
    message id this bridge does not have. Its string content is accepted
    verbatim, so text parts are joined and anything with no assistant
    representation (an image, a file) is dropped with a log.
    """
    texts: List[str] = []
    for item in content:
        if not isinstance(item, dict):
            _LOGGER.warning(
                "Dropping non-dict assistant content part of type %r",
                type(item).__name__,
            )
            continue
        if item.get("type") == "text":
            text = item.get("text", "")
            if not isinstance(text, str):
                _LOGGER.warning(
                    "Serialising non-string assistant text content part (%s)",
                    type(text).__name__,
                )
                text = _as_json_text(text, what="an assistant text content part")
            if text:
                texts.append(text)
        else:
            _LOGGER.warning(
                "Dropping assistant content part %r: an assistant message in the "
                "Responses input carries text only (an image or file part has no "
                "assistant shape)",
                item.get("type"),
            )
    return "\n".join(texts)


def _tool_call_identity(tool_call: Any) -> Tuple[Optional[str], Optional[str]]:
    """Project one chat-completions tool call onto ``(id, name)``, logging nothing.

    Pairing calls with outputs needs the identity of every call before anything
    is emitted, and the emission pass logs what it drops; keeping this pass
    quiet stops every decision being reported twice.
    """
    call_id = _message_field(tool_call, "id")
    function = _message_field(tool_call, "function")
    name = _message_field(function, "name") if function is not None else None
    return call_id, name


def _tool_call_fields(tool_call: Any) -> Tuple[Optional[str], Optional[str], str]:
    """Project one chat-completions tool call onto ``(id, name, arguments)``.

    Responses takes ``arguments`` as a JSON STRING. Some providers hand back a
    dict instead, so a non-string is serialised: emptying it would leave a call
    the model is told it made with no arguments at all.
    """
    call_id, name = _tool_call_identity(tool_call)
    function = _message_field(tool_call, "function")
    arguments = _message_field(function, "arguments") if function is not None else None

    if isinstance(arguments, str):
        return call_id, name, arguments
    if arguments is None:
        # No arguments at all: "{}" is the empty JSON object the API expects,
        # where "" is not valid JSON.
        return call_id, name, "{}"
    _LOGGER.warning(
        "Serialising non-string arguments (%s) on tool call %r: the Responses API "
        "takes arguments as a JSON string",
        type(arguments).__name__,
        call_id,
    )
    return call_id, name, _as_json_text(arguments, what=f"arguments of call {call_id!r}")


def _tool_calls_of(message: Any, *, warn: bool = True) -> List[Any]:
    """The tool calls on ``message`` as a list, logging a shape that is not one.

    ``warn=False`` for the pairing pass, which walks the same messages the
    emission pass does and would otherwise report every drop twice.
    """
    tool_calls = _message_field(message, "tool_calls")
    if not tool_calls:
        return []
    if isinstance(tool_calls, (list, tuple)):
        return list(tool_calls)
    if warn:
        _LOGGER.warning(
            "Dropping tool_calls of unexpected type %r", type(tool_calls).__name__
        )
    return []


def _paired_call_ids(messages: List[Any]) -> Set[str]:
    """Call ids that have BOTH an emittable ``function_call`` and an output.

    Emittable means the call carries an id and a name and sits on a message
    whose role survives conversion: a call dropped for any of those reasons
    takes its output with it, so the drop that protects the request cannot
    create the very shape it protects against.
    """
    called: Set[str] = set()
    answered: Set[str] = set()
    for message in messages:
        role = _message_field(message, "role")
        if role == "tool":
            call_id = _message_field(message, "tool_call_id")
            if call_id:
                answered.add(call_id)
            continue
        if role not in _INPUT_MESSAGE_ROLES:
            continue
        for tool_call in _tool_calls_of(message, warn=False):
            call_id, name = _tool_call_identity(tool_call)
            if call_id and name:
                called.add(call_id)
    return called & answered


def _reasoning_message_to_responses_item(message: Any) -> dict:
    """Rebuild one AG-UI reasoning message as an OpenAI Responses item."""
    item_id = _message_field(message, "id")
    if not isinstance(item_id, str) or not item_id:
        raise ValueError(
            "A reasoning message requires its OpenAI provider item id for replay"
        )

    content = _message_field(message, "content")
    if content is None or content == "":
        summary: List[dict] = []
    elif isinstance(content, str):
        summary = [{"type": "summary_text", "text": content}]
    else:
        raise ValueError("A reasoning message summary must be a string")

    item = {
        "id": item_id,
        "type": "reasoning",
        "summary": summary,
    }
    encrypted = _message_field(message, "encrypted_value")
    if encrypted is None:
        encrypted = _message_field(message, "encryptedValue")
    if encrypted is not None:
        if not isinstance(encrypted, str):
            raise ValueError("A reasoning message encrypted value must be a string")
        item["encrypted_content"] = encrypted
    return item


def _input_replays_reasoning(input_value: Any) -> bool:
    """Whether explicit top-level Responses input contains reasoning history.

    Strings are valid new input, and an arbitrary iterable may be one-shot, so
    inspect only concrete list/tuple input without consuming or rewriting it.
    """
    if not isinstance(input_value, (list, tuple)):
        return False
    return any(_message_field(item, "type") == "reasoning" for item in input_value)


def chat_messages_to_responses_input(messages: Iterable[Any]) -> List[dict]:
    """Convert chat-completions messages onto Responses ``input`` items.

    Message content rides an input message item; an AG-UI ``reasoning`` message
    becomes the replayable Responses reasoning item; an assistant tool call
    becomes a ``function_call`` item keyed by ``call_id``; and a ``tool``
    message becomes the matching ``function_call_output``.

    Calls and outputs are only emitted IN PAIRS. The Responses API rejects the
    whole request over a call with no output AND over an output with no call, so
    an unmatched item of either kind is dropped: a conversation the user
    abandoned mid-tool-call, or a tool result whose call never made it into
    state, would otherwise hard-fail every later turn. A duplicate of either
    kind is dropped for the same reason.
    """
    materialised = list(messages or [])
    paired = _paired_call_ids(materialised)

    emitted_calls: Set[str] = set()
    emitted_outputs: Set[str] = set()
    items: List[dict] = []
    for message in materialised:
        role = _message_field(message, "role")
        content = _message_field(message, "content")

        if role == "reasoning":
            items.append(_reasoning_message_to_responses_item(message))
            continue

        if role == "tool":
            call_id = _message_field(message, "tool_call_id")
            if not call_id:
                _LOGGER.warning("Dropping tool message with no tool_call_id")
                continue
            if call_id not in paired:
                _LOGGER.warning(
                    "Dropping unpaired function_call_output %r: the Responses API "
                    "rejects an output with no matching call",
                    call_id,
                )
                continue
            if call_id in emitted_outputs:
                _LOGGER.warning(
                    "Dropping a second function_call_output for call %r", call_id
                )
                continue
            emitted_outputs.add(call_id)
            if isinstance(content, str):
                output = content
            elif content is None:
                output = ""
            else:
                output = _as_json_text(content, what=f"output of call {call_id!r}")
            items.append(
                {
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": output,
                }
            )
            continue

        if role not in _INPUT_MESSAGE_ROLES:
            _LOGGER.warning("Dropping message with unsupported role %r", role)
            continue

        if isinstance(content, list):
            if role in _INPUT_PART_ROLES:
                parts = _content_parts_to_responses(content)
                if parts:
                    items.append({"role": role, "content": parts})
                elif content:
                    _LOGGER.warning(
                        "Dropping %s message: no content part survived conversion", role
                    )
            else:
                text = _assistant_content_text(content)
                if text:
                    items.append({"role": role, "content": text})
                elif content:
                    _LOGGER.warning(
                        "Dropping %s message: no content part survived conversion", role
                    )
        elif isinstance(content, str):
            if content:
                items.append({"role": role, "content": content})
        elif content is not None:
            _LOGGER.warning(
                "Serialising %s content of unexpected type %r",
                role,
                type(content).__name__,
            )
            items.append(
                {
                    "role": role,
                    "content": _as_json_text(content, what=f"{role} message content"),
                }
            )

        for tool_call in _tool_calls_of(message):
            call_id, name, arguments = _tool_call_fields(tool_call)
            if not call_id or not name:
                _LOGGER.warning("Dropping tool call with no id or name: %r", tool_call)
                continue
            if call_id not in paired:
                _LOGGER.warning(
                    "Dropping unresolved function_call %r (%s): the Responses API "
                    "rejects a call with no matching output",
                    call_id,
                    name,
                )
                continue
            if call_id in emitted_calls:
                _LOGGER.warning("Dropping a second function_call for call %r", call_id)
                continue
            emitted_calls.add(call_id)
            items.append(
                {
                    "type": "function_call",
                    "call_id": call_id,
                    "name": name,
                    "arguments": arguments,
                }
            )

    return items


async def copilotkit_responses(
    *,
    model: str,
    messages: Iterable[Any],
    tools: Optional[Iterable[Any]] = None,
    reasoning: Optional[Dict[str, Any]] = None,
    **kwargs: Any,
):
    """Open a streaming OpenAI Responses-API call, ready for ``copilotkit_stream``.

    Takes the SAME message and tool shapes a flow already passes to
    ``litellm.acompletion`` and converts them, so switching a node onto this
    channel is a one-line change:

    ```python
    response = await copilotkit_stream(
        await copilotkit_responses(
            model="openai/gpt-5.4",
            messages=[{"role": "system", "content": prompt}, *state.messages],
            tools=tools,
            reasoning={"effort": "medium", "summary": "auto"},
        )
    )
    ```

    ``reasoning`` is passed through untouched. OpenAI streams reasoning summaries
    only when it carries a ``summary`` (``"auto"`` / ``"concise"`` /
    ``"detailed"``); without one the run succeeds but has no trace to surface.

    Continuation has two exclusive shapes. Without ``previous_response_id``,
    AG-UI message history is converted into stateless Responses input (including
    replayable reasoning items). With ``previous_response_id``, callers must pass
    explicit new ``input``; converted history is not sent, and including a
    reasoning item in that explicit input is rejected as duplicate continuation.

    Raises ``RuntimeError`` when the channel is unavailable, naming which of the
    two probes failed: litellm exposes no ``aresponses`` entrypoint, or it cannot
    model event types this bridge must read. Probe
    ``responses_channel_available()`` first when the caller wants to degrade to
    chat-completions instead; refusing here is what keeps such a build from
    failing mid-turn, after the client has already seen part of an answer.
    """
    entrypoint = responses_entrypoint()
    if entrypoint is None:
        raise RuntimeError(
            "The OpenAI Responses channel is unavailable: the installed litellm "
            "exposes no 'aresponses' entrypoint. Upgrade litellm, or call "
            "litellm.acompletion instead (chat-completions carries no OpenAI "
            "reasoning summaries)."
        )

    unmodellable = responses_event_modelling().unmodellable_event_types
    if unmodellable:
        raise RuntimeError(
            "The OpenAI Responses channel is unavailable: the installed litellm "
            "has no model for these stream event types ("
            f"{', '.join(unmodellable)}) and raises on them, so the reasoning "
            "summaries, continuation items and answer deltas this channel exists "
            "to read cannot be parsed at all. Upgrade litellm, or call "
            "litellm.acompletion instead "
            "(chat-completions carries no OpenAI reasoning summaries)."
        )

    if reasoning is not None and not reasoning.get("summary"):
        _LOGGER.warning(
            "reasoning=%r has no 'summary': OpenAI streams reasoning summaries "
            "only when one is requested, so no REASONING_* events will surface.",
            reasoning,
        )

    raw_input_provided = "input" in kwargs
    raw_input = kwargs.pop("input", None)
    previous_response_id = kwargs.get("previous_response_id")
    if previous_response_id is not None:
        if not raw_input_provided:
            raise ValueError(
                "previous_response_id requires explicit new Responses input"
            )
        if _input_replays_reasoning(raw_input):
            raise ValueError(
                "previous_response_id cannot be combined with replayed reasoning "
                "items in explicit input"
            )
        responses_input = raw_input
    else:
        responses_input = (
            raw_input
            if raw_input_provided
            else chat_messages_to_responses_input(messages)
        )

    call_kwargs: Dict[str, Any] = {
        "model": model,
        "input": responses_input,
        "stream": True,
    }
    responses_tools = chat_tools_to_responses_tools(tools)
    if responses_tools:
        call_kwargs["tools"] = responses_tools
    if reasoning is not None:
        call_kwargs["reasoning"] = reasoning
    call_kwargs.update(kwargs)

    return await entrypoint(**call_kwargs)
