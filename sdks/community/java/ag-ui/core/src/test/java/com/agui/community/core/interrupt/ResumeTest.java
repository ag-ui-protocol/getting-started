package com.agui.community.core.interrupt;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

class ResumeTest {

    @Test
    void requiresInterruptIdAndStatus() {
        assertThrows(NullPointerException.class, () -> new Resume(null, ResumeStatus.RESOLVED, "x"));
        assertThrows(NullPointerException.class, () -> new Resume("i1", null, "x"));
    }

    @Test
    void carriesTheResolvedPayload() {
        Resume resume = new Resume("i1", ResumeStatus.RESOLVED, "yes");

        assertEquals("i1", resume.interruptId());
        assertEquals(ResumeStatus.RESOLVED, resume.status());
        assertEquals("yes", resume.payload());
    }

    @Test
    void payloadIsOptional() {
        assertNull(new Resume("i1", ResumeStatus.CANCELLED, null).payload());
    }
}
