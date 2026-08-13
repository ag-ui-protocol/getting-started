package com.agui.adk.translator.context;

import com.agui.adk.translator.PredictStateMapping;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class PredictiveStateBaselineTest {

    private static final String TOOL_A = "toolA";
    private static final String TOOL_B = "toolB";
    private static final String TOOL_C = "toolC";
    private static final String ANY_TOOL = "anyTool";

    private PredictiveState predictiveState;
    private PredictStateMapping mapping1;
    private PredictStateMapping mapping2;
    private PredictStateMapping mapping3;

    @BeforeEach
    void setUp() {
        mapping1 = mock(PredictStateMapping.class);
        when(mapping1.toolName()).thenReturn(TOOL_A);
        when(mapping1.emitConfirmTool()).thenReturn(true);

        mapping2 = mock(PredictStateMapping.class);
        when(mapping2.toolName()).thenReturn(TOOL_B);
        when(mapping2.emitConfirmTool()).thenReturn(false);

        mapping3 = mock(PredictStateMapping.class);
        when(mapping3.toolName()).thenReturn(TOOL_A);
        when(mapping3.emitConfirmTool()).thenReturn(false);

        predictiveState = new PredictiveState(List.of(mapping1, mapping2, mapping3));
    }

    @Test
    void constructorGroupsMappingsByToolInInputOrder() {
        assertThat(predictiveState.getMappingsForTool(TOOL_A)).containsExactly(mapping1, mapping3);
        assertThat(predictiveState.getMappingsForTool(TOOL_B)).containsExactly(mapping2);
        assertThat(predictiveState.getMappingsForTool(TOOL_C)).isEmpty();
    }

    @Test
    void exposedMappingsAreImmutable() {
        List<PredictStateMapping> mappings = predictiveState.getMappingsForTool(TOOL_A);

        assertThatThrownBy(() -> mappings.add(mapping2))
                .isInstanceOf(UnsupportedOperationException.class);
    }

    @Test
    void configuredToolLookupRecognizesKnownTools() {
        assertThat(predictiveState.hasToolConfig(TOOL_A)).isTrue();
        assertThat(predictiveState.hasToolConfig(TOOL_B)).isTrue();
    }

    @Test
    void configuredToolLookupRejectsUnknownTools() {
        assertThat(predictiveState.hasToolConfig(TOOL_C)).isFalse();
    }

    @Test
    void emittedStateIsRecordedPerTool() {
        String toolName = "toolX";

        assertThat(predictiveState.hasEmittedForTool(toolName)).isFalse();
        predictiveState.markAsEmittedForTool(toolName);
        assertThat(predictiveState.hasEmittedForTool(toolName)).isTrue();
    }

    @Test
    void emittedConfirmationStateIsRecordedPerTool() {
        String toolName = "toolY";

        assertThat(predictiveState.hasEmittedConfirmForTool(toolName)).isFalse();
        predictiveState.markAsEmittedConfirmForTool(toolName);
        assertThat(predictiveState.hasEmittedConfirmForTool(toolName)).isTrue();
    }

    @Test
    void confirmationIsRequiredWhenAnyConfiguredMappingRequestsIt() {
        assertThat(predictiveState.shouldEmitConfirmForTool(TOOL_A)).isTrue();
    }

    @Test
    void confirmationIsNotRequiredWhenNoConfiguredMappingRequestsIt() {
        assertThat(predictiveState.shouldEmitConfirmForTool(TOOL_B)).isFalse();
    }

    @Test
    void nullConfigurationProducesEmptyState() {
        PredictiveState nullConfig = new PredictiveState(null);

        assertThat(nullConfig.hasToolConfig(ANY_TOOL)).isFalse();
        assertThat(nullConfig.getMappingsForTool(ANY_TOOL)).isEmpty();
        assertThat(nullConfig.hasEmittedForTool(ANY_TOOL)).isFalse();
    }

    @Test
    void emptyConfigurationProducesEmptyState() {
        PredictiveState emptyConfig = new PredictiveState(List.of());

        assertThat(emptyConfig.hasToolConfig(ANY_TOOL)).isFalse();
        assertThat(emptyConfig.getMappingsForTool(ANY_TOOL)).isEmpty();
        assertThat(emptyConfig.hasEmittedForTool(ANY_TOOL)).isFalse();
    }

    @Test
    void constructorDetachesTheConfigurationList() {
        java.util.ArrayList<PredictStateMapping> config = new java.util.ArrayList<>(List.of(mapping1));
        PredictiveState detached = new PredictiveState(config);

        config.add(mapping2);

        assertThat(detached.getMappingsForTool(TOOL_A)).containsExactly(mapping1);
        assertThat(detached.getMappingsForTool(TOOL_B)).isEmpty();
    }
}
