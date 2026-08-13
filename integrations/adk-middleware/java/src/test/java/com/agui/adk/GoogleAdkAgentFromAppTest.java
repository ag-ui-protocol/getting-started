package com.agui.adk;

import com.google.adk.agents.BaseAgent;
import com.google.adk.agents.LlmAgent;
import com.google.adk.apps.App;
import com.agui.community.core.agent.Context;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.RunErrorEvent;
import com.agui.community.core.event.RunFinishedEvent;
import com.agui.community.core.event.RunStartedEvent;
import com.agui.community.core.message.UserMessage;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Audit finding M-07: the canonical {@code ADKAgent.from_app} factory (App + ADK services) must
 * have a Java equivalent that wires the App's root agent, plugins and configuration into the
 * public run path instead of requiring a pre-composed runner and manager.
 */
class GoogleAdkAgentFromAppTest {

    @Test
    void fromAppWiresTheAppIntoTheAgentRunner() throws Exception {
        BaseAgent root = LlmAgent.builder().name("assistant").build();
        App app = App.builder().name("my_assistant").rootAgent(root).build();

        GoogleAdkAgent agent = GoogleAdkAgent.fromApp(
                app,
                ignored -> "user",
                new com.google.adk.sessions.InMemorySessionService(),
                new com.google.adk.memory.InMemoryMemoryService(),
                new com.google.adk.artifacts.InMemoryArtifactService(),
                AdkAgUiOptions.defaults());

        // The App's name and root agent are carried into the agent's runner (Python from_app).
        AdkRunnerClient runner = agentRunner(agent);
        assertThat(runner.appName()).isEqualTo("my_assistant");
        assertThat(runner.rootAgent()).hasValueSatisfying(
                wired -> assertThat(wired).isSameAs(root));
    }

    @Test
    void fromAppAgentRunsOnThePublicRunPath() throws Exception {
        BaseAgent root = LlmAgent.builder().name("assistant").build();
        App app = App.builder().name("my_assistant").rootAgent(root).build();

        GoogleAdkAgent agent = GoogleAdkAgent.fromApp(
                app,
                ignored -> "user",
                new com.google.adk.sessions.InMemorySessionService(),
                new com.google.adk.memory.InMemoryMemoryService(),
                new com.google.adk.artifacts.InMemoryArtifactService(),
                AdkAgUiOptions.defaults());

        RecordingSubscriber subscriber = new RecordingSubscriber();
        agent.run(input()).subscribe(subscriber);

        // The run reaches the ADK runner (the App's root agent executes) and completes the public
        // lifecycle. A model-less LlmAgent surfaces an execution error event instead of a hang.
        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.events).first().isInstanceOf(RunStartedEvent.class);
        assertThat(subscriber.events).last()
                .isInstanceOfAny(RunFinishedEvent.class, RunErrorEvent.class);
    }

    private static AdkRunnerClient agentRunner(GoogleAdkAgent agent) throws Exception {
        Field field = GoogleAdkAgent.class.getDeclaredField("runner");
        field.setAccessible(true);
        return (AdkRunnerClient) field.get(agent);
    }

    private static RunAgentInput input() {
        return new RunAgentInput(
                "thread-1",
                "run-1",
                Map.of(),
                List.of(new UserMessage("message-1", "Hello")),
                List.of(),
                List.of(new Context("appName", "my_assistant")),
                Map.of());
    }

    private static final class RecordingSubscriber implements Flow.Subscriber<Event> {
        private final List<Event> events = new ArrayList<>();
        private final CountDownLatch terminal = new CountDownLatch(1);
        private final AtomicReference<Throwable> error = new AtomicReference<>();

        @Override
        public void onSubscribe(Flow.Subscription subscription) {
            subscription.request(Long.MAX_VALUE);
        }

        @Override
        public void onNext(Event event) {
            events.add(event);
        }

        @Override
        public void onError(Throwable throwable) {
            error.set(throwable);
            terminal.countDown();
        }

        @Override
        public void onComplete() {
            terminal.countDown();
        }

        boolean await() throws InterruptedException {
            return terminal.await(10, TimeUnit.SECONDS);
        }
    }
}
