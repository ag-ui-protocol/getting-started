package com.agui.adk;

import com.google.adk.agents.BaseAgent;
import com.google.adk.agents.LlmAgent;
import com.google.adk.agents.RunConfig;
import com.google.adk.models.BaseLlm;
import com.google.adk.sessions.Session;
import com.google.genai.types.Content;
import com.agui.adk.a2ui.A2UISubAgentTool;
import com.agui.adk.context.AdkAgUiRunContext;
import com.agui.adk.encoding.EncodedEvent;
import com.agui.adk.message.MessageReservation;
import com.agui.adk.message.MessageReservationStore;
import com.agui.adk.session.ResolvedSession;
import com.agui.adk.session.SessionMapping;
import com.agui.adk.session.SessionMappingKey;
import com.agui.adk.tool.AgUiToolset;
import com.agui.community.core.agent.Agent;
import com.agui.community.core.agent.Context;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.RunFinishedEvent;
import com.agui.community.core.event.RunStartedEvent;
import com.agui.community.core.message.Message;
import com.agui.community.core.message.UserMessage;
import com.agui.community.core.tool.Tool;
import com.agui.community.core.tool.ToolParameters;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Single;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.when;

/**
 * M-18 — A2UI auto-injection/factory must be wired to the PUBLIC run path ({@code GoogleAdkAgent}):
 * a forwarded {@code injectA2UITool} run flag (or the {@code a2uiConfig} backend option) rebuilds
 * the runner's agent tree per run, injects a queue-bound {@code generate_a2ui} tool on the root,
 * drops the {@code render_a2ui} frontend proxy from the per-run context, and executes the run
 * against that per-run tree. A dev-wired A2UI tool is likewise rebound per run without injection.
 */
@ExtendWith(MockitoExtension.class)
class GoogleAdkAgentA2uiInjectionTest {

    private static final String TEST_USER_ID = "test-user";

    @Mock
    private SessionManager sessionManager;

    private static Tool renderProxy() {
        return new Tool("render_a2ui", "render a surface", new ToolParameters(Map.of(), List.of()));
    }

    private static UserMessage createUserMessage(String messageId) {
        return new UserMessage(messageId, "Hello");
    }

    private static RunAgentInput agentInput(List<Tool> tools, Object forwardedProps) {
        List<Map<String, Object>> rawSchemas = new ArrayList<>();
        for (int i = 0; i < tools.size(); i++) {
            rawSchemas.add(Map.of(
                    "position", i,
                    "name", tools.get(i).name(),
                    "schema", Map.of("type", "object")));
        }
        Map<String, Object> props = new LinkedHashMap<>();
        if (forwardedProps instanceof Map<?, ?> m) {
            for (Map.Entry<?, ?> entry : m.entrySet()) {
                props.put(String.valueOf(entry.getKey()), entry.getValue());
            }
        }
        props.put(com.agui.adk.input.AdkRunExtensions.FORWARDED_PROPS_KEY,
                Map.of("rawToolSchemas", rawSchemas));
        return new RunAgentInput(
                "thread-1",
                "run-1",
                Map.of(),
                List.of(createUserMessage("1")),
                tools,
                List.of(new Context("appName", "test-app")),
                props);
    }

    private static ResolvedSession resolvedSession(RunAgentInput input) {
        Session session = Session.builder(input.threadId())
                .appName("test-app")
                .userId(TEST_USER_ID)
                .state(Map.of(
                        "processedMessageIds", Set.of(),
                        "_ag_ui_message_fingerprints", Map.of()))
                .build();
        return new ResolvedSession(session, new SessionMapping(
                new SessionMappingKey("test-app", TEST_USER_ID, input.threadId()), input.threadId()));
    }

    private GoogleAdkAgent buildAgent(AdkRunnerClient runner, Map<String, Object> a2uiConfig) {
        GoogleAdkAgent created = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(sessionManager)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(input -> TEST_USER_ID)
                .eventEncoder(event -> new EncodedEvent(event, "{}"))
                .a2uiConfig(a2uiConfig)
                .build();
        clearInvocations(sessionManager);
        return created;
    }

