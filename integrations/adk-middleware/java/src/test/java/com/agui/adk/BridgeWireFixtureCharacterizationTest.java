package com.agui.adk;

import com.fasterxml.jackson.databind.JsonNode;
import com.agui.community.core.event.Event;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.agui.adk.serialization.JacksonAgUiSerializer;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.Set;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/** Pins the canonical wire event families currently emitted by the ADK bridge. */
class BridgeWireFixtureCharacterizationTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final JacksonAgUiSerializer SERIALIZER = new JacksonAgUiSerializer(JSON);
    private static final Set<String> EMITTED_EVENT_TYPES = Set.of(
            "RUN_STARTED", "RUN_FINISHED", "RUN_ERROR",
            "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END",
            "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT",
            "TOOL_CALL_CHUNK", "REASONING_START", "REASONING_MESSAGE_START",
            "REASONING_MESSAGE_CONTENT", "REASONING_MESSAGE_END",
            "REASONING_ENCRYPTED_VALUE", "REASONING_END", "STATE_DELTA",
            "STATE_SNAPSHOT", "MESSAGES_SNAPSHOT", "CUSTOM");

    @Test
    void canonicalEventFixturesCoverEveryEventFamilyEmittedByTheBridge() throws IOException {
        Path fixtureDirectory = Path.of("src/test/resources/contracts/events");
        Set<String> fixtureTypes = new HashSet<>();

        try (Stream<Path> fixtures = Files.list(fixtureDirectory)) {
            for (Path fixture : fixtures.filter(path -> path.toString().endsWith(".json")).toList()) {
                JsonNode event = JSON.readTree(fixture.toFile());
                assertThat(event.path("type").asText())
                        .as("uppercase AG-UI discriminator in %s", fixture.getFileName())
                        .matches("[A-Z_]+");
                fixtureTypes.add(event.path("type").asText());
            }
        }

        assertThat(fixtureTypes).containsExactlyInAnyOrderElementsOf(EMITTED_EVENT_TYPES);
    }

    @Test
    void canonicalEventFixturesAreWireEquivalentThroughTheOfficialSerializer() throws IOException {
        Path fixtureDirectory = Path.of("src/test/resources/contracts/events");
        try (Stream<Path> fixtures = Files.list(fixtureDirectory)) {
            for (Path fixture : fixtures.filter(path -> path.toString().endsWith(".json")).toList()) {
                JsonNode expected = JSON.readTree(fixture.toFile());
                Event event = SERIALIZER.deserialize(expected.toString(), Event.class);
                JsonNode actual = JSON.readTree(SERIALIZER.serialize(event));
                assertThat(actual).as("serializer wire tree for %s", fixture.getFileName()).isEqualTo(expected);
                assertThat(SERIALIZER.deserialize(actual.toString(), Event.class)).isEqualTo(event);
            }
        }
    }

    @Test
    void goldenStreamsAreReproducedExactlyByTheOfficialSerializer() throws IOException {
        Path streamDirectory = Path.of("src/test/resources/contracts/streams");
        try (Stream<Path> streams = Files.list(streamDirectory)) {
            for (Path stream : streams.filter(path -> path.toString().endsWith(".jsonl")).toList()) {
                for (String line : Files.readAllLines(stream)) {
                    if (!line.isEmpty()) {
                        Event event = SERIALIZER.deserialize(line, Event.class);
                        assertThat(SERIALIZER.serialize(event))
                                .as("exact serializer line in %s", stream.getFileName()).isEqualTo(line);
                        assertThat(SERIALIZER.deserialize(line, Event.class)).isEqualTo(event);
                    }
                }
            }
        }
    }

    @Test
    void goldenStreamsPinExactCompactJsonWireLines() throws IOException {
        Path streamDirectory = Path.of("src/test/resources/contracts/streams");

        try (Stream<Path> streams = Files.list(streamDirectory)) {
            for (Path stream : streams.filter(path -> path.toString().endsWith(".jsonl")).toList()) {
                for (String line : Files.readAllLines(stream)) {
                    if (line.isEmpty()) {
                        continue;
                    }
                    JsonNode event = JSON.readTree(line);
                    assertThat(JSON.writeValueAsString(event))
                            .as("canonical JSONL line in %s", stream.getFileName())
                            .isEqualTo(line);
                }
            }
        }
    }
}
