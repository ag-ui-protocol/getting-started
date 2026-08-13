package com.agui.adk.auth;

import com.agui.adk.context.AdkAgUiRunContext;
import com.agui.community.core.event.Event;
import io.reactivex.rxjava3.core.Flowable;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Explicit request-local boundary for auth inputs unsupported by Google ADK Java 1.7.
 */
@FunctionalInterface
public interface AdkAuthRequestAdapter {

    /**
     * Handles one immutable auth input without using bridge-wide mutable request state.
     *
     * @param request request-local auth data
     * @return official events produced by the adapter
     */
    Flowable<Event> handle(Request request);

    /**
     * Immutable auth request delegated by the bridge.
     *
     * @param requestId client request identifier
     * @param input immutable auth input
     * @param context immutable bridge request context
     */
    record Request(String requestId, Map<String, Object> input, AdkAgUiRunContext context) {

        /**
         * Copies adapter data so no request can mutate another request's input.
         *
         * @param requestId client request identifier
         * @param input auth input
         * @param context request context
         */
        public Request {
            Objects.requireNonNull(requestId, "requestId");
            Objects.requireNonNull(input, "input");
            Objects.requireNonNull(context, "context");
            input = Map.copyOf(new LinkedHashMap<>(input));
        }
    }
}
