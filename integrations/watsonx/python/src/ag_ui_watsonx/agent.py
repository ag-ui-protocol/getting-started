"""Translates between IBM watsonx orchestrate SSE and AG-UI events."""

from typing import Any, AsyncGenerator, List, Protocol
import asyncio
import inspect
import logging
import time
import uuid
import json

import httpx

from ag_ui.core import (
    AssistantMessage,
    EventType,
    FunctionCall,
    MessagesSnapshotEvent,
    RawEvent,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
    StepFinishedEvent,
    StepStartedEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCall,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
    ToolMessage as AGUIToolMessage,
)

logger = logging.getLogger(__name__)

_IAM_TOKEN_URL = "https://iam.cloud.ibm.com/identity/token"


class ThreadIdStore(Protocol):
    """Persistence for the mapping of AG-UI thread_id to the watsonx-managed
    thread_id. ``get``/``set`` may be sync or async."""

    def get(self, thread_id: str) -> Any: ...

    def set(self, thread_id: str, watsonx_thread_id: str) -> Any: ...


class InMemoryThreadIdStore:
    """Default store; sufficient when the agent instance lives as long as the
    conversation. Provide a custom store (e.g. database-backed) when agent
    instances are created per-request on a server."""

    def __init__(self) -> None:
        self._threads: dict[str, str] = {}

    def get(self, thread_id: str) -> str | None:
        return self._threads.get(thread_id)

    def set(self, thread_id: str, watsonx_thread_id: str) -> None:
        self._threads[thread_id] = watsonx_thread_id


async def _maybe_await(value):
    if inspect.isawaitable(value):
        return await value
    return value


def _messages_since_last_user(messages: list) -> list:
    """When continuing a watsonx-managed thread, only the messages from the
    last user message onward are new to the server (earlier context lives in
    the thread). Keeps trailing assistant/tool messages so tool results still
    reach watsonx."""
    for i in range(len(messages) - 1, -1, -1):
        if messages[i].role == "user":
            return messages[i:]
    return messages


