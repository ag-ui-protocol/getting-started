package com.agui.adk.hitl;

import com.agui.community.core.interrupt.Resume;
import com.agui.community.core.interrupt.ResumeStatus;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.networknt.schema.InputFormat;
import com.networknt.schema.Schema;
import com.networknt.schema.SchemaRegistry;
import com.networknt.schema.SpecificationVersion;

import java.util.Objects;

/** Validates official resume payloads against the immutable interrupt response schema. */
public final class ResumePayloadValidator {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final SchemaRegistry SCHEMAS =
            SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_2020_12);

    /**
     * Validates one response schema before the associated interrupt becomes visible.
     *
     * @param responseSchema JSON Schema-compatible value
     * @return compiled immutable schema
     */
    public Schema compile(Object responseSchema) {
        Objects.requireNonNull(responseSchema, "responseSchema");
        try {
            return SCHEMAS.getSchema(JSON.writeValueAsString(responseSchema), InputFormat.JSON);
        } catch (RuntimeException | JsonProcessingException error) {
            throw new IllegalArgumentException("invalid interrupt response schema", error);
        }
    }

    /**
     * Validates one official resume before any durable store mutation.
     *
     * @param schema compiled interrupt response schema
     * @param resume official client response
     */
    public void validate(Schema schema, Resume resume) {
        Objects.requireNonNull(schema, "schema");
        Objects.requireNonNull(resume, "resume");
        if (resume.status() == ResumeStatus.CANCELLED) {
            if (resume.payload() != null) {
                throw new IllegalArgumentException("cancelled resume payload must be null");
            }
            return;
        }
        try {
            String payload = JSON.writeValueAsString(resume.payload());
            if (!schema.validate(payload, InputFormat.JSON).isEmpty()) {
                throw new IllegalArgumentException(
                        "resume payload does not match interrupt response schema");
            }
        } catch (JsonProcessingException error) {
            throw new IllegalArgumentException("resume payload must be JSON", error);
        }
    }
}
