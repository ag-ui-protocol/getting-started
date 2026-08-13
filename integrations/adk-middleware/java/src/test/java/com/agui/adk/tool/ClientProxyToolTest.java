package com.agui.adk.tool;

import com.google.adk.flows.llmflows.Functions;
import com.google.genai.types.FunctionCall;
import com.google.genai.types.Schema;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class ClientProxyToolTest {

    @Test
    void declaresALongRunningFrontendToolWithoutExecutingApplicationWork() {
        ClientProxyTool tool = new ClientProxyTool(
                "show_sports_list", "Show sports", Schema.builder().type("object").build());

        assertThat(tool.longRunning()).isTrue();
        assertThat(tool.declaration()).flatMap(declaration -> declaration.name())
                .contains("show_sports_list");
        assertThat(tool.runAsync(Map.of("league", "nba"), null).blockingGet()).isEmpty();
    }

    @Test
    void identifiesTheFrontendCallAsLongRunningInTheOfficialAdkFlow() {
        ClientProxyTool tool = new ClientProxyTool(
                "show_sports_list", "Show sports", Schema.builder().type("object").build());
        FunctionCall call = FunctionCall.builder()
                .id("call-1")
                .name("show_sports_list")
                .args(Map.of("league", "nba"))
                .build();

        assertThat(Functions.getLongRunningFunctionCalls(List.of(call), Map.of(tool.name(), tool)))
                .containsExactly("call-1");
    }
}
