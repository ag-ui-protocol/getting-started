"""Minimal CrewAI Crew for testing the dict-state code path (add_crewai_crew_fastapi_endpoint)."""

from crewai import Agent, Crew, Task, Process

from ag_ui_crewai._config import resolve_agent_execution_ceiling_seconds
from ._crewai_llm import bounded_llm

MODEL = "openai/gpt-5.4"


class CrewChatCrew:
    """A minimal crew wrapper with .crew() and .name, used to test the
    add_crewai_crew_fastapi_endpoint() code path where state is a plain dict.

    Does NOT use @CrewBase to avoid config file lookups and init-time LLM calls
    from crew_chat_generate_crew_chat_inputs, which would fail before aimock starts."""

    name = "CrewChatCrew"

    def crew(self) -> Crew:
        # ONE INSTANCE PER OWNER, not one for both. The agent set no llm at all
        # before, so these keep crewai's env-derived resolution (``bounded_llm``
        # mirrors it) while carrying the read timeout. The chat loop is bounded in
        # ``crews.py`` either way; what a bounded ``chat_llm`` newly bounds is
        # ``generate_crew_chat_inputs``, which calls the model through that object
        # while the flow is being built.
        #
        # Sharing one object would carry the crew's own settings into the chat
        # helper: a streaming kickoff calls ``enable_agent_streaming``, which sets
        # ``agent.llm.stream = True`` and never restores it (crewai
        # ``crews/utils.py:54``), and crewai mutates ``_token_usage`` in place
        # (``crewai/llms/base_llm.py:958``). Both measured against crewai 1.15.11.
        assistant_llm = bounded_llm(MODEL)
        chat_llm = bounded_llm(MODEL)

        assistant = Agent(
            role="General Assistant",
            goal="Help the user with their request",
            backstory="You are a helpful general-purpose assistant.",
            llm=assistant_llm,
            # The read timeout bounds one read, which crewai then multiplies; this
            # trims that product by dropping the task-retry factor, and does not
            # cap the execution's wall clock (see ``_crewai_llm``).
            max_execution_time=resolve_agent_execution_ceiling_seconds(),
            verbose=False,
        )

        assist_task = Task(
            description="{user_message}",
            expected_output="A helpful response to the user's message",
            agent=assistant,
        )

        return Crew(
            agents=[assistant],
            tasks=[assist_task],
            process=Process.sequential,
            verbose=False,
            chat_llm=chat_llm,
        )
