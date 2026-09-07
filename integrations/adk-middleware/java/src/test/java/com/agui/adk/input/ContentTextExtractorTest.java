package com.agui.adk.input;

import static org.assertj.core.api.Assertions.assertThat;

import com.google.genai.types.Content;
import com.google.genai.types.Part;

import java.util.List;

import org.junit.jupiter.api.Test;

class ContentTextExtractorTest {

    @Test
    void extractTextFromContentJoinsPartTextsAndHandlesEmpty() {
        Content content = Content.builder().role("user").parts(List.of(
                Part.builder().text("hello").build(),
                Part.builder().text("").build(),
                Part.builder().text("world").build(),
                Part.builder().functionCall(com.google.genai.types.FunctionCall.builder()
                        .name("f").build()).build())).build();
        assertThat(ContentTextExtractor.extractTextFromContent(content)).isEqualTo("hello\nworld");
        assertThat(ContentTextExtractor.extractTextFromContent(Content.builder().role("user")
                .parts(List.of()).build())).isEmpty();
        assertThat(ContentTextExtractor.extractTextFromContent(null)).isEmpty();
    }

    @Test
    void flattenMessageContentHandlesNullStringListAndOther() {
        assertThat(ContentTextExtractor.flattenMessageContent(null)).isEmpty();
        assertThat(ContentTextExtractor.flattenMessageContent("plain")).isEqualTo("plain");
        assertThat(ContentTextExtractor.flattenMessageContent(List.of("a", "b", 42)))
                .isEqualTo("a\nb");
        assertThat(ContentTextExtractor.flattenMessageContent(42)).isEqualTo("42");
        assertThat(ContentTextExtractor.flattenMessageContent("")).isEmpty();
    }
}
