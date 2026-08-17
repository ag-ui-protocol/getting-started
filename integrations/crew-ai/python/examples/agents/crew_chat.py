"""Minimal CrewAI Crew for testing the dict-state code path (add_crewai_crew_fastapi_endpoint)."""

from crewai import Agent, Crew, Task, Process


class CrewChatCrew:
    """A minimal crew wrapper with .crew() and .name, used to test the
    add_crewai_crew_fastapi_endpoint() code path where state is a plain dict.

    Does NOT use @CrewBase to avoid config file lookups and init-time LLM calls
    from crew_chat_generate_crew_chat_inputs, which would fail before aimock starts."""

    name = "CrewChatCrew"

    def crew(self) -> Crew:
        assistant = Agent(
            role="General Assistant",
            goal="Help the user with their request",
            backstory="You are a helpful general-purpose assistant.",
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
            chat_llm="openai/gpt-5.4",
        )
