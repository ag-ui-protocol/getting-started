package com.agui.adk.serialization;

import com.agui.community.core.event.*;
import com.agui.community.core.interrupt.*;
import com.agui.community.core.message.*;
import com.agui.community.core.serialization.SerializationException;
import com.agui.community.core.serialization.Serializer;
import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;
import com.fasterxml.jackson.annotation.JsonValue;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.DeserializationContext;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonDeserializer;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.module.SimpleModule;

import java.io.IOException;

import java.util.List;
import java.util.Objects;

/** Canonical Jackson serializer for the official AG-UI community types. */
public final class JacksonAgUiSerializer implements Serializer {
    private final ObjectMapper objectMapper;

    /**
     * Creates an isolated, thread-safe serializer configuration.
     *
     * @param base application mapper whose modules and settings should be retained
     */
    public JacksonAgUiSerializer(ObjectMapper base) {
        objectMapper = Objects.requireNonNull(base, "base").copy();
        objectMapper.disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
        objectMapper.setDefaultPropertyInclusion(JsonInclude.Value.construct(
                JsonInclude.Include.NON_NULL, JsonInclude.Include.ALWAYS));
        objectMapper.addMixIn(Event.class, EventMixin.class);
        objectMapper.addMixIn(Message.class, MessageMixin.class);
        objectMapper.addMixIn(RunOutcome.class, RunOutcomeMixin.class);
        objectMapper.addMixIn(EventType.class, EventTypeMixin.class);
        objectMapper.addMixIn(Role.class, RoleMixin.class);
        objectMapper.addMixIn(OutcomeType.class, OutcomeTypeMixin.class);
        objectMapper.addMixIn(ResumeStatus.class, ResumeStatusMixin.class);
        objectMapper.registerModule(new SimpleModule().addDeserializer(
                ResumeStatus.class, new ResumeStatusDeserializer()));
    }

    @Override
    public String serialize(Object value) {
        try {
            JsonNode node = objectMapper.valueToTree(value);
            if (value instanceof ReasoningMessageStartEvent) {
                ((ObjectNode) node).put("role", "reasoning");
            }
            return objectMapper.writeValueAsString(canonicalize(node));
        } catch (Exception exception) {
            throw failure("serialize", value == null ? "null" : value.getClass().getName(), exception);
        }
    }

    @Override
    public <T> T deserialize(String json, Class<T> type) {
        try {
            return objectMapper.readValue(json, type);
        } catch (Exception exception) {
            throw failure("deserialize", Objects.requireNonNull(type, "type").getName(), exception);
        }
    }

    @Override
    public <T> List<T> deserializeList(String json, Class<T> elementType) {
        try {
            return objectMapper.readValue(json, objectMapper.getTypeFactory()
                    .constructCollectionType(List.class, elementType));
        } catch (Exception exception) {
            throw failure("deserialize list of", Objects.requireNonNull(elementType, "elementType").getName(), exception);
        }
    }

    /**
     * Orders discriminators first and removes normalized empty optional message fields.
     *
     * @param node Jackson tree to canonicalize
     * @return canonical wire tree
     */
    private JsonNode canonicalize(JsonNode node) {
        if (node instanceof ArrayNode array) {
            ArrayNode result = JsonNodeFactory.instance.arrayNode();
            array.forEach(child -> result.add(canonicalize(child)));
            return result;
        }
        if (!(node instanceof ObjectNode object)) {
            return node;
        }
        ObjectNode result = JsonNodeFactory.instance.objectNode();
        if (object.has("type")) {
            result.set("type", object.get("type"));
        }
        if (object.has("id")) {
            result.set("id", object.get("id"));
        }
        if (object.has("messageId")) {
            result.set("messageId", object.get("messageId"));
        }
        if (object.has("role") && !"TOOL_CALL_RESULT".equals(object.path("type").asText())) {
            result.set("role", object.get("role"));
        }
        object.properties().forEach(entry -> {
            String name = entry.getKey();
            if (!result.has(name) && !("toolCalls".equals(name) && entry.getValue().isEmpty())) {
                result.set(name, canonicalize(entry.getValue()));
            }
        });
        return result;
    }

    /**
     * Creates the protocol-level exception required by the serializer contract.
     *
     * @param operation attempted operation
     * @param target target type
     * @param exception underlying failure
     * @return wrapped protocol exception
     */
    private static SerializationException failure(String operation, String target, Exception exception) {
        if (exception instanceof SerializationException serializationException) {
            return serializationException;
        }
        return new SerializationException("Failed to " + operation + " AG-UI value " + target, exception);
    }

