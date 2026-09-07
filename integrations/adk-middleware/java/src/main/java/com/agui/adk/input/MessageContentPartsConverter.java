package com.agui.adk.input;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.genai.types.Blob;
import com.google.genai.types.FileData;
import com.google.genai.types.Part;

import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Pure port of the exported Python {@code ag_ui_adk.utils.converters.convert_message_content_to_parts}
 * (with its {@code _to_text_part} / {@code _to_binary_part} / {@code _media_content_to_part}
 * helpers): converts AG-UI message content into google.genai {@code Part}s.
 *
 * <p>Supports {@code str} &rarr; {@code [Part(text)]}, and an ordered list of dict content items:
 * {@code text} &rarr; text part, media ({@code image}/{@code audio}/{@code video}/{@code document})
 * data sources &rarr; {@code inline_data} Blob (base64), media URL sources &rarr; {@code file_data},
 * and the legacy {@code binary} part &rarr; {@code inline_data} Blob (base64). Invalid/unsupported
 * items (missing data/mime, bad base64, unknown type) are skipped with a debug/warning, never
 * raising, exactly like the Python helper. This is the permissive exported utility surface; it is
 * intentionally separate from the strict, validator-driven {@link MessageContentConverter}.
 */
public final class MessageContentPartsConverter {

    private static final Set<String> MEDIA_TYPES =
            Set.of("image", "audio", "video", "document");

    private MessageContentPartsConverter() {
    }

    /**
     * Converts AG-UI message content into genai parts (Python {@code convert_message_content_to_parts}).
     *
     * @param content content string or ordered list of dict items (may be null)
     * @return the converted parts (never null; empty for null/blank/unsupported content)
     */
    public static List<Part> convert(Object content) {
        if (content == null) {
            return List.of();
        }
        if (content instanceof String text) {
            return text.isEmpty() ? List.of() : List.of(Part.fromText(text));
        }
        if (content instanceof List<?> items) {
            List<Part> parts = new ArrayList<>();
            for (Object item : items) {
                Part part = convertItem(item);
                if (part != null) {
                    parts.add(part);
                }
            }
            return parts;
        }
        return List.of();
    }

    private static final ObjectMapper JSON = new ObjectMapper();

    /**
     * Converts the string content of an AG-UI message to Google parts (public run-path wiring
     * for multimodal input, audit finding M-02).
     *
     * <p>The agui4j message model represents content as a string, so structured AG-UI content
     * arrives as its JSON serialization. When the content parses as a JSON array of content
     * items, each item is converted with {@link #convert(Object)} (text, inline image/audio/video/
     * document data, URL file_data, legacy binary); otherwise the content is treated as plain
     * text. A JSON array that yields no representable parts falls back to the raw text so a
     * literal {@code [1,2,3]} user message is never silently dropped.
     *
     * @param content message content (may be null)
     * @return converted parts (never null)
     */
    public static List<Part> fromMessageContent(String content) {
        if (content == null || content.isEmpty()) {
            return List.of();
        }
        String trimmed = content.strip();
        if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
            try {
                List<Part> parts = convert(JSON.readValue(trimmed, Object.class));
                if (!parts.isEmpty()) {
                    return parts;
                }
            } catch (JsonProcessingException ignored) {
                // Malformed structured content falls back to the raw text.
            }
        }
        return List.of(Part.fromText(content));
    }

    /**
     * Converts a single dict content item, skipping unsupported/invalid shapes.
     *
     * @param item the content item (a map)
     * @return the converted part, or null when the item is unsupported/invalid
     */
    private static Part convertItem(Object item) {
        if (!(item instanceof Map<?, ?> map)) {
            return null; // non-dict item: Python logs and ignores (only dict/InputContent handled)
        }
        String type = stringOf(map.get("type"));
        if (type == null) {
            return null;
        }
        if ("text".equals(type)) {
            String text = stringOf(map.get("text"));
            return (text == null || text.isEmpty()) ? null : Part.fromText(text);
        }
        if (MEDIA_TYPES.contains(type)) {
            return mediaContentToPart(map);
        }
        if ("binary".equals(type)) {
            return toBinaryPart(
                    stringOf(map.get("data")),
                    firstOf(map, "mimeType", "mime_type"),
                    stringOf(map.get("url")),
                    stringOf(map.get("id")));
        }
        return null;
    }

    /**
     * Port of Python {@code _to_binary_part}: data + mime base64 to an inline_data Blob.
     *
     * @param data the base64 data (required)
     * @param mimeType the media type (required)
     * @param url an optional URI (unsupported; presence skips)
     * @param binaryId an optional identifier (unsupported; presence skips)
     * @return the inline-data part, or null when data/mime missing, url/id present, or bad base64
     */
    private static Part toBinaryPart(String data, String mimeType, String url, String binaryId) {
        if (data == null || data.isEmpty() || url != null || binaryId != null || mimeType == null) {
            return null; // only inline data is supported; missing data/mime or url/id -> skip
        }
        byte[] decoded = tryBase64(data);
        if (decoded == null) {
            return null; // invalid base64 -> skip
        }
        return Part.builder()
                .inlineData(Blob.builder().mimeType(mimeType).data(decoded).build())
                .build();
    }

    /**
     * Port of Python {@code _media_content_to_part}: data source to inline_data, url to file_data.
     *
     * @param item the media content item
     * @return the media part, or null when the source is absent/unrecognized or data invalid
     */
    private static Part mediaContentToPart(Map<?, ?> item) {
        Object source = item.get("source");
        if (!(source instanceof Map<?, ?> sourceMap)) {
            return null; // no source -> skip
        }
        String sourceType = stringOf(sourceMap.get("type"));

        String mime = firstOf(sourceMap, "mimeType", "mime_type");
        if ("data".equals(sourceType)) {
            String dataValue = stringOf(sourceMap.get("value"));
            if (dataValue != null) {
                if (mime == null) {
                    return null;
                }
                byte[] decoded = tryBase64(dataValue);
                if (decoded == null) {
                    return null;
                }
                return Part.builder()
                        .inlineData(Blob.builder().mimeType(mime).data(decoded).build())
                        .build();
            }
        }
        if ("url".equals(sourceType)) {
            String urlValue = stringOf(sourceMap.get("value"));
            if (urlValue == null || urlValue.isEmpty()) {
                return null;
            }
            return Part.builder()
                    .fileData(FileData.builder().fileUri(urlValue).mimeType(mime).build())
                    .build();
        }
        return null; // unrecognized source type
    }

    /**
     * Strict base64 decode; returns null on invalid input (Python validates and skips).
     *
     * @param data the base64 string
     * @return the decoded bytes, or null when invalid base64
     */
    private static byte[] tryBase64(String data) {
        try {
            return Base64.getDecoder().decode(data);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /**
     * Coerces a value to string, or null when absent.
     *
     * @param value the value
     * @return the string form, or null
     */
    private static String stringOf(Object value) {
        return value == null ? null : String.valueOf(value);
    }

    /**
     * Reads the first present of two map keys, falling back to the second.
     *
     * @param map the source map
     * @param first the preferred key
     * @param second the fallback key
     * @return the string value, or null when neither key is present
     */
    private static String firstOf(Map<?, ?> map, String first, String second) {
        Object selectedValue = map.get(first);
        if (selectedValue == null) {
            selectedValue = map.get(second);
        }
        return selectedValue == null ? null : String.valueOf(selectedValue);
    }
}
