package com.agui.community.core.serialization;

import java.util.List;

/**
 * Abstraction over a JSON serialization library, allowing AG-UI types to be
 * read from and written to the wire without the {@code core} module depending
 * on any particular implementation.
 *
 * <p>Implementations live in the integration modules and are expected to be
 * backed by a concrete library such as Jackson's {@code ObjectMapper} or a
 * Spring {@code MappingJackson2HttpMessageConverter}. Implementations must be
 * configured to handle the sealed AG-UI hierarchies polymorphically — for
 * example {@link com.agui.community.core.event.Event} keyed on its
 * {@code type} discriminator and {@link com.agui.community.core.message.Message}
 * keyed on its {@code role} discriminator.
 *
 * <p>Implementations should be thread-safe and must wrap any underlying failure
 * in a {@link SerializationException}.
 */
public interface Serializer {

    /**
     * Serializes the given value to its JSON representation.
     *
     * @param value the value to serialize
     * @return the JSON string
     * @throws SerializationException if serialization fails
     */
    String serialize(Object value);

    /**
     * Deserializes the given JSON into an instance of {@code type}.
     *
     * @param json the JSON string to read
     * @param type the target type
     * @param <T>  the target type
     * @return the deserialized value
     * @throws SerializationException if deserialization fails
     */
    <T> T deserialize(String json, Class<T> type);

    /**
     * Deserializes the given JSON array into a {@link List} of {@code elementType}.
     * Provided as a convenience because a {@link Class} token cannot, on its own,
     * express a parameterized collection type.
     *
     * @param json        the JSON array string to read
     * @param elementType the type of the list elements
     * @param <T>         the element type
     * @return the deserialized list
     * @throws SerializationException if deserialization fails
     */
    <T> List<T> deserializeList(String json, Class<T> elementType);
}
