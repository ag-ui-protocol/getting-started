import asyncio
import json
import uuid
from typing import Any, AsyncGenerator, Dict, List, Optional, Union

# --- AG-UI Event Models and Encoder ---
# Assuming these are the correct paths and names based on typical structure.
try:
    from copilotkit.ui.api_response_v1 import (
        AGCoreEventEncoder,
        Message,
        MessagesSnapshotEvent,
        StateSnapshotEvent,
        RunStartedEvent,
        RunFinishedEvent,
        RunErrorEvent,
        TextMessageStartEvent,
        TextMessageChunkEvent,
        TextMessageContentEvent,
        TextMessageEndEvent,
        ToolCallStartEvent,
        ToolCallArgsEvent,
        ToolCallEndEvent,
        ConversationEndEvent,
    )
    # Ensure actual Pydantic models are used if available
    _actual_pydantic_models_available = True
except ImportError:
    print("WARNING: AG-UI Pydantic models from `copilotkit.ui.api_response_v1` not found. Using placeholder dicts/logic.")
    _actual_pydantic_models_available = False
    # Placeholder classes (condensed for brevity, same as before)
    class PlaceholderEvent:
        def __init__(self, **kwargs):
            self.type = kwargs.pop("type", "UnknownEvent") # Ensure type is a top-level attribute
            # Assign other kwargs to their respective attributes if they are not None
            for key, value in kwargs.items():
                if value is not None:
                    setattr(self, key, value)
            # Ensure payload exists, even if empty, for events that expect it
            if 'payload' not in kwargs and any(event_type in self.type for event_type in ["StateSnapshot", "RunError", "TextMessage", "ToolCall"]):
                 self.payload = {}


        def model_dump(self):
            d = {key: value for key, value in self.__dict__.items() if value is not None and key != "kwargs"}
            return d

    class PlaceholderMessage(PlaceholderEvent): # Specific placeholder for Message
        def __init__(self, id: str, role: str, content: str, created_at: Optional[int] = None, meta: Optional[Dict[str, Any]] = None):
            # Manually call __init__ of PlaceholderEvent with expected structure
            super().__init__(type="Message", id=id, role=role, content=content, created_at=created_at, meta=meta)


    Message=PlaceholderMessage
    MessagesSnapshotEvent=lambda invocationId, payload: PlaceholderEvent(type="MessagesSnapshot",invocationId=invocationId,payload=payload)
    StateSnapshotEvent=lambda invocationId, payload: PlaceholderEvent(type="StateSnapshot",invocationId=invocationId,payload=payload)
    RunStartedEvent=lambda invocationId, payload=None: PlaceholderEvent(type="RunStarted",invocationId=invocationId,payload=payload)
    RunFinishedEvent=lambda invocationId, payload=None: PlaceholderEvent(type="RunFinished",invocationId=invocationId,payload=payload)
    RunErrorEvent=lambda invocationId, payload: PlaceholderEvent(type="RunError",invocationId=invocationId,payload=payload)
    TextMessageStartEvent=lambda messageId, contentId, payload=None: PlaceholderEvent(type="TextMessageStart",messageId=messageId, contentId=contentId, payload=payload)
    TextMessageChunkEvent=lambda messageId, contentId, payload: PlaceholderEvent(type="TextMessageChunk",messageId=messageId, contentId=contentId, payload=payload)
    TextMessageContentEvent=lambda messageId, contentId, payload: PlaceholderEvent(type="TextMessageContent",messageId=messageId, contentId=contentId, payload=payload)
    TextMessageEndEvent=lambda messageId, contentId, payload=None: PlaceholderEvent(type="TextMessageEnd",messageId=messageId, contentId=contentId, payload=payload)
    ToolCallStartEvent=lambda toolCallId, payload: PlaceholderEvent(type="ToolCallStart",toolCallId=toolCallId,payload=payload)
    ToolCallArgsEvent=lambda toolCallId, payload: PlaceholderEvent(type="ToolCallArgs",toolCallId=toolCallId,payload=payload)
    ToolCallEndEvent=lambda toolCallId, payload: PlaceholderEvent(type="ToolCallEnd",toolCallId=toolCallId,payload=payload)
    ConversationEndEvent=lambda payload=None: PlaceholderEvent(type="ConversationEnd",payload=payload)

    class AGCoreEventEncoder:
        def encode(self,event_obj):
            dm=getattr(event_obj,"model_dump",None);
            if callable(dm): return f"data: {json.dumps(dm())}\n\n"
            elif isinstance(event_obj,dict): return f"data: {json.dumps(event_obj)}\n\n" # Should be rare
            raise TypeError(f"Object of type {type(event_obj)} not JSON serializable or lacks model_dump")

