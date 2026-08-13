type StreamResponseChunk = any;
type SubgraphStreamEvent = any;

export function isSubgraphStreamEvent(
  event: StreamResponseChunk,
): event is StreamResponseChunk & { method: "lifecycle"; params: { data: SubgraphStreamEvent } } {
    // OLD:
    // (streamResponseChunk.event.startsWith("events") ||
    //             streamResponseChunk.event.startsWith("values"))

  return event?.method === "lifecycle" && event?.params?.data?.type === "subgraph";
}

// The "messages-tuple" stream mode surfaces in the v3 protocol as a
// lifecycle event whose params.data.type is "message_tuple" (rather than
// the legacy SSE "messages" event name), so we match on that data type.
export function isMessageTupleEvent(event: StreamResponseChunk): event is StreamResponseChunk & { method: "lifecycle"; params: { data: { type: "message_tuple"; message: any } } } {
    // OLD:
    // streamResponseChunk.event === "messages" &&
    //           (Array.isArray(streamModes) ? streamModes : [streamModes]).includes(
    //             "messages-tuple" as StreamMode,
    //           )

    return event?.method === "lifecycle" && event?.params?.data?.type === "message_tuple";
}