/// Live integration test that exercises the Dart SDK against a running
/// ag-ui dojo (the Python `server-starter-all-features` container).
///
/// Assumes the dojo is reachable at `AGUI_DOJO_BASE_URL` (preferred) or
/// `AGUI_BASE_URL`, falling back to `http://127.0.0.1:18000` — the port the
/// docker image `ag-ui-protocol/ag-ui-server` is typically mapped to when
/// running locally (`docker run -p 18000:8000 ag-ui-protocol/ag-ui-server`).
///
/// Set `AGUI_SKIP_DOJO=1` to skip when the dojo is not running.
library;

import 'dart:io';

import 'package:ag_ui/ag_ui.dart';
import 'package:test/test.dart';

String _dojoBaseUrl() {
  return Platform.environment['AGUI_DOJO_BASE_URL'] ??
      Platform.environment['AGUI_BASE_URL'] ??
      'http://127.0.0.1:18000';
}

bool _skipDojo() {
  return Platform.environment['AGUI_SKIP_DOJO'] == '1';
}

/// Lightweight reachability probe so the test surfaces a clear skip reason
/// when the container is not running, instead of a generic socket error
/// buried inside a `TransportError` stack.
Future<bool> _dojoReachable(String baseUrl) async {
  final client = HttpClient()..connectionTimeout = const Duration(seconds: 2);
  try {
    final uri = Uri.parse('$baseUrl/openapi.json');
    final req = await client.getUrl(uri);
    final resp = await req.close().timeout(const Duration(seconds: 3));
    await resp.drain<void>();
    return resp.statusCode == 200;
  } on Object {
    return false;
  } finally {
    client.close(force: true);
  }
}

/// Assert shared lifecycle invariants that must hold for every dojo endpoint:
/// - Exactly one RUN_STARTED (first event).
/// - Exactly one RUN_FINISHED (last event).
/// - No event follows RUN_FINISHED.
/// - No RUN_ERROR on the happy path.
/// - threadId / runId echo back correctly on both bookend events.
void _assertLifecycleInvariants(
  List<BaseEvent> events,
  SimpleRunAgentInput input,
) {
  expect(events, isNotEmpty, reason: 'expected at least one event');

  // Exactly one RUN_STARTED, exactly one RUN_FINISHED.
  final starts = events.whereType<RunStartedEvent>().toList(growable: false);
  final finishes = events.whereType<RunFinishedEvent>().toList(growable: false);
  expect(starts, hasLength(1), reason: 'exactly one RUN_STARTED');
  expect(finishes, hasLength(1), reason: 'exactly one RUN_FINISHED');

  // First event is RUN_STARTED.
  expect(events.first, isA<RunStartedEvent>(),
      reason: 'first event must be RUN_STARTED');

  // RUN_FINISHED is the last event — no events follow it.
  expect(events.last, isA<RunFinishedEvent>(),
      reason: 'last event must be RUN_FINISHED');
  expect(events.indexOf(finishes.single), equals(events.length - 1),
      reason: 'RUN_FINISHED must be at the last index');

  // No RUN_ERROR on the happy path.
  expect(events.whereType<RunErrorEvent>().toList(growable: false), isEmpty,
      reason: 'no RUN_ERROR on the happy path');

  // threadId / runId echo back on RUN_STARTED.
  final started = starts.single;
  expect(started.threadId, equals(input.threadId),
      reason: 'RUN_STARTED.threadId must echo the request threadId');
  expect(started.runId, equals(input.runId),
      reason: 'RUN_STARTED.runId must echo the request runId');

  // threadId / runId echo back on RUN_FINISHED.
  final finished = finishes.single;
  expect(finished.threadId, equals(input.threadId),
      reason: 'RUN_FINISHED.threadId must echo the request threadId');
  expect(finished.runId, equals(input.runId),
      reason: 'RUN_FINISHED.runId must echo the request runId');
}