# --- ADK Data Structures ---
class ADKPart:
    def __init__(self, text: Optional[str] = None, tool_code: Optional[str] = None, tool_result: Optional[Dict[str,Any]] = None):
        self.text = text; self.tool_code = tool_code; self.tool_result = tool_result # For richer history
class ADKContent:
    def __init__(self, role: str, parts: List[ADKPart]): self.role=role; self.parts=parts
    @property
    def text(self) -> Optional[str]: return "".join([p.text for p in self.parts if p.text]) if self.parts else None
class ADKFunctionCall:
    def __init__(self, name: str, arguments_json: str, id: Optional[str]=None): self.name=name; self.arguments_json=arguments_json; self.id=id or str(uuid.uuid4())
class ADKLlmResponse:
    def __init__(self, text_content:Optional[str]=None, function_call:Optional[ADKFunctionCall]=None, is_partial:bool=False, turn_complete:bool=False): self.text_content=text_content; self.function_call=function_call; self.is_partial=is_partial; self.turn_complete=turn_complete
class ADKToolResult:
    def __init__(self, function_call_id: str, result: str, is_error:bool=False): self.function_call_id=function_call_id; self.result=result; self.is_error=is_error
class ADKEvent:
    def __init__(self, sid:str, txt_chunk:Optional[str]=None, llm_resp:Optional[ADKLlmResponse]=None, tool_res:Optional[ADKToolResult]=None, state_delta:Optional[Dict[str,Any]]=None, partial:bool=False, turn_comp:bool=False, err_msg:Optional[str]=None, final_event:bool=False):
        self.session_id=sid; self.text_chunk=txt_chunk; self.llm_response=llm_resp; self.tool_result=tool_res; self.state_delta=state_delta; self.partial=partial; self.turn_complete=turn_comp; self.error_message=err_msg; self.is_final_event_for_session=final_event
class ADKSession:
    def __init__(self, session_id:str): self.session_id=session_id; self.history:List[ADKContent]=[]
    def add_content_to_history(self, content: ADKContent): self.history.append(content)
    def add_message_to_history(self,role:str,text:str): self.history.append(ADKContent(role=role,parts=[ADKPart(text=text)]))

# --- ADK Simulation ---
class ADKLiveRequestQueue: # Simplified, actual processing in ADKInMemoryRunner
    def __init__(self, sid:str, runner_q:asyncio.Queue, runner_ref): self.session_id=sid; self._runner_event_queue=runner_q; self._adk_runner_ref=runner_ref
    async def send_content(self, inv_id:str, prompt_text:str): await self._adk_runner_ref._process_new_user_message(self.session_id, inv_id, prompt_text)
class ADKSessionService:
    def __init__(self): self.sessions:Dict[str,ADKSession]={}; self._runner_q=None; self._runner_ref=None
    def set_runner_dependencies(self,q,ref): self._runner_q=q; self._runner_ref=ref
    async def create_session(self, sid:Optional[str]=None, initial_history:Optional[List[ADKContent]]=None) -> str:
        sid = sid or str(uuid.uuid4()); new_s = ADKSession(sid)
        if initial_history: new_s.history = initial_history
        self.sessions[sid] = new_s; return sid
    def get_session(self, sid:str) -> ADKSession: return self.sessions[sid]
    def get_request_queue(self, sid:str): return ADKLiveRequestQueue(sid, self._runner_q, self._runner_ref)

