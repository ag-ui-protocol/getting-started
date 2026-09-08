package com.agui.community.core.message;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

class RoleTest {

    @ParameterizedTest
    @EnumSource(Role.class)
    void valueRoundTripsThroughFromValue(Role role) {
        assertSame(role, Role.fromValue(role.value()));
    }

    @Test
    void knownWireValuesMapToRoles() {
        assertEquals(Role.DEVELOPER, Role.fromValue("developer"));
        assertEquals(Role.SYSTEM, Role.fromValue("system"));
        assertEquals(Role.ASSISTANT, Role.fromValue("assistant"));
        assertEquals(Role.USER, Role.fromValue("user"));
        assertEquals(Role.TOOL, Role.fromValue("tool"));
    }

    @Test
    void fromValueRejectsUnknownValue() {
        assertThrows(IllegalArgumentException.class, () -> Role.fromValue("robot"));
    }
}
