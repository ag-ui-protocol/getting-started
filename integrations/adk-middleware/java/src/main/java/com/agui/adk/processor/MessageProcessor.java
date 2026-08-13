package com.agui.adk.processor;

import com.google.genai.types.Content;
import com.google.genai.types.FunctionResponse;
import com.google.genai.types.Part;
import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import com.agui.community.core.message.Message;
import com.agui.community.core.message.Role;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Predicate;
import java.util.stream.Stream;

/**
 * Imported message chunking and Google content conversion logic.
 */
public enum MessageProcessor {

    INSTANCE;

    private static final Predicate<Message> IS_TOOL_MESSAGE =
            message -> message.role() == Role.TOOL;
    private static final Predicate<Message> IS_NOT_TOOL_MESSAGE = IS_TOOL_MESSAGE.negate();

    private final Gson gson = new Gson();

    /**
     * Groups consecutive request messages into the imported execution chunks.
     *
     * @param messages official AG-UI messages
     * @return ordered message chunks
     */
    public List<MessageChunk> groupMessagesIntoChunks(List<Message> messages) {
        if (messages.isEmpty()) {
            return List.of();
        }

        List<MessageChunk> result = new ArrayList<>();
        List<Message> remainingMessages = messages;

        while (!remainingMessages.isEmpty()) {
            MessageChunk messageChunk = remainingMessages.getFirst().role() == Role.TOOL
                    ? createToolLedChunk(remainingMessages)
                    : createUserLedChunk(remainingMessages);

            result.add(messageChunk);

            int processedCount = messageChunk.toolMessages().size()
                    + messageChunk.userSystemMessages().size();
            remainingMessages = remainingMessages.subList(processedCount, remainingMessages.size());
        }

        return result;
    }

    /**
     * Creates a chunk beginning with tool messages.
     *
     * @param messages remaining messages
     * @return tool-led chunk
     */
    private static MessageChunk createToolLedChunk(List<Message> messages) {
        List<Message> toolChunk = findChunk(messages, IS_TOOL_MESSAGE);
        List<Message> messagesAfterTools = messages.subList(toolChunk.size(), messages.size());
        List<Message> userSystemChunk = findChunk(messagesAfterTools, IS_NOT_TOOL_MESSAGE);
        return new MessageChunk(toolChunk, userSystemChunk);
    }

    /**
     * Creates a chunk beginning with a non-tool message.
     *
     * @param messages remaining messages
     * @return user-led chunk
     */
    private static MessageChunk createUserLedChunk(List<Message> messages) {
        List<Message> userSystemChunk = findChunk(messages, IS_NOT_TOOL_MESSAGE);
        return MessageChunk.fromUserSystemChunk(userSystemChunk);
    }

    /**
     * Takes the leading messages matching a predicate.
     *
     * @param messages remaining messages
     * @param predicate chunk predicate
     * @return matching leading messages
     */
    private static List<Message> findChunk(
            List<Message> messages, Predicate<Message> predicate) {
        return messages.stream().takeWhile(predicate).toList();
    }

    /**
     * Constructs Google ADK content from request messages and tool results.
     *
     * @param messageBatch request message batch
     * @param toolResults validated tool results
     * @return content when at least one part exists
     */
    public Optional<Content> constructMessageToSend(
            List<Message> messageBatch, List<ToolResult> toolResults) {
        List<Part> toolParts = createToolParts(toolResults);
        List<Part> userParts = createUserParts(messageBatch);
        List<Part> parts = Stream.of(toolParts, userParts)
                .filter(list -> !list.isEmpty())
                .flatMap(List::stream)
                .toList();

        return Optional.of(parts)
                .filter(items -> !items.isEmpty())
                .map(items -> Content.builder().role("user").parts(items).build());
    }

    /**
     * Builds resumed content containing only a complete response group.
     *
     * @param results complete stable-order result group
     * @return ADK content containing correlated function responses
     */
    public Content constructResumedMessage(
            List<com.agui.adk.hitl.BufferedToolResult> results) {
        return constructResumedMessage(results, List.of());
    }

    /**
     * Builds one atomic ADK content from a complete result group and its follow-up messages.
     *
     * @param results complete stable-order result group
     * @param trailingMessages following request messages
     * @return ADK content containing responses followed by user content
     */
    public Content constructResumedMessage(
            List<com.agui.adk.hitl.BufferedToolResult> results,
            List<Message> trailingMessages) {
        List<Part> responseParts = results.stream()
                .map(result -> Part.builder().functionResponse(FunctionResponse.builder()
                        .id(result.call().key().toolCallId())
                        .name(result.call().event().toolCallName())
                        .response(result.result().response())
                        .build()).build())
                .toList();
        List<Part> parts = Stream.concat(responseParts.stream(), createUserParts(trailingMessages).stream())
                .toList();
        return Content.builder().role("user").parts(parts).build();
    }

    /**
     * Converts the latest user message to a text part.
     *
     * @param messageBatch request message batch
     * @return zero or one user text part
     */
    private static List<Part> createUserParts(List<Message> messageBatch) {
        return messageBatch.stream()
                .filter(message -> message.role() == Role.USER
                        && message.content() != null
                        && !message.content().isEmpty())
                .reduce((first, second) -> second) // Get the last user message
                .map(message -> com.agui.adk.input.MessageContentPartsConverter
                        .fromMessageContent(message.content()))
                .orElse(List.of());
    }

    /**
     * Converts tool result payloads to function-response parts.
     *
     * @param toolResults validated tool results
     * @return Google function-response parts
     */
    private List<Part> createToolParts(List<ToolResult> toolResults) {
        return Optional.ofNullable(toolResults)
                .orElse(List.of())
                .stream()
                .map(toolResult -> {
                    Map<String, Object> responseMap = gson.fromJson(
                            toolResult.message().content(),
                            new TypeToken<Map<String, Object>>() {
                            }.getType());
                    return buildPart(toolResult.toolName(), responseMap);
                })
                .toList();
    }

    /**
     * Wraps a Google function response in a part.
     *
     * @param toolName resolved tool name
     * @param responseMap parsed tool response
     * @return function-response part
     */
    private static Part buildPart(String toolName, Map<String, Object> responseMap) {
        return Part.builder().functionResponse(
                createFunctionResponse(toolName, responseMap)).build();
    }

    /**
     * Builds the Google function response.
     *
     * @param toolName resolved tool name
     * @param responseMap parsed tool response
     * @return Google function response
     */
    private static FunctionResponse createFunctionResponse(
            String toolName, Map<String, Object> responseMap) {
        return FunctionResponse.builder()
                .name(toolName)
                .response(responseMap)
                .build();
    }
}
