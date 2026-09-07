package com.agui.adk;

import com.google.genai.types.Content;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.message.AssistantMessage;
import com.agui.community.core.message.Message;
import com.agui.community.core.message.UserMessage;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

class RunContextBaselineTest {

    @Test
    void shouldInitializeCorrectly_whenAllParametersProvided() {
        String threadId = UUID.randomUUID().toString();
        String runId = UUID.randomUUID().toString();
        String appName = "test-app";
        String userId = "test-user";
        RunAgentInput input = input(threadId, runId, List.of(new UserMessage("1", "Hello")));

        RunContext context = new RunContext(input, appName, userId);

        assertEquals(appName, context.appName());
        assertEquals(userId, context.userId());
        assertEquals(threadId, context.sessionId());
        assertEquals(runId, context.runId());
        Content latestMessage = context.latestMessage();
        assertNotNull(latestMessage);
        assertEquals("user", latestMessage.role().orElse(null));
        assertEquals("Hello", extractFromPartsOf(latestMessage));
    }

    @Test
    @Disabled("Official RunAgentInput 0.2.0 rejects null run IDs before adapter code runs")
    void shouldGenerateRunId_whenNotProvidedInParameters() {
        RunAgentInput input = input(UUID.randomUUID().toString(), null, List.of());

        RunContext context = new RunContext(input, "app", "user");

        assertNotNull(context.runId());
        assertDoesNotThrow(() -> UUID.fromString(context.runId()),
                "Generated runId should be a valid UUID");
    }

    @Test
    void shouldExtractLatestUserMessage_whenMultipleMessagesExist() {
        List<Message> messages = List.of(
                new UserMessage("1", "First message"),
                new AssistantMessage("2", "Some other content"),
                new UserMessage("3", "Latest message"));

        RunContext context = new RunContext(
                input(UUID.randomUUID().toString(), "run-1", messages), "app", "user");

        Content latestMessage = context.latestMessage();
        assertNotNull(latestMessage);
        assertEquals("Latest message", extractFromPartsOf(latestMessage));
    }

    @Test
    void shouldHaveNullLatestMessage_whenNoUserMessagesExist() {
        RunContext context = new RunContext(
                input("thread-1", "run-1", List.of(new AssistantMessage("1", "I am a model"))),
                "app",
                "user");

        assertNull(context.latestMessage());
    }

    @Test
    void shouldHaveNullLatestMessage_whenMessagesListIsEmpty() {
        RunContext context = new RunContext(
                input("thread-1", "run-1", List.of()), "app", "user");

        assertNull(context.latestMessage());
    }

    private static String extractFromPartsOf(Content latestMessage) {
        return latestMessage.parts().filter(items -> !items.isEmpty())
                .flatMap(items -> items.getFirst().text()).orElse(null);
    }

    private static RunAgentInput input(String threadId, String runId, List<Message> messages) {
        return new RunAgentInput(
                threadId,
                runId,
                Map.of(),
                messages,
                List.of(),
                List.of(),
                Map.of());
    }
}
