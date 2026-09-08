package com.agui.community.spring.server.core;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.DeserializationContext;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonDeserializer;
import com.fasterxml.jackson.databind.JsonSerializer;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializerProvider;
import com.fasterxml.jackson.databind.module.SimpleModule;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.EventType;
import com.agui.community.core.interrupt.OutcomeType;
import com.agui.community.core.interrupt.ResumeStatus;
import com.agui.community.core.interrupt.RunOutcome;
import com.agui.community.core.message.Message;
import com.agui.community.core.message.Role;
import com.agui.community.core.serialization.SerializationException;
import com.agui.community.core.serialization.Serializer;
import com.agui.community.spring.server.core.jackson.EventMixin;
import com.agui.community.spring.server.core.jackson.MessageMixin;
import com.agui.community.spring.server.core.jackson.RunOutcomeMixin;
import java.io.IOException;
import java.util.List;
import java.util.Objects;

/**
 * A {@link Serializer} backed by a Jackson {@link ObjectMapper}, configured to
 * handle the AG-UI sealed hierarchies polymorphically: {@link Event} keyed on
 * its {@code type} discriminator and {@link Message} keyed on its {@code role}
 * discriminator. The {@link Role} and {@link EventType} enums are read and
 * written using their AG-UI wire values.
 *
 * <p>The configuration is applied to a copy of the supplied mapper, so passing
 * Spring's shared {@code ObjectMapper} does not mutate it.
 *
 * <p>Shared by the WebFlux and WebMVC server modules.
 */
public final class JacksonSerializer implements Serializer {

    private final ObjectMapper mapper;

    /** Creates a serializer backed by a freshly configured {@link ObjectMapper}. */
    public JacksonSerializer() {
        this(new ObjectMapper());
    }

    /**
     * Creates a serializer that applies AG-UI configuration to a copy of the
     * given mapper.
     *
     * @param mapper the mapper to base the configuration on (required)
     */
    public JacksonSerializer(ObjectMapper mapper) {
        this.mapper = configure(Objects.requireNonNull(mapper, "mapper must not be null").copy());
    }

    /**
     * Applies the AG-UI mix-ins, enum bindings and lenient settings to a mapper.
     *
     * @param mapper the mapper to configure (mutated and returned)
     * @return the configured mapper
     */
    public static ObjectMapper configure(ObjectMapper mapper) {
        mapper.configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);
        mapper.setSerializationInclusion(JsonInclude.Include.NON_NULL);
        mapper.addMixIn(Event.class, EventMixin.class);
        mapper.addMixIn(Message.class, MessageMixin.class);
        mapper.addMixIn(RunOutcome.class, RunOutcomeMixin.class);

        SimpleModule module = new SimpleModule("ag-ui");
        module.addSerializer(Role.class, new JsonSerializer<>() {
            @Override
            public void serialize(Role value, JsonGenerator gen, SerializerProvider serializers)
                    throws IOException {
                gen.writeString(value.value());
            }
        });
        module.addDeserializer(Role.class, new JsonDeserializer<>() {
            @Override
            public Role deserialize(JsonParser p, DeserializationContext ctxt) throws IOException {
                return Role.fromValue(p.getValueAsString());
            }
        });
        module.addSerializer(EventType.class, new JsonSerializer<>() {
            @Override
            public void serialize(EventType value, JsonGenerator gen, SerializerProvider serializers)
                    throws IOException {
                gen.writeString(value.value());
            }
        });
        module.addDeserializer(EventType.class, new JsonDeserializer<>() {
            @Override
            public EventType deserialize(JsonParser p, DeserializationContext ctxt) throws IOException {
                return EventType.fromValue(p.getValueAsString());
            }
        });
        module.addSerializer(OutcomeType.class, new JsonSerializer<>() {
            @Override
            public void serialize(OutcomeType value, JsonGenerator gen, SerializerProvider serializers)
                    throws IOException {
                gen.writeString(value.value());
            }
        });
        module.addDeserializer(OutcomeType.class, new JsonDeserializer<>() {
            @Override
            public OutcomeType deserialize(JsonParser p, DeserializationContext ctxt) throws IOException {
                return OutcomeType.fromValue(p.getValueAsString());
            }
        });
        module.addSerializer(ResumeStatus.class, new JsonSerializer<>() {
            @Override
            public void serialize(ResumeStatus value, JsonGenerator gen, SerializerProvider serializers)
                    throws IOException {
                gen.writeString(value.value());
            }
        });
        module.addDeserializer(ResumeStatus.class, new JsonDeserializer<>() {
            @Override
            public ResumeStatus deserialize(JsonParser p, DeserializationContext ctxt) throws IOException {
                return ResumeStatus.fromValue(p.getValueAsString());
            }
        });
        mapper.registerModule(module);
        return mapper;
    }

    @Override
    public String serialize(Object value) {
        try {
            return mapper.writeValueAsString(value);
        } catch (IOException e) {
            throw new SerializationException("Failed to serialize " + value, e);
        }
    }

    @Override
    public <T> T deserialize(String json, Class<T> type) {
        try {
            return mapper.readValue(json, type);
        } catch (IOException e) {
            throw new SerializationException("Failed to deserialize to " + type.getName(), e);
        }
    }

    @Override
    public <T> List<T> deserializeList(String json, Class<T> elementType) {
        try {
            return mapper.readValue(json,
                    mapper.getTypeFactory().constructCollectionType(List.class, elementType));
        } catch (IOException e) {
            throw new SerializationException("Failed to deserialize list of " + elementType.getName(), e);
        }
    }
}
