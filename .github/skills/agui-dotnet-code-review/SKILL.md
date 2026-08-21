---
name: agui-dotnet-code-review
description: >
  Review C#/.NET code changes to the AG-UI .NET SDK (sdks/dotnet/) against its
  specific conventions and architectural rules — AOT serialization, the
  "no ASP.NET in src/" boundary, the PublicAPI analyzer workflow, wire
  compatibility with the TypeScript reference, and the house style
  (sealed/no-records/ConfigureAwait). Runs a phased, rule-by-rule review.
  USE FOR: reviewing a PR, diff, or branch that touches sdks/dotnet/; checking a
  new event/message type; verifying serialization, package placement, or
  public-API changes in the .NET SDK. DO NOT USE FOR: generic C# style nits
  already enforced by analyzers/EditorConfig; reviewing the TypeScript SDK
  (sdks/typescript/) or Python SDK (sdks/python/); writing new features (only
  flag violations, never rewrite code).
---

# AG-UI .NET SDK Code Review

Encodes the AG-UI .NET SDK's house rules so a reviewer flags real violations a
generic C# reviewer misses. Authoritative sources: `sdks/dotnet/AGENTS.md`
(house rules) and `sdks/dotnet/docs/architecture.md` (design boundaries). Each
rule cites a real enforcement example in the repo; full BAD→GOOD examples and
per-rule exceptions live in [`references/rules.md`](references/rules.md). The
change-footprint and test rules below distil the `minimize-change-footprint`,
`ensure-test-coverage`, and `ensure-test-quality` review conventions for this SDK.

## Reviewer discipline

- **High signal-to-noise.** Only flag a genuine violation of a rule below, tied
  to its cited convention. Don't invent nits or restate analyzer output.
- **Verify before flagging.** Read the actual changed code and confirm the rule
  applies. Automated reviewers have high false-positive rates.
- **Scope.** Review only files under `sdks/dotnet/`. Skip generic style already
  enforced by `TreatWarningsAsErrors`, nullable, and EditorConfig.
- **Blast radius.** Fix nothing — this skill only reports. Local convention
  violations get a finding; codebase-wide concerns are noted as out-of-scope
  follow-ups, not per-line nits.
- **Severity:** ❌ must fix (breaks AOT/wire/build/boundary); ⚠️ should fix
  (convention drift); 💡 optional polish.

## The review process

**Step 0 — Ground truth & file classification.** Derive the package map from
`AGUI.slnx`; skim `AGENTS.md` + `docs/architecture.md`. Classify each changed
file: `production | test | sample | proto | csproj | public-api | docs`. Rules
are gated by class.

**Step 1 — Determine and summarize the change set.** Resolve what is under
review, in order: an explicit target (PR number / branch / commit range); else
the current branch vs. its tracking/base branch (`git merge-base <base> HEAD`);
plus **staged, unstaged, and untracked** working-tree changes. Then write a short
summary of what the diff does — new types, wire/protocol changes, public-surface
changes, new dependencies, src-vs-sample placement. This frames every phase and
catches scope creep early.

**Step 2 — Walk the rules, phase by phase (A→G).** For each phase, check every
applicable changed file against every rule in that phase. Write each finding
immediately: `file:line`, rule ID, severity, one-line fix. Verify the code first.

**Step 3 — Self-validation.** Dedupe; confirm each finding cites a real rule and
a real line; confirm no rule was applied to the wrong file class; drop anything
not verifiable in the actual diff.

**Step 4 — Emit the review summary** (see below) — a single human-readable comment,
findings grouped by severity with a verdict and coverage line.

## Phase A — Scope / scenarios

