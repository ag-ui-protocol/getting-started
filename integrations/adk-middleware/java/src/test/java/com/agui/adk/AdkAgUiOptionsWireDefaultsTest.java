package com.agui.adk;

import org.junit.jupiter.api.Test;

import java.time.Duration;

import static org.assertj.core.api.Assertions.assertThat;

/** Public option defaults required by the canonical Python ADK bridge. */
class AdkAgUiOptionsWireDefaultsTest {

    @Test
    void defaultsMatchPythonExecutionAndConcurrencyLimits() {
        AdkAgUiOptions options = AdkAgUiOptions.defaults();

        assertThat(options.runTimeout()).isEqualTo(Duration.ofSeconds(600));
        assertThat(options.globalConcurrencyLimit()).isEqualTo(10);
    }
}
