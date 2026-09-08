# AG-UI .NET Code Review — Rules Reference

Full detail for every rule in [`../SKILL.md`](../SKILL.md): what to look for, the
exceptions, and a BAD→GOOD example where one clarifies the rule. Severity legend:
❌ must fix · ⚠️ should fix · 💡 optional polish.

- [Phase A — Scope / scenarios](#phase-a--scope--scenarios)
- [Phase B — Design / architecture](#phase-b--design--architecture)
- [Phase C — Implementation / correctness](#phase-c--implementation--correctness)
- [Phase D — Wire compatibility](#phase-d--wire-compatibility)
- [Phase E — PublicAPI analyzer](#phase-e--publicapi-analyzer)
- [Phase F — Style / naming](#phase-f--style--naming)
- [Phase G — Tests](#phase-g--tests)

---

## Phase A — Scope / scenarios

### NET-SCOPE-01 · Every change traces to a spec requirement or issue `[⚠️]`
**Look for:** code in the diff that no requirement, issue, or design note asks for.
**Exceptions:** minimal infra implied by the feature (a new csproj, a DI
registration the feature needs); small, clearly-correct drive-by fixes in touched
code — flag them as out-of-scope but reasonable.

### NET-SCOPE-02 · No unrequested capability, configurability, or dependency `[⚠️]`
**Look for:** options/flags/strategy seams added "just in case"; a NuGet dependency
for something the BCL or an existing package already provides.
**Exceptions:** none — hardcode the value and remove the seam until a requirement asks for it.

```csharp
// BAD: spec asked only to emit events; a knob nobody requested
public AGUIStreamOptions Options { get; set; } = new() { BufferSize = 4096 };

// GOOD: no configurability until required
// (emit with the SDK defaults)
```

### NET-SCOPE-03 · A wire/protocol change carries compatibility coverage `[❌]`
**Look for:** an event/message field rename, a new required field, a casing or
discriminator change with no fixture/round-trip test proving TS compatibility.
**Exceptions:** none for wire-affecting changes. See `NET-TEST-04`.

### NET-SCOPE-04 · Sample-only behavior stays out of `src/` `[⚠️]`
**Look for:** demo/host wiring (ASP.NET endpoints, `Configure<JsonOptions>`) added
to a `src/` package instead of `samples/AGUI.Samples.Shared`.
**Exceptions:** none — `src/` is framework-agnostic.

### NET-SCOPE-05 · Minimal footprint `[⚠️]`
**Look for:** unrelated refactors, speculative abstraction, or cosmetic churn mixed
into a feature diff; every changed line should serve the stated task.
**Exceptions:** a formatting fix inside a span you also changed functionally is
local scope — keep it. A pre-existing problem in a file you only touched lightly is
**reported**, not fixed here.

---

## Phase B — Design / architecture

### NET-ARCH-01 · No `src/` project references `Microsoft.AspNetCore.App` `[❌]`
**Look for:** a `FrameworkReference`/`PackageReference` to ASP.NET, or `using
Microsoft.AspNetCore.*`, anywhere under `sdks/dotnet/src`. Verify:
`git grep "Microsoft.AspNetCore" -- sdks/dotnet/src` must be empty.
**Exceptions:** none — ASP.NET belongs only in `samples/AGUI.Samples.Shared`.

### NET-ARCH-02 · Correct package placement `[❌]`
**Look for:** wire/protocol types outside `AGUI.Abstractions`; SSE/formatting outside
`AGUI.Formatting`; protobuf outside `AGUI.Protobuf`; client/transport outside
`AGUI.Client`; server-agnostic hosting outside `AGUI.Server`.
**Exceptions:** none.

```csharp
// BAD: a wire event declared in AGUI.Client
namespace AGUI.Client; public sealed class FooEvent : BaseEvent { ... }

// GOOD: wire types live in Abstractions
namespace AGUI.Abstractions; public sealed class FooEvent : BaseEvent { ... }
```

### NET-ARCH-03 · Dependency direction `[❌]`
**Look for:** `AGUI.Client` referencing `AGUI.Server` or vice versa; either taking
an ASP.NET dependency. They share only Abstractions/Formatting.
**Exceptions:** none. Cite: `src/AGUI.Server/AGUI.Server.csproj`.

### NET-ARCH-04 · `IChatClient` is the only integration point `[💡]`
**Look for:** a new bespoke "agent" interface or runner that bypasses the
`Microsoft.Extensions.AI` middleware model.
**Exceptions:** internal helpers that compose `IChatClient` are fine.

### NET-ARCH-05 · Every type has a single reason to change `[⚠️]`
**Look for:** a type mixing unrelated responsibilities (e.g., wire mapping +
transport + DI wiring) — usually a sign your new code gave an existing class a
second job.
**Exceptions:** extract YOUR new responsibility into a new type; don't refactor the
pre-existing one if that is medium+ blast radius — report it instead.

### NET-ARCH-06 · No interface without multiple implementations or a test-double need `[⚠️]`
**Look for:** a one-implementation interface or single-use factory added for
indirection only.
**Exceptions:** an interface that exists purely for a test double is justified.

### NET-ARCH-07 · Make invalid states unrepresentable `[⚠️]`
**Look for:** `bool`/`string` parameters or properties where an enum, `required`
member, or distinct type would prevent an invalid combination.
**Exceptions:** wire types must mirror the TS shape — if TS uses a string, match it
(see `NET-WIRE-01`) rather than inventing an enum that breaks the wire.

### NET-ARCH-08 · One class per file; file name matches the type `[⚠️]`
**Look for:** multiple top-level types in a file, or a file name that doesn't match
its type. Folders (`Events/`, `Messages/`) are layout, not namespace segments.
**Exceptions:** tiny tightly-coupled private nested types are fine inside their owner.

---

## Phase C — Implementation / correctness

### NET-IMPL-01 · Every serializable type registered in `AGUIJsonSerializerContext` `[❌]`
**Look for:** a new event/message/payload type without a `[JsonSerializable(typeof(T))]`
entry. Cite: `src/AGUI.Abstractions/Serialization/AGUIJsonSerializerContext.cs`.
**Exceptions:** none — an unregistered type fails at runtime under AOT.

```csharp
// BAD: new type, no registration -> AOT/runtime failure
public sealed class ActivityEvent : BaseEvent { ... }

// GOOD: registered in the source-gen context
[JsonSerializable(typeof(ActivityEvent))]
public partial class AGUIJsonSerializerContext : JsonSerializerContext { }
```

### NET-IMPL-02 · No `Serialize<object>` / no reflection serialization `[❌]`
**Look for:** `JsonSerializer.Serialize(value)` without a `JsonTypeInfo`,
`Serialize<object>(...)`, or any reflection-based (de)serialization path.
**Exceptions:** none — always go through `AGUIJsonSerializerContext.Default.{Type}`
or `options.GetTypeInfo(...)`.

### NET-IMPL-03 · Polymorphic JSON uses a hand-written discriminator converter `[❌]`
**Look for:** `[JsonDerivedType]`/`[JsonPolymorphic]` or reflection polymorphism on
events/messages/content. Cite: `src/AGUI.Abstractions/Events/BaseEventJsonConverter.cs`,
`AGUIMessageJsonConverter`, `AGUIInputContentJsonConverter`.
**Exceptions:** none — attribute polymorphism is not AOT-safe.

```csharp
// BAD: reflection polymorphism
[JsonDerivedType(typeof(FooEvent), "FOO")] public abstract class BaseEvent { }

// GOOD: discriminator switch in the converter
"FOO" => JsonSerializer.Deserialize(ref reader, ctx.FooEvent),
```

### NET-IMPL-04 · Property attribute kit present `[⚠️]`
**Look for, on each serialized property:** explicit `[JsonPropertyName("camelCase")]`;
**no** `[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]` on optionals —
`AGUIJsonSerializerContext` sets `DefaultIgnoreCondition = WhenWritingNull` for every type it
knows, and a re-added per-property attribute hides whether that global setting still works;
required strings initialized to `string.Empty`; collections to `[]`.
Cite: `src/AGUI.Abstractions/Events/RunStartedEvent.cs`.
**Exceptions:** a non-nullable `JsonElement` the contract lets a producer omit takes
`WhenWritingDefault` (`AGUITool.Parameters`, `RunAgentInput`); `InterruptRequestContent` and
`InterruptResponseContent` keep `WhenWritingNull` attributes because they are registered onto
caller-owned options and cannot inherit the context's setting.

### NET-IMPL-05 · `ConfigureAwait(false)` on every `await` in `src/` `[⚠️]`
**Look for:** a bare `await` in a `src/` library path. Cite:
`src/AGUI.Client/AGUIChatClient.cs`.
**Exceptions:** sample/test code does not require it.

```csharp
// BAD
await stream.WriteAsync(buffer, ct);
// GOOD
await stream.WriteAsync(buffer, ct).ConfigureAwait(false);
```

### NET-IMPL-06 · `[EnumeratorCancellation]` on `IAsyncEnumerable<T>` tokens `[⚠️]`
**Look for:** an `async IAsyncEnumerable<T>` method whose `CancellationToken`
parameter lacks `[EnumeratorCancellation]`. Cite:
`src/AGUI.Formatting/SseEventStreamFormatter.cs`.
**Exceptions:** none when the token is meant to flow to the consumer.

### NET-IMPL-07 · `ArgumentNullException.ThrowIfNull` for public-API args `[⚠️]`
**Look for:** public methods dereferencing a reference parameter without a null
guard. Cite: `src/AGUI.Client/AGUIChatClient.cs`.
**Exceptions:** value types and already-validated internal call paths.

### NET-IMPL-08 · Validate external input at the boundary `[⚠️]`
**Look for:** range/format/length validation scattered deep in the call stack
instead of where untrusted data enters; conversely, redundant re-validation of
data already checked at the boundary.
**Exceptions:** none — trust validated data internally (see `NET-TEST-06` boundary tests).

### NET-IMPL-09 · Guard every code path `[⚠️]`
**Look for:** a `switch` without a `default`, an `if` chain with no final `else`,
or a branch that silently falls through for an unexpected discriminator.
**Exceptions:** an exhaustive `switch` over a closed enum the compiler proves complete.

### NET-IMPL-10 · No swallowed exceptions `[⚠️]`
**Look for:** empty `catch {}`, a `catch` that only logs and continues, or one that
loses the original via `throw ex;`.
**Exceptions:** a `catch` that genuinely handles and recovers, with a comment saying why.

```csharp
// BAD
try { Parse(s); } catch { }
// GOOD
try { Parse(s); }
catch (FormatException ex) { throw new InvalidOperationException("…", ex); }
```

### NET-IMPL-11 · Never log or expose sensitive data in errors `[❌]`
**Look for:** tokens, keys, auth headers, or PII in log messages, exception
messages, or error responses.
**Exceptions:** none.

### NET-IMPL-12 · No dead, commented-out, or impossible-condition defensive code `[⚠️]`
**Look for:** ≥2 lines of commented-out code; a null check after a non-nullable flow;
an `else`/`case` that can never run.
**Exceptions:** remove only in files you changed; report pre-existing dead code
elsewhere instead of fixing it.

### NET-IMPL-13 · No logic duplicated across the changeset (Rule of Three) `[⚠️]`
**Look for:** ≥3 near-identical blocks/methods within your diff; extract a shared
helper and update all call sites.
**Exceptions:** only 2 occurrences (each <20 lines) — tolerate; duplicated AAA setup
in tests is acceptable (`NET-TEST-11`). Don't extract a single-use helper.

### NET-IMPL-14 · Prefer BCL/platform APIs over hand-rolled equivalents `[⚠️]`
**Look for:** a custom helper reimplementing something the BCL already provides
(string/URL/collection ops, date math).
**Exceptions:** the SDK's deliberate AOT-safe hand-written paths — the
`JsonElement`↔`google.protobuf.Value` bridge and the discriminator converters — are
intentional (Google.Protobuf's reflection JSON formatter is not AOT-safe). These are
not violations.

```csharp
// BAD: reinventing the BCL
static bool IsBlank(string? s) => s == null || s.Trim().Length == 0;
// GOOD
static bool IsBlank(string? s) => string.IsNullOrWhiteSpace(s);
```

---

## Phase D — Wire compatibility

### NET-WIRE-01 · Protocol types match the TS reference `[❌]`
**Look for:** a field rename, added required field, casing change, or discriminator
change that diverges from the type's `// Keep in sync with sdks/typescript/…`
marker. Cite: `src/AGUI.Abstractions/Events/RunStartedEvent.cs`.
**Exceptions:** none — confirm the field against the referenced TS source.

### NET-WIRE-02 · Events are additive `[⚠️]`
**Look for:** removing or repurposing an existing event/field. New event types are
fine — unknown types round-trip via `RawEvent`.
**Exceptions:** a coordinated cross-SDK breaking change with explicit sign-off.

### NET-WIRE-03 · Protobuf parity preserved for the supported event set `[❌]`
**Look for:** a codec change to `AGUI.Protobuf` without a corresponding parity
fixture; encoding outside the supported 16 events should throw
`NotSupportedException`, not silently misencode.
**Exceptions:** none — see the protobuf parity suite in `tests/CrossLanguage.Vitest`.

---

## Phase E — PublicAPI analyzer

### NET-API-01 · `PublicAPI.Unshipped.txt` updated for every public-surface change `[❌]`
**Look for:** an added/changed/removed public member with no matching edit to that
project's `PublicAPI.Unshipped.txt` — the build fails RS0016. Cite:
`sdks/dotnet/Directory.Build.targets`, `src/AGUI.Abstractions/PublicAPI.Unshipped.txt`.
**Exceptions:** `internal`/`private` members (unless `InternalsVisibleTo` exposes them).

### NET-API-02 · A new event type completes the full checklist `[⚠️]`
**Look for, all of:** class in `Events/` deriving `BaseEvent`; `Type` overridden to a
constant in `AGUIEventTypes`; the constant added there; `[JsonSerializable]` added;
a read case in `BaseEventJsonConverter`; `PublicAPI.Unshipped.txt` updated; a
round-trip test. Flag any missing step.
**Exceptions:** none.

---

## Phase F — Style / naming

### NET-STYLE-01 · `sealed` on every non-abstract class `[⚠️]`
**Look for:** a concrete class without `sealed`. Cite:
`src/AGUI.Abstractions/Events/BaseEventJsonConverter.cs`.
**Exceptions:** types intended as a base (abstract or explicitly designed for
inheritance).

### NET-STYLE-02 · No `record` types `[❌]`
**Look for:** `record`/`record struct`. Use `sealed class` with properties.
**Exceptions:** none — this is a house rule for the SDK.

### NET-STYLE-03 · No tuples in public APIs `[⚠️]`
**Look for:** `(T1, T2, …)` return/parameter types on public members. Define a
named type. **Exceptions:** a private, immediately-consumed 2-tuple is fine.

### NET-STYLE-04 · Braces always `[⚠️]`
**Look for:** brace-less `if`/`for`/`foreach`/`while` bodies.
**Exceptions:** none.

### NET-STYLE-05 · Naming conventions `[⚠️]`
**Look for:** events not named `{Name}Event`; discriminators not
`SCREAMING_SNAKE_CASE` constants in `AGUIEventTypes`; outcome/role values as enums
instead of lowercase string constants; options not `AGUI{Purpose}Options`; extension
classes not `{Target}Extensions`; test classes not `{TypeUnderTest}Test`.
**Exceptions:** none.

### NET-STYLE-06 · Namespace rules `[⚠️]`
**Look for:** DI-extension types not in `Microsoft.Extensions.DependencyInjection`;
any other type using a sub-namespace instead of the project `RootNamespace`.
**Exceptions:** none.

### NET-STYLE-07 · No XML docs on `internal`/`private` members `[⚠️]`
**Look for:** `///` doc comments on non-public members.
**Exceptions:** none (public API may and should be documented).

### NET-STYLE-08 · Don't reformat untouched code `[⚠️]`
**Look for:** whitespace/format-only hunks in files you didn't functionally change.
**Exceptions:** a format fix inside a region you also changed functionally is fine.

---

## Phase G — Tests

### NET-TEST-01 · Assert JSON property names via `JsonDocument` `[⚠️]`
**Look for:** serialization tests that assert on the deserialized object instead of
parsing the JSON and checking concrete property names — the latter misses naming bugs.
**Exceptions:** none for wire-shape tests.

```csharp
// BAD: round-trips through the object, misses a wrong [JsonPropertyName]
var back = Deserialize(json); Assert.Equal("r1", back.RunId);

// GOOD: assert the actual wire name
using var doc = JsonDocument.Parse(json);
Assert.Equal("r1", doc.RootElement.GetProperty("runId").GetString());
```

### NET-TEST-02 · No full-JSON-string comparisons `[❌]`
**Look for:** `Assert.Equal(expectedJsonString, actual)`. Parse and assert
individual properties. **Exceptions:** none.

### NET-TEST-03 · No reflection in tests `[❌]`
**Look for:** reflection to enumerate types or verify membership (e.g., asserting all
events are registered by scanning the assembly).
**Exceptions:** none — assert against explicit expectations.

### NET-TEST-04 · Wire change ⇒ compatibility fixture + round-trip `[⚠️]`
**Look for:** a wire-affecting change with no fixture in
`tests/AGUI.Abstractions.UnitTests/Compatibility/` (loaded via `FixtureLoader`,
sourced from the TS impl).
**Exceptions:** none for wire changes.

### NET-TEST-05 · Cover new behavior at the right level `[⚠️/💡]`
**Look for:** new public behavior without a unit test; a server-pipeline change
without an integration test (`tests/AGUI.Hosting.AspNetCore.IntegrationTests/`,
`WebApplicationFactory`).
**Exceptions:** trivial code (see `NET-TEST-07`).

### NET-TEST-06 · Branch and boundary coverage `[⚠️]`
**Look for:** a new/changed class with branching logic whose tests miss the happy
path, the primary error/rejection path, or boundary values (null, empty, zero,
negative, single-element).
**Exceptions:** internal methods fed only pre-validated data (trust the boundary);
parameters whose type makes invalid values unrepresentable (`required`,
non-nullable, enum).

```csharp
[Theory]
[InlineData(10, false, "standard", 10)]
[InlineData(10, true,  "express",  60)]
public void CalculateShipping_ReturnsExpected(decimal w, bool intl, string tier, decimal expected)
    => Assert.Equal(expected, _calc.CalculateShipping(w, intl, tier));
```

### NET-TEST-07 · Don't test trivial code `[💡]`
**Look for:** tests for DTOs/records with no logic, one-line delegations, or
constant returns.
**Exceptions:** a "trivial" member with a subtle side effect (e.g., a setter that
raises an event) — keep the test.

### NET-TEST-08 · Test via DI + `InternalsVisibleTo`, not public-for-test `[⚠️]`
**Look for:** a member widened to `public` solely so a test can reach it. Use
`[InternalsVisibleTo("…UnitTests")]` and constructor injection instead.
**Exceptions:** none.

### NET-TEST-09 · Assert a specific observable value `[❌]`
**Look for:** assertion-free tests (pass because nothing threw), or bare
`Assert.NotNull`/`Assert.True(x > 0)`/`Assert.NotEmpty` standing in for the real value.
**Exceptions:** a test explicitly proving "no exception for tricky input X" may use
`Assert.True(true, "…")` with an explanatory message.

```csharp
// BAD
Assert.NotNull(result); Assert.True(result.Items.Count > 0);
// GOOD
Assert.Equal(3, result.Items.Count);
Assert.Equal("Widget", result.Items[0].Name);
```

### NET-TEST-10 · Deterministic and isolated `[❌]`
**Look for:** `Thread.Sleep`/`Task.Delay` used as synchronization; tests that read
state set by another test; side effects (files, ports, env vars) left uncleaned.
**Exceptions:** cleanup centralized in a shared `IClassFixture`/`IAsyncLifetime` is fine.

```csharp
// BAD: hope it finished
service.Start(); await Task.Delay(2000); Assert.True(service.IsComplete);
// GOOD: signal completion
var done = new TaskCompletionSource();
var service = new Worker(onComplete: () => done.SetResult());
service.Start(); await done.Task; Assert.True(service.IsComplete);
```

### NET-TEST-11 · Test behavior, not implementation `[⚠️]`
**Look for:** `mock.Verify(…, Times.*)` or assertions on internal call order; a
`[Theory]` whose rows exercise different code paths (should be `[Fact]`s) or 3+
identical `[Fact]`s that should be one `[Theory]`; setup hidden in flow helpers
above the tests; shared mutable fixtures instead of factory methods; `// TODO` or
empty test bodies.
**Exceptions:** when the spec makes the call count the observable behavior (e.g.
"batches into exactly 2 requests"), `Times.Exactly(2)` is correct; stubbing a single
method with one `mock.Setup` is fine over a full fake.

```csharp
// BAD: couples to the mock
mockSender.Verify(x => x.Send(It.IsAny<string>(), …), Times.Once);
// GOOD: assert the observable outcome via a fake
Assert.Single(fakeSender.Sent);
Assert.Equal("order@example.com", fakeSender.Sent[0].To);
```
