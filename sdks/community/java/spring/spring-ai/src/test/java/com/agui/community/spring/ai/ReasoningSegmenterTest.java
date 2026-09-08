package com.agui.community.spring.ai;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.agui.community.spring.ai.ReasoningSegmenter.Kind;
import com.agui.community.spring.ai.ReasoningSegmenter.Segment;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class ReasoningSegmenterTest {

    @Test
    void passesPlainTextThrough() {
        ReasoningSegmenter segmenter = new ReasoningSegmenter();

        List<Segment> segments = new ArrayList<>(segmenter.feed("hello world"));
        segments.addAll(segmenter.flush());

        assertEquals(List.of(new Segment(Kind.TEXT, "hello world")), segments);
    }

    @Test
    void splitsReasoningAndText() {
        ReasoningSegmenter segmenter = new ReasoningSegmenter();

        List<Segment> segments = new ArrayList<>(segmenter.feed("a<think>b</think>c"));
        segments.addAll(segmenter.flush());

        assertEquals(
                List.of(
                        new Segment(Kind.TEXT, "a"),
                        new Segment(Kind.REASONING, "b"),
                        new Segment(Kind.TEXT, "c")),
                segments);
    }

    @Test
    void reassemblesTagsSplitAcrossFeeds() {
        ReasoningSegmenter segmenter = new ReasoningSegmenter();

        List<Segment> segments = new ArrayList<>();
        segments.addAll(segmenter.feed("<thi"));
        segments.addAll(segmenter.feed("nk>deep "));
        segments.addAll(segmenter.feed("thought</thi"));
        segments.addAll(segmenter.feed("nk>visible"));
        segments.addAll(segmenter.flush());

        String reasoning = segments.stream()
                .filter(s -> s.kind() == Kind.REASONING)
                .map(Segment::text)
                .reduce("", String::concat);
        String text = segments.stream()
                .filter(s -> s.kind() == Kind.TEXT)
                .map(Segment::text)
                .reduce("", String::concat);

        assertEquals("deep thought", reasoning);
        assertEquals("visible", text);
    }

    @Test
    void treatsUnterminatedThinkAsReasoningOnFlush() {
        ReasoningSegmenter segmenter = new ReasoningSegmenter();

        List<Segment> segments = new ArrayList<>(segmenter.feed("<think>still going"));
        segments.addAll(segmenter.flush());

        assertEquals(List.of(new Segment(Kind.REASONING, "still going")), segments);
    }
}
