package com.agui.adk.session;

import static org.assertj.core.api.Assertions.assertThat;

import com.agui.adk.SessionManager;
import com.google.adk.memory.BaseMemoryService;
import com.google.adk.sessions.InMemorySessionService;
import com.agui.adk.testsupport.VertexLikeSessionService;
import java.util.Map;
import static org.mockito.Mockito.mock;
import org.junit.jupiter.api.Test;

/**
 * P1 #17 — temp:-state bearer-token rotation cleanup ({@code adk_agent.py} L3455-3463): after a
 * run completes, the bridge drops the per-invocation {@code temp:} state injected via
 * {@code RequestStateSessionService} so a later run on the same session does not inherit stale
 * values (e.g. a rotated bearer token). No-op when the wrapped session service is not a
 * {@code RequestStateSessionService}.
 */
class SessionManagerTempStateRotationTest {

    private static final String APP = "app";
    private static final String USER = "user";

    @Test
    void clearsPendingTempStateOnARequestStateWrappedService() {
        // Stock in-memory service: getSession returns a per-read copy, so the in-place
        // temp injection (m-02) never leaks into storage — matching the Python contract
        // test_temp_state_not_persisted_to_inner.
        InMemorySessionService underlying = new InMemorySessionService();
        RequestStateSessionService wrapped = new RequestStateSessionService(underlying);
        SessionManager manager = new SessionManager(wrapped,
                mock(BaseMemoryService.class));

        wrapped.createSession(APP, USER, new java.util.concurrent.ConcurrentHashMap<>(), "s1")
                .blockingGet();
        wrapped.setPendingTempState(APP, USER, "s1", Map.of("temp:bucket", "s3://old-bucket"));

        // Before cleanup the stale value is injected on get.
        assertThat(wrapped.getSession(APP, USER, "s1", java.util.Optional.empty())
                .blockingGet().state().get("temp:bucket")).isEqualTo("s3://old-bucket");

        manager.clearPendingRequestTempState(APP, USER, "s1");

        // After cleanup the per-invocation temp state is dropped.
        assertThat(wrapped.getSession(APP, USER, "s1", java.util.Optional.empty())
                .blockingGet().state().get("temp:bucket")).isNull();
        // The inner service's storage was never mutated (Python test_temp_state_not_persisted_to_inner).
        assertThat(underlying.getSession(APP, USER, "s1", java.util.Optional.empty())
                .blockingGet().state().containsKey("temp:bucket")).isFalse();
    }

    @Test
    void isNoOpWhenServiceIsNotRequestStateWrapped() {
        VertexLikeSessionService underlying = new VertexLikeSessionService(true);
        SessionManager manager = new SessionManager(underlying,
                mock(BaseMemoryService.class));

        // No RequestStateSessionService in the chain -> clear is a harmless no-op.
        org.junit.jupiter.api.Assertions.assertDoesNotThrow(
                () -> manager.clearPendingRequestTempState(APP, USER, "s1"));
    }
}
