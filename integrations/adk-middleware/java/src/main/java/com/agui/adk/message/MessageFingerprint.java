package com.agui.adk.message;

import com.agui.community.core.message.AssistantMessage;
import com.agui.community.core.message.DeveloperMessage;
import com.agui.community.core.message.FunctionCall;
import com.agui.community.core.message.Message;
import com.agui.community.core.message.SystemMessage;
import com.agui.community.core.message.ToolCall;
import com.agui.community.core.message.ToolMessage;
import com.agui.community.core.message.UserMessage;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Objects;

/** Produces stable content fingerprints for duplicate AG-UI message IDs. */
public final class MessageFingerprint {

    private MessageFingerprint() {
    }

    /**
     * Hashes every wire-significant field of each official AG-UI 0.2.0 message variant.
     * Length-prefixing makes the serialized form unambiguous and deterministic.
     *
     * @param message official AG-UI message
     * @return lowercase SHA-256 fingerprint
     */
    public static String of(Message message) {
        Objects.requireNonNull(message, "message");
        StringBuilder payload = new StringBuilder();
        append(payload, message.getClass().getName());
        append(payload, message.id());
        append(payload, message.role().name());
        append(payload, message.content());
        switch (message) {
            case UserMessage user -> append(payload, user.name());
            case SystemMessage system -> append(payload, system.name());
            case DeveloperMessage developer -> append(payload, developer.name());
            case ToolMessage tool -> {
                append(payload, tool.toolCallId());
                append(payload, tool.error());
            }
            case AssistantMessage assistant -> {
                append(payload, assistant.name());
                append(payload, Integer.toString(assistant.toolCalls().size()));
                for (ToolCall toolCall : assistant.toolCalls()) {
                    appendToolCall(payload, toolCall);
                }
            }
        }
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256")
                    .digest(payload.toString().getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(bytes.length * 2);
            for (byte value : bytes) {
                hex.append(Character.forDigit((value >>> 4) & 0xf, 16));
                hex.append(Character.forDigit(value & 0xf, 16));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }

    /**
     * Internal helper.
     * @param payload value
     * @param toolCall value
     */
    private static void appendToolCall(StringBuilder payload, ToolCall toolCall) {
        FunctionCall function = toolCall.function();
        append(payload, toolCall.id());
        append(payload, toolCall.type());
        append(payload, function.name());
        append(payload, function.arguments());
    }

    /**
     * Internal helper.
     * @param payload value
     * @param value value
     */
    private static void append(StringBuilder payload, String value) {
        if (value == null) {
            payload.append(-1).append(':');
        } else {
            payload.append(value.length()).append(':').append(value);
        }
    }
}
