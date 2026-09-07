package com.agui.adk.processor;

import com.google.genai.types.Content;
import com.google.genai.types.FunctionResponse;
import com.agui.community.core.message.Message;
import com.agui.community.core.message.ToolMessage;
import com.agui.community.core.message.UserMessage;
import java.util.List;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class MessageProcessorBaselineTest {

    @Test
    void emptyInputsProduceNoContent() {
        assertThat(construct(List.of(), List.of())).isEmpty();
    }

    @Test
    void userMessageProducesTextContent() {
        Content content = construct(List.of(new UserMessage("user-1", "Hello, world!")), List.of())
                .orElseThrow();

        assertThat(content.role()).contains("user");
        assertThat(content.parts().orElseThrow()).singleElement()
                .satisfies(part -> assertThat(part.text()).contains("Hello, world!"));
    }

    @Test
    void toolResultProducesFunctionResponseContent() {
        Content content = construct(List.of(), List.of(toolResult())).orElseThrow();

        assertThat(content.role()).contains("user");
        assertThat(content.parts().orElseThrow()).singleElement().satisfies(part -> {
            FunctionResponse response = part.functionResponse().orElseThrow();
            assertThat(response.name()).contains("test-tool");
            assertThat(response.response().orElseThrow()).containsEntry("status", "done");
        });
    }

    @Test
    void toolResultPrecedesUserTextWhenBothArePresent() {
        Content content = construct(
                List.of(new UserMessage("user-1", "Is it done yet?")),
                List.of(toolResult())).orElseThrow();

        assertThat(content.role()).contains("user");
        assertThat(content.parts().orElseThrow()).satisfiesExactly(
                part -> {
                    FunctionResponse response = part.functionResponse().orElseThrow();
                    assertThat(response.name()).contains("test-tool");
                    assertThat(response.response().orElseThrow()).containsEntry("status", "done");
                },
                part -> assertThat(part.text()).contains("Is it done yet?"));
    }

    private static java.util.Optional<Content> construct(List<Message> messages, List<ToolResult> toolResults) {
        return MessageProcessor.INSTANCE.constructMessageToSend(messages, toolResults);
    }

    private static ToolResult toolResult() {
        ToolMessage message = new ToolMessage(
                "tool-message-1", "{\"status\":\"done\"}", "tool-call-1");
        return new ToolResult("test-tool", message);
    }
}
