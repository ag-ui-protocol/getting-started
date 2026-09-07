package com.agui.adk.input;

import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.interrupt.Resume;
import com.agui.community.core.interrupt.ResumeStatus;
import com.agui.community.core.message.Message;
import com.agui.community.core.tool.Tool;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Validates request data before any Google ADK invocation.
 */
public final class RunInputValidator {

    public static final String ERROR_CODE = "INVALID_RUN_INPUT";

    /**
     * Validates official input and the bounded compatibility extension.
     *
     * @param input official AG-UI input
     * @param extensions optional compatibility extensions
     * @throws IllegalArgumentException when the input is invalid
     */
    public void validate(RunAgentInput input, AdkRunExtensions extensions) {
        if (input == null) {
            throw invalidInput("input must not be null");
        }
        requireId(input.threadId(), "threadId");
        requireId(input.runId(), "runId");
        validateMessages(input.messages());
        validateResumes(input.resume());
        validateExtensions(input.tools(), extensions);
    }

    /**
     * Validates the request identity values carried by the run context.
     *
     * @param appName Google ADK application name
     * @param userId Google ADK user identifier
     * @param sessionId Google ADK session identifier
     * @throws IllegalArgumentException when an identity is null or blank
     */
    public void validateIdentity(String appName, String userId, String sessionId) {
        requireId(appName, "appName");
        requireId(userId, "userId");
        requireId(sessionId, "sessionId");
    }

    /**
     * Creates the stable invalid-input failure used before lifecycle error types are introduced.
     *
     * @param detail validation detail
     * @return invalid-input exception
     */
    public static IllegalArgumentException invalidInput(String detail) {
        return new IllegalArgumentException(ERROR_CODE + ": " + detail);
    }

    /**
     * Validates message identifiers and conflicting duplicate messages.
     *
     * @param messages official messages
     */
    private static void validateMessages(List<Message> messages) {
        if (messages == null) {
            throw invalidInput("messages must not be null");
        }
        Map<String, Message> messagesById = new HashMap<>();
        for (Message message : messages) {
            if (message == null) {
                throw invalidInput("messages must not contain null values");
            }
            requireId(message.id(), "message id");
            Message previous = messagesById.putIfAbsent(message.id(), message);
            if (previous != null && !Objects.equals(previous, message)) {
                throw invalidInput(
                        "duplicate message id " + message.id() + " has different content");
            }
        }
    }

    /**
     * Validates the complete official resume list before any routing or mutation.
     *
     * <p>Phase 4 deliberately validates and routes this field before the historical HITL path.
     * Durable interrupt correlation and payload-schema validation remain owned by the Phase 6
     * interruption store; this validation prevents malformed or ambiguous lists from being
     * silently ignored in the meantime.
     *
     * @param resumes official interrupt responses
     */
    private static void validateResumes(List<Resume> resumes) {
        if (resumes == null) {
            throw invalidInput("resume must not be null");
        }
        java.util.Set<String> ids = new java.util.HashSet<>();
        for (Resume resume : resumes) {
            if (resume == null) {
                throw invalidInput("resume must not contain null values");
            }
            requireId(resume.interruptId(), "resume interruptId");
            if (resume.interruptId().length() > 512) {
                throw invalidInput("resume interruptId is too long");
            }
            if (!ids.add(resume.interruptId())) {
                throw invalidInput("duplicate resume interruptId " + resume.interruptId());
            }
            if (resume.status() == ResumeStatus.CANCELLED && resume.payload() != null) {
                throw invalidInput("cancelled resume payload must be null");
            }
        }
    }

    /**
     * Validates parent identity and raw-schema pairing with official tools.
     *
     * @param tools official tools
     * @param extensions optional compatibility extensions
     */
    private static void validateExtensions(
            List<Tool> tools,
            AdkRunExtensions extensions) {
        if (extensions == null) {
            return;
        }
        if (extensions.parentRunId() != null && extensions.parentRunId().isBlank()) {
            throw invalidInput("parentRunId must not be blank when present");
        }
        List<Tool> officialTools = tools == null ? List.of() : tools;
        for (RawToolSchema rawSchema : extensions.rawToolSchemas()) {
            if (rawSchema.position() >= officialTools.size()) {
                throw invalidInput(
                        "raw tool schema position " + rawSchema.position()
                                + " is outside the official tool list");
            }
            Tool officialTool = officialTools.get(rawSchema.position());
            if (officialTool == null || !rawSchema.name().equals(officialTool.name())) {
                throw invalidInput(
                        "raw tool schema " + rawSchema.name()
                                + " does not match official tool at position "
                                + rawSchema.position());
            }
        }
    }

    /**
     * Requires a nonblank identifier.
     *
     * @param value identifier value
     * @param name identifier name
     */
    private static void requireId(String value, String name) {
        if (value == null || value.isBlank()) {
            throw invalidInput(name + " must not be null or blank");
        }
    }
}
