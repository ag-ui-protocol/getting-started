package com.agui.adk.hitl;

import com.google.genai.types.Content;
import com.google.genai.types.FunctionResponse;
import com.google.genai.types.Part;

import java.util.Map;
import java.util.Objects;

/**
 * Translates AG-UI compatibility confirmation actions into native ADK continuation content.
 */
public final class AdkConfirmationTranslator {

    private static final String REQUEST_CONFIRMATION_FUNCTION_CALL_NAME = "adk_request_confirmation";

    /**
     * Immutable decision retaining both native ADK correlation identifiers.
     *
     * @param invocationId synthetic confirmation function-call identifier
     * @param toolCallId original ADK tool-call identifier
     * @param approved confirmation decision
     */
    public record Decision(String invocationId, String toolCallId, boolean approved) {
        public Decision {
            invocationId = Objects.requireNonNull(invocationId, "invocationId");
            toolCallId = Objects.requireNonNull(toolCallId, "toolCallId");
        }
    }

    /**
     * Creates an approved confirmation decision.
     *
     * @param invocationId synthetic confirmation function-call identifier
     * @param toolCallId original ADK tool-call identifier
     * @return immutable decision
     */
    public Decision approve(String invocationId, String toolCallId) {
        return new Decision(invocationId, toolCallId, true);
    }

    /**
     * Creates a rejected confirmation decision.
     *
     * @param invocationId synthetic confirmation function-call identifier
     * @param toolCallId original ADK tool-call identifier
     * @return immutable decision
     */
    public Decision reject(String invocationId, String toolCallId) {
        return new Decision(invocationId, toolCallId, false);
    }

    /**
     * Builds the user function-response consumed by ADK's confirmation request processor.
     *
     * @param decision client confirmation decision
     * @return native ADK continuation content
     */
    public Content continuation(Decision decision) {
        Objects.requireNonNull(decision, "decision");
        Map<String, Object> confirmation = Map.of(
                "hint", "",
                "confirmed", decision.approved(),
                "payload", Map.of("toolCallId", decision.toolCallId()));
        return Content.builder()
                .role("user")
                .parts(Part.builder().functionResponse(FunctionResponse.builder()
                        .id(decision.invocationId())
                        .name(REQUEST_CONFIRMATION_FUNCTION_CALL_NAME)
                        .response(confirmation)
                        .build()).build())
                .build();
    }
}
