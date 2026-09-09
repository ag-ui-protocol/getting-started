# Deprecations

The shims the SDKs still carry for peers speaking a pre-1.0 protocol. Each
entry names what was retired, what replaces it, where the shim lives, and
when the shim itself expires. The dates below are provisional: 1.0 has not
been released, so they are twelve months from when the shims were WRITTEN
rather than twelve months from when they shipped, and they will be re-dated
from the 1.0 release if it slips. After the expiry date the shim may be
removed in the next release, and the deprecated shape stops working entirely.

The canonical 1.0 contract (spec/draft/schema.json) excludes these shapes.
Compatibility conversions live in the TypeScript client boundary and
middleware layer: the
always-on inbound boundary (`CompatibilityBoundary`) upgrades what arrives,
and four version-gated middlewares are inserted when the peer ceiling is at or
below their version. They do not all work in the same direction.
`BackwardCompatibility_0_0_39` and `_0_0_47` rewrite the `RunAgentInput` on its
way out and leave the returned stream alone; `_0_0_57` does both, sanitising
the input and then filtering and rewriting the stream (it drops the `SUBAGENT_*`
events and strips `subagentRunId` from the survivors — `MESSAGES_SNAPSHOT`
messages, `RUN_STARTED.input` messages, `RUN_FINISHED` interrupt outcomes);
and `_0_0_45` touches the input not at
all — it maps the RETURNED event stream, translating the `THINKING_*` shapes an
old peer sends back into `REASONING_*`. Every inbound conversion warns;
outbound, the warnings fire where a conversion loses or strands content (the
non-lossy binary upgrade for a modern peer is silent).
`SUPPRESS_TRANSFORMATION_WARNINGS=true` silences the warnings, not the
conversions.

| Deprecated shape                              | Replacement                                                             | Shim                                                                  | Expires    |
| --------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------- |
| `THINKING_START` event                        | `REASONING_START`                                                       | inbound boundary (and `BackwardCompatibility_0_0_45` for gated flows) | 2027-08-24 |
| `THINKING_END` event                          | `REASONING_END`                                                         | inbound boundary (and `BackwardCompatibility_0_0_45`)                 | 2027-08-24 |
| `THINKING_TEXT_MESSAGE_START` event           | `REASONING_MESSAGE_START`                                               | inbound boundary (and `BackwardCompatibility_0_0_45`)                 | 2027-08-24 |
| `THINKING_TEXT_MESSAGE_CONTENT` event         | `REASONING_MESSAGE_CONTENT`                                             | inbound boundary (and `BackwardCompatibility_0_0_45`)                 | 2027-08-24 |
| `THINKING_TEXT_MESSAGE_END` event             | `REASONING_MESSAGE_END`                                                 | inbound boundary (and `BackwardCompatibility_0_0_45`)                 | 2027-08-24 |
| `{ type: "binary" }` input content part       | the media parts (`image`, `audio`, `video`, `document`) with a `source` | inbound boundary; outbound `BackwardCompatibility_0_0_47`             | 2027-08-24 |
| `parentMessageId: null` on `TOOL_CALL_START`  | omit the field                                                          | inbound boundary                                                      | 2027-08-24 |
| `parentMessageId: null` on `TOOL_CALL_CHUNK`  | omit the field                                                          | inbound boundary                                                      | 2027-08-24 |
| `outcome: null` on `RUN_FINISHED`             | omit the field                                                          | inbound boundary                                                      | 2027-08-24 |
| `rawEvent: null` on an event                  | omit the field                                                          | inbound boundary                                                      | 2027-09-08 |
| `result: null` on `RUN_FINISHED`              | omit the field                                                          | inbound boundary                                                      | 2027-09-08 |
| `result: null` on `SUBAGENT_FINISHED`         | omit the field                                                          | inbound boundary                                                      | 2027-09-08 |
| `payload: null` on a resume entry             | omit the field                                                          | inbound boundary (events)                                             | 2027-09-08 |
| `metadata: null` on an `image` content part   | omit the field                                                          | inbound boundary (events)                                             | 2027-09-08 |
| `metadata: null` on an `audio` content part   | omit the field                                                          | inbound boundary (events)                                             | 2027-09-08 |
| `metadata: null` on a `video` content part    | omit the field                                                          | inbound boundary (events)                                             | 2027-09-08 |
| `metadata: null` on a `document` content part | omit the field                                                          | inbound boundary (events)                                             | 2027-09-08 |
| `parameters: null` on a tool                  | omit the field                                                          | inbound boundary (events)                                             | 2027-09-08 |
| `forwardedProps: null` on `RunAgentInput`     | omit the field                                                          | inbound boundary (events)                                             | 2027-09-08 |

The optional-null conversions preserve compatibility with shapes the previous
SDK accepted. They run before validation on incoming events, including nested
messages and `RUN_STARTED.input`, across in-memory runs, reconnects, SSE and
protobuf. Direct request parsing does not pass through this event boundary.
Request handlers accepting older inputs must locally omit the listed optional
nulls before strict validation; CopilotKit's shared run/connect parser is this
explicit exception. The conversion helper remains internal to AG-UI, with no
public request-normalization API. Canonical schemas still reject these whole
optional nulls, and producer serializers omit them. The existing
`RunAgentInput.state: null` parser tolerance continues to yield `undefined`.

This is a selective compatibility list: event or message `metadata: null` and
`parentRunId: null` already failed validation and remain invalid. Required JSON
payloads such as `CUSTOM.value: null` remain valid.

A `null` **value under a metadata key** is not on this list and never will
be: metadata is open by key and a null value there is data. Only a `null` in
place of a whole optional field was ever a deviation.