- `NET-SCOPE-01` Every change traces to a spec requirement or issue `[⚠️]`
- `NET-SCOPE-02` No unrequested capability, configurability, or dependency `[⚠️]`
- `NET-SCOPE-03` A wire/protocol change carries compatibility coverage `[❌]`
- `NET-SCOPE-04` Sample-only behavior stays out of `src/` `[⚠️]`
- `NET-SCOPE-05` Minimal footprint — every diff line serves the task; no unrelated
  refactor, speculative abstraction, or cosmetic churn `[⚠️]`

## Phase B — Design / architecture

From `docs/architecture.md` "Architectural constraints".

- `NET-ARCH-01` No `src/` project references `Microsoft.AspNetCore.App` `[❌]` —
  `git grep "Microsoft.AspNetCore" -- sdks/dotnet/src` must be empty.
- `NET-ARCH-02` Correct package placement (wire→Abstractions, SSE→Formatting,
  proto→Protobuf, client/transport→Client, hosting→Server) `[❌]`
- `NET-ARCH-03` Dependency direction — `Client` and `Server` never reference each
  other `[❌]`. Cite: `src/AGUI.Server/AGUI.Server.csproj`.
- `NET-ARCH-04` `IChatClient` is the only integration point — no bespoke agent
  abstraction `[💡]`
- `NET-ARCH-05` Every type has a single reason to change `[⚠️]`
- `NET-ARCH-06` No interface without multiple implementations or a test-double need `[⚠️]`
- `NET-ARCH-07` Make invalid states unrepresentable (enums/types over bool/string) `[⚠️]`
- `NET-ARCH-08` One class per file; file name matches the type `[⚠️]`

## Phase C — Implementation / correctness

From `AGENTS.md` "JSON serialization" / "Code style".

- `NET-IMPL-01` Every serializable type registered in `AGUIJsonSerializerContext`
  via `[JsonSerializable(typeof(T))]` `[❌]`. Cite:
  `src/AGUI.Abstractions/Serialization/AGUIJsonSerializerContext.cs`.
- `NET-IMPL-02` No `JsonSerializer.Serialize<object>` and no reflection-based
  serialization — go through the source-gen context `[❌]`
- `NET-IMPL-03` Polymorphic JSON uses a hand-written discriminator `JsonConverter<T>` `[❌]`.
  Cite: `src/AGUI.Abstractions/Events/BaseEventJsonConverter.cs`.
- `NET-IMPL-04` Property attribute kit present: explicit `[JsonPropertyName]`, **no**
  `[JsonIgnore(WhenWritingNull)]` on optionals (the context-wide default does that),
  required strings = `string.Empty`, collections = `[]` `[⚠️]`.
  Cite: `src/AGUI.Abstractions/Events/RunStartedEvent.cs`.
- `NET-IMPL-05` `ConfigureAwait(false)` on every `await` in `src/` `[⚠️]`. Cite:
  `src/AGUI.Client/AGUIChatClient.cs`.
- `NET-IMPL-06` `[EnumeratorCancellation]` on the token of any `IAsyncEnumerable<T>`
  method `[⚠️]`. Cite: `src/AGUI.Formatting/SseEventStreamFormatter.cs`.
- `NET-IMPL-07` `ArgumentNullException.ThrowIfNull(...)` for public-API argument
  validation `[⚠️]`
