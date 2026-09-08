---
name: agui-dotnet-sample-step
description: >
  Add a GettingStarted sample Step (a Server/Client pair) to the AG-UI .NET SDK that
  demonstrates one protocol feature the way we want users to write it. USE FOR: adding a
  new samples/GettingStarted/StepNN_<Name> Server+Client pair, wiring it into AGUI.slnx and
  the integration-test project, giving it a deterministic FakeChatClient for replay, and
  registering it in the Step tables in AGENTS.md / docs/architecture.md. DO NOT USE FOR: the
  replay/Verify integration-test mechanics (use agui-dotnet-integration-tests), the dojo
  scenarios under samples/AGUIClientServer (use agui-dojo), or protocol/wire changes the
  sample exercises (use agui-dotnet-wire-types / agui-dotnet-transport).
---

# AG-UI .NET — Add a GettingStarted Sample Step

The `samples/GettingStarted/Step01..StepNN` pairs are the primary consumer-facing
deliverable: each Step is a self-contained Server + Client that demonstrates **one**
feature, written to look like the code we want users to write. Adding a Step is a
recurring, multi-artifact task. This skill covers the sample anatomy and wiring; it
**routes the integration-test mechanics to `agui-dotnet-integration-tests`** and the doc
sync to `agui-dotnet-agents-sync`.

Run all commands from `sdks/dotnet/`. Confirm the next free number and the current naming
by listing `samples/GettingStarted/Step*` first — never assume the range.

## Anatomy of a Step

A Step is a folder `samples/GettingStarted/StepNN_<Name>/` with two projects:

- **`StepNN_<Name>.Server`** — an ASP.NET host (`Microsoft.NET.Sdk.Web`, `net10.0`).
  `Program.cs` calls `builder.Services.AddAGUI()`, registers an `IChatClient`, and ends
  with `app.MapAGUI("/")`. The `IChatClient` is the whole point: the SDK turns any
  `IChatClient` into an AG-UI endpoint, so the sample logic is just MEAI.
  - References `src/AGUI.Abstractions` + `samples/AGUI.Samples.Shared` (the ASP.NET glue).
    It does **not** reference an `src/` server package directly.
  - `InternalsVisibleTo` the integration-test project so its replay test can reach the
    server's `Program` and any `FakeChatClient`.
  - Provide a **deterministic `FakeChatClient`** fallback (fixed clocks, canned tool
    results) used when no real LLM is configured. Replayable determinism is what lets the
    integration test record once and replay forever.
- **`StepNN_<Name>.Client`** — a console app (`Microsoft.NET.Sdk`, `OutputType Exe`,
  `net10.0`). `Program.cs` builds the client and hands it to a shared `SampleClient`:

  ```csharp
  using HttpClient httpClient = new() { BaseAddress = new Uri(baseUrl) };
  var aguiClient = new AGUIChatClient(new(httpClient, baseUrl));
  await SampleClient.RunAsync(aguiClient, Console.Out);
  ```

  - References only `src/AGUI.Client`. (`AGUIChatClient` is constructed from
    `AGUIChatClientOptions` — see `agui-dotnet-transport` for the protobuf opt-in via
    `AGUIEventStreamHandler`.)

Mirror the closest existing Step rather than inventing structure: the feature determines
which one (tools → Step02/03, interrupts → Step09/10, state → Step05, parallel calls →
Step12). Keep the file-name/type-name/namespace consistent (`StepNN_<Name>.Server` etc.).

## Wiring (the parts agents forget)

1. **Solution.** Add both `.csproj` paths to `AGUI.slnx` under the
   `/samples/GettingStarted/` folder, in Step order.
2. **Integration-test references.** Add a `ProjectReference` to both the Server and Client
   projects in `tests/AGUI.Hosting.AspNetCore.IntegrationTests/*.csproj` (it references
   every Step pair so its replay tests can host them).
3. **Replay test.** Add `Samples/GettingStarted/StepNN_<Name>Test.cs` deriving from
   `IntegrationTestBase<StepNN_<Name>.Server.Program>`, then record its baseline. The
   recording/Verify/8-capture-point mechanics belong to
   **`agui-dotnet-integration-tests`** — use that skill; don't reinvent them here. Fixtures
   land under `Samples/GettingStarted/fixtures/StepNN_<Name>/` and baselines under
   `baselines/StepNN_<Name>/`.
4. **Doc tables.** Add the Step to the Step tables in `sdks/dotnet/AGENTS.md` and
   `sdks/dotnet/docs/architecture.md` (and the PR review guide's Step table if present) via
   **`agui-dotnet-agents-sync`**.

GettingStarted Steps are standalone console samples, **not** dojo scenarios. The dojo is a
separate host (`samples/AGUIClientServer/AGUIDojoServer`) — only touch it via `agui-dojo`
if the feature also needs a dojo demo.

## Verify

```bash
dotnet build samples/GettingStarted/StepNN_<Name>/StepNN_<Name>.Server/StepNN_<Name>.Server.csproj
dotnet build samples/GettingStarted/StepNN_<Name>/StepNN_<Name>.Client/StepNN_<Name>.Client.csproj
dotnet test tests/AGUI.Hosting.AspNetCore.IntegrationTests/ --filter StepNN_<Name>
```

Run the pair end to end (server in one shell, client in another) to confirm it reads like
the code a user would write — the bar for a sample is exemplary, not merely passing.

## ❌ Anti-patterns

1. **Non-deterministic sample behavior.** A wall-clock, RNG, or live network call in the
   `FakeChatClient` path breaks record/replay. Use fixed values.
2. **Protocol or hosting code in the sample.** A Step composes existing SDK APIs; if it
   needs a new event/encoding, that lands in `src/` first (`agui-dotnet-wire-types` /
   `agui-dotnet-transport`), and the sample only consumes it.
3. **Half-wired Step.** Forgetting `AGUI.slnx`, the integration-test `ProjectReference`, or
   the doc Step tables leaves a sample that builds locally but isn't covered, shipped in the
   solution, or documented.
4. **Diverging from the sibling Steps.** Copy the closest Step's shape (naming, csproj refs,
   `Program.cs` skeleton, `InternalsVisibleTo`) instead of a new layout.

## References

- Replay/Verify test mechanics: **`agui-dotnet-integration-tests`**.
- Step tables / structure sync: **`agui-dotnet-agents-sync`**.
- Protobuf opt-in or a new encoding the Step demos: **`agui-dotnet-transport`**.
- End-to-end workflow context: **`agui-dotnet-feature-workflow`**.
