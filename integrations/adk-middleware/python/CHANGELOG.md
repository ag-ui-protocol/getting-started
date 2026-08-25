# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.0] - 2026-06-22

### Added

- **FEATURE**: A2UI (Agent-to-UI) generative-UI rendering for ADK agents (OSS-158, #1955)
  - Adds a `render_a2ui` sub-agent tool (`A2UISubAgentTool`, `get_a2ui_tool()`) that lets an ADK agent emit A2UI v0.9 server-to-client operations (`createSurface` / `updateComponents` / `updateDataModel`), which the runtime detects and renders against a client-registered catalog. `plan_a2ui_injection()` decides when to auto-inject the `generate_a2ui` tool, giving ADK the same auto-injection behavior the AWS Strands middleware already has (Strands parity).
  - Generation is wrapped in the `ag-ui-a2ui-toolkit` **recovery loop**: the model's free-form output is validated structurally and retried on structural errors up to a capped number of attempts; when recovery is exhausted the middleware surfaces a graceful A2UI **hard-failure envelope** rather than emitting a malformed tree.
  - Reuses the A2A-free subset of Google's `a2ui-agent-sdk` for prompt construction and healing: `render_catalog_instructions()` wraps `render_as_llm_instructions` (renders the v0.9 envelope, common-types definitions, and catalog components into a prompt block), and `heal_json_arg()` wraps `parse_and_fix` (repairs smart quotes, trailing commas, and single-object wraps in the model's JSON). Validation deliberately stays on the toolkit's structural/lenient validator (not Google's strict `A2uiValidator`), because client-injected zod catalogs are not strict-resolvable.
  - Import hygiene is enforced by `test_a2ui_import_hygiene.py`, which blocks `a2ui.a2a`, `a2ui.adk`, and `a2a` imports so the middleware stays A2A-free.
  - **New dependencies**: `ag-ui-a2ui-toolkit>=0.0.3` and `a2ui-agent-sdk>=0.2.4,<0.3.0`. `a2ui-agent-sdk` floors `google-adk` at `>=1.28.1`, so the effective ADK floor is raised to `1.28.1` (the full `google-adk<3.0.0` range is retained — ADK 1.x and 2.x both supported).

### Changed

