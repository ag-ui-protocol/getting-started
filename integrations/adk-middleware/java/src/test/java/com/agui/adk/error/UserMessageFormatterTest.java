package com.agui.adk.error;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class UserMessageFormatterTest {

    @Test
    void formatsContextPrefixAndFallback() {
        Throwable e = new IllegalArgumentException("boom");
        assertThat(UserMessageFormatter.createErrorMessage(e, "loading state"))
                .isEqualTo("loading state: IllegalArgumentException - boom");
        assertThat(UserMessageFormatter.createErrorMessage(e, "")).isEqualTo("IllegalArgumentException: boom");
        assertThat(UserMessageFormatter.createErrorMessage(e, null)).isEqualTo("IllegalArgumentException: boom");
        assertThat(UserMessageFormatter.createErrorMessage(new RuntimeException(), "ctx"))
                .isEqualTo("ctx: RuntimeException - ");
    }
}
