package com.agui.community.spring.ai;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.EventType;
import com.agui.community.core.event.JsonPatchOperation;
import com.agui.community.core.event.RunErrorEvent;
import com.agui.community.core.event.RunFinishedEvent;
import com.agui.community.core.event.StateDeltaEvent;
import com.agui.community.core.event.StateSnapshotEvent;
import com.agui.community.core.event.TextMessageContentEvent;
import com.agui.community.core.event.ToolCallResultEvent;
import com.agui.community.core.event.ToolCallStartEvent;
import com.agui.community.core.interrupt.Interrupt;
import com.agui.community.core.interrupt.InterruptOutcome;
import com.agui.community.core.interrupt.Resume;
import com.agui.community.core.interrupt.ResumeStatus;
import com.agui.community.core.message.Role;
import com.agui.community.core.message.UserMessage;
import com.agui.community.core.tool.Tool;
import com.agui.community.core.tool.ToolParameters;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;
import org.junit.jupiter.api.Test;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.messages.AssistantMessage;
import org.springframework.ai.chat.messages.ToolResponseMessage;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.chat.model.Generation;
import org.springframework.ai.chat.model.ToolContext;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.tool.ToolCallback;
import org.springframework.ai.tool.definition.ToolDefinition;
import reactor.adapter.JdkFlowAdapter;
import reactor.core.publisher.Flux;

/**
 * End-to-end tests that drive the agent through a real {@link ChatClient} (built
 * over a fake {@link ChatModel}). The detailed chunk-to-event mapping is covered
 * by {@link SpringAiEventTranslatorTest}.
 */
class SpringAiAgentTest {

    private static final RunAgentInput INPUT = new RunAgentInput("t1", "r1",
            List.of(new UserMessage("m1", "hi")), List.of());

    @Test
    void emitsInterruptOutcomeForPendingClientToolCallsWhenEnabled() {
        Tool tool = new Tool("get_weather", "Get the weather",
                new ToolParameters(Map.of("city", Map.of("type", "string")), List.of("city")));
        ChatModel model = streaming(toolChunk("call-1", "get_weather", "{\"city\":\"Paris\"}"));
        RunAgentInput input = new RunAgentInput("t1", "r1",
                List.of(new UserMessage("m1", "weather?")), List.of(tool));
        SpringAiAgent agent = SpringAiAgent.builder(ChatClient.create(model))
                .messageIdGenerator(sequentialIds())
                .emitInterruptOutcome(true)
                .build();

        List<Event> events = collect(agent.run(input));

        RunFinishedEvent finished = (RunFinishedEvent) events.get(events.size() - 1);
        InterruptOutcome outcome = assertInstanceOf(InterruptOutcome.class, finished.outcome());
        assertEquals(1, outcome.interrupts().size());
        Interrupt interrupt = outcome.interrupts().get(0);
        assertEquals("call-1", interrupt.id());
        assertEquals("call-1", interrupt.toolCallId());
        assertEquals("tool_call", interrupt.reason());
        assertEquals("get_weather", interrupt.message());
        // Additive: the client tool call is still surfaced as TOOL_CALL_* events.
        assertTrue(events.stream().anyMatch(e -> e.type() == EventType.TOOL_CALL_START));
    }

    @Test
    void doesNotEmitInterruptOutcomeByDefault() {
        Tool tool = new Tool("get_weather", "Get the weather",
                new ToolParameters(Map.of("city", Map.of("type", "string")), List.of("city")));
        ChatModel model = streaming(toolChunk("call-1", "get_weather", "{\"city\":\"Paris\"}"));
        RunAgentInput input = new RunAgentInput("t1", "r1",
                List.of(new UserMessage("m1", "weather?")), List.of(tool));
        SpringAiAgent agent = new SpringAiAgent(ChatClient.create(model), sequentialIds());

        List<Event> events = collect(agent.run(input));

        RunFinishedEvent finished = (RunFinishedEvent) events.get(events.size() - 1);
        assertNull(finished.outcome());
    }

