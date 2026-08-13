package com.agui.adk.history;

import com.agui.community.core.message.Message;
import com.agui.community.core.message.Role;
import com.agui.community.core.message.ToolMessage;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * Pure port of the Python {@code ADKAgent} message-id helpers. {@link #filter} mirrors
 * {@code _get_unseen_messages}: returns the messages not yet processed for a session, maintaining
 * chronological order. It filters out ALL processed messages (not just up to the first one) to
 * handle out-of-order processing (e.g. LRO tool results arriving after later user messages); a
 * {@code ToolMessage} is also skipped when its {@code tool_call_id} has been processed (the #437
 * replay fix). {@link #collectMessageIds} mirrors {@code _collect_message_ids}: extracts the ids of
 * messages that carry one (skipping id-less/empty id messages), preserving order - used to record
 * which messages were just processed.
 */
public final class UnseenMessageFilter {

    private UnseenMessageFilter() {
    }

    /**
     * Returns the unprocessed messages in order.
     *
     * @param messages     the session's candidate messages
     * @param processedIds ids (and processed tool_call_ids) already marked processed
     * @return the unseen, unprocessed messages preserving order
     */
    public static List<Message> filter(List<Message> messages, Set<String> processedIds) {
        if (messages == null || messages.isEmpty()) {
            return List.of();
        }
        List<Message> unseen = new ArrayList<>();
        for (Message message : messages) {
            String messageId = message.id();
            if (messageId != null && processedIds.contains(messageId)) {
                continue;
            }
            if (message instanceof ToolMessage toolMessage) {
                String toolCallId = toolMessage.toolCallId();
                if (toolCallId != null && processedIds.contains(toolCallId)) {
                    continue;
                }
            }
            unseen.add(message);
        }
        return unseen;
    }

    /**
     * Port of the Python {@code ADKAgent._is_tool_result_submission}: whether the last unseen
     * message is a tool result - the run loop uses this to decide whether a submission resumes a
     * pending tool batch (resume gate) or starts a fresh turn. Returns false for an empty/unseen
     * list or when the last message is not a tool message.
     *
     * @param unseen the unseen, unprocessed messages
     * @return true when the last unseen message is a tool message
     */
    public static boolean isToolResultSubmission(List<Message> unseen) {
        if (unseen == null || unseen.isEmpty()) {
            return false;
        }
        return unseen.get(unseen.size() - 1).role() == Role.TOOL;
    }

    /**
     * Port of the Python {@code ADKAgent._collect_message_ids}: extracts the ids of the given
     * messages that carry a non-empty id, preserving order (id-less/empty-id messages are skipped).
     *
     * @param messages the messages to collect ids from
     * @return the message ids that are present and non-empty
     */
    public static List<String> collectMessageIds(List<Message> messages) {
        if (messages == null || messages.isEmpty()) {
            return List.of();
        }
        List<String> ids = new ArrayList<>();
        for (Message message : messages) {
            String id = message.id();
            if (id != null && !id.isEmpty()) {
                ids.add(id);
            }
        }
        return ids;
    }
}