class WatsonxAgent:
    def __init__(
        self,
        *,
        region: str,
        instance_id: str,
        agent_id: str,
        api_key: str | None = None,
        bearer_token: str | None = None,
        name: str = "watsonx",
        thread_id_store: ThreadIdStore | None = None,
    ):
        if not api_key and not bearer_token:
            raise ValueError(
                "WatsonxAgent requires either api_key or bearer_token"
            )
        self.region = region
        self.instance_id = instance_id
        self.agent_id = agent_id
        self.api_key = api_key
        self._cached_token = bearer_token
        self._token_expires_at = time.time() + 55 * 60 if bearer_token else 0
        self.name = name
        self._token_lock = asyncio.Lock()
        self._thread_id_store: ThreadIdStore = thread_id_store or InMemoryThreadIdStore()

    def clone(self):
        """Create a new WatsonxAgent with the same config but fresh state.

        Does not use copy.deepcopy because asyncio.Lock cannot be deepcopied.
        """
        cloned = WatsonxAgent(
            region=self.region,
            instance_id=self.instance_id,
            agent_id=self.agent_id,
            api_key=self.api_key,
            bearer_token=self._cached_token,
            name=self.name,
            # Share the store so the clone continues existing watsonx threads.
            thread_id_store=self._thread_id_store,
        )
        cloned._token_expires_at = self._token_expires_at
        return cloned

    @property
    def base_url(self) -> str:
        return f"https://api.{self.region}.watson-orchestrate.cloud.ibm.com/instances/{self.instance_id}"

    async def _get_token(self) -> str:
        if self._cached_token and time.time() < self._token_expires_at:
            return self._cached_token

        async with self._token_lock:
            # Double-check after acquiring lock
            if self._cached_token and time.time() < self._token_expires_at:
                return self._cached_token

            if not self.api_key:
                raise RuntimeError(
                    "watsonx: bearer token expired and no api_key provided for refresh"
                )

            async with httpx.AsyncClient(timeout=30) as client:
                try:
                    resp = await client.post(
                        _IAM_TOKEN_URL,
                        data={
                            "grant_type": "urn:ibm:params:oauth:grant-type:apikey",
                            "apikey": self.api_key,
                        },
                    )
                    resp.raise_for_status()
                except httpx.HTTPStatusError as e:
                    raise RuntimeError(f"IAM token exchange failed: HTTP {e.response.status_code}") from None
                data = resp.json()

            self._cached_token = data["access_token"]
            self._token_expires_at = data["expiration"] - 60
            return self._cached_token

    async def run(self, input_data: RunAgentInput) -> AsyncGenerator:
        thread_id = input_data.thread_id
        run_id = input_data.run_id

        yield RunStartedEvent(type=EventType.RUN_STARTED, thread_id=thread_id, run_id=run_id)

        # Emit TOOL_CALL_RESULT for any tool messages in the input (matches langgraph pattern)
        for msg in input_data.messages:
            if hasattr(msg, "tool_call_id") and getattr(msg, "tool_call_id", None) and msg.role == "tool":
                content = msg.content if isinstance(msg.content, str) else json.dumps(msg.content)
                yield ToolCallResultEvent(
                    type=EventType.TOOL_CALL_RESULT,
                    tool_call_id=msg.tool_call_id,
                    message_id=getattr(msg, "id", str(uuid.uuid4())),
                    content=content,
                    role="tool",
                )

        # watsonx orchestrate manages conversation state server-side, keyed by
        # a thread_id it issues in the SSE stream. It ignores client-invented
        # IDs (creating a fresh thread instead) and only acts on the last user
        # message in the payload. So: reuse the watsonx thread_id captured
        # from a previous run of this AG-UI thread, and when continuing, send
        # only the messages since the last user message.
        watsonx_thread_id = await _maybe_await(self._thread_id_store.get(thread_id))
        request_messages = (
            _messages_since_last_user(input_data.messages)
            if watsonx_thread_id
            else input_data.messages
        )

        messages = []
        for msg in request_messages:
            content = msg.content if isinstance(msg.content, str) else json.dumps(msg.content)
            entry: dict = {"role": msg.role, "content": content}
            if hasattr(msg, "tool_call_id") and msg.tool_call_id:
                entry["tool_call_id"] = msg.tool_call_id
            if hasattr(msg, "tool_calls") and msg.tool_calls:
                entry["tool_calls"] = [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {"name": tc.function.name, "arguments": tc.function.arguments or ""},
                    }
                    for tc in msg.tool_calls
                ]
            messages.append(entry)

        msg_id: str | None = None
        msg_started = False
        active_tool_calls: dict[int, dict] = {}
        # Accumulate streamed content and tool calls for MESSAGES_SNAPSHOT
        accumulated_text = ""
        accumulated_tool_calls: list[dict] = []

        step_name = "watsonx_chat"

        try:
            token = await self._get_token()

            body: dict = {}
            if input_data.forwarded_props:
                body.update(input_data.forwarded_props)
            body["messages"] = messages
            body["stream"] = True
            if input_data.tools:
                body["tools"] = [
                    {
                        "type": "function",
                        "function": {
                            "name": t.name,
                            "description": t.description or "",
                            "parameters": t.parameters if t.parameters is not None else {},
                        },
                    }
                    for t in input_data.tools
                ]

            # STEP_STARTED wraps the watsonx API call
            yield StepStartedEvent(type=EventType.STEP_STARTED, step_name=step_name)

            # On the first turn the header is omitted so watsonx creates the
            # thread; its thread_id is captured from the stream and reused on
            # later turns.
            headers = {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            }
            if watsonx_thread_id:
                headers["X-IBM-THREAD-ID"] = watsonx_thread_id

            async with httpx.AsyncClient(timeout=httpx.Timeout(connect=30, read=120, write=30, pool=30)) as client:
                async with client.stream(
                    "POST",
                    f"{self.base_url}/v1/orchestrate/{self.agent_id}/chat/completions",
                    json=body,
                    headers=headers,
                ) as response:
                    response.raise_for_status()

                    async for line in response.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        data = line[6:].strip()
                        if data == "[DONE]":
                            break

                        try:
                            chunk = json.loads(data)
                        except json.JSONDecodeError:
                            continue

                        # Emit RAW event for each parsed SSE chunk
                        yield RawEvent(
                            type=EventType.RAW,
                            event=chunk,
                            source="watsonx",
                        )

                        # Persist the watsonx-managed thread_id so the next
                        # turn continues the same server-side thread. Chunks
                        # may carry it even when they have no choices.
                        wx_thread_id = chunk.get("thread_id")
                        if (
                            isinstance(wx_thread_id, str)
                            and wx_thread_id
                            and wx_thread_id != watsonx_thread_id
                        ):
                            watsonx_thread_id = wx_thread_id
                            await _maybe_await(
                                self._thread_id_store.set(thread_id, wx_thread_id)
                            )

                        choices = chunk.get("choices") or []
                        if not choices:
                            continue
                        choice = choices[0]
                        delta = choice.get("delta", {})

                        if "tool_calls" in delta and delta["tool_calls"]:
                            for tc in delta["tool_calls"]:
                                idx = tc.get("index", 0)

                                if tc.get("id") and tc.get("function", {}).get("name"):
                                    active_tool_calls[idx] = {
                                        "id": tc["id"],
                                        "name": tc["function"]["name"],
                                        "args": "",
                                        "ended": False,
                                    }
                                    yield ToolCallStartEvent(
                                        type=EventType.TOOL_CALL_START,
                                        tool_call_id=tc["id"],
                                        tool_call_name=tc["function"]["name"],
                                    )

                                args = tc.get("function", {}).get("arguments")
                                if args is not None and args != "":
                                    active = active_tool_calls.get(idx)
                                    if active:
                                        active["args"] += args
                                        yield ToolCallArgsEvent(
                                            type=EventType.TOOL_CALL_ARGS,
                                            tool_call_id=active["id"],
                                            delta=args,
                                        )

                        content = delta.get("content")
                        if content is not None and content != "":
                            accumulated_text += content
                            if not msg_started:
                                msg_id = str(uuid.uuid4())
                                yield TextMessageStartEvent(
                                    type=EventType.TEXT_MESSAGE_START,
                                    message_id=msg_id,
                                    role="assistant",
                                )
                                msg_started = True
                            yield TextMessageContentEvent(
                                type=EventType.TEXT_MESSAGE_CONTENT,
                                message_id=msg_id,
                                delta=content,
                            )

                        if choice.get("finish_reason") == "tool_calls":
                            for tc in active_tool_calls.values():
                                if not tc["ended"]:
                                    yield ToolCallEndEvent(
                                        type=EventType.TOOL_CALL_END,
                                        tool_call_id=tc["id"],
                                    )
                                    tc["ended"] = True

                    for tc in active_tool_calls.values():
                        if not tc["ended"]:
                            yield ToolCallEndEvent(
                                type=EventType.TOOL_CALL_END,
                                tool_call_id=tc["id"],
                            )

                    if msg_started and msg_id:
                        yield TextMessageEndEvent(
                            type=EventType.TEXT_MESSAGE_END,
                            message_id=msg_id,
                        )

            # Collect accumulated tool calls for MESSAGES_SNAPSHOT
            for tc_info in active_tool_calls.values():
                accumulated_tool_calls.append({
                    "id": tc_info["id"],
                    "name": tc_info["name"],
                    "args": tc_info["args"],
                })

            # STEP_FINISHED after the API call completes
            yield StepFinishedEvent(type=EventType.STEP_FINISHED, step_name=step_name)

            # Build MESSAGES_SNAPSHOT with input messages + assistant response
            snapshot_messages: List = list(input_data.messages)
            assistant_msg_id = msg_id or str(uuid.uuid4())
            tool_calls_for_snapshot = [
                ToolCall(
                    id=tc["id"],
                    type="function",
                    function=FunctionCall(name=tc["name"], arguments=tc["args"]),
                )
                for tc in accumulated_tool_calls
            ] or None
            snapshot_messages.append(
                AssistantMessage(
                    id=assistant_msg_id,
                    role="assistant",
                    content=accumulated_text or None,
                    tool_calls=tool_calls_for_snapshot,
                )
            )
            yield MessagesSnapshotEvent(
                type=EventType.MESSAGES_SNAPSHOT,
                messages=snapshot_messages,
            )

            yield RunFinishedEvent(type=EventType.RUN_FINISHED, thread_id=thread_id, run_id=run_id)

        except Exception as e:
            logger.exception("watsonx agent error")
            # Clean up open tool calls
            for tc in active_tool_calls.values():
                if not tc["ended"]:
                    yield ToolCallEndEvent(type=EventType.TOOL_CALL_END, tool_call_id=tc["id"])
                    tc["ended"] = True
            # Clean up open text message
            if msg_started and msg_id:
                yield TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=msg_id)
            # Close the step if it was started
            yield StepFinishedEvent(type=EventType.STEP_FINISHED, step_name=step_name)
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                message=f"watsonx request failed: {type(e).__name__}: {str(e)[:200]}",
                code="WATSONX_ERROR",
            )
            yield RunFinishedEvent(type=EventType.RUN_FINISHED, thread_id=thread_id, run_id=run_id)