    @Test
    void foldsResumeAnswersBackInAsToolResults() {
        AtomicReference<Prompt> captured = new AtomicReference<>();
        RunAgentInput input = new RunAgentInput("t1", "r1", null,
                List.of(new UserMessage("u1", "weather?")), List.of(), List.of(), null,
                List.of(new Resume("call-1", ResumeStatus.RESOLVED, "sunny")));
        SpringAiAgent agent = new SpringAiAgent(ChatClient.create(capturingModel(captured)), () -> "msg-1");

        collect(agent.run(input));

        ToolResponseMessage toolResponse = captured.get().getInstructions().stream()
                .filter(ToolResponseMessage.class::isInstance)
                .map(ToolResponseMessage.class::cast)
                .findFirst()
                .orElseThrow();
        ToolResponseMessage.ToolResponse response = toolResponse.getResponses().get(0);
        assertEquals("call-1", response.id());
        assertEquals("sunny", response.responseData());
    }

    @Test
    void backendInterruptToolPausesTheRunEvenWithoutTheFlag() {
        Tool approval = new Tool("request_approval", "Ask the human to approve",
                new ToolParameters(Map.of("approved", Map.of("type", "boolean")), List.of("approved")));
        ChatModel model = streaming(toolChunk("call-9", "request_approval", "{}"));
        // emitInterruptOutcome is NOT set: interrupt tools always interrupt.
        SpringAiAgent agent = SpringAiAgent.builder(ChatClient.create(model))
                .messageIdGenerator(sequentialIds())
                .interruptTools(List.of(approval))
                .build();

        List<Event> events = collect(agent.run(INPUT));

        RunFinishedEvent finished = (RunFinishedEvent) events.get(events.size() - 1);
        InterruptOutcome outcome = assertInstanceOf(InterruptOutcome.class, finished.outcome());
        Interrupt interrupt = outcome.interrupts().get(0);
        assertEquals("call-9", interrupt.toolCallId());
        assertEquals("input_required", interrupt.reason());
        assertEquals("request_approval", interrupt.message());
        // the tool's parameters are advertised as the expected response schema
        assertNotNull(interrupt.responseSchema());
    }

    @Test
    void wrapsTheModelResponseInTheRunLifecycle() {
        ChatClient chatClient = ChatClient.create(streaming(chunk("hello")));
        SpringAiAgent agent = new SpringAiAgent(chatClient, () -> "msg-1");

        List<Event> events = collect(agent.run(INPUT));

        assertEquals(EventType.RUN_STARTED, events.get(0).type());
        assertEquals(EventType.RUN_FINISHED, events.get(events.size() - 1).type());
        assertTrue(events.stream().anyMatch(e -> e.type() == EventType.TEXT_MESSAGE_START));
        assertTrue(events.stream().anyMatch(e -> e.type() == EventType.TEXT_MESSAGE_END));

        String text = events.stream()
                .filter(e -> e instanceof TextMessageContentEvent)
                .map(e -> ((TextMessageContentEvent) e).delta())
                .reduce("", String::concat);
        assertEquals("hello", text);
    }

    @Test
    void streamsTextFromAnAsynchronousModel() {
        ChatModel asyncModel = new ChatModel() {
            @Override
            public ChatResponse call(Prompt prompt) {
                return new ChatResponse(List.of());
            }

            @Override
            public Flux<ChatResponse> stream(Prompt prompt) {
                // Emit on another thread, as a real model (Ollama) does.
                return Flux.just(chunk("Hello "), chunk("world"))
                        .delayElements(java.time.Duration.ofMillis(10));
            }
        };
        SpringAiAgent agent = new SpringAiAgent(ChatClient.create(asyncModel), () -> "msg-1");

        List<Event> events = collect(agent.run(INPUT));

        String text = events.stream()
                .filter(e -> e instanceof TextMessageContentEvent)
                .map(e -> ((TextMessageContentEvent) e).delta())
                .reduce("", String::concat);
        assertEquals("Hello world", text);
    }

