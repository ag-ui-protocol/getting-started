package com.agui.adk;

import com.google.adk.agents.BaseAgent;
import com.google.adk.agents.LlmAgent;
import com.google.adk.agents.RunConfig;
import com.google.adk.agents.SequentialAgent;
import com.google.adk.events.Event;
import com.google.adk.sessions.Session;
import com.google.genai.types.Content;
import com.google.genai.types.Part;
import com.google.genai.types.Schema;
import com.google.genai.types.Type;
import com.agui.adk.context.AdkAgUiRunContext;
import com.agui.adk.session.ResolvedSession;
import com.agui.adk.session.SessionMapping;
import com.agui.adk.session.SessionMappingKey;
import com.agui.community.core.agent.Context;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.RunErrorEvent;
import com.agui.community.core.event.TextMessageContentEvent;
import com.agui.community.core.event.TextMessageEndEvent;
import com.agui.community.core.event.TextMessageStartEvent;
import com.agui.community.core.message.Message;
import com.agui.community.core.message.UserMessage;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Single;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.when;

/**
 * Audit finding M-01: output_schema text suppression must be wired to the public run path.
 *
 * <p>Python discovers the agents that declare an {@code output_schema} from the agent tree and
 * hands their names to the event translator, which then suppresses user-visible text authored by
 * those agents (GitHub #1390). The bridge previously only supported a manually supplied name set,
 * so structured JSON from classifiers could leak into the chat. These tests prove that the public
 * {@link GoogleAdkAgent} run path discovers output_schema agents from the runner's agent tree
 * (including nested workflow children) and suppresses their text through the default translator
 * factory.
 */
@ExtendWith(MockitoExtension.class)
class GoogleAdkAgentOutputSchemaSuppressionTest {

    @Mock
    private SessionManager sessionManager;

