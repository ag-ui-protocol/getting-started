package com.agui.community.core.interrupt;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

class OutcomeTypeTest {

    @ParameterizedTest
    @EnumSource(OutcomeType.class)
    void valueRoundTripsThroughFromValue(OutcomeType type) {
        assertSame(type, OutcomeType.fromValue(type.value()));
    }

    @Test
    void knownWireValuesMapToTypes() {
        assertEquals(OutcomeType.SUCCESS, OutcomeType.fromValue("success"));
        assertEquals(OutcomeType.INTERRUPT, OutcomeType.fromValue("interrupt"));
    }

    @Test
    void fromValueRejectsUnknownValue() {
        assertThrows(IllegalArgumentException.class, () -> OutcomeType.fromValue("paused"));
    }
}
