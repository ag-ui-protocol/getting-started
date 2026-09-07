package com.agui.adk.history;

import com.google.adk.events.Event;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.genai.types.Content;
import com.google.genai.types.FileData;
import com.google.genai.types.FunctionCall;
import com.google.genai.types.FunctionResponse;
import com.google.genai.types.Part;
import com.agui.community.core.message.AssistantMessage;
import com.agui.community.core.message.DeveloperMessage;
import com.agui.community.core.message.Message;
import com.agui.community.core.message.ToolCall;
import com.agui.community.core.message.ToolMessage;
import com.agui.community.core.message.UserMessage;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** P1 #17 — `adk_events_to_messages` history projection (representable subset). */
class AdkEventsToMessagesTest {

    private static Event event(String author, boolean partial, Part... parts) {
        return Event.builder().author(author).partial(partial)
                .content(Content.builder().role(author).parts(List.of(parts)).build())
                .build();
    }

    private static Event event(String id, String author, Part... parts) {
        return Event.builder().id(id).author(author).partial(false)
                .content(Content.builder().role(author).parts(List.of(parts)).build())
                .build();
    }

    @Test
    void userTextBecomesUserMessage() {
        List<Message> out = AdkEventsToMessages.convert(List.of(
                event("user", false, Part.builder().text("hello").build())));
        assertThat(out).hasSize(1);
        assertThat(out.get(0)).isInstanceOf(UserMessage.class);
        assertThat(out.get(0).content()).isEqualTo("hello");
        assertThat(out.get(0).role().value()).isEqualTo("user");
    }

    @Test
    void assistantTextAndToolCallBecomeAssistantMessage() {
        FunctionCall fc = FunctionCall.builder().id("fc1").name("calc").args(Map.of("a", 1)).build();
        List<Message> out = AdkEventsToMessages.convert(List.of(
                event("my_agent", false,
                        Part.builder().text("calling").build(),
                        Part.builder().functionCall(fc).build())));
        assertThat(out).hasSize(1);
        AssistantMessage am = (AssistantMessage) out.get(0);
        assertThat(am.content()).isEqualTo("calling");
        assertThat(am.name()).isEqualTo("my_agent");
        assertThat(am.toolCalls()).hasSize(1);
        ToolCall tc = am.toolCalls().get(0);
        assertThat(tc.id()).isEqualTo("fc1");
        assertThat(tc.function().name()).isEqualTo("calc");
        assertThat(tc.function().arguments()).isEqualTo("{\"a\":1}");
    }

    @Test
    void functionResponseBecomesToolMessage() {
        FunctionResponse fr = FunctionResponse.builder().id("fr1").name("calc")
                .response(Map.of("k", "v")).build();
        List<Message> out = AdkEventsToMessages.convert(List.of(
                event("my_agent", false, Part.builder().functionResponse(fr).build())));
        assertThat(out).hasSize(1);
        ToolMessage tm = (ToolMessage) out.get(0);
        assertThat(tm.toolCallId()).isEqualTo("fr1");
        assertThat(tm.content()).contains("\"k\"");
        assertThat(tm.role().value()).isEqualTo("tool");
    }

    @Test
    void partialAndEmptyEventsAreSkipped() {
        Event partial = event("user", true, Part.builder().text("chunk").build());
        Event empty = Event.builder().author("user").partial(false)
                .content(Content.builder().role("user").parts(List.of()).build()).build();
        List<Message> out = AdkEventsToMessages.convert(List.of(partial, empty));
        assertThat(out).isEmpty();
    }

    @Test
    void reasoningIsPreservedSeparatelyBeforeVisibleAssistantText() {
        List<Message> out = AdkEventsToMessages.convert(List.of(event(
                "evt-1", "model",
                Part.builder().text("hidden reasoning").thought(true).build(),
                Part.builder().text("visible answer").build())));

        assertThat(out).hasSize(2);
        DeveloperMessage reasoning = (DeveloperMessage) out.get(0);
        assertThat(reasoning.id()).isEqualTo("evt-1-reasoning");
        assertThat(reasoning.name()).isEqualTo("reasoning");
        assertThat(reasoning.content()).isEqualTo("hidden reasoning");
        assertThat(out.get(1)).isInstanceOf(AssistantMessage.class);
        assertThat(out.get(1).content()).isEqualTo("visible answer");
    }

    @Test
    void userFileDataIsPreservedAsCanonicalTypedMediaJson() throws Exception {
        List<Message> out = AdkEventsToMessages.convert(List.of(event(
                "evt-media", "user",
                Part.builder().text("attachments").build(),
                file("gs://bucket/image.png", "image/png"),
                file("gs://bucket/audio.mp3", "audio/mpeg"),
                file("gs://bucket/video.mp4", "video/mp4"),
                file("gs://bucket/report.pdf", "application/pdf"))));

        List<Map<String, Object>> content = new ObjectMapper().readValue(
                out.getFirst().content(), new TypeReference<>() { });
        assertThat(content).containsExactly(
                Map.of("type", "text", "text", "attachments"),
                media("image", "gs://bucket/image.png", "image/png"),
                media("audio", "gs://bucket/audio.mp3", "audio/mpeg"),
                media("video", "gs://bucket/video.mp4", "video/mp4"),
                media("document", "gs://bucket/report.pdf", "application/pdf"));
    }

    @Test
    void fileDataWithoutUriIsIgnoredWithoutChangingPlainTextContent() {
        List<Message> out = AdkEventsToMessages.convert(List.of(event(
                "evt-media", "user",
                Part.builder().text("plain").build(),
                Part.builder().fileData(FileData.builder().mimeType("image/png").build()).build())));

        assertThat(out).singleElement().extracting(Message::content).isEqualTo("plain");
    }

    private static Part file(String uri, String mimeType) {
        return Part.builder().fileData(FileData.builder().fileUri(uri).mimeType(mimeType).build()).build();
    }

    private static Map<String, Object> media(String type, String uri, String mimeType) {
        return Map.of("type", type, "source", Map.of(
                "type", "url", "value", uri, "mimeType", mimeType));
    }

    @Test
    void userOnlyThinkingWithoutTextIsSkipped() {
        List<Message> out = AdkEventsToMessages.convert(List.of(
                event("user", false, Part.builder().text("hidden").thought(true).build())));
        assertThat(out).isEmpty();
    }

    @Test
    void findFunctionCallInvocationIdMatchesCallPartId() {
        Event call = com.google.adk.events.Event.builder().author("model").partial(false)
                .invocationId("inv-42").content(Content.builder().role("model").parts(List.of(
                        Part.builder().functionCall(com.google.genai.types.FunctionCall.builder()
                                .id("call-1").name("foo").build()).build())).build()).build();
        Event unrelated = com.google.adk.events.Event.builder().author("model").partial(false)
                .invocationId("inv-99").content(Content.builder().role("model").parts(List.of(
                        Part.builder().functionCall(com.google.genai.types.FunctionCall.builder()
                                .id("call-2").name("bar").build()).build())).build()).build();
        assertThat(AdkEventsToMessages.findFunctionCallInvocationId(List.of(unrelated, call), "call-1"))
                .isEqualTo("inv-42");
        assertThat(AdkEventsToMessages.findFunctionCallInvocationId(List.of(unrelated), "call-1"))
                .isNull();
        assertThat(AdkEventsToMessages.findFunctionCallInvocationId(List.of(unrelated, call), "call-2"))
                .isEqualTo("inv-99");
    }
}
