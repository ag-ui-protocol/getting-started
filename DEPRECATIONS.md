# Deprecations

The shims the SDKs still carry for peers speaking a pre-1.0 protocol. Each
entry names what was retired, what replaces it, where the shim lives, and
when the shim itself expires. The dates below are provisional: 1.0 has not
been released, so they are twelve months from when the shims were WRITTEN
rather than twelve months from when they shipped, and they will be re-dated
from the 1.0 release if it slips. After the expiry date the shim may be
removed in the next release, and the deprecated shape stops working entirely.

The 1.0 contract (spec/draft/schema.json) does not describe any of these
shapes, and since the SDKs moved onto the generated models none of the three
— TypeScript, Python, .NET — declares them. They exist only as conversions
in the TypeScript client middleware layer: the
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

| Deprecated shape | Replacement | Shim | Expires |
| --- | --- | --- | --- |
| `THINKING_START` event | `REASONING_START` | inbound boundary (and `BackwardCompatibility_0_0_45` for gated flows) | 2027-08-24 |
| `THINKING_END` event | `REASONING_END` | inbound boundary (and `BackwardCompatibility_0_0_45`) | 2027-08-24 |
| `THINKING_TEXT_MESSAGE_START` event | `REASONING_MESSAGE_START` | inbound boundary (and `BackwardCompatibility_0_0_45`) | 2027-08-24 |
| `THINKING_TEXT_MESSAGE_CONTENT` event | `REASONING_MESSAGE_CONTENT` | inbound boundary (and `BackwardCompatibility_0_0_45`) | 2027-08-24 |
| `THINKING_TEXT_MESSAGE_END` event | `REASONING_MESSAGE_END` | inbound boundary (and `BackwardCompatibility_0_0_45`) | 2027-08-24 |
| `{ type: "binary" }` input content part | the media parts (`image`, `audio`, `video`, `document`) with a `source` | inbound boundary; outbound `BackwardCompatibility_0_0_47` | 2027-08-24 |
| `parentMessageId: null` on `TOOL_CALL_START` | omit the field | inbound boundary | 2027-08-24 |
| `parentMessageId: null` on `TOOL_CALL_CHUNK` | omit the field | inbound boundary | 2027-08-24 |
| `outcome: null` on `RUN_FINISHED` | omit the field | inbound boundary | 2027-08-24 |

A `null` **value under a metadata key** is not on this list and never will
be: metadata is open by key and a null value there is data. Only a `null` in
place of a whole optional field was ever a deviation.
