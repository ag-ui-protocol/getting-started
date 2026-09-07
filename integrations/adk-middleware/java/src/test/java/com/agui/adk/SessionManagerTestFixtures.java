package com.agui.adk;

import io.reactivex.rxjava3.core.Single;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

public final class SessionManagerTestFixtures {
    private SessionManagerTestFixtures() {
    }

    public static void stubNoOpMutationGuard(SessionManager sessionManager) {
        when(sessionManager.acquireExecutionMutationGuard(any())).thenReturn(Single.just(() -> {
        }));
    }
}
