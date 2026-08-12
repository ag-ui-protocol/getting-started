"""Agent wrapper — an OpenAI Agents SDK Agent that speaks AG-UI."""

import logging
from typing import Any, AsyncIterator

from agents import Agent, RunConfig, Runner

from ag_ui.core import BaseEvent, CustomEvent, RunAgentInput
from .translator import AGUITranslator

logger = logging.getLogger(__name__)

# Sentinel: distinguishes "caller passed context=None" (a real SDK context of
# None) from "caller said nothing" (fall back to the AG-UI context list).
_UNSET_CONTEXT: Any = object()


class OpenAIAgentsAgent:
    """Wrap an OpenAI Agents SDK Agent so it speaks the AG-UI protocol.

    The wrapper is reusable across requests. Non-conflicting client tools are
    added to a per-request agent clone, and output uses fresh per-run state.

    This shortcut hides the run loop. Use ``AGUITranslator`` directly when
    application logic needs access to ``RunResultStreaming``.

    Example:
        from agents import Agent
        from ag_ui_openai_agents import OpenAIAgentsAgent

        sdk_agent = Agent(name="assistant", instructions="You are helpful.")
        agent = OpenAIAgentsAgent(sdk_agent)

        async for event in agent.run_streamed(run_input):
            ...
    """

    def __init__(
        self,
        agent: Agent,
        *,
        name: str | None = None,
        description: str = "",
        translator: AGUITranslator | None = None,
        run_config: RunConfig | None = None,
        context: Any = _UNSET_CONTEXT,
        start_custom_event: CustomEvent | None = None,
        initial_state: Any = None,
        final_state: Any = None,
        emit_messages_snapshot: bool = True,
        end_custom_event: CustomEvent | None = None,
        emit_run_error: bool = True,
        run_error_message: str | None = None,
    ) -> None:
        """Configure an OpenAI Agents SDK Agent for AG-UI requests.

        Args:
            agent: The OpenAI Agents SDK Agent to serve.
            name: Public name for health/introspection. Defaults to agent.name.
            description: Optional human-readable description.
            translator: Reusable translator. Provide one to customize mapping
                through engine subclasses.
            run_config: Run-wide OpenAI Agents SDK configuration. None uses the
                SDK defaults.
            context: The SDK run context (``TContext``) handed to tools, hooks,
                and dynamic instructions via ``RunContextWrapper.context``. When
                omitted, the AG-UI request's ambient ``context`` list is passed
                through instead. Provide this when the wrapped agent's tools
                expect an application-specific context object.
            start_custom_event: CustomEvent emitted after RUN_STARTED. Its value
                may be static or a zero-argument sync/async factory.
            initial_state: Passed to AGUITranslator.to_agui unchanged.
            final_state: Passed to AGUITranslator.to_agui unchanged.
            emit_messages_snapshot: Whether to emit MESSAGES_SNAPSHOT before
                RUN_FINISHED. Defaults to True.
            end_custom_event: CustomEvent emitted before the terminal event.
                Its value may be static or a zero-argument sync/async factory.
                Use the translator directly when its value needs the run result.
            emit_run_error: Whether to emit RUN_ERROR for ordinary lifecycle
                errors.
                Defaults to True.
            run_error_message: Fixed RUN_ERROR message. None sends str(exc).
        """
        self.agent = agent
        self.name = name or agent.name
        self.description = description
        self._translator = translator or AGUITranslator()
        self._run_config = run_config
        self._context = context
        self._start_custom_event = start_custom_event
        self._initial_state = initial_state
        self._final_state = final_state
        self._emit_messages_snapshot = emit_messages_snapshot
        self._end_custom_event = end_custom_event
        self._emit_run_error = emit_run_error
        self._run_error_message = run_error_message

    async def run_streamed(self, input: RunAgentInput) -> AsyncIterator[BaseEvent]:
        """Translate one AG-UI request, run the agent, and yield AG-UI events.

        Client tools are added to a per-request agent clone. The translator
        handles input and output mapping, lifecycle events, and snapshots.

        Args:
            input: The incoming AG-UI RunAgentInput.

        Yields:
            AG-UI BaseEvent instances, ready to encode.
        """
        translated = self._translator.to_openai(input)

        run_agent = self.agent
        if translated.tools:
            server_tool_names = {
                name
                for tool in self.agent.tools
                if (name := getattr(tool, "name", None)) is not None
            }
            client_tools = []
            seen_client_names: set[str] = set()
            for tool in translated.tools:
                if tool.name in server_tool_names:
                    logger.warning(
                        "Ignoring client tool %r because a server tool already uses this name",
                        tool.name,
                    )
                    continue
                if tool.name in seen_client_names:
                    logger.warning(
                        "Ignoring duplicate client tool %r; the SDK cannot resolve two tools with one name",
                        tool.name,
                    )
                    continue
                seen_client_names.add(tool.name)
                client_tools.append(tool)

            if client_tools:
                run_agent = self.agent.clone(
                    tools=[*self.agent.tools, *client_tools]
                )

        # Fall back to the AG-UI ambient context; normalize an empty list to
        # None so a context-less request matches the SDK's own default (None),
        # not [] — agents that branch on `ctx.context is None` rely on this.
        context = (
            self._context
            if self._context is not _UNSET_CONTEXT
            else (translated.context or None)
        )
        result = Runner.run_streamed(
            run_agent,
            input=translated.messages,
            run_config=self._run_config,
            context=context,
        )

        async for event in self._translator.to_agui(
            result,
            input,
            start_custom_event=self._start_custom_event,
            initial_state=self._initial_state,
            final_state=self._final_state,
            emit_messages_snapshot=self._emit_messages_snapshot,
            end_custom_event=self._end_custom_event,
            emit_run_error=self._emit_run_error,
            run_error_message=self._run_error_message,
        ):
            yield event
