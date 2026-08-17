import { EventEncoder } from "../encoder";
import { EventType, TextMessageStartEvent } from "@ag-ui/core";
import * as proto from "@ag-ui/proto";

describe("Encoder Tests", () => {
  // Create a valid TextMessageStartEvent event
  const testEvent: TextMessageStartEvent = {
    type: EventType.TEXT_MESSAGE_START,
    timestamp: 123456789,
    messageId: "msg123",
    role: "assistant",
  };

  describe("encodeBinary method", () => {
    it("should return protobuf encoded data when accept header includes protobuf media type", () => {
      // Setup an encoder with protobuf accepted
      const encoder = new EventEncoder({
        accept: `text/event-stream, ${proto.AGUI_MEDIA_TYPE}`,
      });

      // Get the binary encoding
      const result = encoder.encodeBinary(testEvent);

      // Verify it's a Uint8Array
      expect(result).toBeInstanceOf(Uint8Array);

      // A protobuf message should start with 4 bytes for length followed by the message
      // So the length should be greater than 4 at minimum
      expect(result.length).toBeGreaterThan(4);

      // The first 4 bytes should be a uint32 representing the message length
      const dataView = new DataView(result.buffer);
      const messageLength = dataView.getUint32(0, false); // false for big-endian

      // The actual message should match the length specified in the header
      expect(result.length - 4).toBe(messageLength);
    });

    it("should return SSE encoded data when accept header doesn't include protobuf media type", () => {
      // Setup an encoder without protobuf accepted
      const encoder = new EventEncoder({
        accept: "text/event-stream",
      });

      // Get the binary encoding
      const result = encoder.encodeBinary(testEvent);

      // Verify it's a Uint8Array
      expect(result).toBeInstanceOf(Uint8Array);

      // Convert back to string to verify it's SSE format
      const decoder = new TextDecoder();
      const resultString = decoder.decode(result);

      // Should match the SSE format with the expected JSON
      expect(resultString).toBe(`data: ${JSON.stringify(testEvent)}\n\n`);
    });

    it("should return SSE encoded data when no accept header is provided", () => {
      // Setup an encoder without any accept header
      const encoder = new EventEncoder();

      // Get the binary encoding
      const result = encoder.encodeBinary(testEvent);

      // Verify it's a Uint8Array
      expect(result).toBeInstanceOf(Uint8Array);

      // Convert back to string to verify it's SSE format
      const decoder = new TextDecoder();
      const resultString = decoder.decode(result);

      // Should match the SSE format with the expected JSON
      expect(resultString).toBe(`data: ${JSON.stringify(testEvent)}\n\n`);
    });
  });

  describe("encodeProtobuf method", () => {
    it("should encode event as protobuf with length prefix", () => {
      const encoder = new EventEncoder();

      const result = encoder.encodeProtobuf(testEvent);

      // Verify it's a Uint8Array
      expect(result).toBeInstanceOf(Uint8Array);

      // A protobuf message should start with 4 bytes for length followed by the message
      expect(result.length).toBeGreaterThan(4);

      // The first 4 bytes should be a uint32 representing the message length
      const dataView = new DataView(result.buffer);
      const messageLength = dataView.getUint32(0, false); // false for big-endian

      // The actual message should match the length specified in the header
      expect(result.length - 4).toBe(messageLength);

      // The message length should be greater than zero
      expect(messageLength).toBeGreaterThan(0);
    });
  });
});
