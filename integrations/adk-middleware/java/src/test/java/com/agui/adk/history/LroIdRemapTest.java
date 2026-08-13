package com.agui.adk.history;

import static org.assertj.core.api.Assertions.assertThat;

import com.google.genai.types.FunctionCall;
import com.google.genai.types.Part;

import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;

class LroIdRemapTest {

    @Test
    void matchesByPositionPerToolNameAndDropsUnchangedIds() {
        Part f1 = Part.builder().functionCall(FunctionCall.builder().name("create_item").id("persist-b").build()).build();
        Part f2 = Part.builder().functionCall(FunctionCall.builder().name("create_item").id("persist-d").build()).build();
        Map<String, List<String>> emittedByName = Map.of(
                "create_item", List.of("emit-a", "emit-b", "emit-c"));
        var remap = LroIdRemap.extract(List.of(f1, f2), emittedByName);
        // FIFO: f1 consumes emit-a -> emit-a != persist-b : remap; f2 consumes emit-b -> emit-b != persist-d : remap
        assertThat(remap).containsEntry("emit-a", "persist-b").containsEntry("emit-b", "persist-d");
    }

    @Test
    void identicalIdsNotRemappedAndEmptyCases() {
        Part same = Part.builder().functionCall(FunctionCall.builder().name("t").id("x").build()).build();
        Map<String, List<String>> emitted = Map.of("t", List.of("x"));
        assertThat(LroIdRemap.extract(List.of(same), emitted)).isEmpty();
        // missing name / no emitted ids -> no mapping
        assertThat(LroIdRemap.extract(List.of(
                Part.builder().functionCall(FunctionCall.builder().name("other").id("y").build()).build()),
                Map.of("t", List.of("x")))).isEmpty();
        // no function-call parts
        assertThat(LroIdRemap.extract(List.of(Part.builder().text("hi").build()), emitted)).isEmpty();
    }
}
