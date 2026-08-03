package com.agui.community.core.interrupt;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

class ResumeStatusTest {

    @ParameterizedTest
    @EnumSource(ResumeStatus.class)
    void valueRoundTripsThroughFromValue(ResumeStatus status) {
        assertSame(status, ResumeStatus.fromValue(status.value()));
    }

    @Test
    void knownWireValuesMapToStatuses() {
        assertEquals(ResumeStatus.RESOLVED, ResumeStatus.fromValue("resolved"));
        assertEquals(ResumeStatus.CANCELLED, ResumeStatus.fromValue("cancelled"));
    }

    @Test
    void fromValueRejectsUnknownValue() {
        assertThrows(IllegalArgumentException.class, () -> ResumeStatus.fromValue("done"));
    }
}
