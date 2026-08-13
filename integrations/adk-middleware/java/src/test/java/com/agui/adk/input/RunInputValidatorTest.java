package com.agui.adk.input;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.interrupt.Resume;
import com.agui.community.core.interrupt.ResumeStatus;
import com.agui.community.core.message.Message;
import com.agui.community.core.message.UserMessage;
import com.agui.community.core.tool.Tool;
import com.agui.community.core.tool.ToolParameters;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class RunInputValidatorTest {

    private final RunInputValidator validator = new RunInputValidator();
    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void acceptsValidInputAndMatchingRawSchema() {
        RunAgentInput input = input(
                "thread-1",
                "run-1",
                List.of(new UserMessage("message-1", "hello")),
                List.of(tool("show_sports_list")));
        AdkRunExtensions extensions = extensions(0, "show_sports_list");

        assertThatCode(() -> validator.validate(input, extensions)).doesNotThrowAnyException();
    }

    @Test
    void officialTypesRejectNullThreadRunAndMessageIds() {
        assertThatThrownBy(() -> input(null, "run-1", validMessages(), List.of()))
                .isInstanceOf(NullPointerException.class)
                .hasMessage("threadId must not be null");
        assertThatThrownBy(() -> input("thread-1", null, validMessages(), List.of()))
                .isInstanceOf(NullPointerException.class)
                .hasMessage("runId must not be null");
        assertThatThrownBy(() -> new UserMessage(null, "hello"))
                .isInstanceOf(NullPointerException.class)
                .hasMessage("id must not be null");
    }

    @Test
    void rejectsBlankThreadRunAndMessageIds() {
        assertInvalid(input(" ", "run-1", validMessages(), List.of()), "threadId");
        assertInvalid(input("thread-1", " ", validMessages(), List.of()), "runId");
        assertInvalid(
                input("thread-1", "run-1", List.of(new UserMessage(" ", "hello")), List.of()),
                "message id");
    }

    @Test
    void rejectsDuplicateMessageIdWithDifferentContent() {
        RunAgentInput input = input(
                "thread-1",
                "run-1",
                List.of(
                        new UserMessage("message-1", "first"),
                        new UserMessage("message-1", "second")),
                List.of());

        assertInvalid(input, "duplicate message id message-1 has different content");
    }

    @Test
    void allowsDuplicateMessageIdWithIdenticalContent() {
        UserMessage message = new UserMessage("message-1", "same");
        RunAgentInput input = input(
                "thread-1",
                "run-1",
                List.of(message, new UserMessage("message-1", "same")),
                List.of());

        assertThatCode(() -> validator.validate(input, null)).doesNotThrowAnyException();
    }

    @Test
    void validatesOfficialResumeListBeforeRuntimeRouting() {
        RunAgentInput duplicate = new RunAgentInput(
                "thread-1", "run-1", Map.of(), validMessages(), List.of(), List.of(), Map.of(),
                List.of(
                        new Resume("interrupt-1", ResumeStatus.RESOLVED, Map.of("value", true)),
                        new Resume("interrupt-1", ResumeStatus.CANCELLED, null)));
        assertInvalid(duplicate, "duplicate resume interruptId interrupt-1");

        RunAgentInput cancelledPayload = new RunAgentInput(
                "thread-1", "run-1", Map.of(), validMessages(), List.of(), List.of(), Map.of(),
                List.of(new Resume("interrupt-1", ResumeStatus.CANCELLED, Map.of("value", false))));
        assertInvalid(cancelledPayload, "cancelled resume payload must be null");

        RunAgentInput valid = new RunAgentInput(
                "thread-1", "run-1", Map.of(), validMessages(), List.of(), List.of(), Map.of(),
                List.of(
                        new Resume("interrupt-1", ResumeStatus.RESOLVED, Map.of("value", true)),
                        new Resume("interrupt-2", ResumeStatus.CANCELLED, null)));
        assertThatCode(() -> validator.validate(valid, null)).doesNotThrowAnyException();
    }

    @Test
    void rejectsRawSchemaPositionOutsideOfficialToolList() {
        RunAgentInput input = input(
                "thread-1",
                "run-1",
                validMessages(),
                List.of(tool("show_sports_list")));

        assertInvalid(input, extensions(1, "show_sports_list"), "position 1");
    }

    @Test
    void rejectsRawSchemaNameMismatchAtTheSamePosition() {
        RunAgentInput input = input(
                "thread-1",
                "run-1",
                validMessages(),
                List.of(tool("show_sports_list")));

        assertInvalid(input, extensions(0, "approve_payment"), "does not match official tool");
    }

    @Test
    void rejectsBlankParentRunIdWhenPresent() {
        RunAgentInput input = input(
                "thread-1",
                "run-1",
                validMessages(),
                List.of());
        AdkRunExtensions extensions = new AdkRunExtensions(" ", List.of());

        assertInvalid(input, extensions, "parentRunId");
    }

    private void assertInvalid(RunAgentInput input, String detail) {
        assertInvalid(input, null, detail);
    }

    private void assertInvalid(
            RunAgentInput input,
            AdkRunExtensions extensions,
            String detail) {
        assertThatThrownBy(() -> validator.validate(input, extensions))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("INVALID_RUN_INPUT")
                .hasMessageContaining(detail);
    }

    private static List<Message> validMessages() {
        return List.of(new UserMessage("message-1", "hello"));
    }

    private static Tool tool(String name) {
        return new Tool(name, "description", new ToolParameters(Map.of(), List.of()));
    }

    private AdkRunExtensions extensions(int position, String name) {
        return new AdkRunExtensions(
                "parent-1",
                List.of(new RawToolSchema(position, name, mapper.createObjectNode())));
    }

    private static RunAgentInput input(
            String threadId,
            String runId,
            List<Message> messages,
            List<Tool> tools) {
        return new RunAgentInput(
                threadId,
                runId,
                Map.of(),
                messages,
                tools,
                List.of(),
                Map.of());
    }
}
