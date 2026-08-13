package com.agui.adk.testsupport;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.adk.sessions.Session;
import io.reactivex.rxjava3.core.Single;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/** Vertex-like fake that round-trips initial state through JSON before persisting it. */
public final class JsonRoundTripSessionService extends VertexLikeSessionService {

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Override
    public Single<Session> createSession(String appName, String userId,
            ConcurrentMap<String, Object> state, String ignoredRequestedId) {
        try {
            ConcurrentMap<String, Object> copied = new ConcurrentHashMap<>(objectMapper.readValue(
                    objectMapper.writeValueAsBytes(state == null ? java.util.Map.of() : state),
                    new TypeReference<java.util.Map<String, Object>>() { }));
            return super.createSession(appName, userId, copied, ignoredRequestedId);
        } catch (Exception error) {
            return Single.error(error);
        }
    }
}