class ADKInMemoryRunner:
    def __init__(self, session_service:ADKSessionService, model_config=None):
        self.session_service=session_service; self.model_config=model_config; self._central_q=asyncio.Queue()
        self.session_service.set_runner_dependencies(self._central_q, self)
        self._callbacks={"before_agent_turn":[],"after_agent_turn":[],"after_llm_response":[],"after_tool_execution":[]}
    def register_event_callback(self,n,c): self._callbacks.get(n,[]).append(c)
    def unregister_event_callback(self,n,c):
        if n in self._callbacks:
            try: self._callbacks[n].remove(c)
            except ValueError: print(f"[ADKSim] Warn: Callback {c.__name__} not found for event {n} during unregistration.")
    async def _trigger_callbacks(self,n,*a,**kw): [asyncio.create_task(c(*a,**kw)) for c in self._callbacks.get(n,[])]
    def get_session_history(self,sid:str): return self.session_service.get_session(sid).history if self.session_service.get_session(sid) else []

    async def _process_new_user_message(self, sid:str, inv_id:str, prompt:str, current_turn_num:int=1): # Added turn_num for complex flows
        s = self.session_service.get_session(sid)
        s.add_message_to_history(role="user", text=prompt)
        await self._trigger_callbacks("before_agent_turn", inv_id, {"session_id":sid, "prompt":prompt})

        # Flow 1: Text -> Tool -> Text
        if "weather" in prompt.lower() and "paris" in prompt.lower(): # Specific trigger for text-tool-text
            print(f"[ADKSim] Inv {inv_id}: Matched 'weather in paris' for text-tool-text flow.")
            await self._central_q.put(ADKEvent(sid,txt_chunk="Okay, checking the weather in Paris for you.",partial=False,turn_comp=True,state_delta={"action":"pre-tool_text"}))
            s.add_message_to_history(role="model",text="Okay, checking the weather in Paris for you.")

            fcid1=f"fc_{uuid.uuid4()}"; await self._central_q.put(ADKEvent(sid,llm_resp=ADKLlmResponse(function_call=ADKFunctionCall("get_weather", '{"location":"Paris"}',id=fcid1)),state_delta={"action":"tool_call_get_weather"}))
            s.add_content_to_history(ADKContent(role="model",parts=[ADKPart(tool_code=json.dumps({"name":"get_weather","arguments":'{"location":"Paris"}'}))])) # Represent tool call

            await asyncio.sleep(0.1) # Sim execution
            await self._central_q.put(ADKEvent(sid,tool_res=ADKToolResult(fcid1,'{"temp":"15C","condition":"Cloudy"}'),state_delta={"action":"tool_result_get_weather"}))
            s.add_content_to_history(ADKContent(role="user",parts=[ADKPart(tool_result={"name":"get_weather","result":'{"temp":"15C","condition":"Cloudy"}'})])) # Represent tool result (ADK often uses 'user' role for tool results)

            await self._central_q.put(ADKEvent(sid,txt_chunk="The weather in Paris is 15C and Cloudy.",partial=False,turn_comp=True,state_delta={"action":"post-tool_text"}))
            s.add_message_to_history(role="model",text="The weather in Paris is 15C and Cloudy.")

        # Flow 2: Multiple tool calls
        elif "order pizza and coke" in prompt.lower():
            print(f"[ADKSim] Inv {inv_id}: Matched 'order pizza and coke' for multi-tool flow.")
            await self._central_q.put(ADKEvent(sid,txt_chunk="Sure, I can help with that. Ordering pizza first...",partial=False,turn_comp=True,state_delta={"action":"pre-multi-tool_text"}))
            s.add_message_to_history(role="model",text="Sure, I can help with that. Ordering pizza first...")

            fcid_pizza=f"fc_{uuid.uuid4()}"; await self._central_q.put(ADKEvent(sid,llm_resp=ADKLlmResponse(function_call=ADKFunctionCall("order_food", '{"item":"pizza","quantity":1}',id=fcid_pizza)),state_delta={"action":"tool_call_pizza"}))
            s.add_content_to_history(ADKContent(role="model",parts=[ADKPart(tool_code=json.dumps({"name":"order_food","arguments":'{"item":"pizza","quantity":1}'}))]))
            await asyncio.sleep(0.1)
            await self._central_q.put(ADKEvent(sid,tool_res=ADKToolResult(fcid_pizza,'{"status":"pizza ordered","order_id":"P123"}'),state_delta={"action":"tool_result_pizza"}))
            s.add_content_to_history(ADKContent(role="user",parts=[ADKPart(tool_result={"name":"order_food","result":'{"status":"pizza ordered","order_id":"P123"}'})]))

            await self._central_q.put(ADKEvent(sid,txt_chunk="Pizza ordered. Now, ordering coke...",partial=False,turn_comp=True,state_delta={"action":"mid-multi-tool_text"}))
            s.add_message_to_history(role="model",text="Pizza ordered. Now, ordering coke...")

            fcid_coke=f"fc_{uuid.uuid4()}"; await self._central_q.put(ADKEvent(sid,llm_resp=ADKLlmResponse(function_call=ADKFunctionCall("order_drink", '{"item":"coke","quantity":1}',id=fcid_coke)),state_delta={"action":"tool_call_coke"}))
            s.add_content_to_history(ADKContent(role="model",parts=[ADKPart(tool_code=json.dumps({"name":"order_drink","arguments":'{"item":"coke","quantity":1}'}))]))
            await asyncio.sleep(0.1)
            await self._central_q.put(ADKEvent(sid,tool_res=ADKToolResult(fcid_coke,'{"status":"coke ordered","order_id":"C456"}'),state_delta={"action":"tool_result_coke"}))
            s.add_content_to_history(ADKContent(role="user",parts=[ADKPart(tool_result={"name":"order_drink","result":'{"status":"coke ordered","order_id":"C456"}'})]))

            await self._central_q.put(ADKEvent(sid,txt_chunk="Pizza and coke have been ordered!",partial=False,turn_comp=True,state_delta={"action":"post-multi-tool_text"}))
            s.add_message_to_history(role="model",text="Pizza and coke have been ordered!")

        # Flow 3: Simulated LLM/Tool Error
        elif "cause error" in prompt.lower():
            print(f"[ADKSim] Inv {inv_id}: Matched 'cause error' for error simulation flow.")
            await self._central_q.put(ADKEvent(sid,txt_chunk="Attempting an operation that might fail...",partial=False,turn_comp=True,state_delta={"action":"pre-error_op"}))
            s.add_message_to_history(role="model",text="Attempting an operation that might fail...")
            if current_turn_num == 1: # Only error on first attempt for this prompt
                 await self._central_q.put(ADKEvent(sid,err_msg="Simulated LLM error during response generation!",state_delta={"action":"llm_error"}))
                 s.add_message_to_history(role="model",text="[ERROR: LLM error occurred]") # Represent error in history
            else: # If tried again, succeed.
                 await self._central_q.put(ADKEvent(sid,txt_chunk="This time it worked!",partial=False,turn_comp=True,state_delta={"action":"error_op_success_next_time"}))
                 s.add_message_to_history(role="model",text="This time it worked!")

        # Default Flow: Echo or simple response
        else:
            print(f"[ADKSim] Inv {inv_id}: Default flow.")
            resp_text = f"ADK processed: '{prompt}'. History has {len(s.history)} items."
            await self._central_q.put(ADKEvent(sid,txt_chunk=resp_text,partial=False,turn_comp=True,state_delta={"action":"default_echo"}))
            s.add_message_to_history(role="model",text=resp_text)

        # This is for the current turn. If there are more turns for this prompt (multi-back-and-forth),
        # this logic would be re-entered or structured differently. For now, one pass.
        if "and then" in prompt.lower() and current_turn_num < 2 and not ("weather" in prompt.lower() or "order" in prompt.lower() or "error" in prompt.lower()): # Simple multi-turn
            print(f"[ADKSim] Inv {inv_id}: Detected 'and then', simulating a follow-up for default flow.")
            # This is a conceptual follow-up; a real system would await another user message.
            # Here, we simulate the agent deciding to continue.
            await self._process_new_user_message(sid, inv_id, "Okay, what next?", current_turn_num + 1) # Recursive call for simulation
        else: # End of this interaction stream
            await self._trigger_callbacks("after_agent_turn", inv_id, {"session_id":sid,"status":"success","final_state":{"history_length":len(s.history)}})
            await self._central_q.put(ADKEvent(sid,final_event=True))

    async def run_live(self, sid:str, inv_id:str): # (As before)
        try:
            while True:
                event=await self._central_q.get()
                if event.session_id==sid:
                    if event.llm_response: await self._trigger_callbacks("after_llm_response",inv_id,event.llm_response)
                    if event.tool_result: await self._trigger_callbacks("after_tool_execution",inv_id,event.tool_result)
                    yield event
                    if event.is_final_event_for_session: break
                else: await self._central_q.put(event); await asyncio.sleep(0.01)
        except Exception as e:
            print(f"[ADKSim] Error in run_live for inv {inv_id}: {e}")
            await self._trigger_callbacks("after_agent_turn",inv_id,{"session_id":sid,"status":"error","error":str(e)})
            raise # Re-raise to be caught by _adk_run_task

