import logging
import traceback
from typing import Any, Dict, List

from langchain_core.runnables import RunnableConfig
from langgraph.graph.state import CompiledStateGraph

from ag_ui.core import RunAgentInput
from ag_ui_agentspec.agentspec_tracing_exporter import EVENT_QUEUE

logger = logging.getLogger("ag_ui_agentspec.tracing")

async def run_langgraph_agent(agent: CompiledStateGraph, input_data: RunAgentInput) -> None:
    input_messages = prepare_langgraph_agent_inputs(input_data)
    input_messages = await filter_only_new_messages(agent, input_data.thread_id, input_messages)
    config = RunnableConfig({"configurable": {"thread_id": input_data.thread_id}})
    current_queue = EVENT_QUEUE.get()
    token = EVENT_QUEUE.set(current_queue)
    try:
        async for _ in agent.astream({"messages": input_messages}, stream_mode="messages", config=config):
            pass
    except Exception as e:
        logger.exception(
            "LangGraph agent crashed with error: %s%s",
            repr(e),
            traceback.format_exc(),
        )
        raise RuntimeError(f"LangGraph agent crashed with error: {repr(e)}\n\nTraceback: {traceback.format_exc()}")
    finally:
        EVENT_QUEUE.reset(token)


def prepare_langgraph_agent_inputs(input_data: RunAgentInput) -> List[Dict[str, Any]]:
    messages = input_data.messages
    if not messages:
        return []
    messages_to_return = []
    for m in messages:
        m_dict = m.model_dump()
        if m_dict["role"] in {"user", "assistant"} and "name" in m_dict:
            del m_dict["name"]
        if m_dict["role"] == "tool" and "error" in m_dict:
            del m_dict["error"]
        # .get: an assistant turn carrying only tool calls has no content, and an
        # optional field with no value is absent from the dump, not present as None.
        if m_dict["role"] == "assistant" and m_dict.get("content") is None:
            m_dict["content"] = ""
        messages_to_return.append(m_dict)
    return messages_to_return


async def filter_only_new_messages(
    agent: CompiledStateGraph, thread_id: str, input_messages: list[dict]
) -> list[dict]:
    config = RunnableConfig({"configurable": {"thread_id": thread_id}})
    state_snapshot = await agent.aget_state(config)
    existing_messages = state_snapshot.values.get("messages", []) or []

    # existing entries are usually LangChain message objects; get their ids if present
    existing_ids = set()
    for message in existing_messages:
        if message.id:
            existing_ids.add(message.id)

    # input_messages are your dicts from the client (with "id")
    return [m for m in input_messages if m.get("id") not in existing_ids]
