package com.agui.adk.history;

import com.google.adk.sessions.Session;
import com.agui.community.core.message.Message;
import io.reactivex.rxjava3.core.Single;

import java.util.List;
import java.util.Objects;

/**
 * ADK-session history provider that replays the full assistant history from the session's own
 * event memory (Python {@code adk_events_to_messages(session.events)}), like the Python bridge.
 *
 * <p>Unlike a strictly conservative provider, this provider presents the representable AG-UI
 * message projection of the ADK session events as a complete history that is safe to emit as an
 * official snapshot. When the session carries no events (or nothing representable as AG-UI
 * messages) it returns explicitly unavailable so no false snapshot is emitted.
 */
public final class AdkSessionMessageHistoryProvider implements MessageHistoryProvider {

    /**
     * Reports the ADK session event history projected to representable AG-UI messages.
     *
     * @param session ADK session whose event history is replayed from its own memory
     * @return complete projected history, or explicitly unavailable when nothing is representable
     */
    @Override
    public Single<Result> history(Session session) {
        Objects.requireNonNull(session, "session");
        List<Message> messages = AdkEventsToMessages.convert(
                session.events() == null ? List.of() : session.events());
        return Single.just(messages.isEmpty() ? Result.unavailable() : Result.complete(messages));
    }

    /**
     * States that this provider replays complete histories from the ADK session memory.
     *
     * @return {@code true}
     */
    @Override
    public boolean providesCompleteHistory() {
        return true;
    }
}
