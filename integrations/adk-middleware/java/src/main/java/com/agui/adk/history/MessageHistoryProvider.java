package com.agui.adk.history;

import com.google.adk.sessions.Session;
import com.agui.community.core.message.Message;
import io.reactivex.rxjava3.core.Single;

import java.util.List;

/** Supplies only histories whose completeness is explicitly known. */
@FunctionalInterface
public interface MessageHistoryProvider {
    /**
     * Reads message history for one resolved ADK session.
     *
     * @param session resolved ADK session
     * @return explicitly complete or unavailable/incomplete history
     */
    Single<Result> history(Session session);

    /**
     * States whether every result from this provider is guaranteed to be complete.
     *
     * <p>The conservative default prevents capability metadata from inferring support from an
     * implementation type or from a single request result.
     *
     * @return true only when this provider guarantees complete histories
     */
    default boolean providesCompleteHistory() {
        return false;
    }

    /** Explicit result boundary preventing partial source histories from becoming snapshots. */
    record Result(List<Message> messages, boolean complete) {
        public Result {
            messages = List.copyOf(messages);
        }

        /**
         * Returns a complete message history eligible for an official snapshot event.
         *
         * @param messages complete canonical messages
         * @return complete result
         */
        public static Result complete(List<Message> messages) {
            return new Result(messages, true);
        }

        /**
         * Returns an unavailable or partial history that must not become a snapshot event.
         *
         * @return unavailable result
         */
        public static Result unavailable() {
            return new Result(List.of(), false);
        }
    }
}
