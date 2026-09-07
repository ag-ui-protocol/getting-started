package com.agui.adk.translator;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class EventTranslatorFactoryBaselineTest {

    @Test
    void shouldAlwaysReturnSameInstance_whenAccessed() {
        // Arrange & Act
        EventTranslatorFactory instance1 = EventTranslatorFactory.INSTANCE;
        EventTranslatorFactory instance2 = EventTranslatorFactory.INSTANCE;

        // Assert
        assertSame(instance1, instance2, "INSTANCE should always return the same object");
    }

    @Test
    void shouldReturnNonNullTranslator_whenCreatedWithFullConfig() {
        // Arrange
        EventTranslatorFactory factory = EventTranslatorFactory.INSTANCE;

        // Act
        EventTranslator translator = factory.create("thread-1", "run-1", List.of());

        // Assert
        assertNotNull(translator, "Factory should create a non-null EventTranslator");
    }

    @Test
    void shouldReturnNonNullTranslator_whenCreatedWithSimpleConfig() {
        // Arrange
        EventTranslatorFactory factory = EventTranslatorFactory.INSTANCE;

        // Act
        EventTranslator translator = factory.create("thread-1", "run-1");

        // Assert
        assertNotNull(translator, "Overloaded factory method should create a non-null EventTranslator");
    }

    @Test
    void shouldReturnDifferentInstances_whenCreatedMultipleTimes() {
        // Arrange
        EventTranslatorFactory factory = EventTranslatorFactory.INSTANCE;

        // Act
        EventTranslator translator1 = factory.create("thread-1", "run-1");
        EventTranslator translator2 = factory.create("thread-2", "run-2");

        // Assert
        assertNotNull(translator1);
        assertNotNull(translator2);
        assertNotSame(translator1, translator2, "Factory should create a new instance for each call");
    }
}
