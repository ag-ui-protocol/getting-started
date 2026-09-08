package com.agui.community.spring.ai;

import com.agui.community.core.agent.Agent;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.RunErrorEvent;
import com.agui.community.core.event.RunFinishedEvent;
import com.agui.community.core.event.RunStartedEvent;
import com.agui.community.core.event.StateDeltaEvent;
import com.agui.community.core.event.StateSnapshotEvent;
import com.agui.community.core.event.ToolCallResultEvent;
import com.agui.community.core.interrupt.Interrupt;
import com.agui.community.core.interrupt.InterruptOutcome;
import com.agui.community.core.interrupt.Resume;
import com.agui.community.core.interrupt.ResumeStatus;
import com.agui.community.core.interrupt.RunOutcome;
import com.agui.community.core.message.Message;
import com.agui.community.core.message.Role;
import com.agui.community.core.tool.Tool;
import com.agui.community.core.tool.ToolParameters;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Flow;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;
import java.util.function.Supplier;
import org.springframework.ai.chat.client.AdvisorParams;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.client.advisor.ToolCallingAdvisor;
import org.springframework.ai.chat.client.advisor.api.Advisor;
import org.springframework.ai.chat.messages.AssistantMessage;
import org.springframework.ai.chat.messages.ToolResponseMessage;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.chat.model.Generation;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.model.tool.ToolCallingChatOptions;
import org.springframework.ai.model.tool.ToolCallingManager;
import org.springframework.ai.model.tool.ToolExecutionResult;
import org.springframework.ai.tool.ToolCallback;
import org.springframework.ai.tool.definition.ToolDefinition;
import org.springframework.ai.util.JsonHelper;
import reactor.adapter.JdkFlowAdapter;
import reactor.core.publisher.Flux;

/**
 * An AG-UI {@link Agent} backed by a Spring AI {@link ChatClient}. The client is
 * the high-level entry point (advisors, memory, default prompts and registered
 * tools) and can be built over any {@code ChatModel} via
 * {@code ChatClient.create(chatModel)} or {@code ChatClient.builder(chatModel)}.
 * Its streamed response is mapped to the AG-UI event lifecycle:
 *
 * <pre>
 * RUN_STARTED
 *   STATE_SNAPSHOT                              (initial state, when state sharing is on)
 *   REASONING_START                             (for &lt;think&gt;...&lt;/think&gt; content)
 *     REASONING_MESSAGE_START
 *       REASONING_MESSAGE_CONTENT*
 *     REASONING_MESSAGE_END
 *   REASONING_END
 *   TEXT_MESSAGE_START                          (when the model produces text)
 *     TEXT_MESSAGE_CONTENT*
 *   TEXT_MESSAGE_END
 *   TOOL_CALL_START                             (per tool call the model requests)
 *     TOOL_CALL_ARGS*
 *   TOOL_CALL_END
 *   STATE_SNAPSHOT                              (when the model calls the state tool)
 * RUN_FINISHED
 * </pre>
 *
 * <p>The agent owns the tool-execution loop. Tools on the {@link RunAgentInput}
 * are <strong>client-side</strong>: they are advertised to the model and surfaced
 * as {@code TOOL_CALL_*} events for the front end to execute. Tools registered via
 * {@link Builder#tools(java.util.List)} are <strong>backend</strong> tools: when
 * the model calls one, the agent emits {@code TOOL_CALL_START/ARGS/END}, executes
 * it, emits a {@code TOOL_CALL_RESULT}, and re-prompts the model with the result
 * (looping until the model stops calling backend tools). If a turn mixes backend
 * and client tool calls, the backend results are emitted and the run then stops so
 * the front end can handle the client calls.
 *
 * <p>With {@link Builder#emitInterruptOutcome(boolean)} enabled, a run that pauses
 * with pending client tool calls finishes with an
 * {@link com.agui.community.core.interrupt.InterruptOutcome} on the
 * {@code RunFinishedEvent} (human-in-the-loop). The front end answers those
 * interrupts on the next run via {@link RunAgentInput#resume()}, which the agent
 * folds back in as tool results. Backend-declared interrupt tools (see
 * {@link Builder#interruptTools(java.util.List)}) are advertised but never executed;
 * a call to one always pauses the run this way, whatever the flag.
 *
 * <p>When state sharing is enabled (see {@link #builder(ChatClient)}), the agent
 * advertises an {@code update_state} tool and injects the current state into the
 * prompt; the model's calls to that tool are intercepted and emitted as state
 * events rather than tool calls, and an initial {@code STATE_SNAPSHOT} echoes the
 * run input's state. State changes are emitted as a full {@code STATE_SNAPSHOT}
 * by default, or as an RFC 6902 {@code STATE_DELTA} when configured with
 * {@link StateUpdates#DELTA}.
 *
 * <p>Text, reasoning and tool-call mapping is performed by
 * {@link SpringAiEventTranslator}. If the model errors, a terminal
 * {@link RunErrorEvent} is emitted instead of propagating the failure, matching
 * the protocol's in-band error handling.
 */