    @Test
    void surfacesModelFailureAsRunError() {
        ChatModel failing = new ChatModel() {
            @Override
            public ChatResponse call(Prompt prompt) {
                throw new IllegalStateException("model exploded");
            }

            @Override
            public Flux<ChatResponse> stream(Prompt prompt) {
                return Flux.error(new IllegalStateException("model exploded"));
            }
        };
        SpringAiAgent agent = new SpringAiAgent(ChatClient.create(failing), () -> "msg-1");

        List<Event> events = collect(agent.run(INPUT));
        Event last = events.get(events.size() - 1);

        RunErrorEvent error = assertInstanceOf(RunErrorEvent.class, last);
        assertTrue(error.message().contains("model exploded"), error.message());
    }

    @Test
    void forwardsRunInputToolCallsWithoutExecutingThem() {
        // A client-side tool from the run input. In Spring AI 2.0.0 the advertised tools
        // are carried by the ToolCallingAdvisor rather than on the captured Prompt options,
        // so we verify the agent's contract behaviourally: when the model calls a client
        // tool, the agent surfaces it as TOOL_CALL_* events and does NOT execute it itself.
        Tool tool = new Tool("get_weather", "Get the weather for a city",
                new ToolParameters(Map.of("city", Map.of("type", "string")), List.of("city")));
        ChatModel model = streaming(toolChunk("call-1", "get_weather", "{\"city\":\"Paris\"}"));
        RunAgentInput input = new RunAgentInput("t1", "r1",
                List.of(new UserMessage("m1", "weather?")), List.of(tool));

        SpringAiAgent agent = new SpringAiAgent(ChatClient.create(model), sequentialIds());
        List<Event> events = collect(agent.run(input));

        ToolCallStartEvent start = (ToolCallStartEvent) events.stream()
                .filter(e -> e.type() == EventType.TOOL_CALL_START)
                .findFirst()
                .orElseThrow();
        assertEquals("get_weather", start.toolCallName());
        // The agent must not run a client tool itself (no backend result emitted).
        assertTrue(events.stream().noneMatch(e -> e.type() == EventType.TOOL_CALL_RESULT),
                "client tools must be forwarded, not executed by the agent");
        assertEquals(EventType.RUN_FINISHED, events.get(events.size() - 1).type());
    }

    @Test
    void emitsInitialStateSnapshotAndAdvertisesStateToolWhenSharingEnabled() {
        AtomicReference<Prompt> captured = new AtomicReference<>();
        ChatModel capturing = new ChatModel() {
            @Override
            public ChatResponse call(Prompt prompt) {
                return new ChatResponse(List.of());
            }

            @Override
            public Flux<ChatResponse> stream(Prompt prompt) {
                captured.set(prompt);
                return Flux.just(chunk("ok"));
            }
        };
        RunAgentInput input = new RunAgentInput("t1", "r1", Map.of("count", 1),
                List.of(new UserMessage("m1", "hi")), List.of(), List.of(), null);
        SpringAiAgent agent = SpringAiAgent.builder(ChatClient.create(capturing))
                .messageIdGenerator(() -> "msg-1")
                .shareState(true)
                .build();

        List<Event> events = collect(agent.run(input));

        // Initial snapshot is emitted right after RUN_STARTED.
        assertEquals(EventType.RUN_STARTED, events.get(0).type());
        StateSnapshotEvent snapshot = assertInstanceOf(StateSnapshotEvent.class, events.get(1));
        assertEquals(Map.of("count", 1), snapshot.snapshot());

        // The update_state tool is advertised: the model's prompt references it.
        assertTrue(captured.get().getContents().contains("update_state"), captured.get().getContents());
    }

