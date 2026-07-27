package com.agui.community.core.interrupt;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class RunOutcomeTest {

    @Test
    void successOutcomeReportsSuccessType() {
        assertEquals(OutcomeType.SUCCESS, new SuccessOutcome().type());
    }

    @Test
    void interruptOutcomeReportsInterruptType() {
        RunOutcome outcome = new InterruptOutcome(List.of(new Interrupt("i1", "confirmation", "Proceed?")));
        assertEquals(OutcomeType.INTERRUPT, outcome.type());
    }

    @Test
    void interruptOutcomeDefaultsNullInterruptsToEmpty() {
        assertTrue(new InterruptOutcome(null).interrupts().isEmpty());
    }

    @Test
    void interruptOutcomeCopiesAndIsUnmodifiable() {
        List<Interrupt> interrupts = new ArrayList<>();
        interrupts.add(new Interrupt("i1", "tool_call", "Run it?"));

        InterruptOutcome outcome = new InterruptOutcome(interrupts);
        interrupts.clear();

        assertEquals(1, outcome.interrupts().size());
        assertThrows(UnsupportedOperationException.class,
                () -> outcome.interrupts().add(new Interrupt("i2", "input_required", "Name?")));
    }

    @Test
    void interruptRequiresId() {
        assertThrows(NullPointerException.class, () -> new Interrupt(null, "confirmation", "?"));
    }

    @Test
    void interruptConvenienceConstructorLeavesOptionalFieldsNull() {
        Interrupt interrupt = new Interrupt("i1", "confirmation", "Proceed?");

        assertEquals("i1", interrupt.id());
        assertEquals("confirmation", interrupt.reason());
        assertEquals("Proceed?", interrupt.message());
        assertNull(interrupt.toolCallId());
        assertNull(interrupt.responseSchema());
        assertNull(interrupt.expiresAt());
        assertNull(interrupt.metadata());
    }
}
