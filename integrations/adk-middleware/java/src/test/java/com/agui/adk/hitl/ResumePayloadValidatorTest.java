package com.agui.adk.hitl;

import com.agui.community.core.interrupt.Resume;
import com.agui.community.core.interrupt.ResumeStatus;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ResumePayloadValidatorTest {
    private final ResumePayloadValidator validator = new ResumePayloadValidator();

    @Test
    void validatesResolvedConfirmationPayloadAndRejectsUnknownProperties() {
        var schema = validator.compile(Map.of(
                "$schema", "https://json-schema.org/draft/2020-12/schema",
                "type", "object",
                "required", java.util.List.of("approved"),
                "properties", Map.of("approved", Map.of("type", "boolean")),
                "additionalProperties", false));

        assertThatCode(() -> validator.validate(schema,
                new Resume("opaque", ResumeStatus.RESOLVED, Map.of("approved", true))))
                .doesNotThrowAnyException();
        assertThatThrownBy(() -> validator.validate(schema,
                new Resume("opaque", ResumeStatus.RESOLVED, Map.of("approved", "yes"))))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> validator.validate(schema,
                new Resume("opaque", ResumeStatus.RESOLVED,
                        Map.of("approved", true, "toolCallId", "forged"))))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void cancelledIsDistinctAndRequiresNullPayload() {
        var schema = validator.compile(Map.of("type", "object"));
        assertThatCode(() -> validator.validate(schema,
                new Resume("opaque", ResumeStatus.CANCELLED, null))).doesNotThrowAnyException();
        assertThatThrownBy(() -> validator.validate(schema,
                new Resume("opaque", ResumeStatus.CANCELLED, Map.of())))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
