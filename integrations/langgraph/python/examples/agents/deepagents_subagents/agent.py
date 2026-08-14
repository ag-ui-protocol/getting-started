"""A deepagents supervisor that delegates to a research subagent which pauses
for human approval (HITL) before finalizing — the interrupt happens INSIDE the
subagent.

This demo exercises AG-UI subagent attribution AND human-in-the-loop via a
LangGraph `interrupt()` raised inside a subagent. The subagent calls the
`request_human_approval` tool, which interrupts; the interrupt propagates to the
top-level run, AG-UI surfaces it as an `on_interrupt` event, the dojo renders an
Approve/Reject prompt (via CopilotKit's `useInterrupt`), and the user's decision
is fed back with `Command(resume=...)` on the same thread so the subagent
continues from where it paused.
"""

import os

from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.types import interrupt

from deepagents import create_deep_agent
from deepagents.middleware.subagents import SubAgent

model = ChatOpenAI(model="gpt-4o-mini")


@tool
def request_human_approval(answer_summary: str) -> str:
    """Request the user's approval before finalizing your answer.

    Args:
        answer_summary: a one- or two-sentence summary of the answer you intend
            to give the user.

    Returns the user's decision.
    """
    # interrupt() pauses the whole run (checkpointed at the top level) until the
    # client resumes with Command(resume=<decision>). The dict is the payload the
    # dojo renders in its approval UI.
    decision = interrupt(
        {
            "type": "approval",
            "summary": answer_summary,
            "question": "The research assistant wants to finalize this answer. Approve?",
        }
    )
    if isinstance(decision, dict) and decision.get("approved"):
        return "The user APPROVED. Present the answer as your final answer."
    return (
        "The user REJECTED the answer. Do NOT present it. Start your reply with "
        "'You rejected my draft answer.' and offer to revise it."
    )


research_assistant: SubAgent = {
    "name": "research_assistant",
    "description": (
        "Researches the user's question and MUST get human approval before "
        "finalizing its answer."
    ),
    "system_prompt": (
        "You are a research assistant. When given a question:\n"
        "1. Decide on a concise (2-3 sentence) answer.\n"
        "2. You MUST call the `request_human_approval` tool exactly once, passing "
        "a short summary of that intended answer, and wait for the decision.\n"
        "3. Follow the tool result's instruction exactly: on approval give the "
        "final answer; on rejection do NOT give the answer — begin with 'You "
        "rejected my draft answer.' and offer to revise.\n"
        "NEVER give a final answer without first calling `request_human_approval`."
    ),
    "tools": [request_human_approval],
}

SUPERVISOR_PROMPT = """You are a research supervisor with one specialist subagent: \
`research_assistant`.

For EVERY user question you MUST delegate to it: call the `task` tool once with \
`subagent_type="research_assistant"` and pass the user's question as the \
description. Do not answer from your own knowledge. Once the subagent returns, \
relay its final answer to the user in one short paragraph."""

# HITL requires a checkpointer so the interrupt can be persisted and resumed.
is_fast_api = os.environ.get("LANGGRAPH_FAST_API", "false").lower() == "true"

if is_fast_api:
    from langgraph.checkpoint.memory import MemorySaver

    graph = create_deep_agent(
        model=model,
        tools=[],
        system_prompt=SUPERVISOR_PROMPT,
        subagents=[research_assistant],
        checkpointer=MemorySaver(),
    )
else:
    # LangGraph API/dev provides its own persistence.
    graph = create_deep_agent(
        model=model,
        tools=[],
        system_prompt=SUPERVISOR_PROMPT,
        subagents=[research_assistant],
    )