/// Assert that TOOL_CALL_* events (if any) form clean, non-interleaved groups
/// per toolCallId where each group is exactly START → ARGS* → END.
///
/// This is called for endpoints that use streaming tool calls rather than
/// MESSAGES_SNAPSHOT to deliver tool call data.
///
/// Probed endpoints that use this pattern:
/// - /predictive_state_updates: two sequential TOOL_CALL groups
/// - /human_in_the_loop: one TOOL_CALL group
void _assertToolCallGrouping(List<BaseEvent> events) {
  final toolEvents = events
      .where((e) =>
          e is ToolCallStartEvent ||
          e is ToolCallArgsEvent ||
          e is ToolCallEndEvent)
      .toList(growable: false);

  if (toolEvents.isEmpty) {
    return; // no tool calls in this stream — nothing to assert
  }

  // Build groups keyed by toolCallId.
  final groups = <String, List<BaseEvent>>{};
  for (final e in toolEvents) {
    final String id;
    if (e is ToolCallStartEvent) {
      id = e.toolCallId;
    } else if (e is ToolCallArgsEvent) {
      id = e.toolCallId;
    } else if (e is ToolCallEndEvent) {
      id = e.toolCallId;
    } else {
      continue;
    }
    (groups[id] ??= <BaseEvent>[]).add(e);
  }

  expect(groups, isNotEmpty, reason: 'expected at least one TOOL_CALL group');

  for (final entry in groups.entries) {
    final id = entry.key;
    final group = entry.value;

    expect(group.first, isA<ToolCallStartEvent>(),
        reason: 'group $id must start with TOOL_CALL_START');
    expect(group.last, isA<ToolCallEndEvent>(),
        reason: 'group $id must end with TOOL_CALL_END');
    // Every event between start and end must be TOOL_CALL_ARGS.
    for (var i = 1; i < group.length - 1; i++) {
      expect(group[i], isA<ToolCallArgsEvent>(),
          reason: 'group $id event at index $i must be TOOL_CALL_ARGS');
    }
  }

  // Assert no cross-id interleaving: scan the raw tool-call event list and
  // verify that once we've seen an END for an id, we never see a START/ARGS
  // for that id again (which would mean interleaved groups).
  final closed = <String>{};
  String? openId;
  for (final e in toolEvents) {
    if (e is ToolCallStartEvent) {
      expect(closed, isNot(contains(e.toolCallId)),
          reason: 'toolCallId ${e.toolCallId} reused after END — interleave detected');
      openId = e.toolCallId;
    } else if (e is ToolCallArgsEvent) {
      expect(e.toolCallId, equals(openId),
          reason: 'TOOL_CALL_ARGS for ${e.toolCallId} while $openId is open — interleave detected');
    } else if (e is ToolCallEndEvent) {
      closed.add(e.toolCallId);
      openId = null;
    }
  }
}