    @Test
    void emitsNoStateEventsWhenSharingDisabled() {
        ChatClient chatClient = ChatClient.create(streaming(chunk("ok")));
        RunAgentInput input = new RunAgentInput("t1", "r1", Map.of("count", 1),
                List.of(new UserMessage("m1", "hi")), List.of(), List.of(), null);
        SpringAiAgent agent = new SpringAiAgent(chatClient, () -> "msg-1");

        List<Event> events = collect(agent.run(input));

        assertTrue(events.stream().noneMatch(e -> e.type() == EventType.STATE_SNAPSHOT));
    }

    @Test
    void injectsStateIntoThePromptByDefault() {
        AtomicReference<Prompt> captured = new AtomicReference<>();
        RunAgentInput input = new RunAgentInput("t1", "r1", Map.of("count", 7),
                List.of(new UserMessage("m1", "hi")), List.of(), List.of(), null);
        SpringAiAgent agent = SpringAiAgent.builder(ChatClient.create(capturingModel(captured)))
                .messageIdGenerator(() -> "msg-1")
                .shareState(true)
                .build();

        collect(agent.run(input));

        String prompt = captured.get().getContents();
        assertTrue(prompt.contains("count"), prompt);
        assertTrue(prompt.contains("update_state"), prompt);
    }

    @Test
    void usesACustomStatePromptWhenConfigured() {
        AtomicReference<Prompt> captured = new AtomicReference<>();
        RunAgentInput input = new RunAgentInput("t1", "r1", Map.of("count", 7),
                List.of(new UserMessage("m1", "hi")), List.of(), List.of(), null);
        SpringAiAgent agent = SpringAiAgent.builder(ChatClient.create(capturingModel(captured)))
                .messageIdGenerator(() -> "msg-1")
                .shareState(true)
                .statePrompt(state -> "SHARED_STATE_MARKER " + state)
                .build();

        collect(agent.run(input));

        assertTrue(captured.get().getContents().contains("SHARED_STATE_MARKER"), captured.get().getContents());
    }

    @Test
    void emitsStateDeltaWhenConfiguredForDeltaUpdates() {
        ChatModel model = streaming(toolChunk("call-1", "update_state", "{\"state\":{\"count\":2}}"));
        RunAgentInput input = new RunAgentInput("t1", "r1", Map.of("count", 1),
                List.of(new UserMessage("m1", "increment")), List.of(), List.of(), null);
        SpringAiAgent agent = SpringAiAgent.builder(ChatClient.create(model))
                .messageIdGenerator(() -> "msg-1")
                .shareState(true)
                .stateUpdates(SpringAiAgent.StateUpdates.DELTA)
                .build();

        List<Event> events = collect(agent.run(input));

        // Initial baseline is still a snapshot; the model's update becomes a delta.
        assertTrue(events.stream().anyMatch(e -> e.type() == EventType.STATE_SNAPSHOT));
        StateDeltaEvent delta = (StateDeltaEvent) events.stream()
                .filter(e -> e.type() == EventType.STATE_DELTA)
                .findFirst()
                .orElseThrow();
        assertEquals(1, delta.delta().size());
        JsonPatchOperation op = delta.delta().get(0);
        assertEquals("replace", op.op());
        assertEquals("/count", op.path());
        assertEquals(2, ((Number) op.value()).intValue());
    }

    private static ChatResponse toolChunk(String id, String name, String arguments) {
        AssistantMessage message = AssistantMessage.builder()
                .toolCalls(List.of(new AssistantMessage.ToolCall(id, "function", name, arguments)))
                .build();
        return new ChatResponse(List.of(new Generation(message)));
    }

