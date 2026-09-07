package com.agui.adk.input;

import com.google.genai.types.Content;
import com.google.genai.types.Part;

import java.util.ArrayList;
import java.util.List;

/**
 * Pure text projections over ADK/genai content, faithful to the Python
 * {@code utils/converters.py} helpers.
 */
public final class ContentTextExtractor {

    private ContentTextExtractor() {
    }

    /**
     * Extracts all text from an ADK {@code Content} object (Python
     * {@code extract_text_from_content}): joins every non-null part text with {@code "\n"};
     * empty string when the content is null or has no parts.
     *
     * @param content ADK content, or null
     * @return the joined text
     */
    public static String extractTextFromContent(Content content) {
        if (content == null || content.parts().isEmpty()) {
            return "";
        }
        List<String> textParts = new ArrayList<>();
        for (Part part : content.parts().orElse(List.of())) {
            part.text().filter(t -> !t.isEmpty()).ifPresent(textParts::add);
        }
        return String.join("\n", textParts);
    }

    /**
     * Flattens arbitrary message content to a plain string (Python
     * {@code flatten_message_content}): null -&gt; ""; a String passes through; a list joins the text
     * of its text-bearing items with {@code "\n"}; anything else is stringified.
     *
     * <p><b>Divergence note:</b> Python joins {@code TextInputContent} items via their {@code text}
     * attribute; the agui4j core 0.2.0 message model has no {@code TextInputContent} type and
     * represents text content as plain strings, so a text-bearing list item here is a {@code String}
     * (or an object whose {@code toString}/{@code text} are its text). This mirrors the core's
     * documented plain-string content model.
     *
     * @param content message content, or null
     * @return the flattened text
     */
    public static String flattenMessageContent(Object content) {
        if (content == null) {
            return "";
        }
        if (content instanceof String s) {
            return s;
        }
        if (content instanceof List<?> list) {
            List<String> textParts = new ArrayList<>();
            for (Object item : list) {
                // Python joins only TextInputContent items with a truthy .text; the agui4j core
                // models text-bearing items as plain strings, so a String item is the equivalent.
                if (item instanceof String s && !s.isEmpty()) {
                    textParts.add(s);
                }
            }
            return String.join("\n", textParts);
        }
        return String.valueOf(content);
    }
}
