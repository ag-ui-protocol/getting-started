package com.agui.adk.hitl;

import com.agui.community.core.message.Message;
import com.agui.community.core.message.ToolMessage;

import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * Separates exact frontend responses from server-tool history before an ADK continuation.
 *
 * <p>The planner recognizes only IDs owned by the pending-call store. It intentionally does not
 * infer frontend ownership from a tool name, because same-name calls may be concurrent.
 */
public final class HitlResumePlanner {
    /**
     * Plans the frontend results represented by one incoming message chunk.
     *
     * @param pendingCallIds exact pending frontend call IDs for this principal-scoped session
     * @param messages incoming chunk messages
     * @return exact pending frontend submissions in request order
     */
    public List<ToolMessage> frontendResults(Set<String> pendingCallIds, List<Message> messages) {
        Objects.requireNonNull(pendingCallIds, "pendingCallIds");
        Objects.requireNonNull(messages, "messages");
        return messages.stream()
                .filter(ToolMessage.class::isInstance)
                .map(ToolMessage.class::cast)
                .filter(message -> pendingCallIds.contains(message.toolCallId()))
                .toList();
    }

    /**
     * Classifies incoming messages before any frontend result can be persisted or resumed.
     *
     * <p>Only tool messages matching a current pending call are frontend submissions. When a
     * request contains one such submission, every other tool result must be known to the same
     * pending set and a following user message would otherwise be lost during the continuation.
     * Historical server tool messages remain ordinary history when no frontend result is present.
     *
     * @param pendingCalls current pending frontend calls for the scoped session
     * @param consumedResults previously consumed frontend result identities
     * @param acceptedResultIds results buffered by earlier requests for current pending groups
     * @param messages incoming messages
     * @return an immutable routing decision
     */
    public Plan plan(
            List<PendingToolCall> pendingCalls,
            Map<String, ConsumedToolResult> consumedResults,
            Set<String> acceptedResultIds,
            List<Message> messages) {
        Objects.requireNonNull(pendingCalls, "pendingCalls");
        Objects.requireNonNull(consumedResults, "consumedResults");
        Objects.requireNonNull(acceptedResultIds, "acceptedResultIds");
        Objects.requireNonNull(messages, "messages");

        Set<String> pendingCallIds = pendingCalls.stream()
                .map(call -> call.key().toolCallId())
                .collect(java.util.stream.Collectors.toUnmodifiableSet());
        List<ToolMessage> frontendResults = frontendResults(pendingCallIds, messages);
        if (frontendResults.isEmpty()) {
            return new Plan(null, List.of(), List.copyOf(messages));
        }
        long matchedGroupCount = pendingCalls.stream()
                .filter(call -> frontendResults.stream()
                        .anyMatch(message -> message.toolCallId().equals(call.key().toolCallId())))
                .map(call -> call.key().group())
                .distinct()
                .count();
        if (matchedGroupCount != 1L) {
            return new Plan("PENDING_CALLS", List.of(), List.copyOf(messages));
        }

        boolean unknownToolResult = messages.stream()
                .filter(ToolMessage.class::isInstance)
                .map(ToolMessage.class::cast)
                .anyMatch(message -> !pendingCallIds.contains(message.toolCallId())
                        && !matchesConsumedResult(consumedResults, message));
        if (unknownToolResult) {
            return new Plan("UNKNOWN_TOOL_RESULT", List.of(), List.copyOf(messages));
        }
        PendingCallGroupKey matchedGroup = pendingCalls.stream()
                .filter(call -> frontendResults.stream()
                        .anyMatch(message -> message.toolCallId().equals(call.key().toolCallId())))
                .map(call -> call.key().group())
                .findFirst()
                .orElseThrow();
        Set<String> matchedResultIds = java.util.stream.Stream.concat(
                        acceptedResultIds.stream(), frontendResults.stream().map(ToolMessage::toolCallId))
                .collect(java.util.stream.Collectors.toUnmodifiableSet());
        boolean groupComplete = pendingCalls.stream()
                .filter(call -> call.key().group().equals(matchedGroup))
                .allMatch(call -> matchedResultIds.contains(call.key().toolCallId()));
        List<Message> trailingMessages = messages.stream()
                .skip(messages.indexOf(frontendResults.getLast()) + 1L)
                .filter(message -> !(message instanceof ToolMessage))
                .toList();
        if (!groupComplete && !trailingMessages.isEmpty()) {
            return new Plan("PENDING_CALLS", List.of(), List.copyOf(messages));
        }
        return new Plan(null, frontendResults, trailingMessages);
    }

    /**
     * Checks a historical result against its retained official-message identity.
     *
     * @param consumedResults retained result identities keyed by provider call ID
     * @param message browser result to classify
     * @return whether the browser result is the exact consumed result
     */
    private static boolean matchesConsumedResult(
            Map<String, ConsumedToolResult> consumedResults, ToolMessage message) {
        ConsumedToolResult consumed = consumedResults.get(message.toolCallId());
        return consumed != null && consumed.matches(message);
    }

    /** Routing decision for one incoming chunk. */
    public record Plan(String errorCode, List<ToolMessage> frontendResults, List<Message> remainingMessages) {
        public Plan {
            frontendResults = List.copyOf(frontendResults);
            remainingMessages = List.copyOf(remainingMessages);
        }
    }
}
