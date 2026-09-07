package com.agui.adk.input;

import static org.assertj.core.api.Assertions.assertThat;

import com.google.genai.types.Part;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class MessageContentPartsConverterTest {

    private static Map<String, Object> map(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            m.put((String) kv[i], kv[i + 1]);
        }
        return m;
    }

    @Test
    void nullAndBlankStringYieldEmpty() {
        assertThat(MessageContentPartsConverter.convert(null)).isEmpty();
        assertThat(MessageContentPartsConverter.convert("")).isEmpty();
    }

    @Test
    void stringBecomesSingleTextPart() {
        List<Part> parts = MessageContentPartsConverter.convert("hello");
        assertThat(parts).hasSize(1);
        assertThat(parts.get(0).text()).hasValue("hello");
    }

    @Test
    void textItemBecomesTextPartAndBlankTextIsSkipped() {
        assertThat(MessageContentPartsConverter.convert(List.of(map("type", "text", "text", "hi"))))
                .singleElement().satisfies(p -> assertThat(p.text()).hasValue("hi"));
        assertThat(MessageContentPartsConverter.convert(List.of(map("type", "text", "text", "")))).isEmpty();
    }

    @Test
    void mediaDataSourceDecodesToInlineDataBlob() {
        List<Part> parts = MessageContentPartsConverter.convert(List.of(
                map("type", "image", "source", map("type", "data", "mimeType", "image/png", "value", "aGk="))));
        assertThat(parts).singleElement().satisfies(p -> {
            assertThat(p.inlineData()).isPresent();
            assertThat(p.inlineData().get().mimeType()).hasValue("image/png");
            assertThat(p.inlineData().get().data()).hasValue(Base64.getDecoder().decode("aGk="));
        });
    }

    @Test
    void mediaUrlSourceBecomesFileData() {
        List<Part> parts = MessageContentPartsConverter.convert(List.of(
                map("type", "document", "source", map("type", "url", "mimeType", "application/pdf", "value", "https://x/y.pdf"))));
        assertThat(parts).singleElement().satisfies(p -> {
            assertThat(p.fileData()).isPresent();
            assertThat(p.fileData().get().fileUri()).hasValue("https://x/y.pdf");
            assertThat(p.fileData().get().mimeType()).hasValue("application/pdf");
        });
    }

    @Test
    void legacyBinaryDataDecodesToInlineData() {
        List<Part> parts = MessageContentPartsConverter.convert(List.of(
                map("type", "binary", "mimeType", "text/plain", "data", "aGVsbG8=")));
        assertThat(parts).singleElement().satisfies(p ->
                assertThat(p.inlineData().get().data()).hasValue(Base64.getDecoder().decode("aGVsbG8=")));
    }

    @Test
    void invalidItemsAreSkipped() {
        // binary with url (only data supported)
        assertThat(MessageContentPartsConverter.convert(
                List.of(map("type", "binary", "mimeType", "text/plain", "url", "https://x")))).isEmpty();
        // bad base64 media
        assertThat(MessageContentPartsConverter.convert(
                List.of(map("type", "image", "source", map("type", "data", "mimeType", "image/png", "value", "!!bad!!"))))).isEmpty();
        // media without source
        assertThat(MessageContentPartsConverter.convert(List.of(map("type", "audio")))).isEmpty();
        // media data without mime
        assertThat(MessageContentPartsConverter.convert(
                List.of(map("type", "image", "source", map("type", "data", "value", "aGk="))))).isEmpty();
    }

    @Test
    void mixedListKeepsOrderAndSkipsUnknownTypes() {
        List<Part> parts = MessageContentPartsConverter.convert(List.of(
                map("type", "text", "text", "a"),
                map("type", "image", "source", map("type", "data", "mimeType", "image/png", "value", "aGk=")),
                map("type", "no_such", "z", 1)));
        assertThat(parts).hasSize(2);
        assertThat(parts.get(0).text()).hasValue("a");
        assertThat(parts.get(1).inlineData()).isPresent();
    }
}
