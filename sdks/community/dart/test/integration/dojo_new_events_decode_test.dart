/// Full `BaseEvent.fromJson` / `EventStreamAdapter.adaptJsonToEvents` coverage
/// for the 9 new event types added on branch `fix-missing-event-types`.
///
/// This file does NOT require the live dojo — it is pure decoder logic using
/// synthesized JSON payloads so we catch decoder regressions independently of
/// server support.
library;

import 'dart:async';
import 'dart:convert';

import 'package:ag_ui/src/client/errors.dart';
import 'package:ag_ui/src/encoder/decoder.dart';
import 'package:ag_ui/src/encoder/stream_adapter.dart';
import 'package:ag_ui/src/events/events.dart';
import 'package:ag_ui/src/sse/sse_message.dart';
import 'package:test/test.dart';

// ---------------------------------------------------------------------------
// Helper: decode → toJson → decode and assert both instances agree on
// a set of spot-checked field values. Returns the re-decoded event.
// ---------------------------------------------------------------------------
T _roundTrip<T extends BaseEvent>(
  EventDecoder decoder,
  Map<String, dynamic> json,
  void Function(T first, T second) check,
) {
  final first = decoder.decodeJson(json) as T;
  final roundTripped = decoder.decodeJson(first.toJson()) as T;
  check(first, roundTripped);
  return roundTripped;
}

