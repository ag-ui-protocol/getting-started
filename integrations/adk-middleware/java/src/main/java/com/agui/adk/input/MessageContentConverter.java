package com.agui.adk.input;

import com.fasterxml.jackson.databind.JsonNode;
import com.google.genai.types.Content;
import com.google.genai.types.Part;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.ArrayList;
import com.agui.community.core.message.Message;
import com.agui.community.core.message.Role;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * Converts supported canonical user content to Google GenAI content without stringifying media.
 */
public final class MessageContentConverter {

    private static final Pattern MIME_TYPE = Pattern.compile(
            "[!#$%&'*+.^_`|~0-9A-Za-z-]+/[!#$%&'*+.^_`|~0-9A-Za-z-]+");

    /**
     * Converts text or structured canonical user content.
     *
     * <p>Structured content may be an ordered part list, a {@code {parts:[...]}} wrapper, or a
     * Jackson tree with the same shape. Supported part types are {@code text} and {@code binary}.
     * Binary parts use {@code data} for base64 inline bytes or {@code url}/{@code id} for a URI.
     *
     * @param source source content
     * @return Google user content
     * @throws IllegalArgumentException when content cannot be represented without data loss
     */
    public Content convert(Object source) {
        List<Part> parts = convertParts(source);
        if (parts.isEmpty()) {
            throw RunInputValidator.invalidInput("structured content must contain at least one part");
        }
        return Content.builder().role("user").parts(parts).build();
    }

    /**
     * Port of the Python {@code ADKAgent._convert_latest_message}: converts the latest user message
     * of a history to a Google user Content. Scans the history in reverse for the newest message
     * whose role is {@code user} and whose content is non-empty, converting it to parts; returns
     * empty when no such message exists. With agui4j messages content is a plain string, so a
     * non-empty string maps to a single text part.
     *
     * @param messages the message history
     * @return the latest user content, or empty when none is present
     */
    public static Optional<Content> convertLatestUserMessage(List<Message> messages) {
        if (messages == null || messages.isEmpty()) {
            return Optional.empty();
        }
        for (int i = messages.size() - 1; i >= 0; i--) {
            Message message = messages.get(i);
            if (message.role() != Role.USER) {
                continue;
            }
            String content = message.content();
            if (content == null || content.isEmpty()) {
                continue;
            }
            return Optional.of(Content.builder().role("user")
                    .parts(MessageContentPartsConverter.fromMessageContent(content)).build());
        }
        return Optional.empty();
    }

    /**
     * Converts a source value into ordered Google parts.
     *
     * @param source source content
     * @return converted parts
     */
    private static List<Part> convertParts(Object source) {
        if (source instanceof String text) {
            return List.of(Part.fromText(text));
        }
        if (source instanceof JsonNode node) {
            return convertJsonNode(node);
        }
        if (source instanceof List<?> values) {
            return convertPartList(values);
        }
        if (source instanceof Map<?, ?> map) {
            Object wrappedParts = map.get("parts");
            return wrappedParts == null
                    ? List.of(convertPart(map))
                    : convertParts(wrappedParts);
        }
        throw RunInputValidator.invalidInput(
                "unsupported structured content value " + typeName(source));
    }

    /**
     * Converts a Jackson content tree.
     *
     * @param node content tree
     * @return converted parts
     */
    private static List<Part> convertJsonNode(JsonNode node) {
        if (node == null || node.isNull()) {
            throw RunInputValidator.invalidInput("message content must not be null");
        }
        if (node.isTextual()) {
            return List.of(Part.fromText(node.textValue()));
        }
        if (node.isArray()) {
            List<Part> parts = new ArrayList<>();
            node.forEach(part -> parts.add(convertJsonPart(part)));
            return List.copyOf(parts);
        }
        if (node.isObject() && node.has("parts")) {
            return convertJsonNode(node.get("parts"));
        }
        if (node.isObject()) {
            return List.of(convertJsonPart(node));
        }
        throw RunInputValidator.invalidInput(
                "unsupported structured content value " + node.getNodeType());
    }

    /**
     * Converts an ordered list of canonical part values.
     *
     * @param values part values
     * @return converted parts
     */
    private static List<Part> convertPartList(List<?> values) {
        List<Part> parts = new ArrayList<>(values.size());
        for (Object value : values) {
            if (value instanceof JsonNode node) {
                parts.add(convertJsonPart(node));
            } else if (value instanceof Map<?, ?> map) {
                parts.add(convertPart(map));
            } else {
                throw RunInputValidator.invalidInput(
                        "structured content parts must be objects");
            }
        }
        return List.copyOf(parts);
    }