public final class SpringAiAgent implements Agent {

    /** How shared-state changes from the model are emitted to the client. */
    public enum StateUpdates {
        /** Emit the complete new state as a {@code STATE_SNAPSHOT}. */
        SNAPSHOT,
        /** Emit an RFC 6902 JSON Patch (vs. the run's input state) as a {@code STATE_DELTA}. */
        DELTA
    }

    /** The name of the tool the model calls to update AG-UI shared state. */
    static final String STATE_TOOL_NAME = "update_state";

    private static final String STATE_TOOL_DESCRIPTION =
            "Update the shared application state. Pass the complete new state as the 'state' argument; "
                    + "it replaces the current state in full.";

    /** Guards against runaway tool-call loops. */
    private static final int MAX_TOOL_ITERATIONS = 8;

    /** Jackson-backed JSON serializer for tool schemas and shared state. */
    private static final JsonHelper JSON = new JsonHelper();

    private final ChatClient chatClient;
    private final Supplier<String> messageIdGenerator;
    private final boolean shareState;
    private final Function<Object, String> statePrompt;
    private final StateUpdates stateUpdates;
    private final List<ToolCallback> backendTools;
    private final boolean emitInterruptOutcome;
    // Backend-declared interrupt tools: advertised to the model but never executed;
    // a call to one pauses the run as an interrupt (answered via resume), like the
    // state tool but yielding an InterruptOutcome instead of a STATE_SNAPSHOT.
    private final List<Tool> interruptTools;
    private final Set<String> interruptToolNames;
    private final Map<String, Object> interruptToolSchemas;
    private final ToolCallingManager toolCallingManager = ToolCallingManager.builder().build();

    // A tool advisor that injects the tool definitions into the request but never
    // auto-executes (its eligibility checker always returns false), so the agent drives
    // its own tool loop (see continueAfterTurn).
    private final Advisor noExecuteToolAdvisor = ToolCallingAdvisor.builder()
            .toolCallingManager(toolCallingManager)
            .toolExecutionEligibilityChecker(response -> false)
            .build();

    /**
     * Creates an agent over the given {@link ChatClient}, generating random message
     * ids, with state sharing disabled.
     *
     * @param chatClient the Spring AI chat client to drive (required)
     */
    public SpringAiAgent(ChatClient chatClient) {
        this(chatClient, defaultMessageIds(), false, SpringAiAgent::defaultStatePrompt, StateUpdates.SNAPSHOT,
                List.of(), false, List.of());
    }

    /**
     * Creates an agent over the given {@link ChatClient} with a custom message-id
     * generator (useful for tests), with state sharing disabled.
     *
     * @param chatClient         the Spring AI chat client to drive (required)
     * @param messageIdGenerator supplies the id used for the assistant message
     *                           (required)
     */
    public SpringAiAgent(ChatClient chatClient, Supplier<String> messageIdGenerator) {
        this(chatClient, messageIdGenerator, false, SpringAiAgent::defaultStatePrompt, StateUpdates.SNAPSHOT,
                List.of(), false, List.of());
    }