# --- GoogleADKAgent Class (Review and Polish) ---
class GoogleADKAgent:
    def __init__(self, model_config:Optional[Dict[str,Any]]=None):
        self.model_config=model_config; self.session_service=ADKSessionService()
        self.adk_runner=ADKInMemoryRunner(session_service=self.session_service,model_config=self.model_config)
        self.event_queue:asyncio.Queue[str]=asyncio.Queue(); self.ag_ui_event_encoder=AGCoreEventEncoder()
        self._active_tool_calls:Dict[str,Dict[str,Any]]={}; self._current_message_id:Optional[str]=None; self._current_content_id:Optional[str]=None
        # Register persistent callbacks if they don't rely on per-run closure context
        # For this simulation, methods are instance methods and should be fine.
        # However, unregistration in `finally` is safer if agent instance is long-lived across different types of runs.
        # Let's stick to per-run registration/unregistration for max safety in this evolving simulation.

    def _log_event_enqueue(self, event_name: str, invocation_id: str):
        print(f"[Agent] Enqueuing {event_name} for inv {invocation_id}")

    def _convert_ag_ui_messages_to_adk(self, ag_ui_messages:List[Message]) -> List[ADKContent]:
        adk_msgs:List[ADKContent]=[]
        for msg in ag_ui_messages:
            adk_role = "user" # Default
            if msg.role == "user": adk_role = "user"
            elif msg.role == "assistant": adk_role = "model" # ADK uses 'model' for assistant
            elif msg.role == "system": adk_role = "system" # Assuming ADK supports 'system'
            # TODO: Handle other AG-UI roles like 'tool' if necessary for ADK history
            adk_msgs.append(ADKContent(role=adk_role,parts=[ADKPart(text=msg.content)]))
        return adk_msgs

    def _convert_adk_messages_to_ag_ui(self, adk_messages:List[ADKContent], inv_id:str) -> List[Message]:
        ag_ui_msgs:List[Message]=[]
        for i,adk_msg in enumerate(adk_messages):
            ag_ui_role = "user" # Default
            if adk_msg.role == "user": ag_ui_role = "user"
            elif adk_msg.role == "model": ag_ui_role = "assistant"
            elif adk_msg.role == "system": ag_ui_role = "system"
            # TODO: Handle ADK tool call/result parts if they are structured in ADKContent parts
            # For now, assumes text parts are primary for MessagesSnapshotEvent
            content_text = "".join([part.text for part in adk_msg.parts if part.text is not None])
            # If content_text is empty (e.g. pure tool call message in history), decide if to include it
            # For now, include it as it represents a turn.
            ag_ui_msgs.append(Message(id=f"hist_{inv_id}_{i}",role=ag_ui_role,content=content_text))
        return ag_ui_msgs

    async def _before_agent_callback_internal(self, inv_id:str, adk_ctx:Any):
        event = RunStartedEvent(invocationId=inv_id)
        self._log_event_enqueue("RunStartedEvent", inv_id)
        await self.event_queue.put(self.ag_ui_event_encoder.encode(event))

    async def _after_agent_callback_internal(self, inv_id:str, adk_ctx:Any):
        print(f"[Agent] _after_agent_callback_internal for inv {inv_id}, ADK context: {adk_ctx}")
        adk_history = self.adk_runner.get_session_history(adk_ctx["session_id"])
        ag_ui_history = self._convert_adk_messages_to_ag_ui(adk_history, inv_id)

        # Create payload for MessagesSnapshotEvent, ensuring it matches Pydantic model expectations
        # Assuming MessagesSnapshotEvent payload is `{"messages": List[Dict]}`
        messages_payload = [msg.model_dump() for msg in ag_ui_history]
        messages_snapshot_event = MessagesSnapshotEvent(invocationId=inv_id, payload={"messages": messages_payload})
        self._log_event_enqueue("MessagesSnapshotEvent", inv_id)
        await self.event_queue.put(self.ag_ui_event_encoder.encode(messages_snapshot_event))

        if adk_ctx.get("final_state"):
             final_state_event = StateSnapshotEvent(invocationId=inv_id, payload={"state":adk_ctx["final_state"],"reason":"RunFinishedSummary"})
             self._log_event_enqueue("StateSnapshotEvent (final)", inv_id)
             await self.event_queue.put(self.ag_ui_event_encoder.encode(final_state_event))

        finish_event = RunFinishedEvent(invocationId=inv_id)
        self._log_event_enqueue("RunFinishedEvent", inv_id)
        await self.event_queue.put(self.ag_ui_event_encoder.encode(finish_event))

    async def _after_model_callback_internal(self, inv_id:str, adk_llm_response:ADKLlmResponse):
        if adk_llm_response.function_call:
            fc=adk_llm_response.function_call; tc_id=f"tc_{uuid.uuid4()}"
            print(f"[Agent] Tool call requested by LLM (inv {inv_id}, ADK fcID {fc.id}): {fc.name}")
            self._active_tool_calls[tc_id]={"adk_function_call_id":fc.id,"name":fc.name,"invocation_id":inv_id}

            start_event = ToolCallStartEvent(toolCallId=tc_id,payload={"name":fc.name})
            self._log_event_enqueue(f"ToolCallStartEvent ({fc.name})", inv_id)
            await self.event_queue.put(self.ag_ui_event_encoder.encode(start_event))

            args_event = ToolCallArgsEvent(toolCallId=tc_id,payload={"args":fc.arguments_json})
            self._log_event_enqueue(f"ToolCallArgsEvent ({fc.name})", inv_id)
            await self.event_queue.put(self.ag_ui_event_encoder.encode(args_event))

    async def _after_tool_callback_internal(self, inv_id:str, adk_tool_result:ADKToolResult):
        tc_id_to_pop=None; tool_name = "UnknownTool"
        for tc_id,data in self._active_tool_calls.items():
            if data["adk_function_call_id"]==adk_tool_result.function_call_id and data["invocation_id"]==inv_id:
                tc_id_to_pop=tc_id; tool_name = data["name"]; break

        if tc_id_to_pop:
            print(f"[Agent] Tool call result received (inv {inv_id}, ADK fcID {adk_tool_result.function_call_id}): {tool_name}")
            payload={"result":adk_tool_result.result,"isError":adk_tool_result.is_error}
            end_event = ToolCallEndEvent(toolCallId=tc_id_to_pop,payload=payload)
            self._log_event_enqueue(f"ToolCallEndEvent ({tool_name})", inv_id)
            await self.event_queue.put(self.ag_ui_event_encoder.encode(end_event))
            del self._active_tool_calls[tc_id_to_pop]
        else:
            print(f"[Agent] Warning: Received ADK tool result for unknown/unmatched call (inv {inv_id}, ADK fcID {adk_tool_result.function_call_id})")


    async def _adk_run_task(self, session_id:str, inv_id:str, initial_user_prompt_text:str):
        text_started=False; run_error_sent=False
        registered_callbacks = { # Keep track of what was registered for this run
            "before_agent_turn": self._before_agent_callback_internal,
            "after_agent_turn": self._after_agent_callback_internal,
            "after_llm_response": self._after_model_callback_internal,
            "after_tool_execution": self._after_tool_callback_internal,
        }
        try:
            print(f"[Agent] Starting _adk_run_task for inv {inv_id}, session {session_id}")
            for name, cb in registered_callbacks.items(): self.adk_runner.register_event_callback(name, cb)

            request_queue = self.session_service.get_request_queue(session_id)
            adk_event_stream = self.adk_runner.run_live(session_id=session_id, invocation_id=inv_id)
            await request_queue.send_content(invocation_id=inv_id, prompt_text=initial_user_prompt_text)

            async for adk_event in adk_event_stream:
                print(f"[Agent] Processing ADKEvent (inv {inv_id}): text_chunk={adk_event.text_chunk is not None}, state_delta={adk_event.state_delta is not None}, error={adk_event.error_message is not None}")
                if adk_event.error_message:
                    err_payload={"message":adk_event.error_message,"code":"ADK_PROCESSING_ERROR"}
                    err_ev=RunErrorEvent(invocationId=inv_id,payload=err_payload)
                    self._log_event_enqueue("RunErrorEvent (ADK)", inv_id)
                    await self.event_queue.put(self.ag_ui_event_encoder.encode(err_ev)); run_error_sent=True; break

                if adk_event.state_delta:
                    state_ev=StateSnapshotEvent(invocationId=inv_id,payload={"state":adk_event.state_delta})
                    self._log_event_enqueue("StateSnapshotEvent", inv_id)
                    await self.event_queue.put(self.ag_ui_event_encoder.encode(state_ev))

                if adk_event.text_chunk:
                    if not text_started:
                        self._current_message_id=f"msg_{uuid.uuid4()}"; self._current_content_id=f"content_{uuid.uuid4()}"
                        start_ev=TextMessageStartEvent(messageId=self._current_message_id,contentId=self._current_content_id)
                        self._log_event_enqueue("TextMessageStartEvent", inv_id)
                        await self.event_queue.put(self.ag_ui_event_encoder.encode(start_ev)); text_started=True

                    payload={"content":adk_event.text_chunk,"isFinal":not adk_event.partial}
                    ev_model=TextMessageChunkEvent if adk_event.partial else TextMessageContentEvent
                    text_ev=ev_model(messageId=self._current_message_id,contentId=self._current_content_id,payload=payload)
                    self._log_event_enqueue(ev_model.__name__, inv_id) # Uses Pydantic model name if available
                    await self.event_queue.put(self.ag_ui_event_encoder.encode(text_ev))

                    if adk_event.turn_complete and text_started:
                        end_ev=TextMessageEndEvent(messageId=self._current_message_id,contentId=self._current_content_id)
                        self._log_event_enqueue("TextMessageEndEvent", inv_id)
                        await self.event_queue.put(self.ag_ui_event_encoder.encode(end_ev))
                        text_started=False; self._current_message_id=None; self._current_content_id=None

                if adk_event.is_final_event_for_session:
                    print(f"[Agent] Received final event for session from ADK (inv {inv_id})")
                    break

        except Exception as e:
            print(f"[Agent] Exception in _adk_run_task (inv {inv_id}): {type(e).__name__}: {e}")
            if not run_error_sent:
                err_payload={"message":str(e),"code":"AGENT_INTERNAL_ERROR","details":type(e).__name__}
                err_ev=RunErrorEvent(invocationId=inv_id,payload=err_payload)
                self._log_event_enqueue("RunErrorEvent (Internal)", inv_id)
                await self.event_queue.put(self.ag_ui_event_encoder.encode(err_ev))
            # Ensure after_agent_turn is called to attempt sending RunFinishedEvent
            await self.adk_runner._trigger_callbacks("after_agent_turn",inv_id,{"session_id":session_id,"status":"error","error":str(e)})
        finally:
            print(f"[Agent] Finalizing _adk_run_task for inv {inv_id}. Unregistering callbacks.")
            for name, cb in registered_callbacks.items(): self.adk_runner.unregister_event_callback(name, cb)

            conv_end_event = ConversationEndEvent()
            self._log_event_enqueue("ConversationEndEvent", inv_id)
            await self.event_queue.put(self.ag_ui_event_encoder.encode(conv_end_event))

    async def _stream_events(self, inv_id:str) -> AsyncGenerator[str,None]:
        print(f"[Agent] _stream_events started for inv {inv_id}")
        while True:
            encoded_event_str = await self.event_queue.get()
            # print(f"[Agent] Yielding from _stream_events (inv {inv_id}): {encoded_event_str.strip()}") # Can be too verbose
            yield encoded_event_str
            if '"type": "ConversationEnd"' in encoded_event_str:
                 print(f"[Agent] _stream_events detected ConversationEnd for inv {inv_id}. Stopping.")
                 break

    async def run(self, messages:List[Message], tools:Optional[List[Dict[str,Any]]]=None) -> AsyncGenerator[str,None]:
        inv_id = f"inv_{uuid.uuid4()}"
        print(f"[Agent] --- New Run (inv {inv_id}) ---")
        print(f"[Agent] Input messages for inv {inv_id}: {[m.model_dump() for m in messages]}")


        initial_adk_history = self._convert_ag_ui_messages_to_adk(messages)
        latest_user_prompt_text = ""
        if initial_adk_history: # If conversion produced some ADK messages
            # Find the content of the last user message to be used as the current prompt
            for i in range(len(initial_adk_history) -1, -1, -1):
                if initial_adk_history[i].role == "user":
                    # Assuming simple text parts for prompt
                    if initial_adk_history[i].parts:
                         latest_user_prompt_text = initial_adk_history[i].parts[0].text or ""
                    break

        if not latest_user_prompt_text:
            print(f"[Agent] No valid user prompt for current turn (inv {inv_id}). Signaling error.")
            # Use a temporary task to enqueue startup/error/finish events to avoid blocking run
            async def send_no_prompt_error_events():
                await self.event_queue.put(self.ag_ui_event_encoder.encode(RunStartedEvent(invocationId=inv_id)))
                err_payload={"message":"No user prompt found for current turn.","code":"NO_USER_PROMPT_FOR_TURN"}
                await self.event_queue.put(self.ag_ui_event_encoder.encode(RunErrorEvent(invocationId=inv_id,payload=err_payload)))
                await self.event_queue.put(self.ag_ui_event_encoder.encode(RunFinishedEvent(invocationId=inv_id)))
                await self.event_queue.put(self.ag_ui_event_encoder.encode(ConversationEndEvent()))
            asyncio.create_task(send_no_prompt_error_events())
        else:
            # Pass history *excluding* the last user message if it's the current prompt.
            # The ADK simulation's _process_new_user_message will add the current prompt to history.
            history_to_set = []
            if initial_adk_history:
                last_user_msg_index = -1
                for i in range(len(initial_adk_history) -1, -1, -1):
                    if initial_adk_history[i].role == "user":
                        last_user_msg_index = i
                        break
                if last_user_msg_index != -1:
                    history_to_set = initial_adk_history[:last_user_msg_index]
                    # If there are messages after the last user message (e.g. assistant then new user prompt), include them
                    history_to_set.extend(initial_adk_history[last_user_msg_index+1:])


            session_id = await self.session_service.create_session(initial_history=history_to_set)
            print(f"[Agent] Created ADK session {session_id} for inv {inv_id} with {len(history_to_set)} initial history messages.")
            asyncio.create_task(self._adk_run_task(session_id, inv_id, latest_user_prompt_text))

        async for event_json_str in self._stream_events(inv_id): yield event_json_str
        print(f"[Agent] --- Run Finished (inv {inv_id}) ---")