- `NET-IMPL-08` Validate external input at the boundary, not deep in the stack `[⚠️]`
- `NET-IMPL-09` Guard every code path — no silent `default`/fallthrough `[⚠️]`
- `NET-IMPL-10` No swallowed exceptions (empty or log-only `catch`) `[⚠️]`
- `NET-IMPL-11` Never log or expose sensitive data in errors `[❌]`
- `NET-IMPL-12` No dead, commented-out, or impossible-condition defensive code `[⚠️]`
- `NET-IMPL-13` No logic duplicated across the changeset — extract a shared helper
  at 3+ uses (Rule of Three; don't extract for 1–2) `[⚠️]`
- `NET-IMPL-14` Prefer BCL/platform APIs over hand-rolled equivalents `[⚠️]` —
  exception: deliberate AOT-safe hand-written paths (the `JsonElement`↔`Value`
  bridge, the discriminator converters) are intentional, not violations.

## Phase D — Wire compatibility

- `NET-WIRE-01` Protocol types match the TS reference — honor the
  `// Keep in sync with sdks/typescript/...` markers `[❌]`. Cite:
  `src/AGUI.Abstractions/Events/RunStartedEvent.cs`.
- `NET-WIRE-02` Events are additive — unknown types round-trip via `RawEvent`;
  don't remove or repurpose existing fields `[⚠️]`
- `NET-WIRE-03` Protobuf parity preserved for the supported event set `[❌]`

## Phase E — PublicAPI analyzer

- `NET-API-01` Any public-surface change updates that project's
  `PublicAPI.Unshipped.txt` (build fails RS0016 otherwise) `[❌]`. Cite:
  `sdks/dotnet/Directory.Build.targets`, `src/AGUI.Abstractions/PublicAPI.Unshipped.txt`.
- `NET-API-02` A new event type completes the full checklist (class in `Events/`
  deriving `BaseEvent`; `Type` → `AGUIEventTypes` constant; `[JsonSerializable]`;
  read case in `BaseEventJsonConverter`; `PublicAPI.Unshipped.txt`; round-trip
  test) `[⚠️]`

## Phase F — Style / naming

From `AGENTS.md` "Code style" / "Naming" (not all analyzer-enforced).

- `NET-STYLE-01` `sealed` on every non-abstract class `[⚠️]`
- `NET-STYLE-02` No `record` types — use `sealed class` with properties `[❌]`
- `NET-STYLE-03` No tuples in public APIs — define a named type `[⚠️]`
- `NET-STYLE-04` Braces always on `if`/`for`/`foreach`/`while` `[⚠️]`
- `NET-STYLE-05` Naming: events `{Name}Event`; discriminators `SCREAMING_SNAKE_CASE`
  constants in `AGUIEventTypes`; outcome/role constants lowercase (never enums);
  options `AGUI{Purpose}Options`; extensions `{Target}Extensions`; tests
  `{TypeUnderTest}Test` `[⚠️]`
- `NET-STYLE-06` DI-extension types use the `Microsoft.Extensions.DependencyInjection`
  namespace; all other types use the project `RootNamespace` with no sub-namespaces `[⚠️]`
- `NET-STYLE-07` No XML docs (`///`) on `internal`/`private` members `[⚠️]`
- `NET-STYLE-08` Don't reformat code you didn't otherwise change `[⚠️]`

## Phase G — Tests

From `AGENTS.md` "Running tests"; coverage/quality rules distilled from
`ensure-test-coverage` and `ensure-test-quality`.

SDK-specific:
- `NET-TEST-01` Serialization tests assert concrete JSON property names via
  `JsonDocument` — not via the deserialized object `[⚠️]`
- `NET-TEST-02` No full-JSON-string comparisons — assert individual properties `[❌]`
- `NET-TEST-03` No reflection to enumerate types or verify membership `[❌]`
- `NET-TEST-04` Wire-affecting change ⇒ compatibility fixture + round-trip in
  `tests/AGUI.Abstractions.UnitTests/Compatibility/` `[⚠️]`
- `NET-TEST-05` New public behavior ⇒ unit test; server-pipeline change ⇒
  integration test (`tests/AGUI.Hosting.AspNetCore.IntegrationTests/`) `[⚠️/💡]`

Coverage:
- `NET-TEST-06` A new/changed class with branching logic has a test covering happy
  path, primary error path, and boundary values (null/empty/zero/single) `[⚠️]`
- `NET-TEST-07` Don't test trivial code — DTOs/records with no logic, one-line
  delegations, constant returns `[💡]`
- `NET-TEST-08` Test through DI + `InternalsVisibleTo`, not members made `public`
  for tests `[⚠️]`

Quality:
- `NET-TEST-09` Every test asserts a specific observable value — no assertion-free
  tests, no bare `Assert.NotNull`/`True`/`NotEmpty` standing in for the real value `[❌]`
- `NET-TEST-10` Deterministic and isolated — no `Thread.Sleep`/`Task.Delay` for
  synchronization, no execution-order dependence, side effects cleaned up
  (files/ports/env) `[❌]`
- `NET-TEST-11` Test behavior, not implementation — prefer hand-written fakes over
  `mock.Verify(Times.*)` (unless the call count is the spec'd behavior); `[Theory]`
  for data variation, `[Fact]` for behavior; AAA visible inline with factory
  helpers (not shared mutable fixtures) below the tests; no `// TODO` or empty
  test bodies `[⚠️]`

## Self-validation

- [ ] The change set was resolved (target / tracking branch / working tree) and summarized
- [ ] Every applicable changed file was walked against every phase's rules
- [ ] Each finding cites a real rule ID, file, and line, and was verified in the diff
- [ ] No rule applied to the wrong file class; no duplicates
- [ ] Clean diffs are reported as clean — no padding

## Common pitfalls

| Pitfall | Solution |
|---------|----------|
| Restating analyzer/EditorConfig output | Only flag rules above that tooling does not enforce |
| Flagging a "missing" registration without checking the context | Open `AGUIJsonSerializerContext.cs` and confirm |
| Treating a sample's ASP.NET usage as a `src/` violation | `NET-ARCH-01` applies to `src/` only |
| Calling an additive new event a wire break | `NET-WIRE-02` — additive is allowed |
| Nitpicking style in files with substantive changes | Focus on the substantive change |

## Review summary

Produce a single human-readable Markdown comment — a reviewer's summary the author
can read top to bottom. Lead with the verdict, then the findings grouped by
severity (most severe first), each one self-contained.

```markdown
## AG-UI .NET SDK code review

**Verdict:** <Request changes | Comment | Looks good> — <one-sentence reason>
**Change set:** <branch vs base, e.g. `feat/x` vs `main`> · <N files reviewed>
(+<U untracked>) · **Findings:** ❌ <a> · ⚠️ <b> · 💡 <c>

<One short paragraph: what the change does and the overall read.>

### ❌ Must fix
- **`src/AGUI.Abstractions/Events/FooEvent.cs:42`** · `NET-IMPL-01` — new event type
  isn't registered in `AGUIJsonSerializerContext`; it fails under AOT.
  **Fix:** add `[JsonSerializable(typeof(FooEvent))]`.

### ⚠️ Should fix
- **`src/AGUI.Client/AGUIChatClient.cs:88`** · `NET-IMPL-05` — bare `await` in
  library code. **Fix:** append `.ConfigureAwait(false)`.

### 💡 Optional
- **`src/AGUI.Server/StreamAdapter.cs:17`** · `NET-ARCH-04` — bespoke agent
  abstraction; the SDK integrates via `IChatClient`. **Fix:** drop the wrapper.

### Coverage
Phases checked: A–G. No findings in: **B Design**, **D Wire**, **E PublicAPI**.
```

Rules for the summary:
- **Order** findings by severity (❌ → ⚠️ → 💡), then by file. One bullet per finding:
  bold `file:line`, the `RULE-ID`, a plain-language description, and an italic
  **Fix:** with a one-line remedy. The reader can look the ID up in
  [`references/rules.md`](references/rules.md).
- **Omit empty severity sections.** Always include the **Coverage** line so the
  author sees which phases were clean versus untouched.
- **Clean diff:** skip the severity sections and write a single line —
  `✅ No violations of the AG-UI .NET house rules — checked phases A–G across N files.`
- **Verdict mapping:** any ❌ → *Request changes*; only ⚠️/💡 → *Comment*; none →
  *Looks good*. The skill never approves or blocks automatically — the verdict is
  advisory and the author decides.

