package com.agui.community.core.serialization;

/**
 * Thrown when a {@link Serializer} fails to serialize or deserialize a value.
 * Implementations should wrap their library-specific exceptions in this type so
 * that callers can handle serialization failures without depending on a
 * particular JSON library.
 */
public class SerializationException extends RuntimeException {

    public SerializationException(String message) {
        super(message);
    }

    public SerializationException(String message, Throwable cause) {
        super(message, cause);
    }
}
