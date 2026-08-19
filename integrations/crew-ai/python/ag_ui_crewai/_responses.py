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

``responses_channel_available()`` answers whether litellm exposes the public
``aresponses`` entrypoint at all, and callers fall back to chat-completions when
it does not. The event vocabulary the stream carries is covered by this package's
declared litellm range, not by a runtime probe of litellm's internals.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from ._capabilities import CAPABILITIES, responses_entrypoint

_LOGGER = logging.getLogger(__name__)

#: Roles a Responses ``input`` message item accepts verbatim.
_INPUT_MESSAGE_ROLES = frozenset({"user", "assistant", "system", "developer"})

#: Roles whose content rides ``input_text`` / ``input_image`` parts. ``assistant``
#: is deliberately absent: see ``_assistant_content_text``.
_INPUT_PART_ROLES = frozenset({"user", "system", "developer"})

#: Prefix OpenAI issues on a Responses reasoning item id. It is the only signal
#: that separates an id OpenAI can resolve from one this process minted: the
#: chat-completions channel carries no provider item id, so the bridge keys those
#: reasoning messages by a uuid4, which has no prefix at all.
_RESPONSES_REASONING_ID_PREFIX = "rs_"


def responses_channel_available() -> bool:
    """Whether the OpenAI Responses streaming channel can be used.

    True when litellm exposes a callable ``aresponses`` entrypoint to open the
    stream. False means callers must stay on chat-completions.
    """
    return CAPABILITIES.responses_api_available


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


def _reasoning_message_to_responses_item(message: Any) -> Optional[dict]:
    """Rebuild one AG-UI reasoning message as an OpenAI Responses item.

    ``None`` when the message did not come from the Responses channel, so the
    caller drops it rather than sending an item OpenAI cannot resolve.
    """
    item_id = _message_field(message, "id")
    if not isinstance(item_id, str) or not item_id.startswith(
        _RESPONSES_REASONING_ID_PREFIX
    ):
        # DEBUG per message, because the WHOLE history is reconverted on every
        # turn: a thread that switched providers once would otherwise re-log the
        # same warning for the same messages for the rest of its life. The caller
        # reports the count once per conversion instead.
        _LOGGER.debug(
            "Dropping reasoning message %r: only reasoning produced by the "
            "Responses channel carries an id OpenAI can resolve, and a reasoning "
            "message off the chat-completions channel (an Anthropic or Gemini "
            "turn) is keyed by a locally minted id instead",
            item_id,
        )
        return None

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


def _reasoning_keeps_its_output(
    items: List[dict], index: int, *, tail_output_dropped: bool
) -> bool:
    """Whether the reasoning item at ``index`` still has the output it produced.

    Consecutive reasoning items share the output that follows them, and reasoning
    that trails the input is normally followed by the output THIS request
    generates. That last allowance holds ONLY while nothing was dropped after it:
    a reasoning item that became trailing BECAUSE its own function_call was
    dropped as unpaired is dangling, not pending, and ``tail_output_dropped`` is
    what tells the two apart. Anything else in that position (an input message, or
    a bare output whose call is gone) leaves the reasoning dangling too.
    """
    for item in items[index + 1 :]:
        if item.get("type") == "reasoning":
            continue
        return item.get("type") == "function_call" or item.get("role") == "assistant"
    return not tail_output_dropped