    private void stubSession(RunAgentInput input) {
        when(sessionManager.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolvedSession(input)));
        when(sessionManager.acquireExecutionMutationGuard(any())).thenReturn(Single.just(() -> { }));
        when(sessionManager.markMessagesProcessedWithFingerprints(any(), anyList()))
                .thenReturn(Completable.complete());
    }

    @Test
    void synchronousEmptyA2uiRunInvokesRunnerExactlyOnceAndInjectsQueueBoundTool() throws Exception {
        LlmAgent root = LlmAgent.builder()
                .name("root")
                .model(new StubLlm())
                .tools(new AgUiToolset())
                .build();
        RecordingRunner runner = new RecordingRunner(root);
        GoogleAdkAgent agent = buildAgent(runner, Map.of());

        RunAgentInput input = agentInput(List.of(renderProxy()), Map.of("injectA2UITool", true));
        stubSession(input);

        RecordingSubscriber subscriber = subscribe(agent.run(input));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error()).isNull();
        assertThat(subscriber.events()).anyMatch(RunStartedEvent.class::isInstance);
        assertThat(subscriber.events()).anyMatch(RunFinishedEvent.class::isInstance);
        assertThat(runner.runCount).isEqualTo(1);

        // The per-run overload was used: the run executed against a rebuilt per-run tree.
        assertThat(runner.perRunAgent).isNotNull();
        assertThat(runner.perRunAgent).isNotSameAs(root);

        // generate_a2ui was injected on the root, bound to a per-run event queue.
        List<Object> tools = new ArrayList<>();
        collectTools(runner.perRunAgent, tools);
        List<A2UISubAgentTool> a2ui = tools.stream()
                .filter(A2UISubAgentTool.class::isInstance)
                .map(A2UISubAgentTool.class::cast)
                .toList();
        assertThat(a2ui).hasSize(1);
        assertThat(a2ui.get(0).name()).isEqualTo("generate_a2ui");
        assertThat(a2ui.get(0).eventQueue()).isNotNull();

        // The render_a2ui frontend proxy was dropped from the per-run context tools
        // (generate_a2ui lives on the backend per-run agent, not the frontend tool list).
        List<String> perRunToolNames = AdkAgUiRunContext.from(runner.lastRunConfig).orElseThrow()
                .input().tools().stream().map(Tool::name).toList();
        assertThat(perRunToolNames).doesNotContain("render_a2ui");
    }

    @Test
    void backendA2uiConfigInjectsWithoutForwardedFlag() throws Exception {
        LlmAgent root = LlmAgent.builder()
                .name("root")
                .model(new StubLlm())
                .tools(new AgUiToolset())
                .build();
        RecordingRunner runner = new RecordingRunner(root);
        GoogleAdkAgent agent = buildAgent(runner, Map.of("inject_a2ui_tool", true));

        RunAgentInput input = agentInput(List.of(renderProxy()), Map.of());
        stubSession(input);

        RecordingSubscriber subscriber = subscribe(agent.run(input));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error()).isNull();
        assertThat(runner.perRunAgent).isNotNull();
        List<Object> tools = new ArrayList<>();
        collectTools(runner.perRunAgent, tools);
        assertThat(tools.stream().filter(A2UISubAgentTool.class::isInstance).count()).isEqualTo(1);
    }

    @Test
    void devWiredA2uiToolIsReboundPerRunWithoutInjection() throws Exception {
        A2UISubAgentTool devWired = new A2UISubAgentTool("generate_a2ui", "dev", new StubLlm(),
                Map.of("composition_guide", "x"), "surface", "catalog", null, null, null);
        LlmAgent root = LlmAgent.builder()
                .name("root")
                .model(new StubLlm())
                .tools(devWired)
                .build();
        RecordingRunner runner = new RecordingRunner(root);
        GoogleAdkAgent agent = buildAgent(runner, Map.of());

        RunAgentInput input = agentInput(List.of(renderProxy()), Map.of());
        stubSession(input);

        RecordingSubscriber subscriber = subscribe(agent.run(input));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error()).isNull();
        // USER PREVAILS: the dev-wired tool was not double-injected; it was rebound to a per-run queue.
        assertThat(runner.perRunAgent).isNotNull();
        List<Object> tools = new ArrayList<>();
        collectTools(runner.perRunAgent, tools);
        List<A2UISubAgentTool> a2ui = tools.stream()
                .filter(A2UISubAgentTool.class::isInstance)
                .map(A2UISubAgentTool.class::cast)
                .toList();
        assertThat(a2ui).hasSize(1);
        assertThat(a2ui.get(0)).isNotSameAs(devWired);
        assertThat(a2ui.get(0).eventQueue()).isNotNull();
        assertThat(devWired.eventQueue()).isNull();
    }

    @Test
    void ordinaryRunWithoutA2uiStaysOnTheConstructionTimeRunner() throws Exception {
        LlmAgent root = LlmAgent.builder()
                .name("root")
                .model(new StubLlm())
                .tools(new AgUiToolset())
                .build();
        RecordingRunner runner = new RecordingRunner(root);
        GoogleAdkAgent agent = buildAgent(runner, Map.of());

        RunAgentInput input = agentInput(List.of(renderProxy()), Map.of());
        stubSession(input);

        RecordingSubscriber subscriber = subscribe(agent.run(input));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error()).isNull();
        assertThat(runner.perRunAgent).isNull();
        assertThat(runner.runCount).isEqualTo(1);
    }

    private static void collectTools(BaseAgent agent, List<Object> out) {
        if (agent instanceof LlmAgent llm && llm.toolsUnion() != null) {
            out.addAll(llm.toolsUnion());
        }
        if (agent.subAgents() != null) {
            for (BaseAgent sub : agent.subAgents()) {
                collectTools(sub, out);
            }
        }
    }

    private static RecordingSubscriber subscribe(Flow.Publisher<Event> publisher) {
        RecordingSubscriber subscriber = new RecordingSubscriber();
        publisher.subscribe(subscriber);
        return subscriber;
    }

    /** Model stub so the LlmAgent resolves a model (needed for injection). */
    private static final class StubLlm extends BaseLlm {
        StubLlm() {
            super("stub-model");
        }

        @Override
        public Flowable<com.google.adk.models.LlmResponse> generateContent(
                com.google.adk.models.LlmRequest request, boolean streaming) {
            return Flowable.empty();
        }

        @Override
        public com.google.adk.models.BaseLlmConnection connect(com.google.adk.models.LlmRequest request) {
            throw new UnsupportedOperationException("not used in this test");
        }
    }

    private static final class RecordingRunner implements AdkRunnerClient {
        private final BaseAgent rootAgent;
        private BaseAgent perRunAgent;
        private RunConfig lastRunConfig;
        private int runCount;

        RecordingRunner(BaseAgent rootAgent) {
            this.rootAgent = rootAgent;
        }

        @Override
        public String appName() {
            return "test-app";
        }

        @Override
        public Optional<BaseAgent> rootAgent() {
            return Optional.ofNullable(rootAgent);
        }

        @Override
        public Flowable<com.google.adk.events.Event> runAsync(
                String userId, String sessionId, Content content,
                RunConfig runConfig, Map<String, Object> stateDelta) {
            runCount++;
            lastRunConfig = runConfig;
            return Flowable.empty();
        }

        @Override
        public Flowable<com.google.adk.events.Event> runAsync(
                String userId, String sessionId, Content content,
                RunConfig runConfig, Map<String, Object> stateDelta, BaseAgent perRunAgent) {
            runCount++;
            lastRunConfig = runConfig;
            this.perRunAgent = perRunAgent;
            return Flowable.empty();
        }
    }

    private static final class RecordingSubscriber implements Flow.Subscriber<Event> {
        private final List<Event> events = new ArrayList<>();
        private final CountDownLatch terminal = new CountDownLatch(1);
        private Throwable error;
        private Flow.Subscription subscription;

        @Override
        public void onSubscribe(Flow.Subscription subscription) {
            this.subscription = subscription;
            subscription.request(Long.MAX_VALUE);
        }

        @Override
        public void onNext(Event item) {
            events.add(item);
        }

        @Override
        public void onError(Throwable throwable) {
            error = throwable;
            terminal.countDown();
        }

        @Override
        public void onComplete() {
            terminal.countDown();
        }

        boolean await() throws InterruptedException {
            return terminal.await(5, TimeUnit.SECONDS);
        }

        List<Event> events() {
            return events;
        }

        Throwable error() {
            return error;
        }
    }
}
