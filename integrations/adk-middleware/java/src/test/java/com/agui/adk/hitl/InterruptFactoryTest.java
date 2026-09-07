package com.agui.adk.hitl;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class InterruptFactoryTest {
    @Test
    void createsOpaqueScopedFrontendInterruptWithoutAuthorityMetadata() {
        PendingCallScope scope = new PendingCallScope("app", "user", "session");
        PendingCallGroupKey group = new PendingCallGroupKey(scope, "provider-invocation");
        PendingInterrupt first = new InterruptFactory().frontendTool(
                group, "run", "predictable-call", "lookup", Map.of("type", "object"));
        PendingInterrupt second = new InterruptFactory().frontendTool(
                group, "run", "predictable-call", "lookup", Map.of("type", "object"));

        assertThat(first.interruptId()).hasSize(22).doesNotContain("predictable", "provider", "user");
        assertThat(second.interruptId()).isNotEqualTo(first.interruptId());
        assertThat(first.interrupt().id()).isEqualTo(first.interruptId());
        assertThat(first.interrupt().toolCallId()).isEqualTo("predictable-call");
        assertThat(first.interrupt().metadata().toString())
                .doesNotContain("user", "session", "provider-invocation");
    }
}