    private SpringAiAgent(ChatClient chatClient, Supplier<String> messageIdGenerator, boolean shareState,
                          Function<Object, String> statePrompt, StateUpdates stateUpdates,
                          List<ToolCallback> backendTools, boolean emitInterruptOutcome,
                          List<Tool> interruptTools) {
        this.chatClient = Objects.requireNonNull(chatClient, "chatClient must not be null");
        this.messageIdGenerator =
                Objects.requireNonNull(messageIdGenerator, "messageIdGenerator must not be null");
        this.shareState = shareState;
        this.statePrompt = Objects.requireNonNull(statePrompt, "statePrompt must not be null");
        this.stateUpdates = Objects.requireNonNull(stateUpdates, "stateUpdates must not be null");
        this.backendTools = List.copyOf(Objects.requireNonNull(backendTools, "backendTools must not be null"));
        this.emitInterruptOutcome = emitInterruptOutcome;
        this.interruptTools =
                List.copyOf(Objects.requireNonNull(interruptTools, "interruptTools must not be null"));
        Set<String> names = new LinkedHashSet<>();
        Map<String, Object> schemas = new java.util.HashMap<>();
        for (Tool tool : this.interruptTools) {
            names.add(tool.name());
            schemas.put(tool.name(), toSchema(tool.parameters()));
        }
        this.interruptToolNames = Set.copyOf(names);
        this.interruptToolSchemas = Map.copyOf(schemas);
    }

    /**
     * The default rendering of the shared state into a system message: the state
     * as JSON plus an instruction to use the {@code update_state} tool.
     *
     * @param state the current shared state (never {@code null} when invoked)
     * @return the system-message text
     */
    private static String defaultStatePrompt(Object state) {
        return "The current shared application state (JSON) is:\n" + JSON.toJson(state)
                + "\nCall the '" + STATE_TOOL_NAME + "' tool with the complete new state to change it.";
    }

    /**
     * Starts building an agent over the given {@link ChatClient}.
     *
     * @param chatClient the Spring AI chat client to drive (required)
     * @return a new builder
     */
    public static Builder builder(ChatClient chatClient) {
        return new Builder(chatClient);
    }

    private static Supplier<String> defaultMessageIds() {
        return () -> UUID.randomUUID().toString();
    }

    /** Builder for {@link SpringAiAgent}. */
    public static final class Builder {

        private final ChatClient chatClient;
        private Supplier<String> messageIdGenerator = defaultMessageIds();
        private boolean shareState;
        private Function<Object, String> statePrompt = SpringAiAgent::defaultStatePrompt;
        private StateUpdates stateUpdates = StateUpdates.SNAPSHOT;
        private List<ToolCallback> backendTools = List.of();
        private boolean emitInterruptOutcome;
        private List<Tool> interruptTools = List.of();

        private Builder(ChatClient chatClient) {
            this.chatClient = chatClient;
        }

        /**
         * Sets the assistant-message id generator (defaults to random UUIDs).
         *
         * @param messageIdGenerator the generator (required)
         * @return this builder
         */
        public Builder messageIdGenerator(Supplier<String> messageIdGenerator) {
            this.messageIdGenerator = messageIdGenerator;
            return this;
        }

        /**
         * Enables AG-UI shared state: the agent advertises an {@code update_state}
         * tool, emits an initial {@code STATE_SNAPSHOT} from the run input, and maps
         * the model's state-tool calls to {@code STATE_SNAPSHOT} events.
         *
         * @param shareState whether to enable state sharing
         * @return this builder
         */
        public Builder shareState(boolean shareState) {
            this.shareState = shareState;
            return this;
        }

