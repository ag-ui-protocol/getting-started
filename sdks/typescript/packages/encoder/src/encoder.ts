import { BaseEvent, omitOptionalNulls } from "@ag-ui/core";
import * as proto from "@ag-ui/proto";
import { preferredMediaTypes } from "./media-type";

export interface EventEncoderParams {
  accept?: string;
}

export class EventEncoder {
  private acceptsProtobuf: boolean;

  constructor(params?: EventEncoderParams) {
    this.acceptsProtobuf = params?.accept ? this.isProtobufAccepted(params.accept) : false;
  }

  getContentType(): string {
    if (this.acceptsProtobuf) {
      return proto.AGUI_MEDIA_TYPE;
    } else {
      return "text/event-stream";
    }
  }

  encode(event: BaseEvent): string {
    return this.encodeSSE(event);
  }

  encodeSSE(event: BaseEvent): string {
    return `data: ${JSON.stringify(omitOptionalNulls(event, "Event"))}\n\n`;
  }

  encodeBinary(event: BaseEvent): Uint8Array {
    if (this.acceptsProtobuf) {
      return this.encodeProtobuf(event);
    } else {
      const sseString = this.encodeSSE(event);
      // Convert string to Uint8Array using TextEncoder
      const encoder = new TextEncoder();
      return encoder.encode(sseString);
    }
  }

  encodeProtobuf(event: BaseEvent): Uint8Array {
    const messageBytes = proto.encode(event);
    const length = messageBytes.length;

    // Create a buffer for 4 bytes (for the uint32 length) plus the message bytes
    const buffer = new ArrayBuffer(4 + length);
    const dataView = new DataView(buffer);

    // Write the length as a uint32
    // Set the third parameter to `false` for big-endian or `true` for little-endian
    dataView.setUint32(0, length, false);

    // Create a Uint8Array view and copy in the message bytes after the 4-byte header
    const result = new Uint8Array(buffer);
    result.set(messageBytes, 4);

    return result;
  }

  private isProtobufAccepted(acceptHeader: string): boolean {
    // Pass the Accept header and an array with your media type
    const preferred = preferredMediaTypes(acceptHeader, [proto.AGUI_MEDIA_TYPE]);

    // If the returned array includes your media type, it's acceptable
    return preferred.includes(proto.AGUI_MEDIA_TYPE);
  }
}
