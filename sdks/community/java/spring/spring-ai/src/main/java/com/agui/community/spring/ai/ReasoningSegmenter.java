package com.agui.community.spring.ai;

import java.util.ArrayList;
import java.util.List;

/**
 * Splits a streamed text into {@code text} and {@code reasoning} segments by
 * detecting inline thinking tags ({@code <think>...</think>} by default). This is
 * the provider-agnostic convention reasoning models use when their thoughts are
 * surfaced in the content stream (the reason Spring AI ships a
 * {@code ThinkingTagCleaner}).
 *
 * <p>The segmenter is fed text incrementally and is robust to tags that are split
 * across chunk boundaries: any trailing text that could be the start of a tag is
 * buffered until the next chunk (or {@link #flush()}) resolves it. It is stateful
 * and not thread-safe; one instance handles one stream.
 */
final class ReasoningSegmenter {

    /** Whether a segment is normal text or model reasoning. */
    enum Kind {
        TEXT,
        REASONING
    }

    /** A contiguous run of {@code text} of a single {@link Kind}. Never empty. */
    record Segment(Kind kind, String text) {
    }

    private final String openTag;
    private final String closeTag;
    private final StringBuilder buffer = new StringBuilder();
    private boolean inReasoning;

    ReasoningSegmenter() {
        this("<think>", "</think>");
    }

    ReasoningSegmenter(String openTag, String closeTag) {
        this.openTag = openTag;
        this.closeTag = closeTag;
    }

    /**
     * Feeds more text and returns the segments that can be emitted now. Text that
     * might be the prefix of a tag is held back until resolved.
     *
     * @param text the next piece of streamed text
     * @return resolved segments, in order (possibly empty)
     */
    List<Segment> feed(String text) {
        buffer.append(text);
        List<Segment> out = new ArrayList<>();
        consume(out, false);
        return out;
    }

    /**
     * Flushes any buffered text when the stream ends, emitting it as a final
     * segment of the current kind (an unterminated {@code <think>} is treated as
     * reasoning).
     *
     * @return the remaining segments, in order (possibly empty)
     */
    List<Segment> flush() {
        List<Segment> out = new ArrayList<>();
        consume(out, true);
        if (buffer.length() > 0) {
            out.add(new Segment(currentKind(), buffer.toString()));
            buffer.setLength(0);
        }
        return out;
    }

    private void consume(List<Segment> out, boolean flushing) {
        while (true) {
            String tag = inReasoning ? closeTag : openTag;
            int idx = buffer.indexOf(tag);
            if (idx >= 0) {
                if (idx > 0) {
                    out.add(new Segment(currentKind(), buffer.substring(0, idx)));
                }
                buffer.delete(0, idx + tag.length());
                inReasoning = !inReasoning;
                continue;
            }
            if (flushing) {
                return;
            }
            // No complete tag: emit everything except a suffix that could be the
            // beginning of the tag we are currently looking for.
            int held = longestSuffixThatIsPrefixOf(buffer, tag);
            int emitLength = buffer.length() - held;
            if (emitLength > 0) {
                out.add(new Segment(currentKind(), buffer.substring(0, emitLength)));
                buffer.delete(0, emitLength);
            }
            return;
        }
    }

    private Kind currentKind() {
        return inReasoning ? Kind.REASONING : Kind.TEXT;
    }

    private static int longestSuffixThatIsPrefixOf(CharSequence text, String tag) {
        int max = Math.min(text.length(), tag.length() - 1);
        for (int length = max; length > 0; length--) {
            int offset = text.length() - length;
            boolean matches = true;
            for (int i = 0; i < length; i++) {
                if (text.charAt(offset + i) != tag.charAt(i)) {
                    matches = false;
                    break;
                }
            }
            if (matches) {
                return length;
            }
        }
        return 0;
    }
}