        /**
         * Overrides how the shared state is rendered into the prompt the model
         * sees. The function receives the current state and returns the
         * system-message text; returning {@code null} or blank skips injecting the
         * state into the prompt (the initial {@code STATE_SNAPSHOT} and the
         * {@code update_state} tool are still emitted/advertised). Only applies when
         * {@link #shareState(boolean) state sharing} is enabled.
         *
         * @param statePrompt maps the current state to the system-message text
         *                    (required)
         * @return this builder
         */
        public Builder statePrompt(Function<Object, String> statePrompt) {
            this.statePrompt = Objects.requireNonNull(statePrompt, "statePrompt must not be null");
            return this;
        }

        /**
         * Chooses how the model's state changes are emitted: as a full
         * {@code STATE_SNAPSHOT} (default) or as a {@code STATE_DELTA} (an RFC 6902
         * JSON Patch computed against the run's input state). The model always
         * supplies the complete new state via the {@code update_state} tool; in
         * {@code DELTA} mode the agent diffs it. Only applies when
         * {@link #shareState(boolean) state sharing} is enabled.
         *
         * @param stateUpdates the delivery mode (required)
         * @return this builder
         */
        public Builder stateUpdates(StateUpdates stateUpdates) {
            this.stateUpdates = Objects.requireNonNull(stateUpdates, "stateUpdates must not be null");
            return this;
        }

        /**
         * Registers <strong>backend</strong> (server-side) tools the agent executes
         * itself. When the model calls one, the agent emits
         * {@code TOOL_CALL_START/ARGS/END}, runs the tool, emits a
         * {@code TOOL_CALL_RESULT}, and re-prompts the model with the result. This is
         * distinct from the client-side tools on the {@code RunAgentInput}, which are
         * forwarded to the front end and not executed here.
         *
         * @param backendTools the server-side tool callbacks (required)
         * @return this builder
         */
        public Builder tools(List<ToolCallback> backendTools) {
            this.backendTools = Objects.requireNonNull(backendTools, "backendTools must not be null");
            return this;
        }

        /**
         * When enabled, a run that pauses with outstanding <strong>client</strong> tool
         * calls finishes with a {@code RunFinishedEvent} carrying an
         * {@link com.agui.community.core.interrupt.InterruptOutcome} — one
         * {@link com.agui.community.core.interrupt.Interrupt} per pending client tool call
         * (reason {@code "tool_call"}, bound by {@code toolCallId}). The front end answers
         * them on the next run via {@code RunAgentInput.resume()}. This is additive — the
         * {@code TOOL_CALL_*} events are still emitted, so clients that ignore the outcome
         * are unaffected. Disabled by default.
         *
         * @param emitInterruptOutcome whether to emit interrupt outcomes
         * @return this builder
         */
        public Builder emitInterruptOutcome(boolean emitInterruptOutcome) {
            this.emitInterruptOutcome = emitInterruptOutcome;
            return this;
        }

        /**
         * Registers <strong>backend</strong> interrupt tools: advertised to the model but
         * never executed. When the model calls one, the run pauses as an interrupt (reason
         * {@code "input_required"}, with the tool's parameters as the response schema)
         * rather than running anything server-side; the human's answer arrives on the next
         * run via {@code RunAgentInput.resume()} and becomes the tool's result. This mirrors
         * the {@code update_state} state tool, but yields an
         * {@link com.agui.community.core.interrupt.InterruptOutcome}. Interrupt tools always
         * produce an interrupt outcome, regardless of {@link #emitInterruptOutcome(boolean)}.
         *
         * @param interruptTools the interrupt tool declarations (required)
         * @return this builder
         */
        public Builder interruptTools(List<Tool> interruptTools) {
            this.interruptTools = Objects.requireNonNull(interruptTools, "interruptTools must not be null");
            return this;
        }

        /**
         * @return the configured agent
         */
        public SpringAiAgent build() {
            return new SpringAiAgent(chatClient, messageIdGenerator, shareState, statePrompt, stateUpdates,
                    backendTools, emitInterruptOutcome, interruptTools);
        }
    }

