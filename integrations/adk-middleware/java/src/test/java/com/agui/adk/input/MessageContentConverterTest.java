package com.agui.adk.input;

import com.google.genai.types.Content;
import com.google.genai.types.Part;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MessageContentConverterTest {

    private final MessageContentConverter converter = new MessageContentConverter();

    @Test
    void convertsLegacyTextContent() {
        Content content = converter.convert("hello");

        assertThat(content.role()).contains("user");
        assertThat(content.parts()).hasValueSatisfying(parts -> {
            assertThat(parts).singleElement();
            assertThat(parts.getFirst().text()).contains("hello");
        });
    }

    @Test
    void convertsOrderedTextInlineDataAndUriParts() {
        String encoded = Base64.getEncoder()
                .encodeToString("image-bytes".getBytes(StandardCharsets.UTF_8));
        List<Map<String, Object>> parts = List.of(
                Map.of("type", "text", "text", "describe this"),
                Map.of(
                        "type", "binary",
                        "mimeType", "image/png",
                        "data", encoded,
                        "filename", "photo.png"),
                Map.of(
                        "type", "binary",
                        "mimeType", "application/pdf",
                        "url", "gs://documents/report.pdf"));

        Content content = converter.convert(parts);
        List<Part> converted = content.parts().orElseThrow();

        assertThat(converted).hasSize(3);
        assertThat(converted.get(0).text()).contains("describe this");
        assertThat(converted.get(1).inlineData()).hasValueSatisfying(blob -> {
            assertThat(blob.mimeType()).contains("image/png");
            assertThat(blob.data()).hasValueSatisfying(data ->
                    assertThat(new String(data, StandardCharsets.UTF_8))
                            .isEqualTo("image-bytes"));
        });
        assertThat(converted.get(2).fileData()).hasValueSatisfying(file -> {
            assertThat(file.mimeType()).contains("application/pdf");
            assertThat(file.fileUri()).contains("gs://documents/report.pdf");
        });
    }

    @Test
    void convertsCanonicalPartsWrapperAndBinaryIdAsUri() {
        Content content = converter.convert(Map.of(
                "parts",
                List.of(Map.of(
                        "type", "binary",
                        "mimeType", "image/jpeg",
                        "id", "files/abc123"))));

        Part part = content.parts().orElseThrow().getFirst();
        assertThat(part.fileData()).hasValueSatisfying(file -> {
            assertThat(file.mimeType()).contains("image/jpeg");
            assertThat(file.fileUri()).contains("files/abc123");
        });
    }

    @Test
    void rejectsInvalidInlineBase64Data() {
        assertInvalid(
                List.of(Map.of(
                        "type", "binary",
                        "mimeType", "image/png",
                        "data", "not base64%%%")),
                "base64");
    }

    @Test
    void rejectsBinaryContentWithoutMimeType() {
        assertInvalid(
                List.of(Map.of(
                        "type", "binary",
                        "data", Base64.getEncoder().encodeToString(new byte[]{1, 2, 3}))),
                "mimeType");
    }

    @Test
    void rejectsUnsupportedStructuredContent() {
        assertInvalid(
                List.of(Map.of("type", "audio", "audio", "opaque")),
                "unsupported structured content type audio");
    }

    @Test
    void rejectsBinaryContentWithoutDataOrUri() {
        assertInvalid(
                List.of(Map.of(
                        "type", "binary",
                        "mimeType", "image/png",
                        "filename", "photo.png")),
                "data, url, or id");
    }

    @Test
    void rejectsBinaryContentWithBothUrlAndId() {
        assertInvalid(
                List.of(Map.of(
                        "type", "binary",
                        "mimeType", "image/png",
                        "url", "gs://images/photo.png",
                        "id", "files/abc123")),
                "exactly one");
    }

    @Test
    void rejectsNonStringBinaryDataInsteadOfIgnoringIt() {
        assertInvalid(
                List.of(Map.of(
                        "type", "binary",
                        "mimeType", "image/png",
                        "data", 42,
                        "url", "gs://images/photo.png")),
                "data must be a string");
    }

    @Test
    void rejectsNonStringMimeTypeInsteadOfIgnoringIt() {
        assertInvalid(
                List.of(Map.of(
                        "type", "binary",
                        "mimeType", 42,
                        "url", "gs://images/photo.png")),
                "mimeType must be a string");
    }

    @Test
    void rejectsMalformedMimeTypeSyntax() {
        assertInvalid(
                List.of(Map.of(
                        "type", "binary",
                        "mimeType", "image png",
                        "url", "gs://images/photo.png")),
                "mimeType");
    }

    @Test
    void rejectsMalformedUriSyntax() {
        assertInvalid(
                List.of(Map.of(
                        "type", "binary",
                        "mimeType", "image/png",
                        "url", "https://example.test/photo image.png")),
                "URI");
    }

    private void assertInvalid(Object content, String detail) {
        assertThatThrownBy(() -> converter.convert(content))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("INVALID_RUN_INPUT")
                .hasMessageContaining(detail);
    }

    @Test
    void convertLatestUserMessageReturnsNewestUserMessageContent() {
        var am = new com.agui.community.core.message.AssistantMessage("a1", "assistant turn", null, List.of());
        var um = new com.agui.community.core.message.UserMessage("u1", "latest user text");
        var olderUm = new com.agui.community.core.message.UserMessage("u0", "older user text");
        Content c = MessageContentConverter.convertLatestUserMessage(
                List.of(am, olderUm, um)).orElseThrow();
        assertThat(c.role().get()).isEqualTo("user");
        assertThat(c.parts().get().get(0).text().get()).isEqualTo("latest user text");
        // empty history / only assistant -> empty
        assertThat(MessageContentConverter.convertLatestUserMessage(List.of())).isEmpty();
        assertThat(MessageContentConverter.convertLatestUserMessage(List.of(am))).isEmpty();
    }
}
