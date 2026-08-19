package com.agui.community.core.message;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class MessageTest {

    @Test
    void userMessageExposesUserRole() {
        UserMessage message = new UserMessage("m1", "hello");
        assertEquals(Role.USER, message.role());
        assertEquals("hello", message.content());
        assertNull(message.name());
    }

    @Test
    void userMessageRequiresIdAndContent() {
        assertThrows(NullPointerException.class, () -> new UserMessage(null, "hi"));
        assertThrows(NullPointerException.class, () -> new UserMessage("m1", null));
    }

    @Test
    void assistantMessageDefaultsToolCallsToEmptyList() {
        AssistantMessage message = new AssistantMessage("m1", "hi", null, null);
        assertTrue(message.toolCalls().isEmpty());
        assertEquals(Role.ASSISTANT, message.role());
    }

    @Test
    void assistantMessageAllowsNullContent() {
        AssistantMessage message = new AssistantMessage("m1", null);
        assertNull(message.content());
    }

    @Test
    void assistantMessageCopiesToolCallsDefensively() {
        List<ToolCall> calls = new ArrayList<>();
        calls.add(new ToolCall("c1", new FunctionCall("search", "{}")));

        AssistantMessage message = new AssistantMessage("m1", null, null, calls);
        calls.clear();

        assertEquals(1, message.toolCalls().size());
        assertThrows(UnsupportedOperationException.class,
                () -> message.toolCalls().add(new ToolCall("c2", new FunctionCall("x", "{}"))));
    }

    @Test
    void messagesExposeSealedHierarchy() {
        Message message = new UserMessage("m1", "hi");
        assertInstanceOf(UserMessage.class, message);
        assertEquals(Role.USER, message.role());
    }
}