void main() {
  late EventDecoder decoder;
  late EventStreamAdapter adapter;

  setUp(() {
    decoder = const EventDecoder();
    adapter = EventStreamAdapter();
  });

  // =========================================================================
  // 1. ACTIVITY_SNAPSHOT
  // =========================================================================
  group('ACTIVITY_SNAPSHOT', () {
    test('direct decode — camelCase payload', () {
      final event = decoder.decodeJson({
        'type': 'ACTIVITY_SNAPSHOT',
        'messageId': 'act-001',
        'activityType': 'task.run',
        'content': {'title': 'Hello', 'progress': 0.25},
        'replace': false,
      });
      expect(event, isA<ActivitySnapshotEvent>());
      final e = event as ActivitySnapshotEvent;
      expect(e.messageId, equals('act-001'));
      expect(e.activityType, equals('task.run'));
      expect((e.content! as Map)['title'], equals('Hello'));
      expect(e.replace, isFalse);
    });

    test('snake_case parity', () {
      final event = decoder.decodeJson({
        'type': 'ACTIVITY_SNAPSHOT',
        'message_id': 'act-002',
        'activity_type': 'task.run',
        'content': null,
      });
      expect(event, isA<ActivitySnapshotEvent>());
      final e = event as ActivitySnapshotEvent;
      expect(e.messageId, equals('act-002'));
      expect(e.activityType, equals('task.run'));
      // default replace is true when omitted
      expect(e.replace, isTrue);
    });

    test('round-trip via toJson', () {
      _roundTrip<ActivitySnapshotEvent>(
        decoder,
        {
          'type': 'ACTIVITY_SNAPSHOT',
          'messageId': 'act-003',
          'activityType': 'progress',
          'content': {'done': true},
          'replace': false,
        },
        (a, b) {
          expect(b.messageId, equals(a.messageId));
          expect(b.activityType, equals(a.activityType));
          expect(b.replace, equals(a.replace));
          expect((b.content! as Map)['done'], isTrue);
        },
      );
    });

    test('replace defaults to true when absent and omitted from toJson', () {
      // replace == true is the default: toJson should omit the field.
      final event = decoder.decodeJson({
        'type': 'ACTIVITY_SNAPSHOT',
        'messageId': 'act-004',
        'activityType': 'status',
        'content': 'ok',
      }) as ActivitySnapshotEvent;
      expect(event.replace, isTrue);
      final json = event.toJson();
      expect(
        json.containsKey('replace'),
        isFalse,
        reason: 'replace==true should be omitted from wire output',
      );
    });
  });

  // =========================================================================
  // 2. ACTIVITY_DELTA
  // =========================================================================
  group('ACTIVITY_DELTA', () {
    test('direct decode — camelCase payload', () {
      final event = decoder.decodeJson({
        'type': 'ACTIVITY_DELTA',
        'messageId': 'act-001',
        'activityType': 'task.run',
        'patch': [
          {'op': 'replace', 'path': '/progress', 'value': 0.5},
        ],
      });
      expect(event, isA<ActivityDeltaEvent>());
      final e = event as ActivityDeltaEvent;
      expect(e.messageId, equals('act-001'));
      expect(e.activityType, equals('task.run'));
      expect(e.patch.length, equals(1));
      expect(e.patch[0]['op'], equals('replace'));
    });

    test('snake_case parity', () {
      final event = decoder.decodeJson({
        'type': 'ACTIVITY_DELTA',
        'message_id': 'act-002',
        'activity_type': 'task.run',
        'patch': <dynamic>[],
      });
      expect(event, isA<ActivityDeltaEvent>());
      final e = event as ActivityDeltaEvent;
      expect(e.messageId, equals('act-002'));
      expect(e.patch, isEmpty);
    });

    test('round-trip via toJson', () {
      _roundTrip<ActivityDeltaEvent>(
        decoder,
        {
          'type': 'ACTIVITY_DELTA',
          'messageId': 'act-003',
          'activityType': 'progress',
          'patch': [
            {'op': 'add', 'path': '/items/-', 'value': 42},
            {'op': 'remove', 'path': '/stale'},
          ],
        },
        (a, b) {
          expect(b.messageId, equals(a.messageId));
          expect(b.activityType, equals(a.activityType));
          expect(b.patch.length, equals(2));
          expect(b.patch[0]['op'], equals('add'));
          expect(b.patch[1]['op'], equals('remove'));
        },
      );
    });
  });

  // =========================================================================
  // 3. REASONING_START
  // =========================================================================
  group('REASONING_START', () {
    test('direct decode — camelCase payload', () {
      final event = decoder.decodeJson({
        'type': 'REASONING_START',
        'messageId': 'rsn-001',
      });
      expect(event, isA<ReasoningStartEvent>());
      expect((event as ReasoningStartEvent).messageId, equals('rsn-001'));
    });

    test('snake_case parity', () {
      final event = decoder.decodeJson({
        'type': 'REASONING_START',
        'message_id': 'rsn-002',
      });
      expect(event, isA<ReasoningStartEvent>());
      expect((event as ReasoningStartEvent).messageId, equals('rsn-002'));
    });

    test('round-trip via toJson', () {
      _roundTrip<ReasoningStartEvent>(
        decoder,
        {'type': 'REASONING_START', 'messageId': 'rsn-003'},
        (a, b) => expect(b.messageId, equals(a.messageId)),
      );
    });
  });

  // =========================================================================
  // 4. REASONING_MESSAGE_START
  // =========================================================================
  group('REASONING_MESSAGE_START', () {
    test('direct decode — camelCase payload', () {
      final event = decoder.decodeJson({
        'type': 'REASONING_MESSAGE_START',
        'messageId': 'rsn-msg-001',
        'role': 'reasoning',
      });
      expect(event, isA<ReasoningMessageStartEvent>());
      final e = event as ReasoningMessageStartEvent;
      expect(e.messageId, equals('rsn-msg-001'));
      expect(e.role, equals(ReasoningMessageRole.reasoning));
    });

    test('snake_case parity', () {
      final event = decoder.decodeJson({
        'type': 'REASONING_MESSAGE_START',
        'message_id': 'rsn-msg-002',
        'role': 'reasoning',
      });
      expect(event, isA<ReasoningMessageStartEvent>());
      expect(
        (event as ReasoningMessageStartEvent).messageId,
        equals('rsn-msg-002'),
      );
    });

    test('round-trip via toJson', () {
      _roundTrip<ReasoningMessageStartEvent>(
        decoder,
        {
          'type': 'REASONING_MESSAGE_START',
          'messageId': 'rsn-msg-003',
          'role': 'reasoning',
        },
        (a, b) {
          expect(b.messageId, equals(a.messageId));
          expect(b.role, equals(a.role));
        },
      );
    });

    test('unknown role falls back to reasoning (forward-compat)', () {
      // Per the fromJson contract: an unknown role string defaults to
      // ReasoningMessageRole.reasoning so a new server-side role value
      // does not break the stream.
      final event = decoder.decodeJson({
        'type': 'REASONING_MESSAGE_START',
        'messageId': 'rsn-msg-004',
        'role': 'future-unknown-role',
      }) as ReasoningMessageStartEvent;
      expect(event.role, equals(ReasoningMessageRole.reasoning));
    });
  });

  // =========================================================================
  // 5. REASONING_MESSAGE_CONTENT
  // =========================================================================
  group('REASONING_MESSAGE_CONTENT', () {
    test('direct decode — camelCase payload', () {
      final event = decoder.decodeJson({
        'type': 'REASONING_MESSAGE_CONTENT',
        'messageId': 'rsn-msg-001',
        'delta': 'thinking hard...',
      });
      expect(event, isA<ReasoningMessageContentEvent>());
      final e = event as ReasoningMessageContentEvent;
      expect(e.messageId, equals('rsn-msg-001'));
      expect(e.delta, equals('thinking hard...'));
    });

    test('snake_case parity', () {
      final event = decoder.decodeJson({
        'type': 'REASONING_MESSAGE_CONTENT',
        'message_id': 'rsn-msg-002',
        'delta': 'still thinking',
      });
      expect(event, isA<ReasoningMessageContentEvent>());
      expect(
        (event as ReasoningMessageContentEvent).delta,
        equals('still thinking'),
      );
    });

    test('empty delta is accepted (canonical parity)', () {
      // TS/Python schemas allow empty string for delta.
      final event = decoder.decodeJson({
        'type': 'REASONING_MESSAGE_CONTENT',
        'messageId': 'rsn-msg-003',
        'delta': '',
      });
      expect(event, isA<ReasoningMessageContentEvent>());
      expect((event as ReasoningMessageContentEvent).delta, equals(''));
    });

    test('round-trip via toJson', () {
      _roundTrip<ReasoningMessageContentEvent>(
        decoder,
        {
          'type': 'REASONING_MESSAGE_CONTENT',
          'messageId': 'rsn-msg-004',
          'delta': 'conclusion reached',
        },
        (a, b) {
          expect(b.messageId, equals(a.messageId));
          expect(b.delta, equals(a.delta));
        },
      );
    });
  });

  // =========================================================================
  // 6. REASONING_MESSAGE_END
  // =========================================================================
  group('REASONING_MESSAGE_END', () {
    test('direct decode — camelCase payload', () {
      final event = decoder.decodeJson({
        'type': 'REASONING_MESSAGE_END',
        'messageId': 'rsn-msg-001',
      });
      expect(event, isA<ReasoningMessageEndEvent>());
      expect(
        (event as ReasoningMessageEndEvent).messageId,
        equals('rsn-msg-001'),
      );
    });

    test('snake_case parity', () {
      final event = decoder.decodeJson({
        'type': 'REASONING_MESSAGE_END',
        'message_id': 'rsn-msg-002',
      });
      expect(event, isA<ReasoningMessageEndEvent>());
      expect(
        (event as ReasoningMessageEndEvent).messageId,
        equals('rsn-msg-002'),
      );
    });

    test('round-trip via toJson', () {
      _roundTrip<ReasoningMessageEndEvent>(
        decoder,
        {'type': 'REASONING_MESSAGE_END', 'messageId': 'rsn-msg-003'},
        (a, b) => expect(b.messageId, equals(a.messageId)),
      );
    });
  });

  // =========================================================================
  // 7. REASONING_MESSAGE_CHUNK
  // =========================================================================
  group('REASONING_MESSAGE_CHUNK', () {
    test('direct decode — with optional fields', () {
      final event = decoder.decodeJson({
        'type': 'REASONING_MESSAGE_CHUNK',
        'messageId': 'rsn-msg-001',
        'delta': 'chunk content',
      });
      expect(event, isA<ReasoningMessageChunkEvent>());
      final e = event as ReasoningMessageChunkEvent;
      expect(e.messageId, equals('rsn-msg-001'));
      expect(e.delta, equals('chunk content'));
    });

    test('snake_case parity', () {
      final event = decoder.decodeJson({
        'type': 'REASONING_MESSAGE_CHUNK',
        'message_id': 'rsn-msg-002',
        'delta': 'partial',
      });
      expect(event, isA<ReasoningMessageChunkEvent>());
      expect(
        (event as ReasoningMessageChunkEvent).messageId,
        equals('rsn-msg-002'),
      );
    });

    test('all fields optional — bare type decodes successfully', () {
      // All fields on ReasoningMessageChunkEvent are optional.
      final event = decoder.decodeJson({'type': 'REASONING_MESSAGE_CHUNK'});
      expect(event, isA<ReasoningMessageChunkEvent>());
      final e = event as ReasoningMessageChunkEvent;
      expect(e.messageId, isNull);
      expect(e.delta, isNull);
    });

    test('round-trip via toJson — optional fields preserved when set', () {
      final event = decoder.decodeJson({
        'type': 'REASONING_MESSAGE_CHUNK',
        'messageId': 'rsn-msg-003',
        'delta': 'step',
      }) as ReasoningMessageChunkEvent;
      final json = event.toJson();
      expect(json['messageId'], equals('rsn-msg-003'));
      expect(json['delta'], equals('step'));

      final reDecoded =
          decoder.decodeJson(json) as ReasoningMessageChunkEvent;
      expect(reDecoded.messageId, equals(event.messageId));
      expect(reDecoded.delta, equals(event.delta));
    });

    test('round-trip — null fields absent from toJson output', () {
      final event = decoder.decodeJson({
        'type': 'REASONING_MESSAGE_CHUNK',
      }) as ReasoningMessageChunkEvent;
      final json = event.toJson();
      expect(json.containsKey('messageId'), isFalse);
      expect(json.containsKey('delta'), isFalse);
    });
  });

  // =========================================================================
  // 8. REASONING_END
  // =========================================================================
  group('REASONING_END', () {
    test('direct decode — camelCase payload', () {
      final event = decoder.decodeJson({
        'type': 'REASONING_END',
        'messageId': 'rsn-001',
      });
      expect(event, isA<ReasoningEndEvent>());
      expect((event as ReasoningEndEvent).messageId, equals('rsn-001'));
    });

    test('snake_case parity', () {
      final event = decoder.decodeJson({
        'type': 'REASONING_END',
        'message_id': 'rsn-002',
      });
      expect(event, isA<ReasoningEndEvent>());
      expect((event as ReasoningEndEvent).messageId, equals('rsn-002'));
    });

    test('round-trip via toJson', () {
      _roundTrip<ReasoningEndEvent>(
        decoder,
        {'type': 'REASONING_END', 'messageId': 'rsn-003'},
        (a, b) => expect(b.messageId, equals(a.messageId)),
      );
    });
  });

  // =========================================================================
  // 9. REASONING_ENCRYPTED_VALUE
  // =========================================================================
  group('REASONING_ENCRYPTED_VALUE', () {
    test('direct decode — tool-call subtype', () {
      final event = decoder.decodeJson({
        'type': 'REASONING_ENCRYPTED_VALUE',
        'subtype': 'tool-call',
        'entityId': 'tc-001',
        'encryptedValue': 'cipher-payload-abc',
      });
      expect(event, isA<ReasoningEncryptedValueEvent>());
      final e = event as ReasoningEncryptedValueEvent;
      expect(e.subtype, equals(ReasoningEncryptedValueSubtype.toolCall));
      expect(e.entityId, equals('tc-001'));
      expect(e.encryptedValue, equals('cipher-payload-abc'));
      // rawEvent must be null — cipher-safety invariant.
      expect(e.rawEvent, isNull);
    });

    test('direct decode — message subtype', () {
      final event = decoder.decodeJson({
        'type': 'REASONING_ENCRYPTED_VALUE',
        'subtype': 'message',
        'entityId': 'msg-001',
        'encryptedValue': 'cipher-payload-xyz',
      });
      expect(event, isA<ReasoningEncryptedValueEvent>());
      final e = event as ReasoningEncryptedValueEvent;
      expect(e.subtype, equals(ReasoningEncryptedValueSubtype.message));
    });

    test('snake_case parity — entity_id / encrypted_value', () {
      final event = decoder.decodeJson({
        'type': 'REASONING_ENCRYPTED_VALUE',
        'subtype': 'tool-call',
        'entity_id': 'tc-002',
        'encrypted_value': 'cipher-snake',
      });
      expect(event, isA<ReasoningEncryptedValueEvent>());
      final e = event as ReasoningEncryptedValueEvent;
      expect(e.entityId, equals('tc-002'));
      expect(e.encryptedValue, equals('cipher-snake'));
    });

    test('round-trip via toJson', () {
      _roundTrip<ReasoningEncryptedValueEvent>(
        decoder,
        {
          'type': 'REASONING_ENCRYPTED_VALUE',
          'subtype': 'message',
          'entityId': 'msg-rt',
          'encryptedValue': 'rt-cipher',
        },
        (a, b) {
          expect(b.subtype, equals(a.subtype));
          expect(b.entityId, equals(a.entityId));
          expect(b.encryptedValue, equals(a.encryptedValue));
          expect(b.rawEvent, isNull);
        },
      );
    });

    test('unknown subtype surfaces as DecodingError', () {
      expect(
        () => decoder.decodeJson({
          'type': 'REASONING_ENCRYPTED_VALUE',
          'subtype': 'unknown-future-subtype',
          'entityId': 'e',
          'encryptedValue': 'v',
        }),
        throwsA(isA<DecodingError>()),
      );
    });
  });

  // =========================================================================
  // Stream-adapter path: REASONING_MESSAGE_START / CONTENT / END triplet
  // =========================================================================
  group('Stream-adapter path — REASONING_MESSAGE_* triplet', () {
    test('adaptJsonToEvents — single event', () {
      final events = adapter.adaptJsonToEvents({
        'type': 'REASONING_MESSAGE_START',
        'messageId': 'rsn-sa-001',
        'role': 'reasoning',
      });
      expect(events.length, equals(1));
      expect(events.first, isA<ReasoningMessageStartEvent>());
    });

    test('adaptJsonToEvents — list of three events for same messageId', () {
      final events = adapter.adaptJsonToEvents([
        {
          'type': 'REASONING_MESSAGE_START',
          'messageId': 'rsn-sa-002',
          'role': 'reasoning',
        },
        {
          'type': 'REASONING_MESSAGE_CONTENT',
          'messageId': 'rsn-sa-002',
          'delta': 'step 1',
        },
        {
          'type': 'REASONING_MESSAGE_END',
          'messageId': 'rsn-sa-002',
        },
      ]);

      expect(events.length, equals(3));
      expect(events[0], isA<ReasoningMessageStartEvent>());
      expect(events[1], isA<ReasoningMessageContentEvent>());
      expect(events[2], isA<ReasoningMessageEndEvent>());

      expect(
        (events[0] as ReasoningMessageStartEvent).messageId,
        equals('rsn-sa-002'),
      );
      expect(
        (events[1] as ReasoningMessageContentEvent).delta,
        equals('step 1'),
      );
      expect(
        (events[2] as ReasoningMessageEndEvent).messageId,
        equals('rsn-sa-002'),
      );
    });

    test(
      'fromSseStream — REASONING_MESSAGE_* triplet flows through correctly',
      () async {
        final controller = StreamController<SseMessage>();
        final stream = adapter.fromSseStream(controller.stream);
        final events = <BaseEvent>[];
        final sub = stream.listen(events.add);

        controller
          ..add(SseMessage(
            data: jsonEncode({
              'type': 'REASONING_START',
              'messageId': 'rsn-sse-001',
            }),
          ))
          ..add(SseMessage(
            data: jsonEncode({
              'type': 'REASONING_MESSAGE_START',
              'messageId': 'rsn-sse-001',
              'role': 'reasoning',
            }),
          ))
          ..add(SseMessage(
            data: jsonEncode({
              'type': 'REASONING_MESSAGE_CONTENT',
              'messageId': 'rsn-sse-001',
              'delta': 'I am thinking...',
            }),
          ))
          ..add(SseMessage(
            data: jsonEncode({
              'type': 'REASONING_MESSAGE_CONTENT',
              'messageId': 'rsn-sse-001',
              'delta': ' Done.',
            }),
          ))
          ..add(SseMessage(
            data: jsonEncode({
              'type': 'REASONING_MESSAGE_END',
              'messageId': 'rsn-sse-001',
            }),
          ))
          ..add(SseMessage(
            data: jsonEncode({
              'type': 'REASONING_END',
              'messageId': 'rsn-sse-001',
            }),
          ));

        await controller.close();
        await sub.cancel();

        expect(events.length, equals(6));
        expect(events[0], isA<ReasoningStartEvent>());
        expect(events[1], isA<ReasoningMessageStartEvent>());
        expect(events[2], isA<ReasoningMessageContentEvent>());
        expect(
          (events[2] as ReasoningMessageContentEvent).delta,
          equals('I am thinking...'),
        );
        expect(events[3], isA<ReasoningMessageContentEvent>());
        expect(
          (events[3] as ReasoningMessageContentEvent).delta,
          equals(' Done.'),
        );
        expect(events[4], isA<ReasoningMessageEndEvent>());
        expect(events[5], isA<ReasoningEndEvent>());

        // All phase-level events share the same messageId.
        expect(
          (events[0] as ReasoningStartEvent).messageId,
          equals('rsn-sse-001'),
        );
        expect(
          (events[5] as ReasoningEndEvent).messageId,
          equals('rsn-sse-001'),
        );
      },
    );

    test(
      'fromSseStream — REASONING_ENCRYPTED_VALUE with unknown subtype is '
      'skipped under skipInvalidEvents',
      () async {
        final controller = StreamController<SseMessage>();
        final stream = adapter.fromSseStream(
          controller.stream,
          skipInvalidEvents: true,
        );
        final events = <BaseEvent>[];
        final sub = stream.listen(events.add);

        controller
          ..add(SseMessage(
            data: jsonEncode({
              'type': 'REASONING_START',
              'messageId': 'rsn-sse-002',
            }),
          ))
          ..add(SseMessage(
            data: jsonEncode({
              'type': 'REASONING_ENCRYPTED_VALUE',
              'subtype': 'unknown-future',
              'entityId': 'e',
              'encryptedValue': 'v',
            }),
          ))
          ..add(SseMessage(
            data: jsonEncode({
              'type': 'REASONING_END',
              'messageId': 'rsn-sse-002',
            }),
          ));

        await controller.close();
        await sub.cancel();

        // The malformed encrypted value is skipped; surrounding events flow.
        expect(events.length, equals(2));
        expect(events[0], isA<ReasoningStartEvent>());
        expect(events[1], isA<ReasoningEndEvent>());
      },
    );

    test('groupRelatedEvents groups REASONING_MESSAGE_* by messageId', () async {
      final source = Stream<BaseEvent>.fromIterable([
        const ReasoningStartEvent(messageId: 'rsn-g-001'),
        const ReasoningMessageStartEvent(messageId: 'rsn-g-001'),
        const ReasoningMessageContentEvent(
          messageId: 'rsn-g-001',
          delta: 'thinking...',
        ),
        const ReasoningMessageEndEvent(messageId: 'rsn-g-001'),
        const ReasoningEndEvent(messageId: 'rsn-g-001'),
      ]);

      final groups =
          await EventStreamAdapter.groupRelatedEvents(source).toList();

      // REASONING_START and REASONING_END → singletons (phase-level).
      // REASONING_MESSAGE_START/CONTENT/END → one grouped list.
      expect(groups.length, equals(3));
      expect(groups[0].length, equals(1));
      expect(groups[0].first, isA<ReasoningStartEvent>());
      expect(groups[1].length, equals(3));
      expect(groups[1][0], isA<ReasoningMessageStartEvent>());
      expect(groups[1][1], isA<ReasoningMessageContentEvent>());
      expect(groups[1][2], isA<ReasoningMessageEndEvent>());
      expect(groups[2].length, equals(1));
      expect(groups[2].first, isA<ReasoningEndEvent>());
    });
  });

  // =========================================================================
  // Cross-type: ACTIVITY_SNAPSHOT + ACTIVITY_DELTA via adaptJsonToEvents list
  // =========================================================================
  group('adaptJsonToEvents — ACTIVITY_* mixed list', () {
    test('decodes activity snapshot and delta in sequence', () {
      final events = adapter.adaptJsonToEvents([
        {
          'type': 'ACTIVITY_SNAPSHOT',
          'messageId': 'act-list-001',
          'activityType': 'task.run',
          'content': {'status': 'started'},
        },
        {
          'type': 'ACTIVITY_DELTA',
          'messageId': 'act-list-001',
          'activityType': 'task.run',
          'patch': [
            {'op': 'replace', 'path': '/status', 'value': 'done'},
          ],
        },
      ]);

      expect(events.length, equals(2));
      expect(events[0], isA<ActivitySnapshotEvent>());
      expect(events[1], isA<ActivityDeltaEvent>());

      final snap = events[0] as ActivitySnapshotEvent;
      expect(snap.messageId, equals('act-list-001'));
      expect((snap.content! as Map)['status'], equals('started'));

      final delta = events[1] as ActivityDeltaEvent;
      expect(delta.patch[0]['value'], equals('done'));
    });
  });
}
