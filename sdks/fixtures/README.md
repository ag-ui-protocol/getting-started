# Cross-language fixtures

Fixtures in this directory are shared by more than one AG-UI SDK. They exist so a wire-format
expectation is written down **once** and every SDK is held to the same text, instead of each SDK
carrying its own copy that can drift.

A fixture here is plain JSON with no language-specific assumptions. Per-SDK fixtures that only ever
serve one implementation stay inside that SDK's test tree.

## `null-omission.json`

The contract that a producer leaves a field **out** of the JSON when it has no value, rather than
writing it as `null`.

TypeScript gets this for free (`JSON.stringify` drops `undefined`). Python and .NET do not — their
serializers write `null` by default — and the divergence cost the protocol three receiving-side
tolerance patches before it was fixed at the source (`TOOL_CALL_START.parentMessageId`,
`TOOL_CALL_CHUNK.parentMessageId`, `RUN_FINISHED.outcome` all still accept `null` for the benefit of
older producers). The fixture pins the behaviour so a fourth one is not needed.

### Shape

```jsonc
{
  "stream": [
    {
      "name": "run_finished_without_result_or_outcome",
      "producedBy": ["typescript", "python", "dotnet"],
      "note": "why this case is here",
      "input": {
        "type": "RUN_FINISHED",
        "threadId": "thread_1",
        "runId": "run_1",
      },
      "expected": {
        "type": "RUN_FINISHED",
        "threadId": "thread_1",
        "runId": "run_1",
      },
    },
  ],
}
```

Each SDK's test walks `stream` and, for every case listing its own name in `producedBy`:

1. deserializes `input` into the SDK's native event type,
2. re-serializes it through the SDK's official producer path (its event encoder / SSE formatter),
3. asserts the emitted JSON parses to exactly `expected`.

Because `expected` is exact, a stray `null` fails the case, and a `null` that the contract _does_
carry (an individual metadata value, a value inside a state snapshot or a JSON Patch operation) must
still be there. Cases are meant to be read as one plausible stream of events, top to bottom.

`producedBy` exists only for event types an SDK genuinely does not implement — protobuf-era chunk
events are absent from .NET, for instance. It is not an escape hatch for a case an SDK fails.

### Consumers

| SDK        | Test                                                                       |
| ---------- | -------------------------------------------------------------------------- |
| TypeScript | `sdks/typescript/packages/encoder/src/__tests__/null-omission.test.ts`     |
| Python     | `sdks/python/tests/test_null_omission.py`                                  |
| .NET       | `sdks/dotnet/tests/AGUI.Abstractions.UnitTests/NullOmissionFixtureTest.cs` |

Those fixture tests check that the SDKs agree with each other. Each SDK additionally has a
reflection-driven test that walks _every_ wire type it defines — not just the ones named here — and
fails on any `null` the contract does not permit. Adding a case here does not remove the need for
that broader sweep; the two catch different things.

### Wiring a new consumer: make the build see this directory

A fixture here sits outside every SDK's project directory, so a build system that decides what to
re-run by looking only inside a project will not notice it changing. Each consumer needs that dealt
with explicitly, or an edit here can leave a stale green result behind:

- **.NET** links the file in as an `EmbeddedResource` (see
  `AGUI.Abstractions.UnitTests.csproj`). MSBuild tracks `EmbeddedResource` items, so this is
  handled.
- **Python** is run directly by `unittest`, with no caching layer. Nothing to do.
- **TypeScript** runs under Nx, which caches `test` on `{projectRoot}/**/*` — this directory is not
  in it. `@ag-ui/encoder` therefore sets `nx.targets.test.cache: false` in its `package.json`; its
  suite takes well under a second, so always running it is cheaper than the risk.

The obvious alternative — adding `{workspaceRoot}/sdks/fixtures/**/*` to the `test` target's
`inputs` in `nx.json` — **does not work**, and was tried. On Nx 22.5.0 in this workspace a
`{workspaceRoot}` input does not reach the hasher: verified with a tracked control file at the
repository root, which changed the file without changing the task hash. Don't spend time on it
again; turn caching off for the consuming project instead.

### Known boundary

.NET models an opaque JSON payload either as `JsonElement` or as `JsonElement?`, and only the
nullable form has this problem: `JsonElement?` cannot tell `"value": null` apart from an absent
`value`, because System.Text.Json maps a JSON null onto the `Nullable<T>` having no value.

So a payload field that is _entirely_ `null` round-trips through .NET for the non-nullable ones and
is lost for the nullable ones:

| Field                       | .NET type      | `field: null` survives?                                                                                     |
| --------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------- |
| `STATE_SNAPSHOT.snapshot`   | `JsonElement`  | yes — covered by a fixture case                                                                             |
| `RAW.event`                 | `JsonElement`  | yes — covered by a fixture case                                                                             |
| `ACTIVITY_SNAPSHOT.content` | `JsonElement`  | yes, but TypeScript's `z.record` rejects a null `content`, so the fixture cannot assert it across all three |
| `CUSTOM.value`              | `JsonElement?` | **no**                                                                                                      |
| `RUN_FINISHED.result`       | `JsonElement?` | **no**                                                                                                      |

Nulls _nested inside_ any of these payloads always survive, in every SDK. Closing the two remaining
gaps means changing those properties to non-nullable `JsonElement` with
`JsonIgnoreCondition.WhenWritingDefault` — a breaking type change, so it is deliberately out of
scope here.

`RunAgentInput.state` is **not** in this table, on purpose: there the null-collapse is the
contract, not a limitation. `state` is optional, absent means "no state", and a bare `null` is
read as absent — a survey of every integration found none that distinguishes the two, so all three
SDKs converge on omission (see the `run_started_input_with_bare_null_state_converges_on_omission`
case). Nulls _inside_ a state object are values and survive.