    @Test
    void executesBackendToolEmitsResultAndContinues() {
        ToolCallback weather = backendTool("getWeather", "{\"temperature\":21}");
        ChatModel model = new ChatModel() {
            @Override
            public ChatResponse call(Prompt prompt) {
                return new ChatResponse(List.of());
            }

            @Override
            public Flux<ChatResponse> stream(Prompt prompt) {
                boolean afterToolResult = prompt.getInstructions().stream()
                        .anyMatch(m -> m instanceof ToolResponseMessage);
                if (afterToolResult) {
                    return Flux.just(chunk("It is 21 degrees in Paris."));
                }
                AssistantMessage toolCall = AssistantMessage.builder()
                        .toolCalls(List.of(new AssistantMessage.ToolCall(
                                "call-1", "function", "getWeather", "{\"location\":\"Paris\"}")))
                        .build();
                return Flux.just(new ChatResponse(List.of(new Generation(toolCall))));
            }
        };
        SpringAiAgent agent = SpringAiAgent.builder(ChatClient.create(model))
                .messageIdGenerator(sequentialIds())
                .tools(List.of(weather))
                .build();

        List<Event> events = collect(agent.run(INPUT));

        assertEquals(
                List.of(
                        EventType.RUN_STARTED,
                        EventType.TOOL_CALL_START,
                        EventType.TOOL_CALL_ARGS,
                        EventType.TOOL_CALL_END,
                        EventType.TOOL_CALL_RESULT,
                        EventType.TEXT_MESSAGE_START,
                        EventType.TEXT_MESSAGE_CONTENT,
                        EventType.TEXT_MESSAGE_END,
                        EventType.RUN_FINISHED),
                events.stream().map(Event::type).toList());

        ToolCallResultEvent result = (ToolCallResultEvent) events.stream()
                .filter(e -> e.type() == EventType.TOOL_CALL_RESULT)
                .findFirst()
                .orElseThrow();
        assertEquals("call-1", result.toolCallId());
        assertTrue(result.content().contains("21"), result.content());

        // The result is its own conversation message: role TOOL and a fresh id, distinct
        // from the assistant turn that made the call - so a front end does not overwrite
        // the assistant tool call (and any generative UI rendered from it) with the result.
        assertEquals(Role.TOOL, result.role());
        ToolCallStartEvent start = (ToolCallStartEvent) events.stream()
                .filter(e -> e.type() == EventType.TOOL_CALL_START)
                .findFirst()
                .orElseThrow();
        assertNotEquals(start.parentMessageId(), result.messageId(),
                "tool result must not reuse the assistant message id");
    }

    @Test
    void emitsBackendResultThenStopsWhenAClientToolIsAlsoCalled() {
        ToolCallback weather = backendTool("getWeather", "{\"temperature\":21}");
        ChatModel model = new ChatModel() {
            @Override
            public ChatResponse call(Prompt prompt) {
                return new ChatResponse(List.of());
            }

            @Override
            public Flux<ChatResponse> stream(Prompt prompt) {
                AssistantMessage toolCalls = AssistantMessage.builder()
                        .toolCalls(List.of(
                                new AssistantMessage.ToolCall("call-1", "function", "getWeather", "{}"),
                                new AssistantMessage.ToolCall("call-2", "function", "showDialog", "{}")))
                        .build();
                return Flux.just(new ChatResponse(List.of(new Generation(toolCalls))));
            }
        };
        // showDialog is a client-side tool from the run input.
        Tool clientTool = new Tool("showDialog", "Show a dialog",
                new ToolParameters(Map.of(), List.of()));
        RunAgentInput input = new RunAgentInput("t1", "r1",
                List.of(new UserMessage("m1", "hi")), List.of(clientTool));
        SpringAiAgent agent = SpringAiAgent.builder(ChatClient.create(model))
                .messageIdGenerator(sequentialIds())
                .tools(List.of(weather))
                .build();

        List<Event> events = collect(agent.run(input));

        // The backend result is emitted, but there is no second (text) turn — the
        // run stops so the front end can run the client tool call.
        assertTrue(events.stream().anyMatch(e -> e.type() == EventType.TOOL_CALL_RESULT));
        assertTrue(events.stream().noneMatch(e -> e.type() == EventType.TEXT_MESSAGE_CONTENT));
        assertEquals(EventType.RUN_FINISHED, events.get(events.size() - 1).type());
    }