    /** Declares every official event discriminator and hides internal provenance. */
    @JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.EXISTING_PROPERTY,
            property = "type")
    @JsonSubTypes({
        @JsonSubTypes.Type(value = RunStartedEvent.class, name = "RUN_STARTED"),
        @JsonSubTypes.Type(value = RunFinishedEvent.class, name = "RUN_FINISHED"),
        @JsonSubTypes.Type(value = RunErrorEvent.class, name = "RUN_ERROR"),
        @JsonSubTypes.Type(value = StepStartedEvent.class, name = "STEP_STARTED"),
        @JsonSubTypes.Type(value = StepFinishedEvent.class, name = "STEP_FINISHED"),
        @JsonSubTypes.Type(value = TextMessageStartEvent.class, name = "TEXT_MESSAGE_START"),
        @JsonSubTypes.Type(value = TextMessageContentEvent.class, name = "TEXT_MESSAGE_CONTENT"),
        @JsonSubTypes.Type(value = TextMessageEndEvent.class, name = "TEXT_MESSAGE_END"),
        @JsonSubTypes.Type(value = TextMessageChunkEvent.class, name = "TEXT_MESSAGE_CHUNK"),
        @JsonSubTypes.Type(value = ToolCallStartEvent.class, name = "TOOL_CALL_START"),
        @JsonSubTypes.Type(value = ToolCallArgsEvent.class, name = "TOOL_CALL_ARGS"),
        @JsonSubTypes.Type(value = ToolCallEndEvent.class, name = "TOOL_CALL_END"),
        @JsonSubTypes.Type(value = ToolCallChunkEvent.class, name = "TOOL_CALL_CHUNK"),
        @JsonSubTypes.Type(value = ToolCallResultEvent.class, name = "TOOL_CALL_RESULT"),
        @JsonSubTypes.Type(value = ReasoningStartEvent.class, name = "REASONING_START"),
        @JsonSubTypes.Type(value = ReasoningEndEvent.class, name = "REASONING_END"),
        @JsonSubTypes.Type(value = ReasoningMessageStartEvent.class, name = "REASONING_MESSAGE_START"),
        @JsonSubTypes.Type(value = ReasoningMessageContentEvent.class, name = "REASONING_MESSAGE_CONTENT"),
        @JsonSubTypes.Type(value = ReasoningMessageEndEvent.class, name = "REASONING_MESSAGE_END"),
        @JsonSubTypes.Type(value = ReasoningMessageChunkEvent.class, name = "REASONING_MESSAGE_CHUNK"),
        @JsonSubTypes.Type(value = ReasoningEncryptedValueEvent.class, name = "REASONING_ENCRYPTED_VALUE"),
        @JsonSubTypes.Type(value = StateSnapshotEvent.class, name = "STATE_SNAPSHOT"),
        @JsonSubTypes.Type(value = StateDeltaEvent.class, name = "STATE_DELTA"),
        @JsonSubTypes.Type(value = MessagesSnapshotEvent.class, name = "MESSAGES_SNAPSHOT"),
        @JsonSubTypes.Type(value = ActivitySnapshotEvent.class, name = "ACTIVITY_SNAPSHOT"),
        @JsonSubTypes.Type(value = ActivityDeltaEvent.class, name = "ACTIVITY_DELTA"),
        @JsonSubTypes.Type(value = RawEvent.class, name = "RAW"),
        @JsonSubTypes.Type(value = CustomEvent.class, name = "CUSTOM"),
        @JsonSubTypes.Type(value = MetaEvent.class, name = "META_EVENT")
    })
    private abstract static class EventMixin {
        @JsonProperty("type")
        abstract EventType type();

        @JsonIgnore
        abstract Object rawEvent();
    }

    /** Declares every official message role discriminator. */
    @JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.EXISTING_PROPERTY,
            property = "role")
    @JsonSubTypes({
        @JsonSubTypes.Type(value = DeveloperMessage.class, name = "developer"),
        @JsonSubTypes.Type(value = SystemMessage.class, name = "system"),
        @JsonSubTypes.Type(value = AssistantMessage.class, name = "assistant"),
        @JsonSubTypes.Type(value = UserMessage.class, name = "user"),
        @JsonSubTypes.Type(value = ToolMessage.class, name = "tool")
    })
    private abstract static class MessageMixin {
        @JsonProperty("role")
        abstract Role role();
    }

    /** Declares every official run-outcome discriminator. */
    @JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.EXISTING_PROPERTY,
            property = "type")
    @JsonSubTypes({
        @JsonSubTypes.Type(value = SuccessOutcome.class, name = "success"),
        @JsonSubTypes.Type(value = InterruptOutcome.class, name = "interrupt")
    })
    private abstract static class RunOutcomeMixin {
        @JsonProperty("type")
        abstract OutcomeType type();
    }

    /** Maps event-type enums to their official uppercase wire values. */
    private abstract static class EventTypeMixin {
        @JsonValue abstract String value();
        @JsonCreator static EventType fromValue(String value) { return EventType.fromValue(value); }
    }

    /** Maps message roles to their official lowercase wire values. */
    private abstract static class RoleMixin {
        @JsonValue abstract String value();
        @JsonCreator static Role fromValue(String value) { return Role.fromValue(value); }
    }

    /** Maps outcome types to their official lowercase wire values. */
    private abstract static class OutcomeTypeMixin {
        @JsonValue abstract String value();
        @JsonCreator static OutcomeType fromValue(String value) { return OutcomeType.fromValue(value); }
    }

    /** Maps resume statuses to their official lowercase wire values. */
    private abstract static class ResumeStatusMixin {
        @JsonValue abstract String value();
    }

    /** Accepts both canonical lowercase values and Java enum names from older clients. */
    private static final class ResumeStatusDeserializer extends JsonDeserializer<ResumeStatus> {
        @Override
        public ResumeStatus deserialize(JsonParser parser, DeserializationContext context)
                throws IOException {
            String value = parser.getValueAsString();
            try {
                return ResumeStatus.fromValue(value);
            } catch (IllegalArgumentException wireValueFailure) {
                try {
                    return ResumeStatus.valueOf(value);
                } catch (IllegalArgumentException enumNameFailure) {
                    enumNameFailure.addSuppressed(wireValueFailure);
                    throw context.weirdStringException(
                            value, ResumeStatus.class, "Unknown resume status");
                }
            }
        }
    }

}