    @Override
    public Flow.Publisher<Event> run(RunAgentInput input) {
        Objects.requireNonNull(input, "input must not be null");
        boolean stateAvailable = shareState && Objects.nonNull(input.state());

        List<org.springframework.ai.chat.messages.Message> baseMessages =
                toSpringAiMessages(input.messages());
        // Fold any human-in-the-loop answers to the previous run's interrupts back in as
        // tool results, so the model sees the interrupted tool calls as completed.
        appendResumeResponses(baseMessages, input.resume());
        if (stateAvailable) {
            // Give the model the current state so it can update it meaningfully.
            String prompt = statePrompt.apply(input.state());
            if (Objects.nonNull(prompt) && !prompt.isBlank()) {
                baseMessages.add(0, new org.springframework.ai.chat.messages.SystemMessage(prompt));
            }
        }

        // Tools advertised to the model: client-side (forwarded as events), the
        // state tool (intercepted) and backend tools (executed by this agent).
        List<ToolCallback> advertised = new ArrayList<>(toToolCallbacks(input.tools()));
        if (shareState) {
            advertised.add(stateToolCallback());
        }
        advertised.addAll(backendTools);
        advertised.addAll(toToolCallbacks(interruptTools));
        Set<String> backendToolNames = toolNames(backendTools);
        String stateToolName = shareState ? STATE_TOOL_NAME : null;
        boolean emitDeltas = shareState && stateUpdates == StateUpdates.DELTA;

        // The tool loop records the run outcome (e.g. an interrupt) when it pauses; the
        // terminal RUN_FINISHED, deferred so it runs after the loop, reads it.
        AtomicReference<RunOutcome> outcome = new AtomicReference<>();

        // Deferred so each subscription runs its own tool loop.
        Flux<Event> events = Flux.<Event>defer(() -> Flux.concat(
                        Flux.<Event>just(new RunStartedEvent(input.threadId(), input.runId())),
                        stateAvailable
                                ? Flux.<Event>just(new StateSnapshotEvent(input.state()))
                                : Flux.<Event>empty(),
                        runTurn(baseMessages, advertised, backendToolNames, stateToolName, emitDeltas,
                                input.state(), 0, outcome),
                        Flux.<Event>defer(() -> Flux.<Event>just(new RunFinishedEvent(
                                input.threadId(), input.runId(), outcome.get(), null, null, null)))))
                .onErrorResume(throwable -> Flux.just(new RunErrorEvent(describe(throwable))));

        return JdkFlowAdapter.publisherToFlowPublisher(events);
    }

    /** Streams one model turn, then continues the tool loop if backend tools were called. */
    private Flux<Event> runTurn(List<org.springframework.ai.chat.messages.Message> messages,
                                List<ToolCallback> advertised, Set<String> backendToolNames,
                                String stateToolName, boolean emitDeltas, Object inputState, int depth,
                                AtomicReference<RunOutcome> outcome) {
        String messageId = messageIdGenerator.get();
        SpringAiEventTranslator translator = new SpringAiEventTranslator(messageId, stateToolName);

        Flux<Event> turnEvents = Flux.concat(
                stream(messages, advertised).concatMapIterable(translator::onChunk),
                Flux.defer(() -> Flux.fromIterable(translator.finish())));
        if (emitDeltas) {
            turnEvents = turnEvents.map(event -> asStateDelta(event, inputState));
        }

        return turnEvents.concatWith(Flux.defer(() ->
                continueAfterTurn(messages, translator, advertised, backendToolNames, stateToolName,
                        emitDeltas, inputState, depth, outcome)));
    }