    /**
     * Converts one canonical map part.
     *
     * @param part canonical part
     * @return Google part
     */
    private static Part convertPart(Map<?, ?> part) {
        String type = requiredString(part.get("type"), "structured content type");
        return switch (type) {
            case "text" -> Part.fromText(requiredString(part.get("text"), "text"));
            case "binary" -> convertBinary(
                    optionalString(part, "mimeType"),
                    optionalString(part, "data"),
                    optionalString(part, "url"),
                    optionalString(part, "id"));
            default -> throw RunInputValidator.invalidInput(
                    "unsupported structured content type " + type);
        };
    }

    /**
     * Converts one canonical Jackson part.
     *
     * @param part canonical part
     * @return Google part
     */
    private static Part convertJsonPart(JsonNode part) {
        if (part == null || !part.isObject()) {
            throw RunInputValidator.invalidInput(
                    "structured content parts must be objects");
        }
        String type = requiredString(textValue(part.get("type")), "structured content type");
        return switch (type) {
            case "text" -> Part.fromText(requiredString(textValue(part.get("text")), "text"));
            case "binary" -> convertBinary(
                    optionalText(part, "mimeType"),
                    optionalText(part, "data"),
                    optionalText(part, "url"),
                    optionalText(part, "id"));
            default -> throw RunInputValidator.invalidInput(
                    "unsupported structured content type " + type);
        };
    }

    /**
     * Converts a canonical binary part.
     *
     * @param mimeType media type
     * @param data base64 inline data
     * @param url media URI
     * @param id uploaded media identifier
     * @return Google binary or URI part
     */
    private static Part convertBinary(
            String mimeType,
            String data,
            String url,
            String id) {
        String requiredMimeType = requiredString(mimeType, "mimeType");
        if (!MIME_TYPE.matcher(requiredMimeType).matches()) {
            throw RunInputValidator.invalidInput("mimeType must be a valid media type");
        }

        int sourceCount = (isPresent(data) ? 1 : 0)
                + (isPresent(url) ? 1 : 0)
                + (isPresent(id) ? 1 : 0);
        if (sourceCount != 1) {
            throw RunInputValidator.invalidInput(
                    "binary content must provide exactly one of data, url, or id");
        }
        if (isPresent(data)) {
            try {
                return Part.fromBytes(Base64.getDecoder().decode(data), requiredMimeType);
            } catch (IllegalArgumentException exception) {
                throw RunInputValidator.invalidInput("binary data must be valid base64");
            }
        }

        String uri = isPresent(url) ? url : id;
        try {
            new URI(uri);
        } catch (URISyntaxException exception) {
            throw RunInputValidator.invalidInput("binary URI must be valid");
        }
        return Part.fromUri(uri, requiredMimeType);
    }

    /**
     * Returns an optional map field without coercing its value.
     *
     * @param source source map
     * @param name field name
     * @return string value or {@code null} when absent
     */
    private static String optionalString(Map<?, ?> source, String name) {
        if (!source.containsKey(name)) {
            return null;
        }
        Object value = source.get(name);
        if (!(value instanceof String string)) {
            throw RunInputValidator.invalidInput(name + " must be a string");
        }
        return string;
    }

    /**
     * Returns an optional Jackson field without coercing its value.
     *
     * @param source source object
     * @param name field name
     * @return text value or {@code null} when absent
     */
    private static String optionalText(JsonNode source, String name) {
        JsonNode value = source.get(name);
        if (value == null) {
            return null;
        }
        if (!value.isTextual()) {
            throw RunInputValidator.invalidInput(name + " must be a string");
        }
        return value.textValue();
    }

    /**
     * Returns a required nonblank string.
     *
     * @param value candidate value
     * @param name field name
     * @return validated string
     */
    private static String requiredString(Object value, String name) {
        String string = stringValue(value);
        if (!isPresent(string)) {
            throw RunInputValidator.invalidInput(name + " must not be blank");
        }
        return string;
    }

    /**
     * Returns a string value without coercing another type.
     *
     * @param value candidate value
     * @return string value or {@code null}
     */
    private static String stringValue(Object value) {
        return value instanceof String string ? string : null;
    }

    /**
     * Returns textual Jackson content without coercion.
     *
     * @param node candidate node
     * @return text value or {@code null}
     */
    private static String textValue(JsonNode node) {
        return node != null && node.isTextual() ? node.textValue() : null;
    }

    /**
     * Reports whether a string contains a nonblank value.
     *
     * @param value candidate value
     * @return whether present
     */
    private static boolean isPresent(String value) {
        return value != null && !value.isBlank();
    }

    /**
     * Returns a stable source type name for validation messages.
     *
     * @param value source value
     * @return type name
     */
    private static String typeName(Object value) {
        return value == null ? "null" : value.getClass().getSimpleName();
    }
}