    @Test
    void carriesPriorAssistantToolCallsAndToolResultsIntoThePrompt() {
        // A prior turn where the model called a client tool and the front end answered.
        // These must be reconstructed for the model, otherwise it re-issues the same call
        // every turn (the client-tool loop).
        var toolCall = new com.agui.community.core.message.ToolCall(
                "call-1", new com.agui.community.core.message.FunctionCall(
                        "setThemeColor", "{\"themeColor\":\"green\"}"));
        var assistant = new com.agui.community.core.message.AssistantMessage("a1", "", null, List.of(toolCall));
        var toolResult = new com.agui.community.core.message.ToolMessage(
                "tr1", "Changing theme color to green", "call-1");

        AtomicReference<Prompt> captured = new AtomicReference<>();
        RunAgentInput input = new RunAgentInput("t1", "r1",
                List.of(new UserMessage("u1", "Set the theme to green"), assistant, toolResult), List.of());
        SpringAiAgent agent = new SpringAiAgent(ChatClient.create(capturingModel(captured)), () -> "msg-1");

        collect(agent.run(input));

        List<org.springframework.ai.chat.messages.Message> sent = captured.get().getInstructions();
        // The assistant turn keeps its tool call...
        boolean hasToolCall = sent.stream()
                .filter(m -> m instanceof AssistantMessage)
                .map(m -> (AssistantMessage) m)
                .flatMap(m -> m.getToolCalls().stream())
                .anyMatch(call -> "setThemeColor".equals(call.name()));
        assertTrue(hasToolCall, "assistant tool call must be carried into the prompt");
        // ...and the result is a ToolResponseMessage linked by the call id.
        ToolResponseMessage toolResponse = (ToolResponseMessage) sent.stream()
                .filter(m -> m instanceof ToolResponseMessage)
                .findFirst()
                .orElseThrow();
        assertEquals("call-1", toolResponse.getResponses().get(0).id());
    }

    private static Supplier<String> sequentialIds() {
        AtomicInteger counter = new AtomicInteger();
        return () -> "m" + counter.incrementAndGet();
    }

    private static ToolCallback backendTool(String name, String result) {
        return new ToolCallback() {
            @Override
            public ToolDefinition getToolDefinition() {
                return ToolDefinition.builder()
                        .name(name)
                        .description("test backend tool")
                        .inputSchema("{\"type\":\"object\",\"properties\":{}}")
                        .build();
            }

            @Override
            public String call(String toolInput) {
                return result;
            }

            @Override
            public String call(String toolInput, ToolContext toolContext) {
                return result;
            }
        };
    }

    private static ChatModel capturingModel(AtomicReference<Prompt> captured) {
        return new ChatModel() {
            @Override
            public ChatResponse call(Prompt prompt) {
                return new ChatResponse(List.of());
            }

            @Override
            public Flux<ChatResponse> stream(Prompt prompt) {
                captured.set(prompt);
                return Flux.just(chunk("ok"));
            }
        };
    }

    private static List<Event> collect(java.util.concurrent.Flow.Publisher<Event> publisher) {
        return JdkFlowAdapter.flowPublisherToFlux(publisher).collectList().block();
    }

    private static ChatResponse chunk(String text) {
        return new ChatResponse(List.of(new Generation(new AssistantMessage(text))));
    }

    private static ChatModel streaming(ChatResponse... chunks) {
        return new ChatModel() {
            @Override
            public ChatResponse call(Prompt prompt) {
                return chunks.length > 0 ? chunks[chunks.length - 1] : new ChatResponse(List.of());
            }

            @Override
            public Flux<ChatResponse> stream(Prompt prompt) {
                return Flux.fromArray(chunks);
            }
        };
    }
}
