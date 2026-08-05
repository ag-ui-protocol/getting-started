package com.agui.community.server;

import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.Event;
import com.agui.community.core.serialization.SerializationException;
import com.agui.community.core.serialization.Serializer;
import java.util.List;
import java.util.function.Function;

/**
 * A test {@link Serializer} that avoids pulling in a real JSON library. Events
 * are serialized to a deterministic token (their {@link Event#type()} wire value
 * by default) so frames can be asserted, and {@link #deserialize} returns a
 * pre-built {@link RunAgentInput} regardless of the body. Deserialization can be
 * configured to fail to exercise the bad-request path.
 */
public final class FakeSerializer implements Serializer {

    private final Function<Object, String> serializeFn;
    private final RunAgentInput inputToReturn;
    private final boolean failDeserialize;

    private FakeSerializer(Function<Object, String> serializeFn, RunAgentInput inputToReturn,
                           boolean failDeserialize) {
        this.serializeFn = serializeFn;
        this.inputToReturn = inputToReturn;
        this.failDeserialize = failDeserialize;
    }

    /** Serializes events to their event-type wire value; deserializes to {@code input}. */
    public static FakeSerializer returning(RunAgentInput input) {
        return new FakeSerializer(value -> ((Event) value).type().value(), input, false);
    }

    /** Uses a custom serialize function; deserialization is unsupported. */
    public static FakeSerializer serializingWith(Function<Object, String> serializeFn) {
        return new FakeSerializer(serializeFn, null, false);
    }

    /** Always fails on deserialize, to exercise the malformed-input path. */
    public static FakeSerializer failingDeserialize() {
        return new FakeSerializer(value -> "", null, true);
    }

    @Override
    public String serialize(Object value) {
        return serializeFn.apply(value);
    }

    @Override
    public <T> T deserialize(String json, Class<T> type) {
        if (failDeserialize) {
            throw new SerializationException("boom");
        }
        return type.cast(inputToReturn);
    }

    @Override
    public <T> List<T> deserializeList(String json, Class<T> elementType) {
        throw new UnsupportedOperationException();
    }
}