def _drop_dangling_reasoning(
    items: List[dict], *, tail_output_dropped: bool
) -> List[dict]:
    """Drop reasoning items whose output did not survive conversion.

    Runs after emission because the shape depends on what followed: a call
    dropped as unpaired takes the reasoning that produced it, so the drop that
    protects the request cannot create the very shape it protects against.
    """
    kept: List[dict] = []
    for index, item in enumerate(items):
        if item.get("type") == "reasoning" and not _reasoning_keeps_its_output(
            items, index, tail_output_dropped=tail_output_dropped
        ):
            _LOGGER.warning(
                "Dropping dangling reasoning item %r: the output it produced did "
                "not survive conversion, and the Responses API rejects a reasoning "
                "item that is not followed by its output",
                item.get("id"),
            )
            continue
        kept.append(item)
    return kept


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

    A reasoning message from any OTHER channel is dropped under that same policy.
    Only OpenAI can resolve a Responses reasoning item id, so a thread whose
    earlier turns ran on Anthropic or Gemini would otherwise hard-fail here the
    moment the user switches provider.

    Reasoning items carry the same two guards on top of that. A second item for
    an id already emitted is dropped, and so is a reasoning item whose output did
    not survive: the API requires a reasoning item to be followed by the output
    it produced, so reasoning left in front of the next user message by the
    unpaired-call drop would hard-fail the request that drop exists to protect.
    """
    materialised = list(messages or [])
    paired = _paired_call_ids(materialised)

    dropped_foreign_reasoning = 0
    # Set when an assistant output is dropped, cleared when one survives, so
    # the post-pass can tell reasoning that is PENDING this request's output
    # from reasoning left trailing by a drop.
    tail_output_dropped = False
    emitted_calls: Set[str] = set()
    emitted_outputs: Set[str] = set()
    emitted_reasoning: Set[str] = set()
    items: List[dict] = []
    for message in materialised:
        role = _message_field(message, "role")
        content = _message_field(message, "content")

        if role == "reasoning":
            reasoning_item = _reasoning_message_to_responses_item(message)
            if reasoning_item is None:
                dropped_foreign_reasoning += 1
                continue
            if reasoning_item["id"] in emitted_reasoning:
                _LOGGER.warning(
                    "Dropping a second reasoning item for id %r", reasoning_item["id"]
                )
                continue
            emitted_reasoning.add(reasoning_item["id"])
            items.append(reasoning_item)
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
                tail_output_dropped = True
                _LOGGER.warning("Dropping tool call with no id or name: %r", tool_call)
                continue
            if call_id not in paired:
                tail_output_dropped = True
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
            tail_output_dropped = False
            items.append(
                {
                    "type": "function_call",
                    "call_id": call_id,
                    "name": name,
                    "arguments": arguments,
                }
            )

    if dropped_foreign_reasoning:
        _LOGGER.warning(
            "Dropped %d reasoning message(s) from the Responses input: they were "
            "produced on the chat-completions channel, whose ids OpenAI cannot "
            "resolve. Each one rendered normally when it streamed; only replay is "
            "affected. Enable DEBUG on this logger to see which.",
            dropped_foreign_reasoning,
        )
    return _drop_dangling_reasoning(items, tail_output_dropped=tail_output_dropped)


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
    ``"detailed"``); without one the run succeeds and the reasoning messages that
    surface carry no visible text.

    Continuation has two exclusive shapes. Without ``previous_response_id``,
    AG-UI message history is converted into stateless Responses input (including
    replayable reasoning items). With ``previous_response_id``, callers must pass
    explicit new ``input``; converted history is not sent, and including a
    reasoning item in that explicit input is rejected as duplicate continuation.

    Raises ``RuntimeError`` when the installed litellm exposes no ``aresponses``
    entrypoint. Probe ``responses_channel_available()`` first when the caller
    wants to degrade to chat-completions instead; refusing here is what keeps
    such a build from failing mid-turn, after the client has already seen part of
    an answer.
    """
    entrypoint = responses_entrypoint()
    if entrypoint is None:
        raise RuntimeError(
            "The OpenAI Responses channel is unavailable: the installed litellm "
            "exposes no 'aresponses' entrypoint. Upgrade litellm, or call "
            "litellm.acompletion instead (chat-completions carries no OpenAI "
            "reasoning summaries)."
        )

    if reasoning is not None and not reasoning.get("summary"):
        _LOGGER.warning(
            "reasoning=%r has no 'summary': OpenAI streams reasoning summaries "
            "only when one is requested, so the reasoning messages that surface "
            "will carry no visible text.",
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