    private Flux<Event> continueAfterTurn(List<org.springframework.ai.chat.messages.Message> messages,
                                          SpringAiEventTranslator translator, List<ToolCallback> advertised,
                                          Set<String> backendToolNames, String stateToolName,
                                          boolean emitDeltas, Object inputState, int depth,
                                          AtomicReference<RunOutcome> outcome) {
        List<AssistantMessage.ToolCall> calls = translator.collectedToolCalls();
        List<AssistantMessage.ToolCall> backendCalls = calls.stream()
                .filter(call -> backendToolNames.contains(call.name()))
                .toList();
        if (backendCalls.isEmpty() || depth >= MAX_TOOL_ITERATIONS) {
            // No backend work (only client tools, the state tool, or plain text): the run
            // ends. Client tools are executed by the front end, and become interrupts.
            recordInterrupts(outcome, pausingCalls(calls, backendToolNames, stateToolName));
            return Flux.empty();
        }

        // Execute the backend tool calls; the result history is used to re-prompt.
        AssistantMessage assistantMessage = AssistantMessage.builder().toolCalls(backendCalls).build();
        ChatResponse toolCallResponse = new ChatResponse(List.of(new Generation(assistantMessage)));
        Prompt executionPrompt = new Prompt(messages,
                ToolCallingChatOptions.builder().toolCallbacks(backendTools).build());
        ToolExecutionResult execution = toolCallingManager.executeToolCalls(executionPrompt, toolCallResponse);

        List<Event> resultEvents = toToolResultEvents(execution);

        if (calls.size() > backendCalls.size()) {
            // Option A: a client tool was also called this turn — surface the backend
            // results, then stop for the client tool calls (which become interrupts).
            recordInterrupts(outcome, pausingCalls(calls, backendToolNames, stateToolName));
            return Flux.fromIterable(resultEvents);
        }

        // Re-prompt the model with the tool results and continue.
        List<org.springframework.ai.chat.messages.Message> nextMessages = execution.conversationHistory();
        return Flux.concat(
                Flux.fromIterable(resultEvents),
                runTurn(nextMessages, advertised, backendToolNames, stateToolName, emitDeltas,
                        inputState, depth + 1, outcome));
    }

    /**
     * The tool calls the agent does not execute itself (neither backend tools nor the
     * state tool): the client tools forwarded to the front end and the backend interrupt
     * tools. These are the calls that pause the run for input.
     */
    private static List<AssistantMessage.ToolCall> pausingCalls(List<AssistantMessage.ToolCall> calls,
            Set<String> backendToolNames, String stateToolName) {
        return calls.stream()
                .filter(call -> !backendToolNames.contains(call.name())
                        && !Objects.equals(call.name(), stateToolName))
                .toList();
    }

    /**
     * Records an interrupt outcome for the pending calls that paused the run. Emitted when
     * interrupt outcomes are enabled, or whenever a backend interrupt tool is among them
     * (interrupt tools always interrupt).
     */
    private void recordInterrupts(AtomicReference<RunOutcome> outcome,
            List<AssistantMessage.ToolCall> pendingCalls) {
        if (pendingCalls.isEmpty()) {
            return;
        }
        boolean hasInterruptTool = pendingCalls.stream()
                .anyMatch(call -> interruptToolNames.contains(call.name()));
        if (emitInterruptOutcome || hasInterruptTool) {
            outcome.set(new InterruptOutcome(pendingCalls.stream().map(this::toInterrupt).toList()));
        }
    }

    private Interrupt toInterrupt(AssistantMessage.ToolCall call) {
        String arguments = Objects.nonNull(call.arguments()) ? call.arguments() : "";
        boolean isInterruptTool = interruptToolNames.contains(call.name());
        String reason = isInterruptTool ? "input_required" : "tool_call";
        Object responseSchema = isInterruptTool ? interruptToolSchemas.get(call.name()) : null;
        return new Interrupt(call.id(), reason, call.name(), call.id(), responseSchema, null,
                Map.of("toolName", call.name(), "arguments", arguments));
    }