    @Test
    void runPathDiscoversOutputSchemaAgentAndSuppressesItsText() throws InterruptedException {
        LlmAgent classifier = LlmAgent.builder()
                .name("classifier")
                .model("gemini-3.5-flash")
                .outputSchema(Schema.builder().type(Type.Known.STRING).build())
                .build();
        LlmAgent worker = LlmAgent.builder().name("worker").model("gemini-3.5-flash").build();
        BaseAgent pipeline = SequentialAgent.builder()
                .name("pipeline")
                .subAgents(List.of(classifier, worker))
                .build();
        LlmAgent root = LlmAgent.builder()
                .name("root")
                .model("gemini-3.5-flash")
                .subAgents(List.of(pipeline))
                .build();

        Flowable<com.google.adk.events.Event> adkEvents = Flowable.just(
                adkTextEvent("classifier", "CHAT"),
                adkTextEvent("root", "Hello there"));
        GoogleAdkAgent agent = agent(root, adkEvents);

        RecordingSubscriber subscriber = subscribe(agent.run(input()));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error()).isNull();
        assertThat(subscriber.events()).noneMatch(RunErrorEvent.class::isInstance);
        List<TextMessageContentEvent> text = subscriber.events().stream()
                .filter(TextMessageContentEvent.class::isInstance)
                .map(TextMessageContentEvent.class::cast)
                .toList();
        // The classifier's structured output is suppressed; the root's chat text is visible.
        assertThat(text).extracting(TextMessageContentEvent::delta).containsExactly("Hello there");
    }

    @Test
    void runPathDoesNotSuppressTextWhenTreeHasNoOutputSchemaAgent() throws InterruptedException {
        LlmAgent root = LlmAgent.builder()
                .name("root")
                .model("gemini-3.5-flash")
                .subAgents(List.of(LlmAgent.builder().name("worker").model("gemini-3.5-flash").build()))
                .build();

        Flowable<com.google.adk.events.Event> adkEvents = Flowable.just(
                adkTextEvent("worker", "plain answer"),
                adkTextEvent("root", "Hello there"));
        GoogleAdkAgent agent = agent(root, adkEvents);

        RecordingSubscriber subscriber = subscribe(agent.run(input()));

        assertThat(subscriber.await()).isTrue();
        List<TextMessageContentEvent> text = subscriber.events().stream()
                .filter(TextMessageContentEvent.class::isInstance)
                .map(TextMessageContentEvent.class::cast)
                .toList();
        assertThat(text).extracting(TextMessageContentEvent::delta)
                .containsExactly("plain answer", "Hello there");
    }

    @Test
    void runPathSuppressesDeeplyNestedOutputSchemaAgentInWorkflowChildren() throws InterruptedException {
        LlmAgent deep = LlmAgent.builder()
                .name("deep-classifier")
                .model("gemini-3.5-flash")
                .outputSchema(Schema.builder().type(Type.Known.STRING).build())
                .build();
        BaseAgent inner = SequentialAgent.builder()
                .name("inner")
                .subAgents(List.of(deep))
                .build();
        BaseAgent outer = SequentialAgent.builder()
                .name("outer")
                .subAgents(List.of(inner))
                .build();
        LlmAgent root = LlmAgent.builder()
                .name("root")
                .model("gemini-3.5-flash")
                .subAgents(List.of(outer))
                .build();

        Flowable<com.google.adk.events.Event> adkEvents = Flowable.just(
                adkTextEvent("deep-classifier", "{\"label\":42}"),
                adkTextEvent("root", "Visible answer"));
        GoogleAdkAgent agent = agent(root, adkEvents);

        RecordingSubscriber subscriber = subscribe(agent.run(input()));

        assertThat(subscriber.await()).isTrue();
        List<TextMessageContentEvent> text = subscriber.events().stream()
                .filter(TextMessageContentEvent.class::isInstance)
                .map(TextMessageContentEvent.class::cast)
                .toList();
        assertThat(text).extracting(TextMessageContentEvent::delta).containsExactly("Visible answer");
    }

    private GoogleAdkAgent agent(BaseAgent rootAgent, Flowable<com.google.adk.events.Event> adkEvents) {
        when(sessionManager.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolvedSession()));
        when(sessionManager.acquireExecutionMutationGuard(any())).thenReturn(Single.just(() -> {
        }));
        when(sessionManager.markMessagesProcessedWithFingerprints(any(), anyList()))
                .thenReturn(Completable.complete());
        return GoogleAdkAgent.builder()
                .runner(new TreeRunner(rootAgent, adkEvents))
                .sessionManager(sessionManager)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "user")
                .build();
    }

    private static com.google.adk.events.Event adkTextEvent(String author, String text) {
        return Event.builder()
                .author(author)
                .content(Content.builder().role("model")
                        .parts(List.of(Part.builder().text(text).build()))
                        .build())
                .build();
    }

    private static RunAgentInput input() {
        return new RunAgentInput(
                "thread-1",
                "run-1",
                Map.of(),
                List.of(new UserMessage("message-1", "Hello")),
                List.of(),
                List.of(new Context("appName", "test-app")),
                Map.of());
    }

    private static ResolvedSession resolvedSession() {
        Session session = Session.builder("thread-1")
                .appName("test-app")
                .userId("user")
                .state(Map.of())
                .build();
        return new ResolvedSession(session, new SessionMapping(
                new SessionMappingKey("test-app", "user", "thread-1"), "thread-1"));
    }

    private static RecordingSubscriber subscribe(Flow.Publisher<com.agui.community.core.event.Event> publisher) {
        RecordingSubscriber subscriber = new RecordingSubscriber();
        publisher.subscribe(subscriber);
        return subscriber;
    }

    /** Runner exposing the constructed agent tree so the run path can discover output_schema names. */
    private static final class TreeRunner implements AdkRunnerClient {
        private final BaseAgent rootAgent;
        private final Flowable<com.google.adk.events.Event> adkEvents;

        private TreeRunner(BaseAgent rootAgent, Flowable<com.google.adk.events.Event> adkEvents) {
            this.rootAgent = rootAgent;
            this.adkEvents = adkEvents;
        }

        @Override
        public String appName() {
            return "test-app";
        }

        @Override
        public Optional<BaseAgent> rootAgent() {
            return Optional.of(rootAgent);
        }

        @Override
        public Flowable<com.google.adk.events.Event> runAsync(
                String userId,
                String sessionId,
                com.google.genai.types.Content content,
                RunConfig runConfig,
                Map<String, Object> stateDelta) {
            return adkEvents;
        }
    }

    private static final class RecordingSubscriber implements Flow.Subscriber<com.agui.community.core.event.Event> {
        private final List<com.agui.community.core.event.Event> events = new ArrayList<>();
        private final CountDownLatch terminal = new CountDownLatch(1);
        private Throwable error;

        @Override
        public void onSubscribe(Flow.Subscription subscription) {
            subscription.request(Long.MAX_VALUE);
        }

        @Override
        public void onNext(com.agui.community.core.event.Event item) {
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

        List<com.agui.community.core.event.Event> events() {
            return events;
        }

        Throwable error() {
            return error;
        }
    }
}
