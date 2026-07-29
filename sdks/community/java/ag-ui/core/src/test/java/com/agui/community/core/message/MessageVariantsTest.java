package com.agui.community.core.message;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * Exercises every concrete {@link Message} variant plus the {@link ToolCall} and
 * {@link FunctionCall} value types: roles, convenience constructors, optional
 * fields and required-field validation.
 */
class MessageVariantsTest {

    /** One instance of each message variant paired with its expected role. */
    static List<Arguments> messagesByRole() {
        return List.of(
                Arguments.of(new DeveloperMessage("m", "do this"), Role.DEVELOPER),
                Arguments.of(new SystemMessage("m", "be helpful"), Role.SYSTEM),
                Arguments.of(new AssistantMessage("m", "hi"), Role.ASSISTANT),
                Arguments.of(new UserMessage("m", "hello"), Role.USER),
                Arguments.of(new ToolMessage("m", "result", "c1"), Role.TOOL));
    }

    @ParameterizedTest(name = "{1}")
    @MethodSource("messagesByRole")
    void messageReportsItsRoleAndId(Message message, Role expected) {
        assertEquals(expected, message.role());
        assertEquals("m", message.id());
    }

    @Test
    void developerMessageWithAndWithoutName() {
        DeveloperMessage withName = new DeveloperMessage("m", "instr", "ops");
        assertEquals("ops", withName.name());
        assertEquals("instr", withName.content());

        assertNull(new DeveloperMessage("m", "instr").name());
    }

    @Test
    void systemMessageWithAndWithoutName() {
        SystemMessage withName = new SystemMessage("m", "ctx", "sys");
        assertEquals("sys", withName.name());

        assertNull(new SystemMessage("m", "ctx").name());
    }

    @Test
    void systemAndDeveloperMessagesRequireIdAndContent() {
        assertThrows(NullPointerException.class, () -> new SystemMessage(null, "c"));
        assertThrows(NullPointerException.class, () -> new SystemMessage("m", null));
        assertThrows(NullPointerException.class, () -> new DeveloperMessage(null, "c"));
        assertThrows(NullPointerException.class, () -> new DeveloperMessage("m", null));
    }

    @Test
    void toolMessageExposesToolCallIdAndOptionalError() {
        ToolMessage ok = new ToolMessage("m", "output", "c1");
        assertEquals("c1", ok.toolCallId());
        assertNull(ok.error());
        assertEquals(Role.TOOL, ok.role());

        ToolMessage failed = new ToolMessage("m", "", "c1", "exploded");
        assertEquals("exploded", failed.error());
    }

    @Test
    void toolMessageRequiresIdContentAndToolCallId() {
        assertThrows(NullPointerException.class, () -> new ToolMessage(null, "c", "t"));
        assertThrows(NullPointerException.class, () -> new ToolMessage("m", null, "t"));
        assertThrows(NullPointerException.class, () -> new ToolMessage("m", "c", null));
    }

    @Test
    void assistantMessageCarriesNameAndToolCalls() {
        ToolCall call = new ToolCall("c1", new FunctionCall("search", "{\"q\":\"x\"}"));
        AssistantMessage message = new AssistantMessage("m", null, "bot", List.of(call));

        assertEquals("bot", message.name());
        assertEquals(1, message.toolCalls().size());
        assertNull(message.content());
    }

    @Test
    void assistantMessageRequiresId() {
        assertThrows(NullPointerException.class, () -> new AssistantMessage(null, "hi"));
    }

    @Test
    void toolCallReportsFunctionTypeAndExposesFunction() {
        FunctionCall function = new FunctionCall("lookup", "{}");
        ToolCall call = new ToolCall("c1", function);

        assertEquals("c1", call.id());
        assertEquals(function, call.function());
        assertEquals(ToolCall.TOOL_CALL_TYPE, call.type());
        assertEquals("function", call.type());
    }

    @Test
    void toolCallRequiresIdAndFunction() {
        assertThrows(NullPointerException.class, () -> new ToolCall(null, new FunctionCall("n", "{}")));
        assertThrows(NullPointerException.class, () -> new ToolCall("c1", null));
    }

    @Test
    void functionCallExposesNameAndArgumentsAndValidates() {
        FunctionCall function = new FunctionCall("search", "{\"q\":1}");
        assertEquals("search", function.name());
        assertEquals("{\"q\":1}", function.arguments());

        assertThrows(NullPointerException.class, () -> new FunctionCall(null, "{}"));
        assertThrows(NullPointerException.class, () -> new FunctionCall("n", null));
    }

    @Test
    void everyMessageVariantIsCovered() {
        long roles = messagesByRole().stream()
                .map(args -> ((Message) args.get()[0]).role())
                .distinct()
                .count();
        assertEquals(Role.values().length, roles, "every role should have a sample message");
        assertTrue(roles == 5);
    }
}
