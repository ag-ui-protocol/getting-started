"""``AntigravityAgent`` -- the AG-UI entry point for Google Antigravity.

    RunAgentInput ──> AntigravityAgent.run() ──> Conversation.receive_steps()
          │                     │                          │
          │              EventTranslator                   │
          │                     │                          │
    BaseEvent[]  <──── translate + bridge events <───── Step[]

The run loop is deliberately small: the Antigravity stream is already ordered,
so translation is a ``for step in receive_steps()`` loop in a try/except. What
this class actually owns is the AG-UI contract around that loop -- exactly one
RUN_STARTED, exactly one terminal event (RUN_FINISHED *or* RUN_ERROR, never
FINISHED after ERROR), and the interleaving of bridge events emitted by parked
hooks and frontend tools.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, AsyncGenerator, Callable, Dict, List, Optional, Sequence

from ag_ui.core import (
    BaseEvent,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunFinishedInterruptOutcome,
    RunStartedEvent,
)
from google.antigravity import (
    Agent,
    CapabilitiesConfig,
    LocalAgentConfig,
    LocalOpenAIAgentConfig,
)
from google.antigravity import types as ag_types

from .event_translator import EventTranslator, step_failure
from .session_manager import SessionLimitExceeded, SessionManager, tool_signature
from .ui_bridge import UIBridge

logger = logging.getLogger(__name__)


class _ResumableOpenAIConfig(LocalOpenAIAgentConfig):
    """Restores ``session_continuation_mode`` on the OpenAI-compatible path.

    ``LocalAgentConfig.create_strategy`` forwards the field to the connection
    strategy, but ``LocalOpenAIAgentConfig.create_strategy`` in
    google-antigravity 0.1.8 does not, which silently disables cold resume.
    Setting it on the constructed strategy restores parity; drop this subclass
    once the SDK forwards the field itself.
    """

    def create_strategy(self, *, tool_runner: Any, hook_runner: Any):
        strategy = super().create_strategy(
            tool_runner=tool_runner, hook_runner=hook_runner
        )
        if not hasattr(strategy, "_session_continuation_mode"):
            raise RuntimeError(
                "google-antigravity changed its connection strategy: "
                "_session_continuation_mode is gone, so cold resume would "
                "silently stop working. Check whether "
                "LocalOpenAIAgentConfig.create_strategy now forwards the field "
                "itself and drop _ResumableOpenAIConfig if so."
            )
        strategy._session_continuation_mode = self.session_continuation_mode
        return strategy


class AntigravityAgent:
    """Wraps a Google Antigravity agent for the AG-UI protocol."""

    def __init__(
        self,
        *,
        model: Optional[str] = None,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        system_instructions: Optional[str] = None,
        capabilities: Optional[CapabilitiesConfig] = None,
        tools: Optional[Sequence[Callable[..., Any]]] = None,
        mcp_servers: Optional[List[Any]] = None,
        subagents: Optional[List[Any]] = None,
        workspaces: Optional[List[str]] = None,
        save_dir: Optional[str] = None,
        response_schema: Optional[Any] = None,
        # AG-UI behaviour
        enable_frontend_tools: bool = True,
        enable_ask_question: bool = True,
        tool_approval: bool = False,
        auto_approve_tools: Optional[Sequence[str]] = None,
        structured_output_as: str = "state",
        emit_builtin_tool_calls: bool = True,
        deduplicate_tool_calls: bool = True,
        # Session policy
        session_timeout_seconds: int = 1800,
        parked_timeout_seconds: int = 7200,
        max_sessions: int = 50,
        session_manager: Optional[SessionManager] = None,
    ):
        """Creates the adapter.

        Args:
          model: Model id. Defaults to the SDK's Gemini default unless
            ``base_url`` selects the OpenAI-compatible path.
          base_url: Root of an OpenAI-compatible server. Note the harness
            appends ``/v1/chat/completions`` itself, so pass the ROOT
            (``http://host:port``), not ``.../v1``.
          api_key: Gemini API key for the native path. Ignored when
            ``base_url`` is set -- the harness' OpenAI path carries no key
            field, so authenticate at the endpoint instead.
          tool_approval: Route every non-frontend tool call through an AG-UI
            approval interrupt. Also satisfies the SDK's mandatory safety guard.
          structured_output_as: ``"state"`` (STATE_SNAPSHOT) or ``"custom"``.
          deduplicate_tool_calls: Dispatch a frontend tool to the client at most
            once per Antigravity turn. An identical repeat is answered from the
            cached result; a repeat with different arguments gets a plain
            statement of what already ran. On by default because the harness
            backgrounds slow custom tools and the model then re-issues them,
            which would run a side-effecting action twice. Turn off if a tool is
            genuinely meant to run more than once within one turn.
        """
        self._model = model
        self._base_url = base_url
        self._api_key = api_key
        self._system_instructions = system_instructions
        self._capabilities = capabilities
        self._static_tools = list(tools or [])
        self._mcp_servers = list(mcp_servers or [])
        self._subagents = list(subagents or [])
        self._workspaces = list(workspaces) if workspaces else [os.getcwd()]
        self._save_dir = save_dir
        self._response_schema = response_schema

        self._enable_frontend_tools = enable_frontend_tools
        self._enable_ask_question = enable_ask_question
        self._tool_approval = tool_approval
        self._auto_approve = set(auto_approve_tools or [])
        if structured_output_as not in ("state", "custom"):
            raise ValueError(
                "structured_output_as must be 'state' or 'custom', got "
                f"{structured_output_as!r}"
            )
        self._structured_output_as = structured_output_as
        self._emit_builtin_tool_calls = emit_builtin_tool_calls
        self._deduplicate_tool_calls = deduplicate_tool_calls

        self._sessions = session_manager or SessionManager(
            session_timeout_seconds=session_timeout_seconds,
            parked_timeout_seconds=parked_timeout_seconds,
            max_sessions=max_sessions,
        )

    @property
    def session_manager(self) -> SessionManager:
        return self._sessions

    def builtin_enabled(self, tool: "ag_types.BuiltinTools") -> bool:
        """True when ``tool`` survives this agent's ``CapabilitiesConfig``.

        The config is an allow/deny list over the harness' built-ins, so a
        capability advertised without consulting it can be a lie.
        """
        capabilities = self._capabilities
        if capabilities is None:
            return True  # SDK default: every built-in enabled.
        if capabilities.enabled_tools is not None:
            return tool in capabilities.enabled_tools
        if capabilities.disabled_tools is not None:
            return tool not in capabilities.disabled_tools
        return True

    @property
    def ask_question_reachable(self) -> bool:
        """True when the model can actually raise an ``ask_question`` interrupt.

        The hook is only half the story: the harness gates the built-in behind
        ``CapabilitiesConfig``, so an ``enabled_tools`` allowlist that omits
        ``ask_question`` (or a ``disabled_tools`` list naming it) makes the
        registered hook unreachable.
        """
        return self._enable_ask_question and self.builtin_enabled(
            ag_types.BuiltinTools.ASK_QUESTION
        )

    async def close(self) -> None:
        await self._sessions.stop()

    # ------------------------------------------------------------------
    # Config construction
    # ------------------------------------------------------------------

    def _build_agent(
        self,
        bridge: UIBridge,
        input_data: RunAgentInput,
        previous_conversation_id: Optional[str],
    ) -> Agent:
        tools: List[Any] = list(self._static_tools)
        if self._enable_frontend_tools and input_data.tools:
            tools.extend(bridge.build_frontend_tools(list(input_data.tools)))

        hooks: List[Any] = []
        if self._enable_ask_question:
            hooks.append(bridge.build_interaction_hook())
        if self._tool_approval:
            hooks.append(
                bridge.build_tool_approval_hook(auto_approve=self._auto_approve)
            )

        capabilities = self._capabilities or CapabilitiesConfig(
            enable_subagents=bool(self._subagents)
        )

        common: Dict[str, Any] = {
            "system_instructions": self._system_instructions,
            "capabilities": capabilities,
            "tools": tools,
            "hooks": hooks,
            "mcp_servers": self._mcp_servers,
            "subagents": self._subagents,
            "workspaces": self._workspaces,
            "save_dir": self._save_dir,
            "response_schema": self._response_schema,
        }
        if previous_conversation_id:
            common["conversation_id"] = previous_conversation_id
            common["session_continuation_mode"] = (
                ag_types.SessionContinuationMode.CREATE_OR_RESUME
            )
        # The SDK refuses to start when write tools or MCP servers are enabled
        # without either a policy or a decide hook. The approval hook counts;
        # otherwise fall back to the SDK's default confirm policy behaviour by
        # allowing everything explicitly (the server operator opted in by
        # enabling those capabilities).
        if not self._tool_approval:
            from google.antigravity.hooks import policy

            common["policies"] = [policy.allow_all()]

        common = {k: v for k, v in common.items() if v is not None}

        if self._base_url:
            return Agent(
                _ResumableOpenAIConfig(
                    model=self._model, base_url=self._base_url, **common
                )
            )
        config_kwargs = dict(common)
        if self._model:
            config_kwargs["model"] = self._model
        if self._api_key:
            config_kwargs["api_key"] = self._api_key
        return Agent(LocalAgentConfig(**config_kwargs))

    # ------------------------------------------------------------------
    # Run
    # ------------------------------------------------------------------

    async def run(
        self, input_data: RunAgentInput
    ) -> AsyncGenerator[BaseEvent, None]:
        """Executes one AG-UI run and yields protocol events."""
        thread_id = input_data.thread_id
        run_id = input_data.run_id

        yield RunStartedEvent(
            type="RUN_STARTED", thread_id=thread_id, run_id=run_id
        )

        terminal_sent = False
        try:
            self._sessions.start()
            signature = tool_signature([t.name for t in (input_data.tools or [])])
            session = await self._sessions.get_or_create(
                thread_id,
                signature=signature,
                factory=lambda bridge, prev: self._build_agent(
                    bridge, input_data, prev
                ),
                bridge_factory=lambda: UIBridge(
                    deduplicate_tool_calls=self._deduplicate_tool_calls
                ),
            )

            async with session.lock:
                session.touch()
                async for event in self._run_locked(session, input_data):
                    if event.type in ("RUN_FINISHED", "RUN_ERROR"):
                        terminal_sent = True
                    yield event
                session.touch()

        except SessionLimitExceeded as exc:
            if not terminal_sent:
                terminal_sent = True
                yield RunErrorEvent(
                    type="RUN_ERROR", message=str(exc), code="SESSION_LIMIT"
                )
        except ag_types.AntigravityCancelledError as exc:
            if not terminal_sent:
                terminal_sent = True
                yield RunErrorEvent(
                    type="RUN_ERROR",
                    # Keep the specific reason, matching the in-loop handler:
                    # "the session was closed" and "the client disconnected"
                    # are different operationally.
                    message=str(exc) or "The run was cancelled.",
                    code="CANCELLED",
                )
        except Exception as exc:  # broad: any failure must reach the client
            logger.exception("Antigravity run failed")
            if not terminal_sent:
                terminal_sent = True
                yield RunErrorEvent(
                    type="RUN_ERROR",
                    message=f"{type(exc).__name__}: {exc}",
                    code="AGENT_ERROR",
                )

        if not terminal_sent:
            yield RunFinishedEvent(
                type="RUN_FINISHED", thread_id=thread_id, run_id=run_id
            )

    async def _run_locked(
        self, session, input_data: RunAgentInput
    ) -> AsyncGenerator[BaseEvent, None]:
        bridge: UIBridge = session.bridge

        # ---- resolve anything the client answered since the last run ----
        resumed = self._apply_client_answers(bridge, input_data)
        bridge.forget_resolved()

        # A resumption can also carry a new user message -- the client flushes
        # the tool result and whatever the user typed in one POST -- so this is
        # not gated on `resumed`.
        prompt, prompt_id = self._extract_prompt(input_data, session)
        if prompt is not None and not resumed:
            # A genuinely new user turn. Anything still parked belongs to the
            # previous turn and the user has moved on without answering it:
            # release it, or the harness stays blocked on our coroutine, this
            # run reads nothing (see _steps_with_bridge), and the session is
            # pinned in memory forever because `is_parked` never clears.
            if bridge.has_pending:
                logger.info(
                    "New user message on thread %s while %d request(s) were "
                    "parked; abandoning them.",
                    input_data.thread_id,
                    len(bridge.pending_ids()),
                )
                bridge.abandon_pending()
            # A harness failure can land while a run is parked; reset_stream
            # recovers it. Continuing would send this prompt onto a dead
            # conversation and report the result as a success.
            stale_failure = await session.reset_stream()
            session.raise_if_closed()
            if stale_failure is not None:
                yield RunErrorEvent(
                    type="RUN_ERROR",
                    message=(
                        f"The Antigravity session failed while awaiting your "
                        f"reply: {type(stale_failure).__name__}: {stale_failure}"
                    ),
                    code="AGENT_ERROR",
                )
                return
            session.raise_if_closed()
            await session.conversation.send(prompt)
            # Recorded only now: marking it before the send means a failed send
            # (or the stale-failure early return above) makes the client's
            # retry look already-delivered, and the message is swallowed.
            session.forwarded_prompts.add(prompt_id)
        elif prompt is not None:
            # Resumption that also carries new user text: the parked coroutine
            # was already resolved above, so just add the message to the turn.
            session.raise_if_closed()
            await session.conversation.send(prompt)
            session.forwarded_prompts.add(prompt_id)
        elif not resumed:
            # Nothing to say and nothing to resume.
            for event in bridge.drain():
                yield event
            return

        # The translator carries per-turn state (message ids, which steps are
        # already finished), so it is created with the turn and retired with it.
        if session.translator is None:
            session.translator = EventTranslator(
                structured_output_as=self._structured_output_as,
                emit_builtin_tool_calls=self._emit_builtin_tool_calls,
            )
            for name in bridge.frontend_tool_names:
                session.translator.suppress_tool(name)
        translator = session.translator

        # ---- consume the Antigravity stream ----
        error: Optional[BaseException] = None
        cancelled = False
        try:
            async for step in self._steps_with_bridge(session, bridge):
                # The lock guard in SessionManager._expired is what protects an
                # in-flight run; this keeps `last_activity` honest for the
                # moment the lock is released, so a turn that streamed for
                # longer than the idle timeout is not swept immediately after.
                session.touch()
                failure = step_failure(step)
                if failure is not None:
                    raise ag_types.AntigravityExecutionError(failure)
                async for event in translator.translate(step):
                    yield event
                for event in bridge.drain():
                    yield event
        except ag_types.AntigravityCancelledError as exc:
            # Same terminal event as the outer handler at run(): a cancellation
            # is not a successful run, and reporting it as one here while the
            # outer path reports RUN_ERROR made the outcome depend on where it
            # happened to surface.
            error = exc
            cancelled = True
            # Not necessarily the client: a forced SessionManager.close()/stop()
            # reaches here through the same exception.
            logger.info("Antigravity run cancelled: %s", exc)
        except Exception as exc:
            error = exc

        if error is not None or cancelled:
            # The turn died or was cancelled. Release anything parked before
            # retiring the stream: a request left pending keeps `is_parked`
            # true, and the idle sweeper never reclaims the session or its
            # subprocess. Cancellation needs this just as much as failure --
            # it used to skip it and pin the harness for the process lifetime.
            bridge.abandon_pending()
            await session.reset_stream()

        async for event in translator.close():
            yield event
        for event in bridge.drain():
            yield event

        if error is not None:
            yield RunErrorEvent(
                type="RUN_ERROR",
                message=(
                    # Keep the specific reason -- "the session was closed" and
                    # "the client disconnected" are different operationally.
                    (str(error) or "The run was cancelled.")
                    if cancelled
                    else f"{type(error).__name__}: {error}"
                ),
                code="CANCELLED" if cancelled else "AGENT_ERROR",
            )
            return

        # ---- terminal event: interrupt or success ----
        interrupts = bridge.pending_interrupts()
        if interrupts:
            yield RunFinishedEvent(
                type="RUN_FINISHED",
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
                outcome=RunFinishedInterruptOutcome(
                    type="interrupt", interrupts=interrupts
                ),
            )
            return

        yield RunFinishedEvent(
            type="RUN_FINISHED",
            thread_id=input_data.thread_id,
            run_id=input_data.run_id,
        )

    async def _steps_with_bridge(self, session, bridge: UIBridge):
        """Yields Antigravity steps, ending the run while a request is parked.

        When a frontend tool or hook parks, the harness goes quiet -- it is
        waiting on our coroutine, which is waiting on the client. Blocking on
        ``receive_steps()`` would hang the SSE response forever, so the run
        returns and the parked coroutine stays alive for the next one.

        One Antigravity turn can therefore span several AG-UI runs. The
        iterator and any in-flight ``__anext__()`` are stashed on the session
        and picked back up on the next run: starting a fresh ``receive_steps()``
        instead makes the harness re-deliver the steps of the turn already in
        progress, so the same tool call is replayed to the client on every run
        and the conversation never converges.
        """
        if session.step_iter is None:
            session.step_iter = session.conversation.receive_steps().__aiter__()

        while True:
            # Checked every iteration, not just on entry: `yield step` below
            # suspends in the SSE writer awaiting the socket, and a forced close
            # landing there sets `step_iter = None`. Resuming would then raise
            # AttributeError and report a deliberate shutdown as an agent bug.
            session.raise_if_closed()
            # Resume the future the previous run left mid-flight, if any.
            next_step = session.pending_step
            if next_step is None:
                next_step = asyncio.ensure_future(session.step_iter.__anext__())
            session.pending_step = next_step

            parked = asyncio.ensure_future(_wait_until_parked(bridge))
            try:
                await asyncio.wait(
                    {next_step, parked}, return_when=asyncio.FIRST_COMPLETED
                )
            finally:
                parked.cancel()

            if next_step.done():
                session.pending_step = None
                if next_step.cancelled():
                    # Somebody else cancelled the future we stashed on the
                    # session -- a forced SessionManager.close()/stop(), or
                    # AntigravityAgent.close(), landing while this run holds the
                    # lock. Calling .result() would raise a bare CancelledError,
                    # and that is a BaseException: it escapes both this method's
                    # caller and endpoint._stream, so the client would get no
                    # terminal event at all. Convert it to the SDK's cancelled
                    # error, which the run loop already maps to
                    # RUN_ERROR/code="CANCELLED".
                    #
                    # A cancellation of this run's OWN task is unaffected: that
                    # raises out of the `asyncio.wait` above, never reaching here.
                    raise ag_types.AntigravityCancelledError(
                        "The Antigravity session was closed while the run was "
                        "in progress."
                    )
                try:
                    step = next_step.result()
                except StopAsyncIteration:
                    # The turn is over; the next one needs a fresh iterator.
                    await session.reset_stream()
                    return
                yield step
                continue

            # Parked. Leave `next_step` pending on the session -- cancelling it
            # would discard the step the harness is mid-way through delivering.
            logger.debug(
                "Run parked with %d pending request(s)", len(bridge.pending_ids())
            )
            return

    # ------------------------------------------------------------------
    # Client input
    # ------------------------------------------------------------------

    def _apply_client_answers(
        self, bridge: UIBridge, input_data: RunAgentInput
    ) -> bool:
        """Resolves parked futures from this run's input. Returns True if any."""
        resolved = False

        for entry in input_data.resume or []:
            if bridge.resolve_interrupt(
                entry.interrupt_id, entry.payload, entry.status == "cancelled"
            ):
                resolved = True
            else:
                # A resume for an id we never issued (or already released) means
                # client and server disagree about the run's state. Staying
                # silent lets the caller believe the answer landed.
                logger.warning(
                    "Ignoring resume for unknown interrupt %s on thread %s",
                    entry.interrupt_id,
                    input_data.thread_id,
                )

        # Frontend tool results arrive as ToolMessages carrying the tool_call_id
        # we minted when the tool parked.
        for message in reversed(list(input_data.messages or [])):
            if getattr(message, "role", None) != "tool":
                continue
            tool_call_id = getattr(message, "tool_call_id", None)
            if not tool_call_id:
                continue
            if bridge.resolve_tool_call(tool_call_id, getattr(message, "content", "")):
                resolved = True
            else:
                # Clients legitimately resend whole transcripts, so old
                # ToolMessages are expected; log at debug for diagnosis only.
                logger.debug(
                    "No parked request for tool_call_id %s", tool_call_id
                )

        return resolved

    def _extract_prompt(self, input_data: RunAgentInput, session) -> tuple:
        """Returns ``(text, message_id)`` for the newest unforwarded user turn.

        Antigravity owns the conversation history in-process while the AG-UI
        client resends the whole transcript every run, so each user message
        must reach the harness exactly once. Identity is the only reliable
        test: inferring it from position -- "after the last ToolMessage" --
        misreads a tool result left over from an earlier turn and replays that
        turn's prompt, and misses new text on a run resumed purely by a
        `resume` entry.
        """
        for message in reversed(list(input_data.messages or [])):
            if getattr(message, "role", None) != "user":
                continue
            message_id = getattr(message, "id", None)
            if message_id in session.forwarded_prompts:
                # Everything before this was forwarded on an earlier run.
                return (None, None)
            text = _message_text(getattr(message, "content", None))
            if text:
                return (text, message_id)
        return (None, None)


def _message_text(content: Any) -> str:
    """Flattens AG-UI message content to the text the harness can accept.

    ``UserMessage.content`` is a string or a list of typed parts. Only text
    survives -- ``conversation.send()`` takes a string -- but ignoring a
    list-shaped message entirely would silently drop the user's turn, so the
    text parts are joined and non-text parts are left for a future multimodal
    mapping.
    """
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for part in content:
            text = getattr(part, "text", None)
            if isinstance(text, str) and text.strip():
                parts.append(text.strip())
        return "\n".join(parts)
    return ""


async def _wait_until_parked(bridge: UIBridge) -> None:
    """Completes once the bridge has an unresolved parked request."""
    while not bridge.has_pending:
        await asyncio.sleep(0.02)