# Example Usage
async def main():
    agent = GoogleADKAgent()
    print(f"--- Starting Test Run: Simple Text ---")
    await run_and_print(agent, [Message(id="m1",role="user",content="Hello there!")])

    print(f"\n--- Starting Test Run: Text-Tool-Text (Weather in Paris) ---")
    await run_and_print(agent, [Message(id="m2",role="user",content="What's the weather in Paris like today, and then tell me a joke based on it?")])

    print(f"\n--- Starting Test Run: Multi-Tool (Order Pizza and Coke) ---")
    await run_and_print(agent, [Message(id="m3",role="user",content="I want to order pizza and coke.")])

    print(f"\n--- Starting Test Run: Simulated Error (then success) ---")
    await run_and_print(agent, [Message(id="m4",role="user",content="Cause error please.")]) # First attempt, expecting error
    # If the agent/ADK were to "remember" this session and try again:
    # For this stateless agent-per-run, this would be a new session.
    # If ADK simulation was changed to succeed on 2nd try for "cause error" *within the same session*,
    # that would require different test setup. The current ADK sim errors once per inv_id for "cause error".
    # To show a success after error, a different prompt or logic in ADK sim is needed.
    # The current ADK sim's `current_turn_num` in `_process_new_user_message` is reset per call.
    # Let's simulate a retry by calling again with the same prompt.
    print(f"\n--- Starting Test Run: Simulated Error (Retry - ADK sim might behave same or differently) ---")
    await run_and_print(agent, [Message(id="m5",role="user",content="Cause error please.")])


    print(f"\n--- Starting Test Run: Multi-Turn Conversation ---")
    history_for_multi_turn = [
        Message(id="mt1", role="user", content="Tell me about the Roman Empire."),
        Message(id="mt2", role="assistant", content="The Roman Empire was vast and influential... (details). It lasted for many centuries."),
        Message(id="mt3", role="user", content="What were its major contributions? And then tell me about its decline.") # "and then" for simulated multi-step in ADK
    ]
    await run_and_print(agent, history_for_multi_turn)

    print(f"\n--- Starting Test Run: No User Prompt ---")
    await run_and_print(agent, [Message(id="s1",role="system",content="You are an AI.")])


async def run_and_print(agent, messages):
    event_count = 0
    async for event_str in agent.run(messages=messages):
        event_count += 1
        print(f"Run Event {event_count}: {event_str.strip()}")
    if event_count == 0: print("No events yielded for this run.")


if __name__ == "__main__": asyncio.run(main())