    /**
     * Appends each {@code resume} entry as a tool response linked to the interrupt's
     * {@code toolCallId}, so the model sees the interrupted tool call as answered.
     */
    private static void appendResumeResponses(List<org.springframework.ai.chat.messages.Message> messages,
            List<Resume> resume) {
        for (Resume entry : resume) {
            messages.add(org.springframework.ai.chat.messages.ToolResponseMessage.builder()
                    .responses(List.of(new org.springframework.ai.chat.messages.ToolResponseMessage.ToolResponse(
                            entry.interruptId(), "", resumeContent(entry))))
                    .build());
        }
    }

    private static String resumeContent(Resume entry) {
        if (entry.status() == ResumeStatus.CANCELLED) {
            return "The user cancelled this request.";
        }
        Object payload = entry.payload();
        if (Objects.isNull(payload)) {
            return "";
        }
        return payload instanceof String text ? text : JSON.toJson(payload);
    }

    private Flux<ChatResponse> stream(List<org.springframework.ai.chat.messages.Message> messages,
                                      List<ToolCallback> advertised) {
        ChatClient.ChatClientRequestSpec spec = chatClient.prompt().messages(messages);
        if (!advertised.isEmpty()) {
            // Advertise the tools, but suppress the auto-registered ToolCallingAdvisor
            // (which would execute the calls) in favour of our never-executing one, so the
            // agent forwards client tools as events, intercepts the state tool, and runs
            // backend tools itself.
            spec = spec.tools(advertised.toArray())
                    .advisors(AdvisorParams.toolCallingAdvisorAutoRegister(false))
                    .advisors(noExecuteToolAdvisor);
        }
        return spec.stream().chatResponse();
    }

    private List<Event> toToolResultEvents(ToolExecutionResult execution) {
        List<org.springframework.ai.chat.messages.Message> history = execution.conversationHistory();
        if (history.isEmpty()
                || !(history.get(history.size() - 1) instanceof ToolResponseMessage toolResponseMessage)) {
            return List.of();
        }
        List<Event> events = new ArrayList<>();
        for (ToolResponseMessage.ToolResponse response : toolResponseMessage.getResponses()) {
            // Each tool result is its own conversation message: a fresh id (distinct from
            // the assistant turn) with role TOOL, so the front end keeps the assistant tool
            // call - and any generative UI rendered from it - alongside the result rather
            // than overwriting it.
            events.add(new ToolCallResultEvent(messageIdGenerator.get(), response.id(),
                    response.responseData(), Role.TOOL, null, null));
        }
        return events;
    }

    private static Set<String> toolNames(List<ToolCallback> tools) {
        Set<String> names = new LinkedHashSet<>();
        for (ToolCallback tool : tools) {
            names.add(tool.getToolDefinition().name());
        }
        return names;
    }

    private static Event asStateDelta(Event event, Object previousState) {
        if (event instanceof StateSnapshotEvent snapshot) {
            return new StateDeltaEvent(JsonStatePatch.diff(previousState, snapshot.snapshot()));
        }
        return event;
    }

    private static ToolCallback stateToolCallback() {
        ToolDefinition definition = ToolDefinition.builder()
                .name(STATE_TOOL_NAME)
                .description(STATE_TOOL_DESCRIPTION)
                .inputSchema(JSON.toJson(Map.of(
                        "type", "object",
                        "properties", Map.of("state",
                                Map.of("type", "object", "description", "The complete new shared state")),
                        "required", List.of("state"))))
                .build();
        return new AgUiToolCallback(definition);
    }

    private static List<ToolCallback> toToolCallbacks(List<Tool> tools) {
        List<ToolCallback> toolCallbacks = new ArrayList<>();
        for (Tool tool : tools) {
            ToolDefinition definition = ToolDefinition.builder()
                    .name(tool.name())
                    .description(tool.description())
                    .inputSchema(JSON.toJson(toSchema(tool.parameters())))
                    .build();
            toolCallbacks.add(new AgUiToolCallback(definition));
        }
        return toolCallbacks;
    }

