package com.agui.adk.history;

import static org.assertj.core.api.Assertions.assertThat;

import com.google.adk.events.Event;
import com.google.genai.types.Content;
import com.google.genai.types.FunctionCall;
import com.google.genai.types.Part;
import com.agui.community.core.message.AssistantMessage;
import com.agui.community.core.message.Message;
import com.agui.community.core.message.ToolCall;
import com.agui.community.core.message.ToolMessage;
import com.agui.community.core.message.UserMessage;

import java.util.List;
import java.util.Map;
import java.util.Optional;

import org.junit.jupiter.api.Test;

class AgUiMessageConversionsTest {

    @Test
    void adkEventToUserMessageJoinsTextAndSkipsEmpty() {
        Event user = Event.builder().id("e1").author("user").partial(false)
                .content(Content.builder().role("user").parts(List.of(
                        Part.builder().text("hi").build(), Part.builder().text("").build(),
                        Part.builder().text("there").build())).build()).build();
        Optional<Message> m = AgUiMessageConversions.convertAdkEventToAgUiMessage(user);
        assertThat(m).isPresent();
        assertThat(((UserMessage) m.get()).content()).isEqualTo("hi\nthere");
        // user event with no text -> empty
        Event emptyUser = Event.builder().id("e3").author("user")
                .content(Content.builder().role("user").parts(List.of(
                        Part.builder().functionCall(FunctionCall.builder().name("f").build()).build()))
                        .build()).build();
        assertThat(AgUiMessageConversions.convertAdkEventToAgUiMessage(emptyUser)).isEmpty();
        // event with no parts -> empty
        assertThat(AgUiMessageConversions.convertAdkEventToAgUiMessage(Event.builder().id("e4")
                .author("user").content(Content.builder().role("user").parts(List.of()).build()).build()))
                .isEmpty();
    }

    @Test
    void adkEventToAssistantMessageKeepsTextToolCallsAndOptionalName() {
        Event model = Event.builder().id("e2").author("model").partial(false)
                .content(Content.builder().role("model").parts(List.of(
                        Part.builder().text("ok").build(),
                        Part.builder().functionCall(FunctionCall.builder().name("f").id("c1")
                                .args(Map.of("a", 1)).build()).build())).build()).build();
        AssistantMessage m = (AssistantMessage) AgUiMessageConversions
                .convertAdkEventToAgUiMessage(model).orElseThrow();
        assertThat(m.content()).isEqualTo("ok");
        assertThat(m.name()).isNull();
        assertThat(m.toolCalls()).hasSize(1);
        assertThat(m.toolCalls().get(0).id()).isEqualTo("c1");
        assertThat(m.toolCalls().get(0).function().name()).isEqualTo("f");
        assertThat(m.toolCalls().get(0).function().arguments()).isEqualTo("{\"a\":1}");
        // non-"model" author kept as name
        Event named = Event.builder().id("e5").author("agentX")
                .content(Content.builder().role("model").parts(List.of(
                        Part.builder().text("x").build())).build()).build();
        assertThat(((AssistantMessage) AgUiMessageConversions.convertAdkEventToAgUiMessage(named)
                .orElseThrow()).name()).isEqualTo("agentX");
    }

    @Test
    void agUiMessagesToAdkCreatesTextAndFunctionCallEvents() {
        AssistantMessage am = new AssistantMessage("a1", "hello", null, List.of(
                new ToolCall("c1", new com.agui.community.core.message.FunctionCall("my_fn", "{\"x\":1}"))));
        List<Event> events = AgUiMessageConversions.convertAgUiMessagesToAdk(List.of(am));
        assertThat(events).hasSize(1);
        Event e = events.get(0);
        assertThat(e.author()).isEqualTo("model");
        List<Part> parts = e.content().orElseThrow().parts().orElseThrow();
        assertThat(parts.get(0).text().orElse("")).isEqualTo("hello");
        FunctionCall fc = parts.get(1).functionCall().orElseThrow();
        assertThat(fc.name().orElse("")).isEqualTo("my_fn");
        assertThat(fc.id().orElse("")).isEqualTo("c1");
        assertThat(fc.args().orElseThrow()).containsEntry("x", 1);
    }

    @Test
    void agUiMessagesToAdkToolMessageResolvesFunctionNameByCallId() {
        AssistantMessage am = new AssistantMessage("a1", null, null, List.of(
                new ToolCall("c1", new com.agui.community.core.message.FunctionCall("my_fn", "{}"))));
        ToolMessage tm = new ToolMessage("t1", "result-content", "c1", null);
        List<Event> events = AgUiMessageConversions.convertAgUiMessagesToAdk(List.of(am, tm));
        assertThat(events).hasSize(2);
        Event tool = events.get(1);
        com.google.genai.types.FunctionResponse fr = tool.content().orElseThrow()
                .parts().orElseThrow().get(0).functionResponse().orElseThrow();
        assertThat(fr.name().orElse("")).isEqualTo("my_fn");
        assertThat(fr.response().orElseThrow()).containsEntry("result", "result-content");
        assertThat(fr.id().orElse("")).isEqualTo("c1");
        // no prior assistant message -> name falls back to tool_call_id
        Event fallback = AgUiMessageConversions.convertAgUiMessagesToAdk(List.of(
                new ToolMessage("t2", "x", "nope", null))).get(0);
        com.google.genai.types.FunctionResponse fr2 = fallback.content().orElseThrow()
                .parts().orElseThrow().get(0).functionResponse().orElseThrow();
        assertThat(fr2.name().orElse("")).isEqualTo("nope");
    }
}
