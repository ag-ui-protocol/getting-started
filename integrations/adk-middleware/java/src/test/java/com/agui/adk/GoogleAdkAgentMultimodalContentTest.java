package com.agui.adk;

import com.google.adk.agents.RunConfig;
import com.google.adk.sessions.Session;
import com.google.genai.types.Content;
import com.google.genai.types.Part;
import com.agui.adk.context.AdkAgUiRunContext;
import com.agui.adk.session.ResolvedSession;
import com.agui.adk.session.SessionMapping;
import com.agui.adk.session.SessionMappingKey;
import com.agui.community.core.agent.Context;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.RunErrorEvent;
import com.agui.community.core.message.UserMessage;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Single;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.when;

/**
 * Audit finding M-02: the multimodal content conversion must be wired to the public run path.
 *
 * <p>Python sends inline image/audio/video/document content to the model; the bridge's
 * {@code MessageContentPartsConverter} helper was never called in production, so user content was
 * flattened to text. These tests prove that {@link GoogleAdkAgent} (the public run path) converts
 * structured AG-UI content — received as its JSON serialization on the text-only agui4j wire —
 * into Google inline-data / file-data parts before invoking the runner.
 */
@ExtendWith(MockitoExtension.class)
class GoogleAdkAgentMultimodalContentTest {

    @Mock
    private SessionManager sessionManager;

    @Test
    void runPathConvertsInlineImageContentToInlineDataParts() throws InterruptedException {
        String png = Base64.getEncoder().encodeToString(new byte[]{(byte) 0x89, 'P', 'N', 'G'});
        String contentJson = "["
                + "{\"type\":\"text\",\"text\":\"Describe this image.\"},"
                + "{\"type\":\"image\",\"source\":{\"type\":\"data\",\"mimeType\":\"image/png\",\"value\":\"" + png + "\"}}"
                + "]";
        CapturingRunner runner = new CapturingRunner();
        GoogleAdkAgent agent = agent(runner);

        RecordingSubscriber subscriber = subscribe(agent.run(input(contentJson)));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error()).isNull();
        assertThat(subscriber.events()).noneMatch(RunErrorEvent.class::isInstance);
        assertThat(runner.lastContent).isNotNull();
        List<Part> parts = runner.lastContent.parts().orElseThrow();
        assertThat(parts).hasSize(2);
        assertThat(parts.get(0).text()).hasValue("Describe this image.");
        assertThat(parts.get(1).inlineData()).isPresent();
        assertThat(parts.get(1).inlineData().get().mimeType()).hasValue("image/png");
        assertThat(parts.get(1).inlineData().get().data())
                .hasValue(Base64.getDecoder().decode(png));
    }

    @Test
    void runPathConvertsDocumentUrlContentToFileDataParts() throws InterruptedException {
        String contentJson = "["
                + "{\"type\":\"document\",\"source\":{\"type\":\"url\",\"mimeType\":\"application/pdf\",\"value\":\"https://x.example/report.pdf\"}}"
                + "]";
        CapturingRunner runner = new CapturingRunner();
        GoogleAdkAgent agent = agent(runner);

        RecordingSubscriber subscriber = subscribe(agent.run(input(contentJson)));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error()).isNull();
        List<Part> parts = runner.lastContent.parts().orElseThrow();
        assertThat(parts).singleElement().satisfies(part -> {
            assertThat(part.fileData()).isPresent();
            assertThat(part.fileData().get().fileUri()).hasValue("https://x.example/report.pdf");
            assertThat(part.fileData().get().mimeType()).hasValue("application/pdf");
        });
    }

    @Test
    void runPathKeepsPlainTextContentAsText() throws InterruptedException {
        CapturingRunner runner = new CapturingRunner();
        GoogleAdkAgent agent = agent(runner);

        RecordingSubscriber subscriber = subscribe(agent.run(input("Just plain text")));

        assertThat(subscriber.await()).isTrue();
        List<Part> parts = runner.lastContent.parts().orElseThrow();
        assertThat(parts).singleElement().satisfies(part -> assertThat(part.text()).hasValue("Just plain text"));
    }

    @Test
    void runPathFallsBackToTextForLiteralArrayLikeText() throws InterruptedException {
        CapturingRunner runner = new CapturingRunner();
        GoogleAdkAgent agent = agent(runner);

        // A JSON array whose items are not content objects yields no parts -> raw text is kept.
        RecordingSubscriber subscriber = subscribe(agent.run(input("[1,2,3]")));

        assertThat(subscriber.await()).isTrue();
        List<Part> parts = runner.lastContent.parts().orElseThrow();
        assertThat(parts).singleElement().satisfies(part -> assertThat(part.text()).hasValue("[1,2,3]"));
    }

    private GoogleAdkAgent agent(CapturingRunner runner) {
        when(sessionManager.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolvedSession()));
        when(sessionManager.acquireExecutionMutationGuard(any())).thenReturn(Single.just(() -> {
        }));
        when(sessionManager.markMessagesProcessedWithFingerprints(any(), anyList()))
                .thenReturn(Completable.complete());
        return GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(sessionManager)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "user")
                .build();
    }

    private static RunAgentInput input(String content) {
        return new RunAgentInput(
                "thread-1",
                "run-1",
                Map.of(),
                List.of(new UserMessage("message-1", content)),
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

    private static RecordingSubscriber subscribe(Flow.Publisher<Event> publisher) {
        RecordingSubscriber subscriber = new RecordingSubscriber();
        publisher.subscribe(subscriber);
        return subscriber;
    }

    private static final class CapturingRunner implements AdkRunnerClient {
        private Content lastContent;

        @Override
        public String appName() {
            return "test-app";
        }

        @Override
        public Flowable<com.google.adk.events.Event> runAsync(
                String userId,
                String sessionId,
                Content content,
                RunConfig runConfig,
                Map<String, Object> stateDelta) {
            lastContent = content;
            return Flowable.empty();
        }
    }

    private static final class RecordingSubscriber implements Flow.Subscriber<Event> {
        private final List<Event> events = new ArrayList<>();
        private final CountDownLatch terminal = new CountDownLatch(1);
        private Throwable error;

        @Override
        public void onSubscribe(Flow.Subscription subscription) {
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