void main() {
  group('AG-UI Dojo smoke (docker)', () {
    final baseUrl = _dojoBaseUrl();
    late bool reachable;

    setUpAll(() async {
      reachable = !_skipDojo() && await _dojoReachable(baseUrl);
      if (!reachable) {
        // ignore: avoid_print
        print('[dojo_smoke_test] Dojo not reachable at $baseUrl — '
            'tests will be skipped. Start the container with:\n'
            '  docker run --rm -p 18000:8000 ag-ui-protocol/ag-ui-server');
      }
    });

    // =========================================================================
    // agentic_chat
    // =========================================================================

    test('agentic_chat streams RUN_STARTED → text events → RUN_FINISHED',
        () async {
      if (!reachable) {
        return markTestSkipped('dojo not reachable');
      }

      final client = AgUiClient(
        config: AgUiClientConfig(baseUrl: baseUrl),
      );

      try {
        final input = SimpleRunAgentInput(
          threadId: 'dojo-smoke-thread',
          runId: 'dojo-smoke-run-${DateTime.now().millisecondsSinceEpoch}',
          messages: [
            UserMessage(id: 'u1', content: 'hello dojo'),
          ],
          tools: const [],
          context: const [],
          state: const <String, dynamic>{},
        );

        final events = <BaseEvent>[];
        await for (final event in client
            .runAgenticChat(input)
            .timeout(const Duration(seconds: 30))) {
          events.add(event);
        }

        // --- Lifecycle invariants (strengthened) ---
        _assertLifecycleInvariants(events, input);

        // --- Text message sub-protocol ---
        final starts =
            events.whereType<TextMessageStartEvent>().toList(growable: false);
        final ends =
            events.whereType<TextMessageEndEvent>().toList(growable: false);
        final contents =
            events.whereType<TextMessageContentEvent>().toList(growable: false);

        expect(starts, hasLength(1),
            reason: 'expect a single TEXT_MESSAGE_START');
        expect(ends, hasLength(1), reason: 'expect a single TEXT_MESSAGE_END');
        expect(contents, isNotEmpty,
            reason: 'expect at least one TEXT_MESSAGE_CONTENT delta');

        // All three text events share the same messageId.
        final messageId = starts.single.messageId;
        for (final c in contents) {
          expect(c.messageId, equals(messageId),
              reason: 'all content deltas share the start messageId');
        }
        expect(ends.single.messageId, equals(messageId));

        // Accumulated body contains the agent's signature countdown.
        final body = contents.map((c) => c.delta).join();
        expect(body, contains('counting down'),
            reason: 'agentic_chat agent emits a countdown intro');
      } finally {
        await client.close();
      }
    }, skip: _skipDojo() ? 'AGUI_SKIP_DOJO=1' : null);

    // =========================================================================
    // tool_based_generative_ui
    // =========================================================================

    test('tool_based_generative_ui emits MESSAGES_SNAPSHOT with a tool call',
        () async {
      if (!reachable) {
        return markTestSkipped('dojo not reachable');
      }

      final client = AgUiClient(
        config: AgUiClientConfig(baseUrl: baseUrl),
      );

      try {
        final input = SimpleRunAgentInput(
          threadId: 'dojo-smoke-tool-thread',
          runId:
              'dojo-smoke-tool-run-${DateTime.now().millisecondsSinceEpoch}',
          messages: [
            UserMessage(id: 'u1', content: 'draw a haiku tree'),
          ],
          tools: const [
            Tool(
              name: 'generate_haiku',
              description: 'Generate a haiku',
              parameters: {
                'type': 'object',
                'properties': {
                  'japanese': {
                    'type': 'array',
                    'items': {'type': 'string'},
                  },
                  'english': {
                    'type': 'array',
                    'items': {'type': 'string'},
                  },
                },
              },
            ),
          ],
          context: const [],
          state: const <String, dynamic>{},
        );

        final events = <BaseEvent>[];
        await for (final event in client
            .runToolBasedGenerativeUi(input)
            .timeout(const Duration(seconds: 30))) {
          events.add(event);
        }

        // --- Lifecycle invariants (strengthened) ---
        _assertLifecycleInvariants(events, input);

        // --- MESSAGES_SNAPSHOT path ---
        // Observed via curl: this endpoint emits only MESSAGES_SNAPSHOT (not
        // TOOL_CALL_* streaming events). The snapshot carries the assistant
        // message with toolCalls populated. TOOL_CALL_* events are not present
        // in this image's response for this endpoint.
        final snapshots = events
            .whereType<MessagesSnapshotEvent>()
            .toList(growable: false);
        expect(snapshots, isNotEmpty,
            reason: 'tool_based_generative_ui emits a MESSAGES_SNAPSHOT');

        final assistant = snapshots.last.messages
            .whereType<AssistantMessage>()
            .toList(growable: false);
        expect(assistant, isNotEmpty,
            reason: 'snapshot should contain at least one AssistantMessage');

        final toolCalls = assistant
            .expand((m) => m.toolCalls ?? const <ToolCall>[])
            .toList(growable: false);
        expect(toolCalls, isNotEmpty,
            reason: 'assistant message should carry tool calls');
        expect(
          toolCalls.map((tc) => tc.function.name),
          contains('generate_haiku'),
        );

        // TOOL_CALL_* streaming events are NOT emitted by this endpoint in the
        // live dojo image — the tool call arrives only via MESSAGES_SNAPSHOT.
        // If they appear in a future image, the grouping assertion below will
        // still pass (it is a no-op when toolEvents is empty).
        _assertToolCallGrouping(events);
      } finally {
        await client.close();
      }
    }, skip: _skipDojo() ? 'AGUI_SKIP_DOJO=1' : null);

    // =========================================================================
    // agentic_generative_ui
    // =========================================================================

    test(
        'agentic_generative_ui emits STATE_SNAPSHOT then STATE_DELTA patch ops',
        () async {
      if (!reachable) {
        return markTestSkipped('dojo not reachable');
      }

      // Observed via curl:
      //   RUN_STARTED
      //   STATE_SNAPSHOT  (steps[0..9] all "pending")
      //   STATE_DELTA × 10  (each: op=replace, path=/steps/<n>/status, value=completed)
      //   STATE_SNAPSHOT  (steps[0..9] all "completed")
      //   RUN_FINISHED
      //
      // NOTE: This endpoint does NOT emit STEP_STARTED / STEP_FINISHED events
      // in the current dojo image. Step-pairing assertions are theoretical and
      // are intentionally omitted here. The endpoint uses STATE_SNAPSHOT /
      // STATE_DELTA to represent progress instead.

      final client = AgUiClient(
        config: AgUiClientConfig(baseUrl: baseUrl),
      );

      try {
        final input = SimpleRunAgentInput(
          threadId: 'dojo-smoke-agui-thread',
          runId:
              'dojo-smoke-agui-run-${DateTime.now().millisecondsSinceEpoch}',
          messages: [
            UserMessage(id: 'u1', content: 'show me progress'),
          ],
          tools: const [],
          context: const [],
          state: const <String, dynamic>{},
        );

        final events = <BaseEvent>[];
        await for (final event in client
            .runAgenticGenerativeUi(input)
            .timeout(const Duration(seconds: 30))) {
          events.add(event);
        }

        // --- Lifecycle invariants ---
        _assertLifecycleInvariants(events, input);

        // --- At least one STATE_SNAPSHOT ---
        final snapshots =
            events.whereType<StateSnapshotEvent>().toList(growable: false);
        expect(snapshots, isNotEmpty,
            reason: 'agentic_generative_ui must emit at least one STATE_SNAPSHOT');

        // The snapshot payload is a Map (not null, not a scalar).
        for (final s in snapshots) {
          expect(s.snapshot, isA<Map<String, dynamic>>(),
              reason: 'STATE_SNAPSHOT.snapshot must be a Map');
        }

        // --- STATE_DELTA patch ops (if present) ---
        final deltas =
            events.whereType<StateDeltaEvent>().toList(growable: false);
        // The live image emits 10 deltas. Asserting > 0 pins the observed behavior.
        expect(deltas, isNotEmpty,
            reason: 'agentic_generative_ui must emit at least one STATE_DELTA');

        const validOps = {'add', 'replace', 'remove', 'move', 'copy', 'test'};
        for (final d in deltas) {
          expect(d.delta, isNotEmpty,
              reason: 'each STATE_DELTA must carry at least one patch op');
          for (final op in d.delta) {
            expect(op['op'], isA<String>(),
                reason: 'each patch op must have a string "op" field');
            expect(validOps, contains(op['op']),
                reason: 'op "${op['op']}" must be a valid RFC 6902 operation');
            expect(op['path'], isA<String>(),
                reason: 'each patch op must have a string "path" field');
            expect(op['path'] as String, isNotEmpty,
                reason: 'patch op "path" must be non-empty');
          }
        }
      } finally {
        await client.close();
      }
    }, skip: _skipDojo() ? 'AGUI_SKIP_DOJO=1' : null);

    // =========================================================================
    // shared_state
    // =========================================================================

    test('shared_state emits STATE_SNAPSHOT with a Map payload', () async {
      if (!reachable) {
        return markTestSkipped('dojo not reachable');
      }

      // Observed via curl:
      //   RUN_STARTED
      //   STATE_SNAPSHOT  (recipe object)
      //   RUN_FINISHED
      //
      // NOTE: No STATE_DELTA events were emitted by this endpoint in the live
      // dojo image. The delta assertions below are conditional — if deltas appear
      // in a future image they are validated, but zero deltas is also acceptable.

      final client = AgUiClient(
        config: AgUiClientConfig(baseUrl: baseUrl),
      );

      try {
        final input = SimpleRunAgentInput(
          threadId: 'dojo-smoke-shared-thread',
          runId:
              'dojo-smoke-shared-run-${DateTime.now().millisecondsSinceEpoch}',
          messages: [
            UserMessage(id: 'u1', content: 'show me state'),
          ],
          tools: const [],
          context: const [],
          state: const <String, dynamic>{},
        );

        final events = <BaseEvent>[];
        await for (final event in client
            .runSharedState(input)
            .timeout(const Duration(seconds: 30))) {
          events.add(event);
        }

        // --- Lifecycle invariants ---
        _assertLifecycleInvariants(events, input);

        // --- At least one STATE_SNAPSHOT carrying a Map ---
        final snapshots =
            events.whereType<StateSnapshotEvent>().toList(growable: false);
        expect(snapshots, isNotEmpty,
            reason: 'shared_state must emit at least one STATE_SNAPSHOT');
        for (final s in snapshots) {
          expect(s.snapshot, isA<Map<String, dynamic>>(),
              reason: 'STATE_SNAPSHOT.snapshot must be a Map');
        }

        // --- Conditional STATE_DELTA validation ---
        // The live image emits zero deltas for this endpoint; the loop below
        // is a no-op but correctly validates any deltas that appear in future images.
        final deltas =
            events.whereType<StateDeltaEvent>().toList(growable: false);
        const validOps = {'add', 'replace', 'remove', 'move', 'copy', 'test'};
        for (final d in deltas) {
          expect(d.delta, isNotEmpty,
              reason: 'each STATE_DELTA must carry at least one patch op');
          for (final op in d.delta) {
            expect(op['op'], isA<String>(),
                reason: 'each patch op must have a string "op" field');
            expect(validOps, contains(op['op']),
                reason: 'op "${op['op']}" must be a valid RFC 6902 operation');
            expect(op['path'], isA<String>(),
                reason: 'each patch op must have a string "path" field');
            expect(op['path'] as String, isNotEmpty,
                reason: 'patch op "path" must be non-empty');
          }
        }
      } finally {
        await client.close();
      }
    }, skip: _skipDojo() ? 'AGUI_SKIP_DOJO=1' : null);

    // =========================================================================
    // predictive_state_updates
    // =========================================================================

    test('predictive_state_updates emits TOOL_CALL groups with no interleaving',
        () async {
      if (!reachable) {
        return markTestSkipped('dojo not reachable');
      }

      // Observed via curl:
      //   RUN_STARTED
      //   CUSTOM(name=PredictState, value=[...])
      //   TOOL_CALL_START (write_document_local)
      //   TOOL_CALL_ARGS × N
      //   TOOL_CALL_END
      //   TOOL_CALL_START (confirm_changes)
      //   TOOL_CALL_ARGS × 1
      //   TOOL_CALL_END
      //   RUN_FINISHED
      //
      // NOTE: This endpoint does NOT emit STATE_SNAPSHOT / STATE_DELTA events in
      // the live dojo image — contrary to the "same state-event assertions" hint
      // in the review spec. It uses streaming TOOL_CALL_* events instead, with a
      // CUSTOM(PredictState) event as a predictor hint. State event assertions
      // are intentionally absent here; tool-call grouping is asserted instead.

      final client = AgUiClient(
        config: AgUiClientConfig(baseUrl: baseUrl),
      );

      try {
        final input = SimpleRunAgentInput(
          threadId: 'dojo-smoke-predict-thread',
          runId:
              'dojo-smoke-predict-run-${DateTime.now().millisecondsSinceEpoch}',
          messages: [
            UserMessage(id: 'u1', content: 'write me a story'),
          ],
          tools: const [],
          context: const [],
          state: const <String, dynamic>{},
        );

        final events = <BaseEvent>[];
        await for (final event in client
            .runPredictiveStateUpdates(input)
            .timeout(const Duration(seconds: 30))) {
          events.add(event);
        }

        // --- Lifecycle invariants ---
        _assertLifecycleInvariants(events, input);

        // --- CUSTOM(PredictState) hint event ---
        final customEvents =
            events.whereType<CustomEvent>().toList(growable: false);
        expect(customEvents, isNotEmpty,
            reason: 'predictive_state_updates must emit at least one CUSTOM event');

        // --- TOOL_CALL grouping: START → ARGS* → END, no cross-id interleave ---
        final toolStarts =
            events.whereType<ToolCallStartEvent>().toList(growable: false);
        expect(toolStarts, isNotEmpty,
            reason: 'predictive_state_updates must emit at least one TOOL_CALL_START');
        _assertToolCallGrouping(events);
      } finally {
        await client.close();
      }
    }, skip: _skipDojo() ? 'AGUI_SKIP_DOJO=1' : null);

    // =========================================================================
    // human_in_the_loop
    // =========================================================================

    test('human_in_the_loop emits TOOL_CALL group for task-step generation',
        () async {
      if (!reachable) {
        return markTestSkipped('dojo not reachable');
      }

      // Observed via curl:
      //   RUN_STARTED
      //   TOOL_CALL_START (generate_task_steps)
      //   TOOL_CALL_ARGS × N
      //   TOOL_CALL_END
      //   RUN_FINISHED
      //
      // NOTE: This endpoint does NOT emit MESSAGES_SNAPSHOT in the live dojo image.
      // The tool call arrives via TOOL_CALL_* streaming events, not via a
      // MESSAGES_SNAPSHOT AssistantMessage. The spec's "AssistantMessage with
      // non-empty toolCalls in final MessagesSnapshotEvent" is the fallback path;
      // the live image takes the TOOL_CALL_* streaming path instead.

      final client = AgUiClient(
        config: AgUiClientConfig(baseUrl: baseUrl),
      );

      try {
        final input = SimpleRunAgentInput(
          threadId: 'dojo-smoke-hitl-thread',
          runId:
              'dojo-smoke-hitl-run-${DateTime.now().millisecondsSinceEpoch}',
          messages: [
            UserMessage(id: 'u1', content: 'hello'),
          ],
          tools: const [],
          context: const [],
          state: const <String, dynamic>{},
        );

        final events = <BaseEvent>[];
        await for (final event in client
            .runHumanInTheLoop(input)
            .timeout(const Duration(seconds: 30))) {
          events.add(event);
        }

        // --- Lifecycle invariants ---
        _assertLifecycleInvariants(events, input);

        // --- Exactly one TOOL_CALL group (generate_task_steps) ---
        final toolStarts =
            events.whereType<ToolCallStartEvent>().toList(growable: false);
        expect(toolStarts, isNotEmpty,
            reason: 'human_in_the_loop must emit at least one TOOL_CALL_START');

        // All tool calls must name generate_task_steps.
        for (final ts in toolStarts) {
          expect(ts.toolCallName, equals('generate_task_steps'),
              reason: 'human_in_the_loop tool must be generate_task_steps');
        }

        // --- TOOL_CALL grouping: START → ARGS* → END, no cross-id interleave ---
        _assertToolCallGrouping(events);

        // MESSAGES_SNAPSHOT is not emitted by this endpoint in the live image.
        // If it appears in a future image, this defensive check ensures it would
        // still carry an AssistantMessage with tool calls.
        final snapshots =
            events.whereType<MessagesSnapshotEvent>().toList(growable: false);
        if (snapshots.isNotEmpty) {
          final assistantWithTools = snapshots.last.messages
              .whereType<AssistantMessage>()
              .where((m) => m.toolCalls != null && m.toolCalls!.isNotEmpty)
              .toList(growable: false);
          expect(assistantWithTools, isNotEmpty,
              reason: 'if MESSAGES_SNAPSHOT is present, at least one '
                  'AssistantMessage must carry tool calls');
        }
      } finally {
        await client.close();
      }
    }, skip: _skipDojo() ? 'AGUI_SKIP_DOJO=1' : null);

    // =========================================================================
    // EventType round-trip guard (no dojo required)
    // =========================================================================

    test('all #1018 event types are registered in EventType.fromString', () {
      // The dojo server (8-month-old image) does not yet emit ACTIVITY_*
      // or REASONING_* events, but this branch adds them to the Dart enum.
      // This subtest guards against regressions in the parser surface
      // independently of the live stream content above.
      const wireNames = <String>[
        'ACTIVITY_SNAPSHOT',
        'ACTIVITY_DELTA',
        'REASONING_START',
        'REASONING_MESSAGE_START',
        'REASONING_MESSAGE_CONTENT',
        'REASONING_MESSAGE_END',
        'REASONING_MESSAGE_CHUNK',
        'REASONING_END',
        'REASONING_ENCRYPTED_VALUE',
      ];
      for (final name in wireNames) {
        final parsed = EventType.fromString(name);
        expect(parsed.value, equals(name),
            reason: '$name must round-trip through EventType.fromString');
      }
    });
  });
}