- **PERFORMANCE**: Cache session reads per execution to cut redundant `get_session` round-trips (#1880, #1890, thanks @he-yufeng)
  - `SessionManager` now memoizes session reads in a short-lived, execution-local cache so repeated state accessors within one turn reuse a single fetch instead of re-pulling the full session (and event history) from the backing `SessionService` on every call — a notable latency win on remote backends like `VertexAiSessionService`. The cache is invalidated on writes and deliberately disabled before the runner and before the post-run HITL cleanup guard, where ADK can mutate session state outside `SessionManager`.
- **CHORE**: Update the default model for the live tests to `gemini-3.5-flash`
  - `gemini-2.0-flash` reached its shutdown date (2026-06-01) and `gemini-2.5-flash` is scheduled to shut down (2026-10-16), so the live/integration tests and documentation snippets now target the current stable flash GA, `gemini-3.5-flash`. The large file count is purely this model-string sweep — there are no library or runtime behavior changes.
  - The test model is centralized in `tests/constants.py` as `LIVE_TEST_MODEL` (env-overridable via `ADK_TEST_MODEL`) so future cutovers are a one-line change instead of a sweep across every test file. A companion `LIVE_TEST_PRO_MODEL` (env-overridable via `ADK_TEST_PRO_MODEL`) holds the high-reasoning model at `gemini-2.5-pro` for now.
  - The HITL resumption live test was hardened for determinism alongside the model bump: the agent instruction now mandates a single `plan_steps` tool call, `temperature` is `0.0`, and per-run `thread_id`s use a UUID instead of a second-resolution timestamp to avoid collisions under concurrent test load.

### Fixed

- **FIX**: `output_schema` text suppression now reaches agents used as Workflow
  graph nodes (#1889, fixes #1860, thanks @he-yufeng). The #1390 suppression
  walks the agent tree to find `LlmAgent`s with an `output_schema` and tells
  `EventTranslator` to drop their `TEXT_MESSAGE_*` events, so the structured
  JSON they emit never leaks into the chat transcript. The collector only
  traversed `.sub_agents`, but an ADK 2.x `Workflow`'s child agents live in
  `workflow.graph.nodes`, not `.sub_agents` — so an `output_schema` agent used
  as a graph node (the canonical Workflow pattern) was never added to the
  suppression set, and its structured output, including the streamed
  `partial=True` chunks, leaked as visible text.
  `ADKAgent._collect_output_schema_agent_names` now also descends into
  `agent.graph.nodes` when present, leaving the existing `.sub_agents`
  traversal unchanged.
- **FIX**: Resume is gated until all of a turn's long-running results arrive
  (#1935). When one model turn emits **multiple long-running tool calls** and
  their results arrive in **separate submissions** (an instant frontend tool
  resolves before a HITL one), ag-ui-adk resumed the model on the *first*
  result. That replays a turn whose function-**call** parts outnumber its
  function-**response** parts, which Gemini rejects server-side (`400
  INVALID_ARGUMENT — number of function response parts [must] equal the number
  of function call parts`). Where the provider tolerated the rearranged history
  instead, ADK dropped the unanswered call and the model re-issued it under a
  fresh id — a **duplicate HITL widget** on the client plus an orphaned
  `pending_tool_calls` entry. The middleware now resumes **once**, after all of
  the turn's long-running calls have results: earlier results are persisted to
  the session (and merged in by ADK) but don't advance the model on their own.
  The gate is scoped to the arriving turn's `invocation_id`, so a leaked or
  orphaned pending entry from another turn can't stall the thread; persistence
  happens before any pending/processed bookkeeping is mutated, so a failed
  persist leaves the turn cleanly re-submittable.
  - **New client-visible `RUN_ERROR` codes.** `PENDING_TOOL_CALLS` — a trailing
    user/system message arrived while another long-running call from the same
    turn was still unanswered; the middleware rejects it and mutates nothing
    (resolve or cancel the open call, then resubmit) rather than forwarding an
    under-answered turn (an opaque provider 400) and silently dropping the
    message. `TOOL_RESULT_BUFFER_ERROR` — persisting a buffered result failed;
    no state was changed, so the client can simply resubmit.
  - **Scope/non-goals**: same-name parallel long-running calls resolved
    *separately* remain unsupported (ADK's `_merge_function_response_events`
    can't pair them); distinct-named staggered calls and same-name calls
    resolved together in one submission both work. See #1334 / PR #1355.
- **FIX**: `ADKAgent.run()` no longer emits `RUN_FINISHED` after `RUN_ERROR`
  (#1892). When a tool raised mid-stream, the background queue path emitted
  `RUN_ERROR` and the consumer loop then fell through to its unconditional
  `RUN_FINISHED`, producing two terminal events for a single run.
  `@ag-ui/client`'s state machine correctly rejects the second event with
  "Cannot send event type 'RUN_FINISHED': The run has already errored". The
  consumer loop now tracks whether a `RUN_ERROR` already flowed through the
  queue and skips the trailing `RUN_FINISHED`, enforcing the AG-UI invariant of
  at most one terminal event per run at the source rather than pushing it onto
  every downstream SSE wrapper. This covers all queue-borne terminal errors
  (tool throw, execution timeout, background-execution failure), not just the
  tool-throw case. Thanks to @sunholo-voight-kampff for the detailed report.
- **FIX**: HITL confirmation on a standalone `LlmAgent` root now re-executes the
  original tool after the user confirms (#1839). Previously, for resumable
  `LlmAgent` roots the #1534 pre-append workaround substituted `new_message`
  with an empty-text placeholder that became the last user event in the
  session. ADK's `_RequestConfirmationLlmRequestProcessor` reverse-scans for
  the last user event and bails on the first one lacking `function_responses`,
  so it never reached the pre-appended confirmation `FunctionResponse` — the
  LLM was invoked instead and hallucinated an "awaiting confirmation" reply.
  (The same workaround also hard-crashed `SequentialAgent`/`LoopAgent`
  composites of `LlmAgent`s on confirmation with "No agent to transfer to".)
  Confirmation responses (`adk_request_confirmation`) are now routed through
  the direct `new_message` path — the same path ADK 2.0 Workflow roots already
  take — making the `FunctionResponse` the trailing user event the processor
  expects. Because `adk_request_confirmation` is a long-running tool that pauses
  rather than ends the invocation, this does not re-trigger the `end_of_agent`
  early-return that motivated the #1534 workaround for turn-ending
  client/frontend tools. This is the `LlmAgent` cousin of the Workflow-root fix
  in #1669; true ADK 2.0 Workflow roots are unaffected (they already bypass the
  workaround).
- **FIX**: Duplicate HITL tool-call emission under SSE streaming (long-running client tools)
  - With SSE streaming (the default), ADK can deliver the *same logical* long-running client tool call **several times** — a streaming chunk (`partial=True`), an aggregated partial, the persisted final (`partial=False`) — and ADK separately **invokes the `ClientProxyTool`**, with `populate_client_function_call_id` assigning a **different ID to every replay** (#1168). Each replay produced its own `TOOL_CALL_START/ARGS/END` trio because every existing dedupe was keyed by tool-call ID — the dojo rendered the Human-in-the-Loop card **twice** (two cards, two different `adk-…` IDs visible in the event stream).
  - **Translator** (`translate_lro_function_calls`): replays are now suppressed via a **high-water mark per tool name** — the Nth same-name LRO call *within one event* only emits if fewer than N calls for that name have been emitted this run (ledger: `lro_emitted_ids_by_name`). This uniformly covers second-partial replays, aggregated partials, and the final, regardless of `partial` flags. Genuinely parallel same-name calls arrive as multiple parts of *one* event, exceed the mark, and still emit individually; a later same-name event cannot be a real second call because an LRO pauses the invocation.
  - **ClientProxyTool**: consults the translator's same ledger (shared into the proxy toolsets like the emitted-ID set already is) and suppresses its invocation when it is the positional twin of an already-streamed emission.
  - The positional (FIFO) pairing is the same one `_extract_lro_id_remap` uses for ID remapping, so result-routing is unaffected; the non-streaming (final-only) path still emits normally.
  - Reproduced deterministically with scripted `BaseLlm` streams driving the real runner + proxy + translator for all three shapes (`partial→final`, `partial→partial→final`, `partial→partial` — the "last event is partial" shape). End-to-end regression `TestLroNoDuplicateToolCallEndToEnd` is parametrized over all three; translator-level tests cover twin/second-partial/parallel/final-only/reset.
  - Reproduced deterministically at the translator level (partial id-A then final id-B for one logical call → previously two `TOOL_CALL_START`, now one). New regression tests in `tests/test_lro_sse_id_remap.py` cover the partial→final twin, parallel same-name calls (no over-suppression), final-only emission, and reset.
  - Also verified **live against google-adk 1.23.0 + Vertex**, where the partial(id-A)/final(id-B) replay occurs on **every** HITL turn (the unfixed translator emitted both → 100% duplicate cards in the dojo); with this fix the same stack emits exactly one. On google-adk 2.x the replay shape does not occur on this path.
  - `examples/uv.lock` refreshed: it pinned `google-adk==1.23.0` (plus a similarly stale dependency set), so `uv run dev` served the demo on an ADK whose event shapes differ from the 2.x the middleware is developed and tested against — making this bug deterministic for example-server users yet invisible in development. The lock now resolves `google-adk 2.2.0` / `google-genai 2.8.0` (the old `aiohttp` pin also broke google-genai 2.8's SSE reader and was refreshed along with the rest).
- **FIX**: Strip `additionalProperties` from client tool schemas before building Gemini function declarations
  - CopilotKit / AG-UI frontend tools serialize their parameters with `zodToJsonSchema(..., {$refStrategy: "none"})`, which stamps `additionalProperties: false` on every object (root and nested). `_clean_schema_for_genai` allowlisted it because it is a field on `google.genai.types.Schema`, so it was forwarded verbatim. The Gemini **Developer API** rejects it in `function_declarations` with `400 INVALID_ARGUMENT` ("Unknown name \"additional_properties\" ... Cannot find field"), which surfaced as a `RUN_ERROR` and **no tool call reaching the UI** — e.g. the Human-in-the-Loop dojo demo rendered nothing for the ADK backend, while OpenAI-based backends (which tolerate the field) worked.
  - `_clean_schema_for_genai` now strips `additionalProperties` / `additional_properties` at every depth via an explicit `_GENAI_REJECTED_SCHEMA_KEYS` denylist, closing both the dynamic `types.Schema.model_fields` allowlist and the static fallback. Gemini ignores `additionalProperties` for argument generation so no model behavior changes; **Vertex** already accepted the field, making this a no-op there and a fix on the Developer API.
  - The middleware never read the value anywhere — it was only ever forwarded. The three #1495 tests that asserted pass-through (they validated `model_validate()` only, never a live request) were updated, and a regression test reproduces the exact dojo HITL tool schema and asserts `additional_properties` appears at no depth.

- **FIX**: `adk_events_to_messages` now preserves `file_data` parts on user
  events (#1771). Previously only the text part was extracted, so image,
  audio, video, and document attachments were silently dropped from
  `MESSAGES_SNAPSHOT` and disappeared from chat history after a page
  refresh. MIME prefix dispatches to `ImageInputContent`, `AudioInputContent`,
  `VideoInputContent`, or `DocumentInputContent`; `file_data` parts with no
  `file_uri` are filtered out and text-only events still serialize as a
  plain string. Thanks to @viktor-matic for the fix.

## [0.6.5] - 2026-05-28

### Fixed

- **FIX**: Revert the `AGUIToolset.bind()` delegation introduced in 0.6.4 (#1746)
  and restore per-run `ClientProxyToolset` replacement (#1786). Thanks to
  @jplikesbikes for catching the regression and driving the fix.
  - **Impact**: 0.6.4 introduced a cross-user data leak under concurrent runs.
    With `max_concurrent_executions=10` (default) and serialization only per
    `(thread_id, user_id)`, two overlapping runs would share a single mutable
    `_delegate` slot on the construction-time `AGUIToolset` placeholder.
    Run A's `TOOL_CALL_START/ARGS/END` events could be emitted onto Run B's
    `event_queue` (a confidentiality breach: tool-call arguments generated
    from one user's conversation/state would land on another user's stream
    and Run A would stall, never having been told about the call). A
    secondary failure mode stranded any still-in-flight run with an empty
    tool list when the first run's `finally` block unbound the shared
    placeholder. Tool *results* (client → agent) were not affected — they
    return via a separate `RunAgentInput` matched per `(thread_id, user)`.
  - **Root cause of the 0.6.4 regression**: The #1746 rationale — that
    ADK 2.0 `Runner.__init__` eagerly caches `get_tools()` results and
    therefore the `AGUIToolset` object must be preserved by reference —
    does not match the GA behavior. Verified against `google-adk` 1.16.0,
    1.34.1, 2.0.0, and 2.1.0: `Runner.__init__` does *no* tool resolution;
    `agent.canonical_tools` reads `self.tools` live per invocation
    (`flows/llm_flows/base_llm_flow.py` caches on the per-`run_async`
    `InvocationContext`, and the toolset-level cache in
    `tools/base_toolset.py` is keyed by `invocation_id`). The actual #1389
    failure mode on the pre-release `google-adk==2.0.0a2` was a separate
    well-formed-`BaseToolset` issue: a toolset missing
    `_use_invocation_cache` (i.e. not calling `BaseToolset.__init__`) is
    silently dropped to `[]` by `llm_agent._convert_tool_union_to_tools`.
    That fix — `super().__init__()` on `AGUIToolset` — is retained; only
    the unnecessary `bind()` delegation that introduced the concurrency
    hazard is reverted.
  - **Fix**: `_update_agent_tools_recursive` once again replaces the
    placeholder per-run with a fresh `ClientProxyToolset` inside the
    per-run shallow-copied agent's own `tools` list. The construction-time
    placeholder is never mutated; each run carries its own `input.tools`
    and `event_queue`.
  - **Tests added** (pass on both `google-adk==1.26.0` and
    `google-adk==2.1.0`):
    - `tests/test_agui_toolset_concurrency.py` — three tests asserting
      per-run isolation, including a real concurrent-`asyncio`
      reproduction with a barrier.
    - `tests/test_adk_2_0_compat.py::TestAGUIToolsetReplacement::test_swapped_in_toolset_resolves_nonempty_via_get_tools_with_prefix`
      — guards the real #1389 silent-drop path (via
      `_use_invocation_cache`) so it cannot silently regress.
  - **Compatibility note**: Pre-release `google-adk==2.0.0a2` snapshotted
    toolset references at `LlmAgent` construction (via `model_post_init` →
    `_build_nodes`) and would regress to an empty tool list under per-run
    replacement; the supported install range `>=1.16.0,<3.0.0` never
    resolves a pre-release.

## [0.6.4] - 2026-05-26

### Added

- **DEPS**: `google-adk` upper bound lifted from `<2.0.0` to `<3.0.0`. The middleware
  is now compatible with both ADK 1.x and ADK 2.x (GA 2026-05-19). See the two
  paired fixes below for the source changes that enable 2.0 support without
  regressing 1.x. Verified against `google-adk==1.33.0`, `google-adk==2.0.0`, and
  `google-adk[a2a]==2.1.0` (the `[a2a]` extra only pulls `a2a-sdk` and does not
  intersect any middleware code path). CI should ideally run the suite under both
  ADK 1.33 and the latest 2.x to keep the dual-pin invariant honest.

### Fixed

- **FIX**: `AGUIToolset` now binds a `ClientProxyToolset` delegate instead of being
  replaced wholesale, so ADK 2.0's eager `Runner.__init__` tool cache stays valid (#1389)
  - **Cause**: ADK 2.0 changed `Runner.__init__` to eagerly walk `agent.tools` and
    cache whatever each toolset returns from `get_tools()`. The previous
    `_update_agent_tools_recursive` strategy reassigned `agent.tools = [...]` so the
    placeholder `AGUIToolset` was replaced by a `ClientProxyToolset` object — but
    the Runner had already cached a reference to the placeholder, leaving the LLM
    with an empty tool list and the error
    `"Tool 'X' not found. Available tools: []"` on first frontend-tool invocation.
    ADK 1.x resolved `get_tools()` lazily so the replacement was visible.
  - **Fix**: `AGUIToolset` gains `bind(delegate)` and `unbind()` methods.
    `get_tools()` forwards to the bound delegate, or returns `[]` if unbound.
    Object identity of the `AGUIToolset` instance in `agent.tools` is preserved
    end-to-end, so ADK 2.0's cache stays valid and ADK 1.x continues to work
    unchanged (the delegation pattern is functionally equivalent to the previous
    replace-the-object approach there).
  - `_update_agent_tools_recursive` calls `bind()` instead of mutating `agent.tools`.
    `_run_adk_in_background`'s `finally` block walks the tree and calls `unbind()`
    so the next run starts with placeholders in their construction-time state.
  - **Additionally**, `AGUIToolset.__init__` now explicitly calls
    `super().__init__()`. `BaseToolset.__init__` initializes the cache
    attributes (`_use_invocation_cache`, `_cached_invocation_id`,
    `_cached_prefixed_tools`) on both ADK 1.x and 2.0; the 2.0 change is
    that `llm_agent.py:185` eagerly reads `_use_invocation_cache` and
    silently drops the toolset when missing. Required now that bind()
    delegation preserves the instance across the run.
  - **Tests**: `tests/test_adk_2_0_compat.py::TestAGUIToolsetDelegation` covers
    construction (super-init runs), unbound `get_tools()` returns `[]` (with an
    opt-in explicit-raise mode preserved for tests), bind/unbind round-trip,
    re-bind across multi-turn runs, and object-identity preservation across a
    full `ADKAgent.run` invocation. Two existing tests in
    `tests/test_adk_agent.py` (`test_agui_tools_properly_converted_in_subagents`
    and `test_non_deepcopyable_tool_does_not_crash`) were updated to assert the
    new delegated semantics (toolset instance preserved, `._delegate` is the
    `ClientProxyToolset`) instead of the old wholesale-replacement semantics.
  - **Reporter**: filed [#1389](https://github.com/ag-ui-protocol/ag-ui/issues/1389)
    with the exact `_use_invocation_cache` symptom and the delegation-via-bind
    workaround. The architecture of this fix follows the proposal in
    [#1470 (withdrawn)](https://github.com/ag-ui-protocol/ag-ui/pull/1470).

- **FIX**: Workflow roots now receive `FunctionResponse` directly in `new_message`
  so ADK 2.0 `Workflow._run_impl` can rehydrate from interrupt (#1669)
  - **Cause**: The #1534 workaround for `Runner._resolve_invocation_id`'s
    end-of-agent short-circuit pre-appends the `FunctionResponse` to the session
    and replaces `new_message` with an empty-text placeholder. That's correct for
    LlmAgent roots (whose `function_call` events carry `end_of_agent=True`), but
    ADK 2.0 `Workflow._run_impl` rehydrates from `new_message.parts` only —
    `_extract_resume_inputs(new_message)` returns `None` when the placeholder
    has no `function_response`, so the workflow restarts from `START` instead of
    resuming the interrupted node. Symptom: Workflow-rooted HITL flows hang
    indefinitely on tool-result submission.
  - **Fix**: Add `ADKAgent._root_agent_is_workflow()` predicate. The pre-append
    branch is now gated on `not self._root_agent_is_workflow()` — Workflow roots
    take the direct-`new_message` path (same path used by ADK <1.28 and
    non-resumable apps), where the `FunctionResponse` lands in
    `new_message.parts` and `Workflow._extract_resume_inputs` can correctly read
    it. The LlmAgent + composite-orchestrator path is unchanged.
  - The predicate imports `google.adk.workflow.Workflow` lazily inside the
    function with a try/except guard, so ADK 1.x (which has no `workflow`
    module) returns `False` without raising.
  - **Tests**: `tests/test_adk_2_0_compat.py::TestWorkflowRootDetection`
    covers the predicate's three branches (LlmAgent-not-workflow, no-root,
    Workflow-true via `Workflow(name="wf_root")`).
    `TestWorkflowRootHitlEndToEnd` is the end-to-end regression: paused
    HITL state, tool-result-only resume, capture `runner.run_async`'s
    `new_message` and assert it carries the `function_response` (not the
    #1534 placeholder). Paired negative-control pins the LlmAgent path.
    Skips cleanly on ADK 1.x. Positive test fails on `main` with ADK 2.0
    force-installed (Workflow gets the placeholder — #1669 reproduced) and
    passes on this branch.
  - **Reporter**: filed [#1669](https://github.com/ag-ui-protocol/ag-ui/issues/1669)
    with the exact root cause and the proposed gating expression that this fix
    implements verbatim.
- **FIX**: `DatabaseSessionService` stale-session crash on HITL turns, with producer-side persistence for streaming fidelity (#1732, #1753, #1754, #1755)
  - **Root cause (#1732)**: ADK 1.27+ added optimistic concurrency control (OCC) to `DatabaseSessionService.append_event`: the session row's storage-update marker is compared to the in-memory session's marker on every write. On a HITL turn, the middleware wrote `pending_tool_calls` to `session.state` from the consumer (`_run_new_execution`) while ADK's Runner was still iterating `runner.run_async` and holding the same session in `invocation_context.session`. The write bumped the storage marker; the next ADK `append_event` raised `ValueError: The session has been modified in storage since it was loaded.` The error escaped from the runner's own append loop, was caught by `_run_adk_in_background`'s `except`, and surfaced to the client as a `RunErrorEvent` with code `BACKGROUND_EXECUTION_ERROR`.
  - **Initial fix (#1735, by [@he-yufeng](https://github.com/he-yufeng))**: gated the consumer's persistence call on `execution.task.done()` — if the producer task is still running when a HITL `ToolCallEndEvent` is dequeued, the consumer awaits `execution.task` before calling `_add_pending_tool_call_with_context`. This guarantees the DB write happens after `runner.run_async` has fully exited, eliminating the race against ADK's in-memory session. PR #1735's ordering test mocks the producer and asserts persistence does not fire until the task is done. Thanks to @he-yufeng for landing this fix quickly. See [PR #1735](https://github.com/ag-ui-protocol/ag-ui/pull/1735).
  - **Regression test for #1732 (#1753 / [PR #1756](https://github.com/ag-ui-protocol/ag-ui/pull/1756))**: the existing `TestStaleSessionRegression` suite in `tests/test_pending_tool_calls_gating.py` had purpose-built scaffolding for this bug class (`_StaleSessionDetector` log handler, `DatabaseSessionService(sqlite+aiosqlite)` fixture, scripted `BaseLlm` stubs) but only covered the backend-tool variant from #1652. Two HITL siblings added: a synchronous smoke test that runs without credentials and pins the post-fix invariants (no stale-session error, no `RunErrorEvent`, `pending_tool_calls` actually persisted), plus a live-Gemini integration test in `TestStaleSessionRegressionLiveLLM` (gated on `GOOGLE_API_KEY`, falls back to `llmock_server`) that reproduces the exact #1732 traceback when PR #1735's fix is reverted. The live test uses `gemini-2.0-flash` + `ResumabilityConfig(is_resumable=True)` + `DatabaseSessionService`, producing the `adk-<uuid>` tool-call IDs from the original issue.
  - **Latent twin: `_store_lro_id_remap` (#1754 / [PR #1757](https://github.com/ag-ui-protocol/ag-ui/pull/1757))**: PR #1735's consumer-side gate did not cover a second mid-Runner writer. `_run_adk_in_background` calls `_store_lro_id_remap` from inside its `async for adk_event in runner.run_async(...)` loop at two sites (the LRO drain branch and the main LRO branch) to record partial→final ID remappings from SSE streaming. Each call went through `session_manager.update_session_state` → `session_service.append_event` and bumped the same storage marker. On non-resumable HITL the existing hard-stop after the LRO event masked the bug, but on resumable HITL (`ResumabilityConfig(is_resumable=True)`) — the path being deprecated *toward* — the runner kept going and ADK's next `append_event` (for the parallel backend tool's `function_response`) hit the same OCC error. The fix buffers remap updates in a local `pending_lro_id_remap: Dict[str, str]` during the runner loop and flushes them once via `_store_lro_id_remap` in the function's `finally` block (after `runner.close()`). New `TestLroIdRemapStaleSessionRegression` in `tests/test_lro_sse_id_remap.py` uses a scripted `BaseLlm` emitting partial=True + partial=False LlmResponses, each with parallel function_calls (backend + frontend) with no IDs set — ADK's `populate_client_function_call_id` assigns fresh UUIDs each time, guaranteeing ID divergence. The backend tool returns a result, forcing the subsequent `append_event` that exposes the stale in-memory session. Deterministic; uses real ADK runner + real `DatabaseSessionService`.
  - **Streaming fidelity via producer-side persistence (#1755 / [PR #1758](https://github.com/ag-ui-protocol/ag-ui/pull/1758))**: PR #1735's gate fired on the first HITL `ToolCallEndEvent` and held the consumer until the producer exited. For resumable HITL with parallel tool calls, post-LRO text, or backend tool results following the LRO, every event the producer enqueued after the first HITL TCE sat in `event_queue` until runner exit and reached the client as a burst rather than streaming live. The producer-side replacement defers only the HITL `ToolCallEndEvent` itself; all other events stream through immediately. New `_HitlDeferringQueue` (subclass of `asyncio.Queue`) replaces the bare queue in `_start_background_execution`: HITL TCEs whose id is in `long_running_tool_ids` are buffered in a local dict; `ToolCallResultEvent` for a deferred id releases the buffered TCE first (preserves TCE→Result order); the `None` sentinel implicitly flushes any remaining deferred TCEs. A new `_finalize_hitl_buffer` helper persists `deferred_hitl_ids` via `_add_pending_tool_call_with_context` and is called at all three producer exit points (normal exit, LRO drain return, non-resumable LRO return). The consumer's HITL gate and the `ToolCallResultEvent`→`_remove_pending_tool_call` unpersist branch are removed entirely — by the time the consumer observes a TCE, the producer has already persisted. PR #1581 invariant preserved (persist before client sees TCE), PR #1735/#1732 invariant preserved (no mid-runner state writes), #1652 invariant preserved (only HITL ids persisted). New `test_non_hitl_events_stream_live_after_hitl_tce` in `tests/test_multi_instance_hitl.py` pins the streaming behavior: producer enqueues HITL TCE then a non-HITL `ToolCallStartEvent` then blocks; assertion is that the non-HITL event reaches the client within 1s while the producer is still blocked AND that the HITL TCE arrives later. Existing mocks in `test_multi_instance_hitl.py` and `test_tool_tracking_hitl.py` were updated to call `_add_pending_tool_call_with_context` before `put(None)`, matching the real producer's new behavior.
  - **Reporter**: [@bajayo](https://github.com/bajayo) filed [#1732](https://github.com/ag-ui-protocol/ag-ui/issues/1732) with a complete bug report — Postgres-backed `DatabaseSessionService` setup, ADK version pinning (1.26.0 working / 1.27.0+ broken), the full traceback, and the workaround. Thanks!

- **FIX**: `_shallow_copy_agent_tree` now re-parents copied sub-agents so `transfer_to_agent` resolves against the per-run copy (#1719)
  - `ADKAgent._shallow_copy_agent_tree` recursively copies the agent tree before each run so that per-execution tool replacement (`AGUIToolset` → `ClientProxyToolset` via `_update_agent_tools_recursive`) doesn't mutate the originals. Pydantic's `model_copy(deep=False)` inherits every field by reference, including `parent_agent`, so each recursively-copied sub-agent still pointed at the **original** parent.
  - ADK's `transfer_to_agent` resolves the target by walking `parent_agent` up to the root and searching the root's `sub_agents` registry. Because each copied sub-agent's `parent_agent` referenced the original (pre-copy) root — whose `tools` were never updated for this run — the transfer either failed to find the target or, where it did find one, escaped into the stale original tree whose `AGUIToolset` was never swapped for `ClientProxyToolset`. The transfer was silently dropped or executed against unwired tools.
  - The fix re-parents each copied sub-agent to its copied parent after the recursive copy: `sub.parent_agent = copied`. A guard skips the early-return branch where `model_copy` raised `AttributeError` and the input was returned as-is (e.g. non-Pydantic test mocks), so the original tree's `parent_agent` is never mutated through the back door.
  - New regression test `test_shallow_copy_reparents_sub_agents` in `tests/test_adk_agent.py` asserts (a) the copied child's `parent_agent is` the copied root (not the original), and (b) the original child's `parent_agent` still points at the original root — pinning the no-mutation invariant alongside the re-parenting fix.
  - **Reporter**: [@jb-delafosse](https://github.com/jb-delafosse) filed [#1719](https://github.com/ag-ui-protocol/ag-ui/issues/1719) with a minimal repro, accurate root-cause analysis, and the proposed re-parenting fix this implementation is based on. Thanks!

## [0.6.3] - 2026-05-16

### Fixed

- **FIX**: `FunctionResponse.name` now set to the called function name, not `tool_call_id` (#1682)
  - `convert_ag_ui_messages_to_adk` was building `types.FunctionResponse` with `name=message.tool_call_id`, conflating the response's `name` field (meant to hold the called function's name, e.g. `get_weather`) with the correlation ID.
  - Gemini's wire contract requires `FunctionResponse.name` to equal the originating `FunctionCall.name`. Using a UUID-shaped `tool_call_id` instead meant any downstream consumer that correlates calls by name (real Gemini's session correlator, aimock's gemini→openai translator, etc.) couldn't find a matching prior `FunctionCall.name`, silently breaking multi-leg round-trips (e.g. `tool-rendering-reasoning-chain` fixture chains failing on the second leg).
  - The fix builds a `tool_call_id → function_name` lookup from all `AssistantMessage.tool_calls` in the same conversion batch before processing `ToolMessage`s. When a `ToolMessage` is encountered, `FunctionResponse.name` is set from the lookup; the old `tool_call_id` fallback is preserved for the edge case where no matching `AssistantMessage` is present in the same batch (malformed input), preventing crashes.
  - `FunctionResponse.id` continues to carry the original `tool_call_id` so clients that key on the correlation ID are unaffected.
  - **Contributor**: Reported and fixed by [@AlemTuzlak](https://github.com/AlemTuzlak) in [#1682](https://github.com/ag-ui-protocol/ag-ui/pull/1682). Thanks!

## [0.6.2] - 2026-05-12

### Security

- **FIX**: `/agents/state` no longer bypasses `extract_state_from_request` (#1646)
  - The experimental `/agents/state` POST endpoint added in #642 read `userId`/`appName` directly from the request body and never invoked the configured `extract_state_from_request` (or legacy `extract_headers`) function. For deployments that rely on the extractor as an auth hook — e.g. minting `user_id`/`thread_id` from a session-provider-minted JWT, per @DamianPereira's report on the original PR — a client could post `{"threadId": "...", "userId": "<victim>"}` and read the victim's session state and full message history. The chat endpoint already routed through the extractor (see `endpoint.py` lines 274-281), so this was a side-channel that ignored the same auth boundary.
  - The fix constructs a synthetic `RunAgentInput` from the `AgentStateRequest` and threads it through the same `extract_state_from_request(request, input_data)` pipeline as the chat endpoint, then resolves identity with a precedence chain that mirrors the chat path: (1) `ADKAgent._static_app_name`/`_static_user_id`, (2) `ADKAgent._app_name_extractor`/`_user_id_extractor` against the post-extractor synthetic input, (3) `state["app_name"]`/`state["user_id"]` written by `extract_state_from_request` directly (so JWT auth hooks work without also wiring an `ADKAgent`-level extractor), (4) body `appName`/`userId` as a documented fallback when none of the above produce a value.
  - `AgentStateRequest.appName`/`userId` are now **deprecated** when `extract_state_from_request` is configured. A `DeprecationWarning` is emitted any time the body supplies either field with an extractor wired up, surfacing the configuration mismatch to operators who may have built UIs around the body shape. The fields are retained for backward compatibility with deployments that configure neither static identity nor an extractor; removal is planned for a future major.
  - Legacy `extract_headers` (and the equivalent `make_extract_headers` helper) writes values under `state.headers.*` rather than `state["user_id"]`, so it does **not** automatically gate `/agents/state` identity. Deployments using `extract_headers` for auth must either map the header to `state["user_id"]` via a custom `extract_state_from_request`, or configure an `ADKAgent`-level `user_id_extractor` that reads `input.state.headers`. This contract is pinned by a regression test in the new `TestAgentsStateExtractorIntegration` suite alongside the four primary tests: extractor invocation (verifying the synthetic `RunAgentInput.thread_id` reaches the extractor), spoofed-body precedence (the bypass repro: a body `userId: "victim-user-id"` is dropped in favor of the extractor's `from-jwt-user`), no-extractor backward compat (body still works as before), and the documented `extract_headers` non-protection.

### Fixed

- **FIX**: `DatabaseSessionService` stale-marker race on every tool-using turn (#1652)
  - PR #1581 (shipped in 0.6.1) began calling `_add_pending_tool_call_with_context` / `_remove_pending_tool_call` from inside the `_stream_events` consumer loop so the entry was persisted before `TOOL_CALL_END` was yielded to the client.  That fixed the horizontally-scaled HITL race but unconditionally wrote `pending_tool_calls` to `session.state` for *every* tool call — including backend tools that resolve in the same stream on the same pod.
  - With `DatabaseSessionService` on ADK >=1.30 (PostgreSQL or SQLite via `aiosqlite`), each mid-stream write advances the session row's `update_timestamp` while the ADK Runner still holds the `Session` instance loaded at the start of `run_async` — its `_storage_update_marker` becomes stale and the next `append_event` raises `ValueError: The session has been modified in storage since it was loaded.`  In production with a real LLM, the error escapes from the runner's own `append_event` as a `BACKGROUND_EXECUTION_ERROR` `RunErrorEvent`; locally it surfaces via `session_manager.update_session_state`.  Reverting #1581 would reintroduce the multi-pod race it was designed to fix.
  - The fix carries a per-execution `long_running_tool_ids: Set[str]` through the producer side, populated synchronously *before* `TOOL_CALL_END` is enqueued by both producer paths: (a) `_run_adk_in_background` from `adk_event.long_running_tool_ids` (the translator-emitted LRO branch in `event_translator.translate_lro_function_calls`), and (b) `ClientProxyTool._execute_proxy_tool` (the proxy-emitted path used when ADK invokes the proxy directly — every emission there is HITL by construction since `ClientProxyTool` wraps `LongRunningFunctionTool` with `is_long_running=True`).  The consumer in `_run_new_execution` now gates `_add/_remove_pending_tool_call` on membership in `execution.long_running_tool_ids`, so backend tools are skipped entirely and the DB marker is no longer advanced mid-Runner.  `mark_messages_processed` (the #437 replay fix) is hoisted out of the gate since it's pure in-memory bookkeeping that should always fire on a tool result regardless of HITL status.
  - The shared set is wired through `ExecutionState`, `ClientProxyToolset`, and `ClientProxyTool` following the existing `_emitted_tool_call_ids` / `_translator_emitted_tool_call_ids` pattern.  Synchronous mutation before any `await event_queue.put(...)` of the event guarantees single-threaded-asyncio visibility on the consumer side.
  - New regression suite `tests/test_pending_tool_calls_gating.py` (8 tests): wiring assertions for the three plumbing points, an end-to-end repro using a scripted `BaseLlm` stub against `DatabaseSessionService(sqlite+aiosqlite)` (with `AGUI_DATABASE_URL` override for live Postgres), an `InMemorySessionService` control, an assertion that backend tool IDs do *not* leak into persisted `pending_tool_calls`, and a HITL-still-persisted check.  The DB regression test reproduces the exact `ValueError` from the issue when run against unfixed code (verified on both `sqlite+aiosqlite` and live PostgreSQL 15 with ADK 1.33).
  - Updated mocks in `test_adk_agent.py`, `test_multi_instance_hitl.py`, and `test_tool_tracking_hitl.py` (which bypass the real producer) now register their tool-call IDs in `kwargs['long_running_tool_ids']` before enqueuing `TOOL_CALL_END`, matching the new producer contract.  PR #1581's `test_pending_tool_call_registered_before_tool_call_end_event_yielded` invariant test continues to pass — HITL tool calls are still persisted before the event is yielded.

- **FIX**: Duplicate `REASONING_*` events for thinking-enabled ADK agents (#1645)
  - With `BuiltInPlanner(thinking_config=ThinkingConfig(include_thoughts=True))` on Gemini via ADK, the reasoning block rendered twice in the UI for every response. `_translate_text_content` extracted `thought_parts` and forwarded them to `_translate_reasoning_content` unconditionally, so the streamed `partial=True` thought chunks *and* the final aggregated `partial=False` event — which re-contains the full accumulated thought text — each produced a `REASONING_START` / `REASONING_MESSAGE_START` / `REASONING_MESSAGE_CONTENT` / `REASONING_MESSAGE_END` sequence. Reproduced against `google-adk` 1.32.0 and `gemini-2.5-pro`.
  - The fix mirrors the text-stream dedup already used a few lines below (`was_already_streaming and not is_partial`) by capturing `was_already_reasoning = self._is_streaming_reasoning` before the guard and gating emission on `not (was_already_reasoning and not is_partial)`. Critically, the guard is *not* a flat "skip every `partial=False` thought event": ADK's `StreamingMode.NONE` yields exactly one `partial=False` event carrying the only copy of the thoughts, so a naive `partial is not False` check would silently drop reasoning entirely in non-streaming mode.
  - Two regression tests added to `tests/test_event_translator_comprehensive.py`: `test_streaming_none_mode_partial_false_thought_emits_reasoning` asserts that a single `partial=False` event with `_is_streaming_reasoning == False` still emits `ReasoningStartEvent`, `ReasoningMessageStartEvent`, and exactly one `ReasoningMessageContentEvent` carrying the thought text; `test_streaming_mode_final_aggregate_thought_not_duplicated` asserts that after a `partial=True` chunk opens the reasoning stream, the trailing aggregated `partial=False` event yields zero `ReasoningMessageContentEvent`s.
  - Note: the `agentic_chat_reasoning` example server exists but is not wired up in the Dojo (`agents.ts` has no entry for it under `adk-middleware`), which is why this code path had no end-to-end coverage prior to this fix.
  - **Contributor**: Reported and fixed by [@viktor-matic](https://github.com/viktor-matic) in [#1645](https://github.com/ag-ui-protocol/ag-ui/pull/1645). Thanks!

## [0.6.1] - 2026-04-30

### Added

- **NEW**: LLMock test infrastructure to run integration tests without `GOOGLE_API_KEY`
  - Uses `@copilotkit/aimock` (LLMock) to mock Gemini API responses via `GOOGLE_GEMINI_BASE_URL`
  - Session-scoped pytest fixture auto-starts a Node.js LLMock server when no real API key is present
  - When a real `GOOGLE_API_KEY` is set, the mock is skipped and tests hit the live API as before
  - Tier 1: 4 test files (32 tests) now pass without credentials — `test_text_events`, `test_context_integration`, `test_multi_turn_conversation`, `test_from_app_integration`
  - Tier 2: 6 test files (50 tests) with tool-call fixtures for LRO, HITL, and skip_summarization — `test_lro_sse_persistence`, `test_lro_sse_id_remap`, `test_lro_tool_response_persistence`, `test_hitl_resumption_text_output`, `test_resumability_config`, `test_issue_437_skip_summarization_integration`
  - Tier 3: `test_thought_to_thinking_integration` (7 tests) — reasoning/thinking event structure via `reasoning` fixture field producing `thought: true` Gemini parts
  - Tier 4: `test_multimodal_e2e` (4 tests) — image and document handling via content-matched fixtures
  - Remaining 4 skipped tests are Vertex AI session service live tests (require real Vertex AI infrastructure, not Gemini API)

- **NEW**: Optional `hitl_max_wait_seconds` parameter for `ADKAgent` and `SessionManager` (#1441)
  - Expired sessions with pending HITL tool calls are preserved indefinitely by default (unchanged behavior)
  - When set, abandoned HITL sessions are force-deleted after the specified duration, preventing unbounded memory growth
  - Tracks preservation start time per session in `_hitl_preserved_since`; tracking is cleaned up automatically when sessions are untracked
  - Opt-in via `hitl_max_wait_seconds=7200` (or any value in seconds) on `ADKAgent()` — defaults to `None` (no limit)

### Changed

- **CHANGE**: `add_adk_fastapi_endpoint` now streams Server-Sent Events via `sse_starlette.sse.EventSourceResponse` instead of `StreamingResponse` ([#1566](https://github.com/ag-ui-protocol/ag-ui/pull/1566); relates to [#1001](https://github.com/ag-ui-protocol/ag-ui/issues/1001); delivers the "lightweight" SSE-comment mode suggested by `@contextablemark` in the [#1002](https://github.com/ag-ui-protocol/ag-ui/pull/1002) review). This adds a 15-second `: ping\n\n` keep-alive comment per the [HTML SSE spec's authoring note](https://html.spec.whatwg.org/multipage/server-sent-events.html#authoring-notes), plus `Cache-Control: no-store` and `X-Accel-Buffering: no` response headers, preventing proxies (Cloud Run 60 s, AWS API Gateway 29 s, nginx ingress) and Node `undici` sockets from dropping idle long-running agent turns. On-the-wire SSE event format is unchanged (per-event JSON is passed through `ServerSentEvent(data=..., sep="\n")`, producing the same `data: {json}\n\n` frames as before). Complementary to a future `HeartbeatPlugin` emitting protocol-level `ACTIVITY_SNAPSHOT` progress events.

  - **Dependency change**: `sse-starlette>=2.1.0` is now a runtime dependency. The minimum `fastapi` floor is unchanged at `>=0.115.2` (the original PR review feedback flagged a `>=0.135.0` jump as too aggressive). `sse-starlette` is preferred over `fastapi.sse.EventSourceResponse` (added in FastAPI 0.135.0) because the FastAPI implementation is a marker class whose SSE encoding only applies via `response_class=` on a generator path operation, which is incompatible with the Accept-header branching below. `sse-starlette` is self-contained and works whether constructed directly or returned from a path operation. `Cache-Control` is now `no-store` (sse-starlette default) instead of `no-cache`; both prevent caches from holding/replaying the stream and `no-store` is the stricter, semantically more correct directive for SSE.

  - **Accept-header content negotiation preserved**: clients explicitly negotiating a non-SSE framing (e.g. `Accept: application/vnd.ag-ui.event+proto`, the media type reserved for a future binary encoder) continue to receive a plain `StreamingResponse(EventEncoder.encode(...))` with the encoder-supplied content type rather than being silently downgraded to SSE/JSON. Today the Python `EventEncoder` is a no-op SSE/JSON stub so the behavior is functionally equivalent for all current clients, but the runtime branch and the `EventEncoder(accept=...).get_content_type()` API surface are preserved so a binary encoder can ship without re-touching the endpoint. Only `text/event-stream` accepts (the default) take the keep-alive `EventSourceResponse` path.

  - **Internal**: `EventType`, `RunErrorEvent`, and `EventEncoder` are now imported at module scope in `ag_ui_adk.endpoint` (previously imported lazily inside the error branches). Tests that relied on the lazy import to patch `ag_ui.core.RunErrorEvent` should patch `ag_ui_adk.endpoint.RunErrorEvent` instead.

  - **Contributor**: Implementation by [@joar](https://github.com/joar) in [#1566](https://github.com/ag-ui-protocol/ag-ui/pull/1566). Thanks!

### Fixed

- **FIX**: Race in multi-instance HITL pending tool-call registration (#1581)
  - In multi-pod deployments sharing a Redis-backed `SessionService`, HITL tool results were silently dropped because `_start_new_execution` registered each pending tool-call ID in the session store *after* the streaming loop exited — i.e. after `ToolCallEndEvent` (and `RUN_FINISHED`) had already been delivered to the client.  A continuation request load-balanced to a different pod observed an empty `pending_tool_calls` list and failed to resume the agent.
  - `_add_pending_tool_call_with_context` now runs inside the streaming loop, before `yield event`, when a `ToolCallEndEvent` is observed.  For backend ADK tools that complete in the same stream, the just-registered ID is removed via `_remove_pending_tool_call` when the corresponding `ToolCallResultEvent` is seen, preserving prior semantics.
  - Adds two regression tests in `test_multi_instance_hitl.py` covering the ordering invariant and the backend-tool cleanup path.

- **FIX**: Gate ADK >=1.30-only tests so they skip cleanly on supported older ADK versions
  - Three tests in `test_lro_tool_response_persistence.py` and one in `test_adk_130_invocation_id_override.py` assert behaviour produced by the ADK >=1.30 pre-append workaround in `adk_agent.py` (guarded by `_ADK_OVERRIDES_INVOCATION_ID`).  On ADK <1.30 the workaround is intentionally a no-op, so these tests previously failed on the lower end of the `>=1.16,<2.0` supported range.
  - Each of the four tests now carries `@pytest.mark.skipif(not _ADK_OVERRIDES_INVOCATION_ID, ...)` and skips with an explicit reason on <1.30; on >=1.30 they continue to run unchanged.  The version-aware `test_function_response_has_correct_invocation_id` and the meta-test `test_feature_detection_matches_installed_adk_version` are intentionally left un-gated.

- **FIX**: `temp:`-prefixed state from `extract_state_from_request` now reaches `tool_context.state` (#1571)
  - ADK's session services (`DatabaseSessionService`, `InMemorySessionService`, `VertexAiSessionService`) strip `temp:` keys before persisting, so request-scoped values (e.g. bearer tokens) returned by `extract_state_from_request` were silently dropped before the Runner fetched the session for an invocation
  - The session service is now transparently wrapped by `RequestStateSessionService`, which holds pending `temp:` state in memory keyed by `(app_name, user_id, session_id)` and merges it into the session that ADK's Runner loads at invocation time — so `temp:` keys are visible to tools during the run while still not being persisted
  - Pending state is cleared in the `finally` block of `_run_adk_in_background` so a later run on the same session cannot inherit a stale value (e.g. a rotated token)
  - `temp:` keys extracted from the request are also filtered out of the end-of-run `STATE_SNAPSHOT` so ephemeral server-side state never leaks to clients
  - Purely additive for callers: non-`temp:` keys flow through the existing persistence path unchanged; ADK-native `output_key="temp:foo"` flows (e.g. `SequentialAgent` passing data between sub-agents) continue to work; the wrapper is a transparent `BaseSessionService` proxy (unwrap via `.inner` if ever needed)
  - New tests: `tests/test_temp_state_extraction.py` (10 tests) covering the wrapper, the `ADKAgent` wiring, and an end-to-end flow that asserts `temp:` visibility in `tool_context.state`, non-persistence to session storage, and non-leakage into `STATE_SNAPSHOT`

- **FIX**: First-turn HITL `TOOL_CALL_*` emission on `google-adk` <1.18 (#1536)
  - `EventTranslator.translate_lro_function_calls` previously suppressed emission for client-tool names in resumable mode, relying on `ClientProxyTool` as the sole emitter
  - On `google-adk` 1.16/1.17 the runner's resumable flow returns before invoking LRO tools on the first turn (`base_llm_flow.py` pause-early-return), so the proxy never ran and the trio was never emitted — the first HITL turn produced no `TOOL_CALL_START/ARGS/END`
  - Translator is now the primary LRO emitter across all supported ADK versions; `ClientProxyTool`'s existing `_translator_emitted_tool_call_ids` dedupe guard keeps emissions idempotent when ADK 1.18+ does invoke the proxy
  - Added a self-dedupe against `emitted_tool_call_ids` so the same LRO event seen twice under SSE streaming (partial=True then partial=False on ADK 1.23+) emits the trio exactly once
  - `test_hitl_tool_result_submission_with_resumability` now passes on the full `>=1.16,<2.0` pin range

- **FIX**: HITL resumption on google-adk >= 1.28 (`_resolve_invocation_id` override) (#1534)
  - ADK's `Runner._resolve_invocation_id()` (present since ~1.28, behavior visible from 1.30 onward) inspects `new_message`, and when it contains a `FunctionResponse`, forcibly substitutes the caller-supplied `invocation_id` with the one from the matching `FunctionCall` event and routes the run through the resumed-invocation code path.  For standalone `LlmAgent` roots (whose `function_call` events were emitted with `end_of_agent=True`), that path early-returned in `run_async()` — the LLM was never invoked and HITL tool-result submissions produced zero content events.
  - Feature-detected via `hasattr(Runner, '_resolve_invocation_id')` so the middleware keeps working across the full supported range (`>=1.16,<2.0`).
  - When the override is present, tool-only submissions now pre-append the `FunctionResponse` as its own session event (tagged with the originating `FunctionCall`'s `invocation_id` for DatabaseSessionService compatibility, #957) and pass a minimal text-only placeholder as `new_message` so `_resolve_invocation_id` short-circuits on the "no function_responses" branch.  Composite-agent HITL resumption continues to pass the stored `invocation_id` via `run_kwargs`.
  - `test_function_response_has_correct_invocation_id` is now version-aware: it asserts the persisted `invocation_id` matches the originating `FunctionCall` event on ADK >=1.28 and continues to assert the AG-UI `run_id` on older ADK.
  - New regression suite `tests/test_adk_130_invocation_id_override.py` pins the tool-only HITL flow end-to-end and verifies pre-append doesn't duplicate the persisted `FunctionResponse`.

- **FIX**: Multi-instance session cache hydration in `ADKAgent.run()` (#1484, thanks @deb538)
  - Hydrates the in-memory `_session_lookup_cache` from the database-backed `SessionService` on cache miss, before pending-tool-call detection runs
  - Prevents HITL breakage in load-balanced deployments where requests land on an instance that did not create the session: without hydration, `_has_pending_tool_calls()` returned `False` and user messages were dispatched ahead of pending tool results, causing the LLM to reject the turn

- **FIX**: Redundant `list_sessions` scan on new thread creation (#1514)
  - Tracks hydration DB misses in `_cache_checked_keys` and passes `skip_find=True` to `get_or_create_session`, eliminating a duplicate `_find_session_by_thread_id` call for new threads

- **FIX**: Stale pending-tool-call cleanup after cache hydration (#1515)
  - Replaces the cache-miss heuristic in `_ensure_session_exists` with `_verify_pending_tool_calls()`, which runs once per instance per session and only clears pending calls when no active execution exists to fulfill them
  - Correctly distinguishes multi-instance cache misses (valid calls) from middleware restarts (stale calls)

### Security

- **SEC**: Bump transitive dependencies to fix 1 critical and 7 high Dependabot alerts
  - `authlib` → 1.6.10 (critical: JWS signature bypass; high: OIDC hash binding, Bleichenbacher oracle, `alg:none` bypass)
  - `pyasn1` → 0.6.3 (high: DoS via unbounded recursion)
  - `pyopenssl` → 26.0.0 (high: DTLS cookie callback buffer overflow)
  - `PyJWT` → 2.12.1 (high: unknown `crit` header extensions)
  - `black` → 26.3.1 (high: arbitrary file writes from cache file name)
  - `cryptography` → 46.0.7 (high: subgroup attack on SECT curves)
  - `protobuf` → 6.33.5+ (high: JSON recursion depth bypass)
  - `python-multipart` → 0.0.22+ (high: arbitrary file write via non-default config)

- **FIX**: JSON Schema cleaning for `google.genai.types.Schema` compatibility (#1495, fixes #1003)
  - Replaces `_strip_json_schema_meta` with `_clean_schema_for_genai`: strips `$`-prefixed keys, filters remaining keys via an allowlist derived from `types.Schema.model_fields` (with camelCase aliases), and maps `examples` → `example` (first element) and `const` → `enum` (JSON-serialized single-value list)
  - Preserves valid genai fields (`title`, `default`, `additionalProperties`, `minProperties`, etc.) that were previously stripped, while correctly removing unsupported fields (`readOnly`, `deprecated`, `contentMediaType`, etc.) that caused `ValidationError`
  - Adds unit tests (positive, negative, mapping) and end-to-end tests validating cleaned schemas through `types.Schema.model_validate()`

- **FIX**: HITL resumption for LlmAgent roots with composite sub-agents (#1444)
  - `_root_agent_needs_invocation_id()` now recursively detects `SequentialAgent` / `LoopAgent` anywhere in the sub-agent tree, not just at the root level
  - Previously, topologies like `LlmAgent → SequentialAgent` or `LlmAgent → LlmAgent → SequentialAgent` lost `invocation_id` across HITL turns, causing the SequentialAgent to lose its position state and ADK to bypass its orchestration on resume
  - Standalone LlmAgents (including those with only LlmAgent transfer targets) are unaffected — the guard still prevents passing `invocation_id` which would trigger `_get_subagent_to_resume()` ValueError

## [0.6.0] - 2026-04-06

### Changed

- **BREAKING**: Migrate from deprecated `THINKING_*` events to `REASONING_*` events (#1406)
  - `THINKING_START` / `THINKING_END` → `REASONING_START` / `REASONING_END`
  - `THINKING_TEXT_MESSAGE_START` / `CONTENT` / `END` → `REASONING_MESSAGE_START` / `CONTENT` / `END`
  - All reasoning events now carry a `message_id` for client-side correlation and `role="reasoning"` on message start
  - Internal state variables renamed accordingly (`_is_thinking` → `_is_reasoning`, etc.)
  - Aligns the ADK middleware with the Claude Agent SDK and LangGraph integrations, which already use `REASONING_*` events

### Added

- **NEW**: `REASONING_ENCRYPTED_VALUE` support for Gemini thought signatures (#1406)
  - Extracts `thought_signature` (opaque bytes) from Google GenAI SDK `Part` objects when present
  - Emits `REASONING_ENCRYPTED_VALUE` events with `subtype="message"` and base64-encoded signature
  - Enables encrypted reasoning / zero-data-retention workflows with Gemini models

- **NEW**: Reasoning chat example (`examples/server/api/agentic_chat_reasoning.py`)
  - Demonstrates `REASONING_*` event emission using Gemini 2.5 Flash with `include_thoughts=True`
  - Registered at `/adk-reasoning-chat` in the example server

- **NEW**: Support for multimodal input types (`ImageInputContent`, `AudioInputContent`, `VideoInputContent`, `DocumentInputContent`) (#1405)
  - Replaces reliance on the deprecated `BinaryInputContent` with the newer modality-specific types defined in the AG-UI protocol
  - `InputContentDataSource` (inline base64) converts to `types.Part(inline_data=types.Blob(...))`, same as before
  - `InputContentUrlSource` (HTTPS/GCS URLs) converts to `types.Part(file_data=types.FileData(file_uri=...))`, leveraging ADK's native URI support
  - Legacy `BinaryInputContent` continues to work for backward compatibility
  - Adds E2E tests gated on `GOOGLE_API_KEY` covering inline images, document URLs (RFC 2549 via IETF), multi-image messages, and mixed text+image content

### Fixed

- **FIX**: Suppress `output_schema` agent text from chat UI (#1390)
  - ADK sub-agents with `output_schema` (e.g. classifiers in SequentialAgent workflows) produce structured output intended for inter-agent data transfer, not user-visible chat messages
  - `ADKAgent._collect_output_schema_agent_names()` recursively walks the agent tree to identify `LlmAgent` instances with `output_schema` set
  - `EventTranslator` suppresses `TextMessageEvent` emission when the event author matches a collected name, while still emitting reasoning/thought events
  - Prevents structured output (e.g. a classifier returning `"CHAT"`) from leaking into the chat UI

- **FIX**: Disable `save_input_blobs_as_artifacts` so inline images reach the model (#1405)
  - ADK's runner was converting `inline_data` parts to artifact references before the model could see them, replacing images with text like `"Uploaded file: artifact_xxx. It is saved into artifacts"`
  - Setting `save_input_blobs_as_artifacts=False` in `RunConfig` preserves inline binary data so the model receives the actual image/audio/video/document content

## [0.5.2] - 2026-03-26

### Changed

- **CHORE**: Cap `google-adk` dependency at `<2.0.0` to prevent breakage when ADK 2.0 ships
  - ADK 2.0.0a1 introduces breaking changes to the agent API, event model, and session schema, and requires Python 3.11+
  - The middleware remains compatible across the full `1.16.0–1.27.5` range — verified by running the full test suite (647 tests) against `1.22.1`, `1.24.1`, and `1.27.5`

### Added

- **NEW**: `use_thread_id_as_session_id` option for `ADKAgent` and `SessionManager`
  - When enabled, uses the AG-UI `thread_id` directly as the ADK `session_id` instead of letting the backend generate one
  - Eliminates the O(n) `list_sessions` scan needed to recover thread-to-session mappings after middleware restarts, replacing it with a direct O(1) `get_session` lookup
  - Opt-in via `use_thread_id_as_session_id=True` on `ADKAgent()` or `ADKAgent.from_app()` — defaults to `False` for backward compatibility
  - Refactors `SessionManager.get_or_create_session` into two clear paths: `_get_or_create_by_thread_id` (direct lookup with race-condition handling) and `_get_or_create_by_scan` (original scan path)
  - Note: Not compatible with `VertexAiSessionService` which rejects caller-provided session IDs

- **NEW**: Vertex AI session service test coverage (`test_vertex_session_service.py`)
  - 10 mock-based tests using `MockVertexAiSessionService` that faithfully replicates Vertex behaviour (generates numeric IDs, rejects custom `session_id`)
  - 4 live integration tests against a real Vertex AI Agent Engine (skipped unless `VERTEX_REASONING_ENGINE_ID` is set)
  - Covers session CRUD, scan-based recovery, multi-turn reuse, and `use_thread_id_as_session_id` error propagation

### Fixed

- **FIX**: Handle parallel same-name LRO tool calls in ADK + Gemini (#1334)
  - When Gemini emitted N parallel function calls for the same tool (e.g. 5× `create_item`), the middleware only emitted the first call and silently dropped the rest, due to a single-call guard in `translate_lro_function_calls()`
  - The LRO ID remap (`lro_emitted_ids_by_name`) used a `Dict[str, str]` keyed by tool name, causing last-write-wins when multiple calls shared the same name — only 1 of N IDs could be remapped, producing a function call/response count mismatch that Gemini rejected with a 400 error
  - `translate_lro_function_calls()` now processes all LRO function calls in a single event, not just the first
  - `lro_emitted_ids_by_name` changed to `Dict[str, List[str]]` with positional (FIFO) matching in `_extract_lro_id_remap()` so every parallel call gets its own correct remap

- **FIX**: Use Pydantic serialization for tool-call args to handle non-stdlib-serializable types (#1331)
  - `json.dumps` on LRO function-call args (e.g. `adk_request_credential`) crashed with `TypeError: Object of type SecuritySchemeType is not JSON serializable` when args contained Pydantic models or Python Enums
  - Introduces a shared `serialize_tool_args()` helper using Pydantic's `TypeAdapter`, applied to all 5 call sites that previously used `json.dumps` on tool args
  - Thanks to **@joar** for this contribution!

- **FIX**: Strip JSON Schema meta-fields (`$schema`, `$id`, `$ref`, etc.) from tool parameters before passing to `google.genai.types.Schema.model_validate()` (#1349)
  - Frontend tools whose JSON Schema includes `$`-prefixed meta-fields (e.g. those generated by Zod/MCP) caused a Pydantic `ValidationError: Extra inputs are not permitted`, crashing the ADK runner silently
  - Adds recursive `_strip_json_schema_meta()` helper to `client_proxy_tool.py` that removes `$`-prefixed keys at all nesting levels before schema validation

- **FIX**: Key session lookup cache by `(thread_id, user_id)` to prevent cross-user collision (#1323)
  - `_session_lookup_cache` and `_active_executions` are now keyed by a `(thread_id, user_id)` tuple instead of `thread_id` alone, preventing one user's session from being returned to another when both share the same thread ID
  - All internal helpers (`_get_session_metadata`, `_get_backend_session_id`, `_remove_pending_tool_call`, `_get_pending_tool_call_ids`, `_has_pending_tool_calls`) now require `user_id` as a mandatory parameter — no silent `""` defaults that could mask cache misses
  - Adds test coverage for two users sharing the same thread ID receiving separate sessions
  - Thanks to **@themavik** for this contribution!

- **FIX**: Remove double JSON encoding of `state` and `messages` in `/agents/state` endpoint (#1347)
  - `AgentStateResponse` declared `state` and `messages` as `str`, and the handler wrapped them with `json.dumps()` before passing to `JSONResponse`, which serializes again
  - Consumers received doubly-encoded strings (e.g. `"[{...}]"`) instead of native objects (`[{...}]`), breaking CopilotKit's message snapshot functionality
  - Fixed by changing `AgentStateResponse` fields to `dict`/`list` and removing the redundant `json.dumps()` calls

- **FIX**: Replace deep copy with shallow copy to support McpToolset (#1264)
  - `ADKAgent.model_copy(deep=True)` fails when the ADK agent tree contains tools with unpicklable attributes (e.g. `McpToolset.errlog = sys.stderr`)
  - Replaced with a recursive shallow copy (`_shallow_copy_agent_tree`) that isolates only the fields modified per-execution (`instruction`, `tools`, `sub_agents`) while sharing tool objects by reference
  - Adds regression test with a mock `UnpicklableToolset` to prevent future breakage

- **FIX**: Update PyPI metadata and lockfile for adk-middleware package (#1263)
  - Added `description` field to `pyproject.toml` for proper PyPI display
  - Added `license = "MIT"` designation
  - Added `project.urls` section with Homepage and Issues links
  - Expanded `uv_build` version constraint from `<0.9` to `<0.11`
  - Added `pytest-xdist` as a dev dependency for faster parallel test execution
  - Regenerated `uv.lock` with updated Python version bounds
  - Thanks to **@rcleveng** for this contribution!

## [0.5.1] - 2026-03-05

### Fixed

- **FIX**: Remap LRO tool-call IDs across SSE streaming partial/final events (#1168)
  - ADK's `populate_client_function_call_id()` generates different UUIDs for the same function call across partial and final SSE streaming events, breaking HITL workflows
  - `EventTranslator` now tracks emitted IDs per tool name (`lro_emitted_ids_by_name`) during `translate_lro_function_calls()`
  - When the non-partial event arrives, `_extract_lro_id_remap()` builds a client-ID → persisted-ID mapping
  - Remap is stored in session state (`lro_tool_call_id_remap`) so it survives across HTTP requests
  - `FunctionResponse` construction applies the remap transparently — clients continue using their original IDs

- **FIX**: Prevent stale frontend state from overwriting backend-managed session metadata (#1168)
  - Internal state keys (e.g. `lro_tool_call_id_remap`, `_ag_ui_*`) are now stripped from `input.state` before syncing to the backend session
  - Fixes "state poisoning" bug where the second and subsequent HITL tool calls in a session would fail because the frontend sent back stale remap data that overwrote the fresh remap stored during the current run
  - Defines `_INTERNAL_STATE_KEYS` frozenset for clear, maintainable separation of backend-managed vs user-visible state

## [0.5.0] - 2026-02-16

### Added

- **NEW**: Streaming function call arguments support for Gemini 3+ models via Vertex AI (#822)
  - Enables real-time streaming of `TOOL_CALL_ARGS` events as the model generates function call arguments incrementally
  - Activated via `streaming_function_call_arguments=True` on `ADKAgent` / `ADKAgent.from_app()`
  - Requires `google-adk >= 1.24.0` (version-gated; emits a warning and disables on older versions)
  - Requires `stream_function_call_arguments=True` in the model's `GenerateContentConfig` and SSE streaming mode
  - JSON deltas are emitted as concatenable fragments: clients join all `TOOL_CALL_ARGS.delta` values to reconstruct the complete arguments JSON
  - Integrates with predictive state updates: `PredictState` CustomEvents are emitted before `TOOL_CALL_START` for configured tools
  - New `stream_tool_call` field on `PredictStateMapping` defers `TOOL_CALL_END` for LRO/HITL workflows
  - Final aggregated (non-partial) events are automatically suppressed to prevent duplicate tool call emissions
  - Confirmed function call IDs are remapped to the streaming ID so `TOOL_CALL_RESULT` uses a consistent ID
  - No upstream monkey-patches or workarounds required (google/adk-python#4311 is fixed in ADK 1.24.0)

### Deprecated

- **DEPRECATED**: Non-resumable (fire-and-forget) HITL flow via `ADKAgent(adk_agent=...)` with client-side tools
  - A `DeprecationWarning` is now emitted at runtime when the old-style HITL early-return path is triggered
  - Use `ADKAgent.from_app()` with `ResumabilityConfig(is_resumable=True)` for human-in-the-loop workflows
  - The direct constructor remains fully supported for agents without client-side tools (chat-only, backend-tool-only)
  - See [USAGE.md](./USAGE.md#migrating-to-resumable-hitl) for migration instructions

### Breaking Changes

- **BREAKING**: AG-UI client tools are no longer automatically included in the root agent's toolset (#903)
  - You must now explicitly add `AGUIToolset` to your agent's tools list to access AG-UI client tools
  - Tool name conflicts are no longer automatically resolved by removing AG-UI tools
  - New `AGUIToolset` class provides explicit control over tool inclusion with `tool_filter` and `tool_name_prefix` parameters
  - This change enables proper support for Orchestrator-style ADK agents where sub-agents need access to client tools
  - **See the [Migration Guide](./README.md#migrating-from-v04x) in README.md for upgrade instructions**
  - Huge thanks to **@jplikesbikes** for this contribution!

### Security

- Upgrade vulnerable transitive dependencies: aiohttp (3.13.3), urllib3 (2.6.3), authlib (1.6.6), pyasn1 (0.6.2), mcp (1.25.0), fastapi (0.128.0), starlette (0.49.3)

### Fixed

- **FIXED**: Thought parts separated from text in message history (#1110, #1118, #1124)
  - `adk_events_to_messages()` was concatenating thought parts (Part.thought=True) with regular text into a single AssistantMessage.content string, causing internal model reasoning to leak into the visible chat when users reloaded sessions
  - Thought parts are now emitted as ReasoningMessage (role="reasoning") before the AssistantMessage, matching the live streaming behavior where THINKING_* events are already separated from TEXT_MESSAGE events
  - Thanks to **@lakshminarasimmanv** for identifying and fixing this issue!
- **FIXED**: Duplicate function_response events when using LongRunningFunctionTool (#1074, #1075)
  - Eliminated duplicate function_response events that were persisted to session database with different invocation_ids
  - Fix works for all agent types (simple LlmAgent and composite SequentialAgent/LoopAgent)
  - Maintains correct invocation_id from client's run_id for DatabaseSessionService compatibility
  - Preserves HITL resumption functionality for composite agents
  - Supports stateless client patterns that re-send full message history
  - Thanks to **@bajayo** for identifying the issue, providing comprehensive tests (529 lines!), and implementing the initial fix
  - Regression fix ensures compatibility across all agent types and usage patterns

- **FIXED**: Invocation ID handling for HITL resumption with composite agents (#1080)
  - Fixed "No agent to transfer to" errors when resuming after HITL pauses by conditionally passing `invocation_id` based on root agent type
  - Composite orchestrators (SequentialAgent, LoopAgent) now correctly receive `invocation_id` in `run_async()` to restore internal state on HITL resumption
  - Standalone LlmAgents and LlmAgents with transfer targets no longer receive `invocation_id`, preventing ValueError in `_get_subagent_to_resume()`
  - Deferred `invocation_id` storage to post-run lifecycle to avoid stale session errors with DatabaseSessionService
  - Tool result submissions with trailing user messages now work correctly without causing ADK resumption errors
  - Thanks to **@lakshminarasimmanv** for this comprehensive fix!
- **FIXED**: Reload session on cache miss to populate events (#1021)
  - `_find_session_by_thread_id()` uses `list_sessions()` which returns metadata only; now reloads via `get_session()` after a cache miss so that session events are available
  - Thanks to **@lakshminarasimmanv** for this fix!
- **FIXED**: Duplicate TOOL_CALL event emission for client-side tools with ResumabilityConfig
  - With `ResumabilityConfig(is_resumable=True)`, ADK emits the same function call from up to
    three sources (LRO event, confirmed event with a different ID, and ClientProxyTool execution),
    causing the frontend to render tool call results (e.g., HITL task lists) multiple times
  - EventTranslator now accepts `client_tool_names` to skip emission for tools owned by
    `ClientProxyTool`, letting the proxy be the sole emitter for client-side tools
  - Bidirectional ID tracking between EventTranslator and ClientProxyTool prevents duplicates
    regardless of execution order
  - Added 12 regression tests covering LRO, confirmed, partial, and mixed tool call scenarios
- **FIXED**: Relax Python version constraint to allow Python 3.14 (#973)
  - Changed `requires-python` from `>=3.9, <3.14` to `>=3.10, <3.15`
  - Fixed `asyncio.get_event_loop()` deprecation in tests for Python 3.14 compatibility
  - Added `asyncio.timeout` compatibility shim for Python 3.10 in tests
- **FIXED**: LRO tool call events now emitted for resumable agents on all ADK versions
  - Previously, `_is_adk_resumable()` skipped `translate_lro_function_calls` entirely, expecting client_proxy_tool to emit events — this didn't work on ADK < 1.22.0
  - Now always emits TOOL_CALL_START/ARGS/END for LRO tools; only the early loop exit is gated on non-resumable agents
- **FIXED**: Stale `pending_tool_calls` no longer block session cleanup after middleware restart (#1051)
  - When a middleware instance restarts, the in-memory `_session_lookup_cache` is lost but `pending_tool_calls` persists in the database, causing sessions to accumulate indefinitely
  - Now clears `pending_tool_calls` when resuming a session after a cache miss (indicating middleware restart or failover)
  - **Note**: This fix assumes sticky sessions (session affinity) are configured at the load balancer level for multi-pod deployments with `DatabaseSessionService`. Without sticky sessions, cache misses are frequent and could prematurely clear valid pending tool calls from active HITL workflows.
  - Thanks to **@lakshminarasimmanv** for identifying and fixing this issue!
- **FIXED**: Agent events not persisted to session with `LongRunningFunctionTool` in SSE streaming mode (#1059)
  - With SSE streaming enabled (default), ADK yields `partial=True` events (not persisted) then `partial=False` events (persisted)
  - Previously, the middleware returned early when detecting LRO tools, abandoning the runner's async generator before the final non-partial event was consumed, causing ADK to never persist the agent's response
  - Now continues consuming events until a non-partial event is received, allowing ADK's natural persistence mechanism to complete
  - Thanks to **@bajayo** for reporting and fixing this issue!

## [0.4.2] - 2026-01-22

### Added
- **NEW**: Native support for `RunAgentInput.context` in ADK agents (#959)
  - Context from AG-UI is automatically stored in session state under `_ag_ui_context` key
  - Accessible in tools via `tool_context.state.get(CONTEXT_STATE_KEY, [])`
  - Accessible in instruction providers via `ctx.state.get(CONTEXT_STATE_KEY, [])`
  - For ADK 1.22.0+, context is also available via `RunConfig.custom_metadata['ag_ui_context']`
  - Follows the pattern established by LangGraph's context handling for cross-framework consistency
  - `CONTEXT_STATE_KEY` constant exported from package for easy access
  - See `examples/other/context_usage.py` for usage examples
- **NEW**: Convert Gemini thought summaries to AG-UI THINKING events (#951)
  - When using `ThinkingConfig(include_thoughts=True)` with Gemini 2.5+ models, thought summaries are now emitted as THINKING events
  - Backwards-compatible: gracefully degrades on older google-genai SDK versions without the `part.thought` attribute
  - No dependency version bumps required - works with existing `google-adk>=1.14.0`
  - Emits proper event sequence: `THINKING_START` → `THINKING_TEXT_MESSAGE_START/CONTENT/END` → `THINKING_END`
  - Thinking streams are properly closed when transitioning to regular text output
- **NEW**: Fine-grained session cleanup configuration via `delete_session_on_cleanup` and `save_session_to_memory_on_cleanup` parameters (#927)
  - Splits the previous `auto_cleanup` behavior into two independent controls
  - `delete_session_on_cleanup`: Controls whether sessions are deleted from ADK SessionService during cleanup (default: `True`)
  - `save_session_to_memory_on_cleanup`: Controls whether sessions are saved to MemoryService before cleanup (default: `True`)
  - Sessions with `pending_tool_calls` are preserved even when `delete_session_on_cleanup=True`
  - Parameters exposed on `ADKAgent` constructor and `ADKAgent.from_app()` classmethod
  - Thanks to @jplikesbikes for the contribution
- **NEW**: Flexible request state extraction in FastAPI endpoints (#925)
  - Added `extract_state` parameter to `add_adk_fastapi_endpoint()` and `create_adk_app()` for custom state extraction from requests
  - Enables extraction of request attributes beyond just headers (e.g., cookies, query params, authentication info)
  - `extract_headers` parameter has been marked for deprecation in favor of `extract_state`
  - Thanks to @jplikesbikes for the contribution
- **NEW**: `add_adk_fastapi_endpoint()` now accepts both `FastAPI` and `APIRouter` objects (#932)
  - Enables better organization of large FastAPI codebases by allowing routes to be added to APIRouters
  - The `app` parameter now accepts `FastAPI | APIRouter` types
  - Note: Using APIRouter may result in different validation error response codes (500 instead of 422 in some edge cases)
  - Thanks to @jplikesbikes for the contribution

### Fixed
- **FIXED**: Duplicate `TOOL_CALL_START` events with google-adk >= 1.22.0 (issue #968)
  - google-adk 1.22.0 enables `PROGRESSIVE_SSE_STREAMING` by default, which sends function call "previews" in partial events
  - The middleware now skips function calls from `partial=True` events, only processing confirmed calls (`partial=False`)
  - Backwards-compatible: uses `getattr(adk_event, 'partial', False)` for older google-adk versions without the attribute
- **FIXED**: `DatabaseSessionService` compatibility for HITL (human-in-the-loop) tool workflows (issue #957)
  - Added `invocation_id` to FunctionResponse events - required by `DatabaseSessionService` for event tracking
  - Session is now refreshed after `update_session_state` to prevent "stale session" errors from optimistic locking
  - Both code paths (tool results with user message, and tool results only) now properly persist events
  - Thanks to @lakshminarasimmanv for the contribution
- **FIXED**: Text message events not emitted when non-streaming response includes client function call (issue #906)
  - In non-streaming mode, when an ADK event contained both text and an LRO (long-running) tool call, text was skipped entirely
  - Added `translate_text_only()` method to EventTranslator to handle text extraction for LRO events
  - Modified LRO routing in ADKAgent to emit TEXT_MESSAGE events before TOOL_CALL events
- **FIXED**: `adk_events_to_messages()` not converting assistant messages from DatabaseSessionService (issue #905)
  - ADK agents set `author` to the agent's name (e.g., "my_agent"), not "model"
  - Previous check for `author == "model"` caused assistant messages to be silently dropped
  - Now treats any non-"user" author as an assistant message

## [0.4.1] - 2026-01-06

### Added
- **NEW**: Multimodal message support for user messages with inline base64-encoded binary data (#864)
  - `convert_message_content_to_parts()` function converts AG-UI `TextInputContent` and `BinaryInputContent` to ADK `types.Part` objects
  - Supports `image/png`, `image/jpeg`, and other MIME types via `inline_data` with base64-decoded bytes
  - Gracefully ignores unsupported binary content (URL-only, id-only references) with warnings
  - Invalid base64 data is logged and skipped without crashing
- **NEW**: Integration tests for multimodal input handling (`test_from_app_with_valid_mime_type`, `test_from_app_with_unsupported_mime_type`)
- **NEW**: Unit tests for multimodal content conversion in `test_utils_converters.py`
- **NEW**: `ADKAgent.from_app()` classmethod for creating agents from ADK App instances (#844)
  - Enables access to App-level features: plugins, resumability, context caching, events compaction
  - Creates per-request App copies with modified agents using `model_copy()` to preserve all configs
  - Includes `plugin_close_timeout` parameter (requires ADK 1.19+, silently ignored on older versions)
  - Runtime detection of ADK version capabilities for forward compatibility
- **NEW**: Integration tests for `from_app()` functionality (`test_from_app_integration.py`)
- **DOCUMENTATION**: Added "Using App for Full ADK Features" section to USAGE.md

### Changed
- **IMPROVED**: Message content conversion now uses `convert_message_content_to_parts()` for multimodal support in `_convert_latest_user_message()` and `convert_ag_ui_messages_to_adk()`

### Fixed
- **FIXED**: Thread ID to Session ID mapping for VertexAI session services (#870)
  - AG-UI `thread_id` is now transparently mapped to ADK `session_id` (which may differ, e.g., VertexAI generates numeric IDs)
  - Backend session IDs never leak to frontend AG-UI events - all events use the original `thread_id`
  - Session state stores metadata (`_ag_ui_thread_id`, `_ag_ui_app_name`, `_ag_ui_user_id`) for recovery after middleware restarts
  - `/agents/state` endpoint now accepts optional `appName` and `userId` parameters for explicit session lookup
  - Processed message tracking now uses `thread_id` as key for consistency

## [0.4.0] - 2025-12-14

### Added
- **NEW**: Message history retrieval via `adk_events_to_messages()` function to convert ADK session events to AG-UI messages (#640)
- **NEW**: `emit_messages_snapshot` flag on ADKAgent for optional MESSAGES_SNAPSHOT emission at run end (default: false)
- **NEW**: Experimental `/agents/state` POST endpoint for on-demand thread state and message history retrieval (#640)
- **NEW**: HTTP header extraction support in FastAPI endpoint via `extract_headers` parameter (#740)
- **NEW**: Predictive state updates support for ADK middleware
- **NEW**: Agentic generative UI agent example (`agentic_generative_ui`)
- **NEW**: Comprehensive live server integration tests using uvicorn

### Fixed
- **FIXED**: Client-side tool results now persist to ADK session database for proper history tracking
- **FIXED**: Improved duplicate detection for Claude and accumulated text streams
- **FIXED**: Historical tool results no longer re-processed on replay
- **FIXED**: Skip consolidated text during streaming to prevent duplicates (issue #742)
- **FIXED**: Route `skip_summarization` events through `translate()` for proper ToolCallResult emission (issue #765)
- **FIXED**: Emit final text response after backend tool completion
- **FIXED**: Filter synthetic `confirm_changes` tool results in ADK middleware
- **FIXED**: Improved event handling and HITL tool processing
- **FIXED**: Prevent duplicate tool calls when processing tool results
- **FIXED**: Multi-turn conversation failure with None user_message (issue #769)
- **FIXED**: Filter empty text events to prevent frontend crash

### Enhanced
- **TESTING**: Added multi-turn conversation tests (issue #769)
- **TESTING**: Added comprehensive tests for message history features including live server tests
- **DOCUMENTATION**: Document thread_id to session_id mapping and initial state handling

## [0.3.6] - 2025-11-20

### Fixed
- Version bump for PyPI publishing

## [0.3.5] - 2025-11-18

### Fixed
- Multi-turn conversation failure with None user_message (issue #769)

## [0.3.4] - 2025-11-15

### Fixed
- Event handling and HITL tool processing improvements
- Duplicate tool call prevention when processing tool results

## [0.3.3] - 2025-11-14

### Added
- **Transcript tracking**: ADKAgent now replays unseen transcript messages sequentially and keeps per-session ledgers of processed message IDs so system/user/assistant content is never dropped when HITL tool results arrive out of order.
- **Tool result validation**: Tool result batches are now checked against pending tool call IDs before being forwarded, and skipped batches are marked processed to prevent repeated replays.
- **State snapshots**: EventTranslator surfaces ADK `state_snapshot` payloads as AG-UI `StateSnapshotEvent`s so clients receive full session dumps alongside deltas.

### Changed
- **Message conversion**: `flatten_message_content()` now flattens `TextInputContent`/`BinaryInputContent` payloads before building ADK `Content` objects, allowing complex UI messages to flow through unchanged.
- **Protocol dependency**: Minimum `ag-ui-protocol` version was bumped to `0.1.10` to align with the new event surface area.
- **Noise reduction**: Removed verbose diagnostic logging around event translation and stream handling while adding duplicate tool call detection to keep logs actionable.

### Fixed
- **Tool flows**: Guarding tool batches that have no matching pending tool calls eliminates spurious run errors and keeps processed message IDs consistent; regression tests cover combined tool-result/user-message submissions and state snapshot passthrough.

---

## Historical Releases (from previous repository)

> **Note**: The releases below were versioned when this code resided in a separate repository.
> Version numbers were reset when the code was integrated into the ag-ui-protocol monorepo.
> These entries are preserved for historical reference.

---

## [0.6.0] - 2025-08-07

### Changed
- **CONFIG**: Made ADK middleware base URL configurable via `ADK_MIDDLEWARE_URL` environment variable in dojo app
- **CONFIG**: Added `adkMiddlewareUrl` configuration to environment variables (defaults to `http://localhost:8000`)
- **DEPENDENCIES**: Upgraded Google ADK from 1.6.1 to 1.9.0 - all 271 tests pass without modification
- **DOCUMENTATION**: Extensive documentation restructuring for improved organization and clarity

## [0.5.0] - 2025-08-05

### Breaking Changes
- **BREAKING**: ADKAgent constructor now requires `adk_agent` parameter instead of `agent_id` for direct agent embedding
- **BREAKING**: Removed AgentRegistry dependency - agents are now directly embedded in middleware instances
- **BREAKING**: Removed `agent_id` parameter from `ADKAgent.run()` method
- **BREAKING**: Endpoint registration no longer extracts agent_id from URL path
- **BREAKING**: AgentRegistry class removed from public API

### Architecture Improvements
- **ARCHITECTURE**: Eliminated AgentRegistry entirely - simplified architecture by embedding ADK agents directly
- **ARCHITECTURE**: Cleaned up agent registration/instantiation redundancy (issue #24)
- **ARCHITECTURE**: Removed confusing indirection where endpoint agent didn't determine execution
- **ARCHITECTURE**: Each ADKAgent instance now directly holds its ADK agent instance
- **ARCHITECTURE**: Simplified method signatures and removed agent lookup overhead

### Fixed
- **FIXED**: All 271 tests now pass with new simplified architecture
- **TESTS**: Updated all test fixtures to match new ADKAgent.run(input_data) signature without agent_id parameter
- **TESTS**: Fixed test expectations in test_endpoint.py to work with direct agent embedding architecture
- **TESTS**: Updated all test fixtures to work with new agent embedding pattern
- **EXAMPLES**: Updated examples to demonstrate direct agent embedding pattern

### Added
- **NEW**: SystemMessage support for ADK agents (issue #22) - SystemMessages as first message are now appended to agent instructions
- **NEW**: Comprehensive tests for SystemMessage functionality including edge cases
- **NEW**: Long running tools can be defined in backend side as well
- **NEW**: Predictive state demo is added in dojo App

### Fixed  
- **FIXED**: Race condition in tool result processing causing "No pending tool calls found" warnings
- **FIXED**: Tool call removal now happens after pending check to prevent race conditions
- **IMPROVED**: Better handling of empty tool result content with graceful JSON parsing fallback
- **FIXED**: Pending tool call state management now uses SessionManager methods (issue #25)
- **FIXED**: Pending tools issue for normal backend tools is now fixed (issue #32)
- **FIXED**: TestEventTranslatorComprehensive unit test cases fixed

### Enhanced
- **LOGGING**: Added debug logging for tool result processing to aid in troubleshooting
- **ARCHITECTURE**: Consolidated agent copying logic to avoid creating multiple unnecessary copies
- **CLEANUP**: Removed unused toolset parameter from `_run_adk_in_background` method
- **REFACTOR**: Replaced direct session service access with SessionManager state management methods for pending tool calls

## [0.4.1] - 2025-07-13

### Fixed
- **CRITICAL**: Fixed memory persistence across sessions by ensuring consistent user ID extraction
- **CRITICAL**: Fixed ADK tool call ID mapping to prevent mismatch between ADK and AG-UI protocols

### Enhanced  
- **ARCHITECTURE**: Simplified SessionManager._delete_session() to accept session object directly, eliminating redundant lookups
- **TESTING**: Added comprehensive memory integration test suite (8 tests) for memory service functionality without requiring API keys
- **DOCUMENTATION**: Updated README with memory tools integration guidance and testing configuration instructions

### Added
- Memory integration tests covering service initialization, sharing, and cross-session persistence
- PreloadMemoryTool import support in FastAPI server examples
- Documentation for proper tool placement on ADK agents vs middleware

### Technical Improvements
- Consistent user ID generation for memory testing ("test_user" instead of dynamic anonymous IDs)
- Optimized session deletion to use session objects directly
- Enhanced tool call ID extraction from ADK context for proper protocol bridging
- Cleaned up debug logging statements throughout codebase


## [0.4.0] - 2025-07-11

### Bug Fixes
- **CRITICAL**: Fixed tool result accumulation causing Gemini API errors about function response count mismatch
- **FIXED**: `_extract_tool_results()` now only extracts the most recent tool message instead of all tool messages from conversation history
- **RELIABILITY**: Prevents multiple tool responses being passed to Gemini when only one function call is expected

### Major Architecture Change
- **BREAKING**: Simplified to all-long-running tool execution model, removing hybrid blocking/long-running complexity
- **REMOVED**: Eliminated blocking tool execution mode - all tools now use long-running behavior for consistency
- **REMOVED**: Removed tool futures, execution resumption, and hybrid execution state management
- **REMOVED**: Eliminated per-tool execution mode configuration (`tool_long_running_config`)

### Simplified Architecture
- **SIMPLIFIED**: `ClientProxyTool` now always returns `None` immediately after emitting events, wrapping `LongRunningFunctionTool` for proper ADK behavior
- **SIMPLIFIED**: `ClientProxyToolset` constructor simplified - removed `is_long_running` and `tool_futures` parameters
- **SIMPLIFIED**: `ExecutionState` cleaned up - removed tool future resolution and hybrid execution logic
- **SIMPLIFIED**: `ADKAgent.run()` method streamlined - removed commented hybrid model code
- **IMPROVED**: Agent tool combination now uses `model_copy()` to avoid mutating original agent instances

### Human-in-the-Loop (HITL) Support
- **NEW**: Session-based pending tool call tracking for HITL scenarios using ADK session state
- **NEW**: Sessions with pending tool calls are preserved during cleanup (no timeout for HITL workflows)
- **NEW**: Automatic tool call tracking when tools emit events and tool response tracking when results are received
- **NEW**: Standalone tool result handling - tool results without active executions start new executions
- **IMPROVED**: Session cleanup logic now checks for pending tool calls before deletion, enabling indefinite HITL workflows

### Enhanced Testing
- **TESTING**: Comprehensive test suite refactored for all-long-running architecture
- **TESTING**: 272 tests passing with 93% overall code coverage (increased from previous 269 tests)
- **TESTING**: Added comprehensive HITL tool call tracking tests (`test_tool_tracking_hitl.py`)
- **TESTING**: Removed obsolete test files for hybrid functionality (`test_hybrid_flow_integration.py`, `test_execution_resumption.py`)
- **TESTING**: Fixed all integration tests to work with simplified architecture and HITL support
- **TESTING**: Updated tool result flow tests to handle new standalone tool result behavior

### Performance & Reliability
- **PERFORMANCE**: Eliminated complex execution state tracking and tool future management overhead
- **RELIABILITY**: Removed potential deadlocks and race conditions from hybrid execution model
- **CONSISTENCY**: All tools now follow the same execution pattern, reducing cognitive load and bugs

### Technical Architecture (HITL)
- **Session State**: Pending tool calls tracked in ADK session state via `session.state["pending_tool_calls"]` array
- **Event-Driven Tracking**: `ToolCallEndEvent` events automatically add tool calls to pending list via `append_event()` with `EventActions.stateDelta`
- **Result Processing**: `ToolMessage` responses automatically remove tool calls from pending list with proper ADK session persistence
- **Session Persistence**: Sessions with pending tool calls bypass timeout-based cleanup for indefinite HITL workflows
- **Standalone Results**: Tool results without active executions start new ADK executions for proper session continuity
- **State Persistence**: Uses ADK's `append_event()` with `EventActions(stateDelta={})` for proper session state persistence

### Breaking Changes
- **API**: `ClientProxyToolset` constructor no longer accepts `is_long_running`, `tool_futures`, or `tool_long_running_config` parameters
- **BEHAVIOR**: All tools now behave as long-running tools - emit events and return `None` immediately
- **BEHAVIOR**: Standalone tool results now start new executions instead of being silently ignored
- **TESTING**: Test expectations updated for all-long-running behavior and HITL support

### Merged from adk-middleware (PR #7)
- **TESTING**: Comprehensive test coverage improvements - fixed all failing tests across the test suite
- **MOCK CONTEXT**: Added proper mock_tool_context fixtures to fix pydantic validation errors in test files
- **TOOLSET CLEANUP**: Fixed ClientProxyToolset.close() to properly cancel pending futures and clear resources
- **EVENT STREAMING**: Updated tests to expect RUN_FINISHED events that are now automatically emitted by enhanced _stream_events method
- **TEST SIGNATURES**: Fixed mock function signatures to match updated _stream_events method parameters (execution, run_id)
- **TOOL RESULT FLOW**: Updated tests to account for RunStartedEvent being emitted for tool result submissions
- **ERROR HANDLING**: Fixed malformed tool message test to correctly expect graceful handling of empty content (not errors)
- **ARCHITECTURE**: Enhanced toolset resource management - toolsets now properly clean up blocking tool futures on close
- **TEST RELIABILITY**: Improved test isolation and mock context consistency across all test files
- **TESTING**: Improved test coverage to 93% overall with comprehensive unit tests for previously untested modules
- **COMPLIANCE**: Tool execution now fully compliant with ADK behavioral expectations
- **OBSERVABILITY**: Enhanced logging for tool call ID tracking and validation throughout execution flow

### Error Handling Improvements
- **ENHANCED**: Better tool call ID mismatch detection with warnings when tool results don't match pending tools
- **ENHANCED**: Improved JSON parsing error handling with detailed error information including line/column numbers
- **ENHANCED**: More specific error codes for better debugging and error reporting
- **ENHANCED**: Better error messages in tool result processing with specific failure reasons

## [0.3.3] - 2025-11-14

### Added
- **Transcript tracking**: ADKAgent now replays unseen transcript messages sequentially and keeps per-session ledgers of processed message IDs so system/user/assistant content is never dropped when HITL tool results arrive out of order.
- **Tool result validation**: Tool result batches are now checked against pending tool call IDs before being forwarded, and skipped batches are marked processed to prevent repeated replays.
- **State snapshots**: EventTranslator surfaces ADK `state_snapshot` payloads as AG-UI `StateSnapshotEvent`s so clients receive full session dumps alongside deltas.

### Changed
- **Message conversion**: `flatten_message_content()` now flattens `TextInputContent`/`BinaryInputContent` payloads before building ADK `Content` objects, allowing complex UI messages to flow through unchanged.
- **Protocol dependency**: Minimum `ag-ui-protocol` version was bumped to `0.1.10` to align with the new event surface area.
- **Noise reduction**: Removed verbose diagnostic logging around event translation and stream handling while adding duplicate tool call detection to keep logs actionable.

### Fixed
- **Tool flows**: Guarding tool batches that have no matching pending tool calls eliminates spurious run errors and keeps processed message IDs consistent; regression tests cover combined tool-result/user-message submissions and state snapshot passthrough.

## [0.3.2] - 2025-07-08

### Added
- **NEW**: Hybrid tool execution model bridging AG-UI's stateless runs with ADK's stateful execution
- **NEW**: Per-tool execution mode configuration via `tool_long_running_config` parameter in `ClientProxyToolset`
- **NEW**: Mixed execution mode support - combine long-running and blocking tools in the same toolset
- **NEW**: Execution resumption functionality using `ToolMessage` for paused executions
- **NEW**: 13 comprehensive execution resumption tests covering hybrid model core functionality
- **NEW**: 13 integration tests for complete hybrid flow with minimal mocking
- **NEW**: Comprehensive documentation for hybrid tool execution model in README.md and CLAUDE.md
- **NEW**: `test_toolset_mixed_execution_modes()` - validates per-tool configuration functionality

### Enhanced
- **ARCHITECTURE**: `ClientProxyToolset` now supports per-tool `is_long_running` configuration
- **TESTING**: Expanded test suite to 185 tests with comprehensive coverage of both execution modes
- **DOCUMENTATION**: Added detailed hybrid execution flow examples and technical implementation guides
- **FLEXIBILITY**: Tools can now be individually configured for different execution behaviors within the same toolset

### Fixed
- **BEHAVIOR**: Improved timeout behavior for mixed execution modes
- **INTEGRATION**: Enhanced integration test reliability for complex tool scenarios
- **RESOURCE MANAGEMENT**: Better cleanup of tool futures and execution state across execution modes

### Technical Architecture
- **Hybrid Model**: Solves architecture mismatch between AG-UI's stateless runs and ADK's stateful execution
- **Tool Futures**: Enhanced `asyncio.Future` management for execution resumption across runs
- **Per-Tool Config**: `Dict[str, bool]` mapping enables granular control over tool execution modes
- **Execution State**: Improved tracking of paused executions and tool result resolution
- **Event Flow**: Maintains proper AG-UI protocol compliance during execution pause/resume cycles

### Breaking Changes
- **API**: `ClientProxyToolset` constructor now accepts `tool_long_running_config` parameter
- **BEHAVIOR**: Default tool execution mode remains `is_long_running=True` for backward compatibility

## [0.3.1] - 2025-07-08

### Added
- **NEW**: Tool-based generative UI demo for ADK in dojo application
- **NEW**: Multiple ADK agent support via `add_adk_fastapi_endpoint()` with proper agent_id handling
- **NEW**: Human-in-the-loop (HITL) support for long-running tools - `ClientProxyTool` with `is_long_running=True` no longer waits for tool responses
- **NEW**: Comprehensive test coverage for `is_long_running` functionality in `ClientProxyTool`
- **NEW**: `test_client_proxy_tool_long_running_no_timeout()` - verifies long-running tools ignore timeout settings
- **NEW**: `test_client_proxy_tool_long_running_vs_regular_timeout_behavior()` - compares timeout behavior between regular and long-running tools
- **NEW**: `test_client_proxy_tool_long_running_cleanup_on_error()` - ensures proper cleanup on event emission errors
- **NEW**: `test_client_proxy_tool_long_running_multiple_concurrent()` - tests multiple concurrent long-running tools
- **NEW**: `test_client_proxy_tool_long_running_event_emission_sequence()` - validates correct event emission order
- **NEW**: `test_client_proxy_tool_is_long_running_property()` - tests property access and default values

### Fixed
- **CRITICAL**: Fixed `agent_id` handling in `ADKAgent` wrapper to support multiple ADK agents properly
- **BEHAVIOR**: Disabled automatic tool response waiting in `ClientProxyTool` when `is_long_running=True` for HITL workflows

### Enhanced
- **ARCHITECTURE**: Long-running tools now properly support human-in-the-loop patterns where responses are provided by users
- **SCALABILITY**: Multiple ADK agents can now be deployed simultaneously with proper isolation
- **TESTING**: Enhanced test suite with 6 additional test cases specifically covering long-running tool behavior

### Technical Architecture
- **HITL Support**: Long-running tools emit events and return immediately without waiting for tool execution completion
- **Multi-Agent**: Proper agent_id management enables multiple ADK agents in single FastAPI application
- **Tool Response Flow**: Regular tools wait for responses, long-running tools delegate response handling to external systems
- **Event Emission**: All tools maintain proper AG-UI protocol compliance regardless of execution mode

## [0.3.0] - 2025-07-07

### Added
- **NEW**: Complete bidirectional tool support enabling AG-UI Protocol tools to execute within Google ADK agents
- **NEW**: `ExecutionState` class for managing background ADK execution with tool futures and event queues
- **NEW**: `ClientProxyTool` class that bridges AG-UI tools to ADK tools with proper event emission
- **NEW**: `ClientProxyToolset` class for dynamic toolset creation from `RunAgentInput.tools`
- **NEW**: Background execution support via asyncio tasks with proper timeout management
- **NEW**: Tool future management system for asynchronous tool result delivery
- **NEW**: Comprehensive timeout configuration: execution-level (600s default) and tool-level (300s default)
- **NEW**: Concurrent execution limits with configurable maximum concurrent executions and automatic cleanup
- **NEW**: 138+ comprehensive tests covering all tool support scenarios with 100% pass rate
- **NEW**: Advanced test coverage for tool timeouts, concurrent limits, error handling, and integration flows
- **NEW**: Production-ready error handling with proper resource cleanup and timeout management

### Enhanced
- **ARCHITECTURE**: ADK agents now run in background asyncio tasks while client handles tools asynchronously
- **OBSERVABILITY**: Enhanced logging throughout tool execution flow with detailed event tracking
- **SCALABILITY**: Configurable concurrent execution limits prevent resource exhaustion

### Technical Architecture
- **Tool Execution Flow**: AG-UI RunAgentInput → ADKAgent.run() → Background execution → ClientProxyTool → Event emission → Tool result futures
- **Event Communication**: Asynchronous event queues for communication between background execution and tool handler
- **Tool State Management**: ExecutionState tracks asyncio tasks, event queues, tool futures, and execution timing
- **Protocol Compliance**: All tool events follow AG-UI protocol specifications (TOOL_CALL_START, TOOL_CALL_ARGS, TOOL_CALL_END)
- **Resource Management**: Automatic cleanup of expired executions, futures, and background tasks
- **Error Propagation**: Comprehensive error handling with proper exception propagation and resource cleanup

### Breaking Changes
- **BEHAVIOR**: `ADKAgent.run()` now supports background execution when tools are provided
- **API**: Added `submit_tool_result()` method for delivering tool execution results
- **API**: Added `get_active_executions()` method for monitoring background executions
- **TIMEOUTS**: Added `tool_timeout_seconds` and `execution_timeout_seconds` parameters to ADKAgent constructor

## [0.2.1] - 2025-07-06

### Changed
- **SIMPLIFIED**: Converted from custom component logger system to standard Python logging
- **IMPROVED**: Logging configuration now uses Python's built-in `logging.getLogger()` pattern
- **STREAMLINED**: Removed proprietary `logging_config.py` module and related complexity
- **STANDARDIZED**: All modules now follow Python community best practices for logging
- **UPDATED**: Documentation (LOGGING.md) with standard Python logging examples

### Removed
- Custom `logging_config.py` module (replaced with standard Python logging)
- `configure_logging.py` interactive tool (no longer needed)
- `test_logging.py` (testing standard Python logging is unnecessary)

## [0.2.0] - 2025-07-06

### Added
- **NEW**: Automatic session memory option - expired sessions automatically preserved in ADK memory service
- **NEW**: Optional `memory_service` parameter in `SessionManager` for seamless session history preservation  
- **NEW**: 7 comprehensive unit tests for session memory functionality (61 total tests, up from 54)
- **NEW**: Updated default app name to "AG-UI ADK Agent" for better branding

### Changed
- **PERFORMANCE**: Enhanced session management to better leverage ADK's native session capabilities

### Added (Previous Release Features)
- **NEW**: Full pytest compatibility with standard pytest commands (`pytest`, `pytest --cov=src`)
- **NEW**: Pytest configuration (pytest.ini) with proper Python path and async support  
- **NEW**: Async test support with `@pytest.mark.asyncio` for all async test functions
- **NEW**: Test isolation with proper fixtures and session manager resets
- **NEW**: 54 comprehensive automated tests with 67% code coverage (100% pass rate)
- **NEW**: Organized all tests into dedicated tests/ directory for better project structure
- **NEW**: Default `app_name` behavior using agent name from registry when not explicitly specified
- **NEW**: Added `app_name` as required first parameter to `ADKAgent` constructor for clarity
- **NEW**: Comprehensive logging system with component-specific loggers (adk_agent, event_translator, endpoint)
- **NEW**: Configurable logging levels per component via `logging_config.py`
- **NEW**: `SessionLifecycleManager` singleton pattern for centralized session management
- **NEW**: Session encapsulation - session service now embedded within session manager
- **NEW**: Proper error handling in HTTP endpoints with specific error types and SSE fallback
- **NEW**: Thread-safe event translation with per-session `EventTranslator` instances
- **NEW**: Automatic session cleanup with configurable timeouts and limits
- **NEW**: Support for `InMemoryCredentialService` with intelligent defaults
- **NEW**: Proper streaming implementation based on ADK `finish_reason` detection
- **NEW**: Force-close mechanism for unterminated streaming messages
- **NEW**: User ID extraction system with multiple strategies (static, dynamic, fallback)
- **NEW**: Complete development environment setup with virtual environment support
- **NEW**: Test infrastructure with `run_tests.py` and comprehensive test coverage

### Changed
- **BREAKING**: `app_name` and `app_name_extractor` parameters are now optional - defaults to using agent name from registry
- **BREAKING**: `ADKAgent` constructor now requires `app_name` as first parameter
- **BREAKING**: Removed `session_service`, `session_timeout_seconds`, `cleanup_interval_seconds`, `max_sessions_per_user`, and `auto_cleanup` parameters from `ADKAgent` constructor (now managed by singleton session manager)
- **BREAKING**: Renamed `agent_id` parameter to `app_name` throughout session management for consistency
- **BREAKING**: `SessionInfo` dataclass now uses `app_name` field instead of `agent_id`
- **BREAKING**: Updated method signatures: `get_or_create_session()`, `_track_session()`, `track_activity()` now use `app_name`
- **BREAKING**: Replaced deprecated `TextMessageChunkEvent` with `TextMessageContentEvent`
- **MAJOR**: Refactored session lifecycle to use singleton pattern for global session management
- **MAJOR**: Improved event translation with proper START/CONTENT/END message boundaries
- **MAJOR**: Enhanced error handling with specific error codes and proper fallback mechanisms
- **MAJOR**: Updated dependency management to use proper package installation instead of path manipulation
- **MAJOR**: Removed hardcoded sys.path manipulations for cleaner imports

### Fixed
- **CRITICAL**: Fixed EventTranslator concurrency issues by creating per-session instances
- **CRITICAL**: Fixed session deletion to include missing `user_id` parameter
- **CRITICAL**: Fixed TEXT_MESSAGE_START ordering to ensure proper event sequence
- **CRITICAL**: Fixed session creation parameter consistency (app_name vs agent_id mismatch)
- **CRITICAL**: Fixed "SessionInfo not subscriptable" errors in session cleanup
- Fixed broad exception handling in endpoints that was silencing errors
- Fixed test validation logic for message event patterns
- Fixed runtime session creation errors with proper parameter passing
- Fixed logging to use proper module loggers instead of print statements
- Fixed event bookending to ensure messages have proper START/END boundaries

### Removed
- **DEPRECATED**: Removed custom `run_tests.py` test runner in favor of standard pytest commands

### Enhanced
- **Project Structure**: Moved all tests to tests/ directory with proper import resolution and PYTHONPATH configuration
- **Usability**: Simplified agent creation - no longer need to specify app_name in most cases
- **Performance**: Session management now uses singleton pattern for better resource utilization
- **Testing**: Comprehensive test suite with 54 automated tests and 67% code coverage (100% pass rate)
- **Observability**: Implemented structured logging with configurable levels per component
- **Error Handling**: Proper error propagation with specific error types and user-friendly messages
- **Development**: Complete development environment with virtual environment and proper dependency management
- **Documentation**: Updated README with proper setup instructions and usage examples
- **Streaming**: Improved streaming behavior based on ADK finish_reason for better real-time responses

### Technical Architecture Changes
- Implemented singleton `SessionLifecycleManager` for centralized session control
- Session service encapsulation within session manager (no longer exposed in ADKAgent)
- Per-session EventTranslator instances for thread safety
- Proper streaming detection using ADK event properties (`partial`, `turn_complete`, `finish_reason`)
- Enhanced error handling with fallback mechanisms and specific error codes
- Component-based logging architecture with configurable levels

## [0.1.0] - 2025-07-04

### Added
- Initial implementation of ADK Middleware for AG-UI Protocol
- Core `ADKAgent` class for bridging Google ADK agents with AG-UI
- Agent registry for managing multiple ADK agents
- Event translation between ADK and AG-UI protocols
- Session lifecycle management with configurable timeouts
- FastAPI integration with streaming SSE support
- Comprehensive test suite with 7 passing tests
- Example FastAPI server implementation
- Support for both in-memory and custom service implementations
- Automatic session cleanup and user session limits
- State management with JSON Patch support
- Tool call translation between protocols

### Fixed
- Import paths changed from relative to absolute for cleaner code
- RUN_STARTED event now emitted at the beginning of run() method
- Proper async context handling with auto_cleanup parameter

### Dependencies
- google-adk >= 0.1.0
- ag-ui (python-sdk)
- pydantic >= 2.0
- fastapi >= 0.100.0
- uvicorn >= 0.27.0
