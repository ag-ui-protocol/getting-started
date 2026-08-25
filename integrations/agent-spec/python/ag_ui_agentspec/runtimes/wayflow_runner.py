import logging
from typing import Any, Dict

from wayflowcore import Flow as WayflowFlow
from wayflowcore import Agent as WayflowAgent
from wayflowcore.agentspec.tracing import AgentSpecEventListener
from wayflowcore.events.eventlistener import register_event_listeners
from wayflowcore.messagelist import Message, MessageType, ToolRequest, ToolResult

from ag_ui.core import RunAgentInput
from ag_ui_agentspec.agentspec_tracing_exporter import EVENT_QUEUE

logger = logging.getLogger("ag_ui_agentspec.tracing")

def prepare_wayflow_agent_input(input_data: RunAgentInput) -> Dict[str, Any]:
    messages = [m.model_dump() for m in input_data.messages]
    wayflow_messages = []
    for m in messages:
        match m["role"]:
            case "system":
                wm = Message(message_type=MessageType.SYSTEM, content=m["content"])
            case "user":
                wm = Message(message_type=MessageType.USER, content=m["content"])
            case "assistant":
                wm = Message(
                    message_type=MessageType.AGENT,
                    # .get: content is optional on an assistant message and is absent
                    # from the dump when unset, not present as None. The system/user/
                    # tool branches keep [] because content is required there, so a
                    # missing key is a real error rather than an empty turn.
                    content=m.get("content"),
                    tool_requests=[
                        ToolRequest(
                            name=tc["function"]["name"],
                            args=tc["function"]["arguments"],
                            tool_request_id=tc["id"],
                        )
                        for tc in (m.get("tool_calls") or [])
                    ],
                )
            case "tool":
                wm = Message(
                    message_type=MessageType.TOOL_RESULT,
                    tool_result=ToolResult(
                        content=m["content"], tool_request_id=m["tool_call_id"]
                    ),
                )
            case _:
                raise NotImplementedError(f"Unsupported message: {m}")
        wayflow_messages.append(wm)
    return wayflow_messages


def prepare_wayflow_flow_input(input_data: RunAgentInput) -> Dict[str, Any]:
    messages = input_data.messages
    return {"user_input": messages[-1].content}


async def run_wayflow(agent: Any, input_data: RunAgentInput) -> None:
    current_queue = EVENT_QUEUE.get()

    if isinstance(agent, WayflowAgent):
        agent._add_talk_to_user_tool = False
        agent._update_internal_state()
        agent_input = prepare_wayflow_agent_input(input_data)

        token = EVENT_QUEUE.set(current_queue)
        try:
            with register_event_listeners([AgentSpecEventListener()]):
                conversation = agent.start_conversation(messages=agent_input)
                await conversation.execute_async()
        except Exception as e:
            logger.exception("[AG-UI Agent Spec] Wayflow agent crashed with error: %s", repr(e))
            raise
        finally:
            EVENT_QUEUE.reset(token)

    elif isinstance(agent, WayflowFlow):
        flow_input = prepare_wayflow_flow_input(input_data)
        token = EVENT_QUEUE.set(current_queue)
        try:
            with register_event_listeners([AgentSpecEventListener()]):
                conversation = agent.start_conversation(flow_input)
                await conversation.execute_async()
        except Exception as e:
            logger.exception("[AG-UI Agent Spec] Wayflow flow crashed with error: %s", repr(e))
            raise
        finally:
            EVENT_QUEUE.reset(token)

    else:
        raise NotImplementedError("Unsupported Wayflow component type")
