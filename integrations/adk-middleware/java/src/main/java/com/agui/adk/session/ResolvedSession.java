package com.agui.adk.session;

import com.google.adk.sessions.Session;

import java.util.Objects;

/**
 * ADK session and the mapping used to resolve it for one AG-UI invocation.
 *
 * @param session resolved ADK session
 * @param mapping stable AG-UI thread mapping
 */
public record ResolvedSession(Session session, SessionMapping mapping) {

    public ResolvedSession {
        session = Objects.requireNonNull(session, "session");
        mapping = Objects.requireNonNull(mapping, "mapping");
    }
}
