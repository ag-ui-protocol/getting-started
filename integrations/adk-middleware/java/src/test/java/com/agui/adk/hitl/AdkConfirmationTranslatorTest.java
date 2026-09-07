package com.agui.adk.hitl;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class AdkConfirmationTranslatorTest {
    private final AdkConfirmationTranslator translator = new AdkConfirmationTranslator();

    @Test
    void preservesInvocationAndCallIdsForApproveAndReject() {
        assertEquals(new AdkConfirmationTranslator.Decision("invocation", "call", true),
                translator.approve("invocation", "call"));
        assertEquals(new AdkConfirmationTranslator.Decision("invocation", "call", false),
                translator.reject("invocation", "call"));
    }
}
