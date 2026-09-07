package com.agui.adk.hitl;

import io.reactivex.rxjava3.core.Completable;
import com.agui.community.core.event.ToolCallChunkEvent;
import io.reactivex.rxjava3.core.Flowable;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

class PendingCallStoreDefaultsTest {
    private final PendingCallStore store = new PendingCallStore() {
        @Override
        public Completable persist(PendingToolCall call) {
            return Completable.complete();
        }

        @Override
        public Flowable<PendingToolCall> pending(PendingCallScope scope) {
            return Flowable.empty();
        }
    };

    @Test
    void finalizationRecoveryDefaultsFailClosed() {
        PendingCallScope scope = new PendingCallScope("app", "principal", "session");
        PendingCallGroupKey group = new PendingCallGroupKey(scope, "turn");
        PendingToolCall call = new PendingToolCall(
                new PendingCallKey(group, "call"),
                new ToolCallChunkEvent("call", "frontend", "{}"),
                "{}",
                PendingStatus.PENDING);
        ResumeClaim claim = new ResumeClaim(
                group,
                List.of(new BufferedToolResult(call, new NormalizedToolResult("call", Map.of()))));

        assertThatThrownBy(() -> store.finalizationPending(claim).blockingGet())
                .isInstanceOf(UnsupportedOperationException.class)
                .hasMessage("resume finalization recovery is unsupported");
        assertThatThrownBy(() -> store.releaseFinalization(claim).blockingAwait())
                .isInstanceOf(UnsupportedOperationException.class)
                .hasMessage("resume finalization recovery is unsupported");
    }
}