    private static Object toSchema(ToolParameters parameters) {
        // A JSON-Schema object: {"type":"object","properties":{...},"required":[...]}.
        return java.util.Map.of(
                "type", parameters.type(),
                "properties", parameters.properties(),
                "required", parameters.required());
    }

    private static List<org.springframework.ai.chat.messages.Message> toSpringAiMessages(
            List<Message> messages) {
        List<org.springframework.ai.chat.messages.Message> result = new ArrayList<>();
        // A tool result references only its call id; remember each call's function name
        // from the assistant turn so the tool-response message can be labelled with it.
        Map<String, String> toolCallNames = new java.util.HashMap<>();
        for (Message message : messages) {
            org.springframework.ai.chat.messages.Message converted =
                    toSpringAiMessage(message, toolCallNames);
            if (Objects.nonNull(converted)) {
                result.add(converted);
            }
        }
        return result;
    }

    private static org.springframework.ai.chat.messages.Message toSpringAiMessage(
            Message message, Map<String, String> toolCallNames) {
        String content = Objects.nonNull(message.content()) ? message.content() : "";
        if (message instanceof com.agui.community.core.message.AssistantMessage assistant
                && hasToolCalls(assistant)) {
            // Preserve the assistant's tool calls so the model sees the calls it has
            // already made and does not repeat them on the next turn.
            return toAssistantWithToolCalls(assistant, content, toolCallNames);
        }
        if (message instanceof com.agui.community.core.message.ToolMessage toolMessage) {
            // Feed the result back as a proper tool response linked to the call id, so the
            // model treats that call as completed rather than requesting it again.
            return toToolResponse(toolMessage, content, toolCallNames);
        }
        return switch (message.role()) {
            case USER -> new org.springframework.ai.chat.messages.UserMessage(content);
            case ASSISTANT -> new org.springframework.ai.chat.messages.AssistantMessage(content);
            case SYSTEM, DEVELOPER -> new org.springframework.ai.chat.messages.SystemMessage(content);
            default -> null;
        };
    }

    private static boolean hasToolCalls(com.agui.community.core.message.AssistantMessage assistant) {
        return Objects.nonNull(assistant.toolCalls()) && !assistant.toolCalls().isEmpty();
    }

    private static org.springframework.ai.chat.messages.AssistantMessage toAssistantWithToolCalls(
            com.agui.community.core.message.AssistantMessage assistant, String content,
            Map<String, String> toolCallNames) {
        List<org.springframework.ai.chat.messages.AssistantMessage.ToolCall> calls = new ArrayList<>();
        for (com.agui.community.core.message.ToolCall toolCall : assistant.toolCalls()) {
            com.agui.community.core.message.FunctionCall function = toolCall.function();
            String name = Objects.nonNull(function) ? function.name() : "";
            String arguments = Objects.nonNull(function) ? function.arguments() : "";
            toolCallNames.put(toolCall.id(), name);
            calls.add(new org.springframework.ai.chat.messages.AssistantMessage.ToolCall(
                    toolCall.id(), toolCall.type(), name, arguments));
        }
        return org.springframework.ai.chat.messages.AssistantMessage.builder()
                .content(content)
                .toolCalls(calls)
                .build();
    }

    private static org.springframework.ai.chat.messages.ToolResponseMessage toToolResponse(
            com.agui.community.core.message.ToolMessage toolMessage, String content,
            Map<String, String> toolCallNames) {
        String name = toolCallNames.getOrDefault(toolMessage.toolCallId(), "");
        return org.springframework.ai.chat.messages.ToolResponseMessage.builder()
                .responses(List.of(
                        new org.springframework.ai.chat.messages.ToolResponseMessage.ToolResponse(
                                toolMessage.toolCallId(), name, content)))
                .build();
    }

    private static String describe(Throwable throwable) {
        String message = throwable.getMessage();
        return Objects.nonNull(message) ? message : throwable.getClass().getSimpleName();
    }
}
