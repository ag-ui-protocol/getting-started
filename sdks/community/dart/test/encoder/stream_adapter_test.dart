import 'dart:async';

import 'package:ag_ui/src/client/errors.dart';
import 'package:ag_ui/src/encoder/stream_adapter.dart';
import 'package:ag_ui/src/events/events.dart';
import 'package:ag_ui/src/sse/sse_message.dart';
import 'package:test/test.dart';

void main() {
  group('EventStreamAdapter', () {
    late EventStreamAdapter adapter;

    setUp(() {
      adapter = EventStreamAdapter();
    });

    group('fromSseStream', () {
      test('converts SSE messages to typed events', () async {
        final sseController = StreamController<SseMessage>();
        final eventStream = adapter.fromSseStream(sseController.stream);

        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);

        // Add SSE messages
        sseController.add(SseMessage(
          data:
              '{"type":"TEXT_MESSAGE_START","messageId":"msg1","role":"assistant"}',
        ));
        sseController.add(SseMessage(
          data:
              '{"type":"TEXT_MESSAGE_CONTENT","messageId":"msg1","delta":"Hello"}',
        ));
        sseController.add(SseMessage(
          data: '{"type":"TEXT_MESSAGE_END","messageId":"msg1"}',
        ));

        await sseController.close();
        await subscription.cancel();

        expect(events.length, equals(3));
        expect(events[0], isA<TextMessageStartEvent>());
        expect(events[1], isA<TextMessageContentEvent>());
        expect(events[2], isA<TextMessageEndEvent>());
      });

      test('ignores non-data SSE messages', () async {
        final sseController = StreamController<SseMessage>();
        final eventStream = adapter.fromSseStream(sseController.stream);

        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);

        // Add various SSE message types
        sseController.add(const SseMessage(id: '123')); // No data
        sseController.add(const SseMessage(event: 'custom')); // No data
        sseController.add(
            const SseMessage(retry: Duration(milliseconds: 1000))); // No data
        sseController.add(SseMessage(
          data: '{"type":"TEXT_MESSAGE_START","messageId":"msg1"}',
        ));
        sseController.add(SseMessage(data: '')); // Empty data

        await sseController.close();
        await subscription.cancel();

        expect(events.length, equals(1));
        expect(events[0], isA<TextMessageStartEvent>());
      });

      test('handles errors when skipInvalidEvents is false', () async {
        final sseController = StreamController<SseMessage>();
        final eventStream = adapter.fromSseStream(
          sseController.stream,
          skipInvalidEvents: false,
        );

        final events = <BaseEvent>[];
        final errors = <Object>[];
        final subscription = eventStream.listen(
          events.add,
          onError: errors.add,
        );

        // Add valid and invalid messages
        sseController.add(SseMessage(
          data: '{"type":"TEXT_MESSAGE_START","messageId":"msg1"}',
        ));
        sseController.add(SseMessage(
          data: 'invalid json',
        ));
        sseController.add(SseMessage(
          data: '{"type":"TEXT_MESSAGE_END","messageId":"msg1"}',
        ));

        await sseController.close();
        await subscription.cancel();

        expect(events.length, equals(2));
        expect(errors.length, equals(1));
      });

      test('skips invalid events when skipInvalidEvents is true', () async {
        final sseController = StreamController<SseMessage>();
        final collectedErrors = <Object>[];
        final eventStream = adapter.fromSseStream(
          sseController.stream,
          skipInvalidEvents: true,
          onError: (error, stack) => collectedErrors.add(error),
        );

        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);

        // Add valid and invalid messages
        sseController.add(SseMessage(
          data: '{"type":"TEXT_MESSAGE_START","messageId":"msg1"}',
        ));
        sseController.add(SseMessage(
          data: 'invalid json',
        ));
        sseController.add(SseMessage(
          data: '{"type":"UNKNOWN_EVENT"}', // Unknown event type
        ));
        sseController.add(SseMessage(
          data: '{"type":"TEXT_MESSAGE_END","messageId":"msg1"}',
        ));

        await sseController.close();
        await subscription.cancel();

        expect(events.length, equals(2));
        expect(collectedErrors.length, equals(2));
      });
    });

    group('fromRawSseStream', () {
      test('handles complete SSE messages', () async {
        final rawController = StreamController<String>();
        final eventStream = adapter.fromRawSseStream(rawController.stream);

        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);

        // Add complete SSE messages
        rawController.add(
            'data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}\n\n');
        rawController.add(
            'data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}\n\n');

        await rawController.close();
        await subscription.cancel();

        expect(events.length, equals(2));
        expect(events[0], isA<RunStartedEvent>());
        expect(events[1], isA<RunFinishedEvent>());
      });

      test('handles partial messages across chunks', () async {
        final rawController = StreamController<String>();
        final eventStream = adapter.fromRawSseStream(rawController.stream);

        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);

        // Split message across chunks
        rawController.add('data: {"type":"TEXT_MES');
        rawController.add('SAGE_START","messageI');
        rawController.add('d":"msg1"}\n\n');

        await rawController.close();
        await subscription.cancel();

        expect(events.length, equals(1));
        expect(events[0], isA<TextMessageStartEvent>());
        final event = events[0] as TextMessageStartEvent;
        expect(event.messageId, equals('msg1'));
      });

      test('handles multi-line data fields', () async {
        final rawController = StreamController<String>();
        final eventStream = adapter.fromRawSseStream(rawController.stream);

        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);

        // Multi-line data
        rawController.add('data: {"type":"TEXT_MESSAGE_CONTENT",\n');
        rawController.add('data: "messageId":"msg1",\n');
        rawController.add('data: "delta":"Hello"}\n\n');

        await rawController.close();
        await subscription.cancel();

        expect(events.length, equals(1));
        expect(events[0], isA<TextMessageContentEvent>());
        final event = events[0] as TextMessageContentEvent;
        expect(event.delta, equals('Hello'));
      });

      test('ignores non-data lines', () async {
        final rawController = StreamController<String>();
        final eventStream = adapter.fromRawSseStream(rawController.stream);

        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);

        rawController.add('id: 123\n');
        rawController.add('event: custom\n');
        rawController.add(': comment\n');
        rawController
            .add('data: {"type":"CUSTOM","name":"test","value":42}\n\n');
        rawController.add('retry: 1000\n');

        await rawController.close();
        await subscription.cancel();

        expect(events.length, equals(1));
        expect(events[0], isA<CustomEvent>());
      });

      test('processes remaining buffered data on close', () async {
        final rawController = StreamController<String>();
        final eventStream = adapter.fromRawSseStream(rawController.stream);

        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);

        // Add data without final newlines
        rawController
            .add('data: {"type":"STATE_SNAPSHOT","snapshot":{"count":42}}');

        await rawController.close();
        await subscription.cancel();

        expect(events.length, equals(1));
        expect(events[0], isA<StateSnapshotEvent>());
        final event = events[0] as StateSnapshotEvent;
        expect(event.snapshot['count'], equals(42));
      });

      test('handles CRLF split across chunks without double-dispatch',
          () async {
        // Regression for Opus2 I3: when lastWasLoneCrAtStart=true and the new
        // chunk starts with '\n', that '\n' is the second half of a chunk-spanning
        // CRLF pair and must NOT produce an extra empty line (which would cause a
        // spurious flush of an in-progress data block).
        //
        // Chunk 1: "data: foo\r\r"
        //   - First \r terminates "data: foo" (lone-CR, sets lastWasLoneCr=true)
        //   - Second \r terminates "" (empty line, dispatches "foo", keeps lastWasLoneCr=true)
        // Chunk 2: "\ndata: bar\n\n"
        //   - Leading \n is the CRLF complement of a PRIOR chunk boundary
        //     (skipped by the edge-case fix so it doesn't dispatch an extra event)
        //   - "data: bar" + "\n\n" dispatches "bar"
        final rawController = StreamController<String>();
        final eventStream = adapter.fromRawSseStream(rawController.stream);

        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);

        rawController.add(
          'data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}\r\r',
        );
        rawController.add(
          '\ndata: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}\n\n',
        );

        await rawController.close();
        await subscription.cancel();

        // Must produce exactly 2 events, not 3 (the spurious empty-flush
        // from the lone \n would have caused a double-dispatch before the fix).
        expect(events.length, equals(2),
            reason:
                'leading \\n in chunk 2 must not produce an extra dispatch');
        expect(events[0], isA<RunStartedEvent>());
        expect(events[1], isA<RunFinishedEvent>());
      });

      test(
          'lone-CR: lastWasLoneCr persists through zero-length intermediate chunk',
          () async {
        // Regression for II5: when a lone-CR terminator is delivered in one
        // chunk and the next chunk is empty (zero-length), lastWasLoneCr must
        // survive across the empty chunk so the subsequent real chunk does not
        // stall waiting for a deferred \r resolution.
        final rawController = StreamController<String>();
        final eventStream = adapter.fromRawSseStream(rawController.stream);

        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);

        // Chunk 1: event + lone-CR terminator pair (CR = end of data line, CR = empty line → flush)
        rawController.add(
          'data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}\r\r',
        );
        // Chunk 2: zero-length — must not reset lastWasLoneCr state
        rawController.add('');
        // Chunk 3: second event using lone-CR style
        rawController.add(
          'data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}\r\r',
        );

        await rawController.close();
        await subscription.cancel();

        expect(events.length, equals(2));
        expect(events[0], isA<RunStartedEvent>());
        expect(events[1], isA<RunFinishedEvent>());
      });

      test(
          'lone-CR: three back-to-back events each delivered in their own chunk',
          () async {
        // Regression for I4/II5: three consecutive lone-CR-terminated events
        // delivered one per chunk. Each chunk ends with \r\r (data line CR +
        // empty-line CR). The lastWasLoneCr flag must persist correctly so
        // each event is dispatched exactly once.
        final rawController = StreamController<String>();
        final eventStream = adapter.fromRawSseStream(rawController.stream);

        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);

        for (final runId in ['r1', 'r2', 'r3']) {
          rawController.add(
            'data: {"type":"RUN_STARTED","threadId":"t1","runId":"$runId"}\r\r',
          );
        }

        await rawController.close();
        await subscription.cancel();

        expect(events.length, equals(3));
        expect((events[0] as RunStartedEvent).runId, equals('r1'));
        expect((events[1] as RunStartedEvent).runId, equals('r2'));
        expect((events[2] as RunStartedEvent).runId, equals('r3'));
      });

      test('mixed lone-CR + CRLF terminators in adjacent events', () async {
        // Regression for I4: chunk1 uses lone-CR style, chunk2 uses CRLF.
        // The transition must not double-dispatch or lose an event.
        // chunk1: "data: foo\r" — lone-CR terminates the line; trailing \r
        //         is deferred (not yet a lone-CR producer confirmation)
        // chunk2: "\r\ndata: bar\n\n" — the leading \r is interpreted as the
        //         continuation of the prior deferred \r, making it a lone-CR
        //         (empty line → flush foo), then \n is handled as a new
        //         terminator for the CRLF-style event.
        // Actually the simpler test: lone-CR event in chunk1, CRLF event in chunk2.
        final rawController = StreamController<String>();
        final eventStream = adapter.fromRawSseStream(rawController.stream);

        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);

        // Chunk 1: lone-CR event (data line + empty line via lone-CR)
        rawController.add(
          'data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}\r\r',
        );
        // Chunk 2: CRLF-terminated event
        rawController.add(
          'data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}\r\n\r\n',
        );

        await rawController.close();
        await subscription.cancel();

        expect(events.length, equals(2));
        expect(events[0], isA<RunStartedEvent>());
        expect(events[1], isA<RunFinishedEvent>());
      });

      test('downstream cancellation propagates to upstream subscription',
          () async {
        // Regression for the leaked-subscription bug noted in the #1018
        // review: pre-fix, `rawStream.listen(...)` was fire-and-forget —
        // the returned stream's `controller.onCancel` did not cancel the
        // upstream subscription. A consumer that stops listening early
        // left the upstream draining indefinitely.
        final rawController = StreamController<String>();
        final eventStream = adapter.fromRawSseStream(rawController.stream);

        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);

        // Push one complete event, then assert the upstream is alive.
        rawController.add(
          'data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}\n\n',
        );
        await Future<void>.delayed(Duration.zero);
        expect(events.length, equals(1));
        expect(rawController.hasListener, isTrue);

        // Cancel the downstream subscription; upstream listener should
        // be released.
        await subscription.cancel();
        // A microtask hop lets the cancel propagate through the
        // controller before we sample `hasListener`.
        await Future<void>.delayed(Duration.zero);
        expect(rawController.hasListener, isFalse,
            reason: 'fromRawSseStream must cancel its upstream subscription '
                'when the downstream stream is cancelled');

        await rawController.close();
      });

      test(
          'CRLF split where second chunk is exactly "\\n" (deferral edge case)',
          () async {
        // Regression for Opus2 I7: when chunk 1 ends with a bare \r (deferred
        // — could be the \r of a CRLF pair), and chunk 2 is exactly "\n", the
        // \r+\n must be treated as a single CRLF terminator and produce exactly
        // ONE empty line (one flush), not two.
        //
        // Without the deferral fix, chunk1's \r would emit a line AND chunk2's
        // \n would emit another empty line, causing double-dispatch.
        final rawController = StreamController<String>();
        final eventStream = adapter.fromRawSseStream(rawController.stream);

        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);

        // Chunk 1: data line terminated by \r (deferred — may be CRLF start)
        rawController.add(
          'data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}\r',
        );
        // Chunk 2: exactly "\n" — the CRLF complement; must NOT produce a
        // second empty line
        rawController.add('\n');

        await rawController.close();
        await subscription.cancel();

        expect(events.length, equals(1),
            reason:
                '\\r\\n split across chunks must produce exactly one flush');
        expect(events[0], isA<RunStartedEvent>());
      });

      test(
          'two distinct JSON decode errors in one chunk both reach the consumer',
          () async {
        // Regression for Opus2 I1: within a single chunk, the per-frame reset
        // of errorRoutedInChunk (reset before EACH empty-line flush) ensures
        // that a second JSON decode error is never suppressed by the first.
        // Both errors must reach the downstream consumer.
        final rawController = StreamController<String>();
        final eventStream = adapter.fromRawSseStream(rawController.stream);

        final errors = <Object>[];
        final subscription = eventStream.listen(
          (_) {},
          onError: errors.add,
        );

        // Single chunk with two complete SSE messages, both with invalid JSON.
        rawController.add('data: not-json-1\n\ndata: not-json-2\n\n');

        await Future<void>.delayed(Duration.zero);
        await subscription.cancel();
        await rawController.close();

        expect(errors.length, equals(2),
            reason: 'both decode errors must reach the consumer; '
                'errorRoutedInChunk must be reset before each new frame');
      });

      test(
          'processChunk size-cap resets dataBuffer so next valid event '
          'is not contaminated (I1 regression)', () async {
        // Regression for Opus2 I1: when a chunk-level size cap fires,
        // the in-progress dataBuffer must be cleared and inDataBlock reset
        // before throwing. Without the fix, chunk 1's data (already appended
        // to dataBuffer via a complete `data:` line) contaminates chunk 4's
        // decode: the leftover partial data triggers a spurious extra error
        // when the blank-line boundary arrives in chunk 3.
        //
        // Sequence:
        //   Chunk 1: `data: <valid-json>\n`  → appended to dataBuffer (complete line)
        //   Chunk 2: huge blob               → processChunk cap fires, 1 error routed
        //   Chunk 3: `\n`                    → blank-line boundary (ends oversized msg)
        //   Chunk 4: valid complete event    → must decode cleanly (0 extra errors)
        //
        // Without fix: chunk 3's blank-line flush sees leftover dataBuffer from
        // chunk 1, tries to decode it → routes a 2nd spurious error.
        // With fix:    dataBuffer cleared on cap; chunk 3 flush is a no-op.
        const smallCap = 60; // big enough for valid events, not for the blob
        final smallAdapter = EventStreamAdapter(maxDataCodeUnits: smallCap);
        final rawController = StreamController<String>();
        final eventStream = smallAdapter.fromRawSseStream(rawController.stream);

        final events = <BaseEvent>[];
        final errors = <Object>[];
        final subscription = eventStream.listen(
          events.add,
          onError: errors.add,
        );

        // Chunk 1: complete data: line (with \n) so content reaches dataBuffer.
        rawController.add('data: {"partial":true}\n');

        // Chunk 2: oversized — exceeds smallCap, fires processChunk cap.
        rawController.add('x' * (smallCap + 1));

        // Chunk 3: blank line — boundary that "closes" the oversized message.
        rawController.add('\n');

        // Chunk 4: clean new SSE event that must decode without error.
        rawController.add(
            'data: {"type":"RUN_FINISHED","threadId":"t","runId":"r"}\n\n');

        await Future<void>.delayed(Duration.zero);
        await subscription.cancel();
        await rawController.close();

        expect(errors.length, equals(1),
            reason: 'only the oversized chunk should produce an error; '
                'the leftover dataBuffer from chunk 1 must NOT cause a 2nd error '
                'when chunk 3\'s blank line fires flushDataBlock');
        expect(events.length, equals(1),
            reason: 'RUN_FINISHED from chunk 4 must decode cleanly');
        expect(events[0], isA<RunFinishedEvent>());
      });

      test(
          '_scanLines: lone-CR at chunk end followed by CRLF at chunk start '
          '(mixed-terminator producer transition)', () async {
        // Regression for S3: producer emits the data line with a lone-CR
        // terminator and the event boundary with CRLF, split across two chunks.
        //
        // chunk1: "data: <json>\r"
        //   → the trailing \r is deferred (could be the \r of a CRLF pair).
        // chunk2: "\r\n"
        //   → chunk2[0] = \r (NOT \n) → deferred \r resolves as lone-CR,
        //     emitting line "data: <json>".  The new \r is immediately
        //     deferred.
        //   → chunk2[1] = \n → deferred \r + \n = CRLF → produces empty
        //     line → event dispatch.
        //
        // Expected: exactly one event, with no double-dispatch from
        // the chunk-boundary \r being misread as part of the \r\n pair.
        final rawController = StreamController<String>();
        final eventStream = adapter.fromRawSseStream(rawController.stream);

        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);

        rawController.add(
          'data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}\r',
        );
        rawController.add('\r\n');

        await rawController.close();
        await subscription.cancel();

        expect(events.length, equals(1),
            reason: 'lone-CR data-line + CRLF boundary split across chunks '
                'must produce exactly one event');
        expect(events[0], isA<RunStartedEvent>());
      });

      test(
          '_scanLines: CRLF data-line in chunk1, lone-CR event-boundary in '
          'chunk2 (mixed-terminator producer transition)', () async {
        // Regression for S3: producer uses CRLF for the data line and a
        // lone-CR for the blank-line event boundary, split across chunks.
        //
        // chunk1: "data: <json>\r\n"
        //   → CRLF terminates the data line; "data: <json>" is appended
        //     to the data buffer.
        // chunk2: "\r"
        //   → trailing \r deferred (could be start of CRLF).
        // stream close:
        //   → deferred \r flushed as lone-CR → produces empty line
        //     → event dispatch.
        //
        // Expected: exactly one event, confirming that a deferred lone-CR
        // left at stream close still triggers the event boundary flush.
        final rawController = StreamController<String>();
        final eventStream = adapter.fromRawSseStream(rawController.stream);

        final events = <BaseEvent>[];
        final subscription = eventStream.listen(events.add);

        rawController.add(
          'data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}\r\n',
        );
        rawController.add('\r');

        await rawController.close();
        await subscription.cancel();

        expect(events.length, equals(1),
            reason: 'CRLF data-line + lone-CR boundary flushed at stream '
                'close must produce exactly one event');
        expect(events[0], isA<RunStartedEvent>());
      });
    });

    group('filterByType', () {
      test('filters events by specific type', () async {
        final controller = StreamController<BaseEvent>();
        final filtered = EventStreamAdapter.filterByType<TextMessageStartEvent>(
          controller.stream,
        );

        final events = <TextMessageStartEvent>[];
        final subscription = filtered.listen(events.add);

        controller.add(TextMessageStartEvent(messageId: 'msg1'));
        controller
            .add(TextMessageContentEvent(messageId: 'msg1', delta: 'Hello'));
        controller.add(TextMessageStartEvent(messageId: 'msg2'));
        controller.add(ToolCallStartEvent(
          toolCallId: 'tool1',
          toolCallName: 'search',
        ));
        controller.add(TextMessageEndEvent(messageId: 'msg1'));

        await controller.close();
        await subscription.cancel();

        expect(events.length, equals(2));
        expect(events[0].messageId, equals('msg1'));
        expect(events[1].messageId, equals('msg2'));
      });
    });

    group('groupRelatedEvents', () {
      test('groups text message events by messageId', () async {
        final controller = StreamController<BaseEvent>();
        final grouped =
            EventStreamAdapter.groupRelatedEvents(controller.stream);

        final groups = <List<BaseEvent>>[];
        final subscription = grouped.listen(groups.add);

        // Complete message sequence
        controller.add(TextMessageStartEvent(messageId: 'msg1'));
        controller
            .add(TextMessageContentEvent(messageId: 'msg1', delta: 'Hello'));
        controller
            .add(TextMessageContentEvent(messageId: 'msg1', delta: ' world'));
        controller.add(TextMessageEndEvent(messageId: 'msg1'));

        await controller.close();
        await subscription.cancel();

        expect(groups.length, equals(1));
        expect(groups[0].length, equals(4));
        expect(groups[0][0], isA<TextMessageStartEvent>());
        expect(groups[0][1], isA<TextMessageContentEvent>());
        expect(groups[0][2], isA<TextMessageContentEvent>());
        expect(groups[0][3], isA<TextMessageEndEvent>());
      });

      test('groups tool call events by toolCallId', () async {
        final controller = StreamController<BaseEvent>();
        final grouped =
            EventStreamAdapter.groupRelatedEvents(controller.stream);

        final groups = <List<BaseEvent>>[];
        final subscription = grouped.listen(groups.add);

        // Complete tool call sequence
        controller.add(ToolCallStartEvent(
          toolCallId: 'tool1',
          toolCallName: 'search',
        ));
        controller.add(ToolCallArgsEvent(
          toolCallId: 'tool1',
          delta: '{"query":',
        ));
        controller.add(ToolCallArgsEvent(
          toolCallId: 'tool1',
          delta: '"test"}',
        ));
        controller.add(ToolCallEndEvent(toolCallId: 'tool1'));

        await controller.close();
        await subscription.cancel();

        expect(groups.length, equals(1));
        expect(groups[0].length, equals(4));
        expect(groups[0][0], isA<ToolCallStartEvent>());
        expect(groups[0][1], isA<ToolCallArgsEvent>());
        expect(groups[0][2], isA<ToolCallArgsEvent>());
        expect(groups[0][3], isA<ToolCallEndEvent>());
      });

      test('handles interleaved message groups', () async {
        final controller = StreamController<BaseEvent>();
        final grouped =
            EventStreamAdapter.groupRelatedEvents(controller.stream);

        final groups = <List<BaseEvent>>[];
        final subscription = grouped.listen(groups.add);

        // Interleaved messages
        controller.add(TextMessageStartEvent(messageId: 'msg1'));
        controller.add(TextMessageStartEvent(messageId: 'msg2'));
        controller.add(TextMessageContentEvent(messageId: 'msg1', delta: 'A'));
        controller.add(TextMessageContentEvent(messageId: 'msg2', delta: 'B'));
        controller.add(TextMessageEndEvent(messageId: 'msg1'));
        controller.add(TextMessageEndEvent(messageId: 'msg2'));

        await controller.close();
        await subscription.cancel();

        expect(groups.length, equals(2));
        // First completed group (msg1)
        expect(groups[0].length, equals(3));
        expect(
            (groups[0][0] as TextMessageStartEvent).messageId, equals('msg1'));
        // Second completed group (msg2)
        expect(groups[1].length, equals(3));
        expect(
            (groups[1][0] as TextMessageStartEvent).messageId, equals('msg2'));
      });

      test('emits single events not part of groups', () async {
        final controller = StreamController<BaseEvent>();
        final grouped =
            EventStreamAdapter.groupRelatedEvents(controller.stream);

        final groups = <List<BaseEvent>>[];
        final subscription = grouped.listen(groups.add);

        controller.add(RunStartedEvent(threadId: 't1', runId: 'r1'));
        controller.add(StateSnapshotEvent(snapshot: {'count': 0}));
        controller.add(CustomEvent(name: 'test', value: 42));

        await controller.close();
        await subscription.cancel();

        expect(groups.length, equals(3));
        expect(groups[0].length, equals(1));
        expect(groups[0][0], isA<RunStartedEvent>());
        expect(groups[1].length, equals(1));
        expect(groups[1][0], isA<StateSnapshotEvent>());
        expect(groups[2].length, equals(1));
        expect(groups[2][0], isA<CustomEvent>());
      });

      test('emits incomplete groups on stream close', () async {
        final controller = StreamController<BaseEvent>();
        final grouped =
            EventStreamAdapter.groupRelatedEvents(controller.stream);

        final groups = <List<BaseEvent>>[];
        final completer = Completer<void>();
        final subscription = grouped.listen(
          groups.add,
          onDone: completer.complete,
        );

        // Incomplete message (no END event)
        controller.add(TextMessageStartEvent(messageId: 'msg1'));
        controller
            .add(TextMessageContentEvent(messageId: 'msg1', delta: 'Hello'));

        await controller.close();
        await completer.future; // Wait for stream to complete
        await subscription.cancel();

        expect(groups.length, equals(1));
        expect(groups[0].length, equals(2));
        expect(groups[0][0], isA<TextMessageStartEvent>());
        expect(groups[0][1], isA<TextMessageContentEvent>());
      });

      test('groups ReasoningMessage* events by messageId', () async {
        // Regression for Opus1 I1: ReasoningMessage* events must be grouped
        // like TextMessage* events, not fall to the default single-event branch.
        final controller = StreamController<BaseEvent>();
        final grouped =
            EventStreamAdapter.groupRelatedEvents(controller.stream);

        final groups = <List<BaseEvent>>[];
        final subscription = grouped.listen(groups.add);

        controller.add(ReasoningMessageStartEvent(messageId: 'rsn1'));
        controller.add(ReasoningMessageContentEvent(
          messageId: 'rsn1',
          delta: 'Thinking...',
        ));
        controller.add(ReasoningMessageEndEvent(messageId: 'rsn1'));

        await controller.close();
        await subscription.cancel();

        expect(groups.length, equals(1));
        expect(groups[0].length, equals(3));
        expect(groups[0][0], isA<ReasoningMessageStartEvent>());
        expect(groups[0][1], isA<ReasoningMessageContentEvent>());
        expect(groups[0][2], isA<ReasoningMessageEndEvent>());
      });

      test('routes chunk into open group when Start/End cycle is active',
          () async {
        // Regression: *Chunk events must be routed into an active group rather
        // than emitted as standalone single-element groups via the default branch.
        final controller = StreamController<BaseEvent>();
        final grouped =
            EventStreamAdapter.groupRelatedEvents(controller.stream);

        final groups = <List<BaseEvent>>[];
        final subscription = grouped.listen(groups.add);

        // TextMessageChunkEvent arriving while a Start/End cycle is open
        controller.add(TextMessageStartEvent(messageId: 'msg1'));
        controller
            .add(TextMessageChunkEvent(messageId: 'msg1', delta: 'chunk'));
        controller.add(TextMessageEndEvent(messageId: 'msg1'));

        await controller.close();
        await subscription.cancel();

        // All three events must land in a single group, not 2 groups
        expect(groups.length, equals(1));
        expect(groups[0].length, equals(3));
        expect(groups[0][1], isA<TextMessageChunkEvent>());
      });

      test('emits standalone chunk when no matching open group exists',
          () async {
        // A *Chunk with no active group (e.g. server sends only chunks, no
        // Start/End) must still be emitted, just as a single-element group.
        final controller = StreamController<BaseEvent>();
        final grouped =
            EventStreamAdapter.groupRelatedEvents(controller.stream);

        final groups = <List<BaseEvent>>[];
        final subscription = grouped.listen(groups.add);

        controller
            .add(TextMessageChunkEvent(messageId: 'msg1', delta: 'standalone'));

        await controller.close();
        await subscription.cancel();

        expect(groups.length, equals(1));
        expect(groups[0].length, equals(1));
        expect(groups[0][0], isA<TextMessageChunkEvent>());
      });

      // Regression for I-J: Tool and Reasoning chunk families were not covered.
      test('routes ToolCallChunkEvent into open tool group', () async {
        final controller = StreamController<BaseEvent>();
        final grouped =
            EventStreamAdapter.groupRelatedEvents(controller.stream);

        final groups = <List<BaseEvent>>[];
        final subscription = grouped.listen(groups.add);

        controller.add(ToolCallStartEvent(
          toolCallId: 'tc1',
          toolCallName: 'search',
          parentMessageId: 'msg1',
        ));
        controller.add(ToolCallChunkEvent(toolCallId: 'tc1', delta: '{"q"'));
        controller.add(ToolCallEndEvent(toolCallId: 'tc1'));

        await controller.close();
        await subscription.cancel();

        // All three must land in a single group, not 2 groups
        expect(groups.length, equals(1));
        expect(groups[0].length, equals(3));
        expect(groups[0][1], isA<ToolCallChunkEvent>());
      });

      test('emits standalone ToolCallChunkEvent when no open group exists',
          () async {
        final controller = StreamController<BaseEvent>();
        final grouped =
            EventStreamAdapter.groupRelatedEvents(controller.stream);

        final groups = <List<BaseEvent>>[];
        final subscription = grouped.listen(groups.add);

        controller.add(ToolCallChunkEvent(toolCallId: 'tc1', delta: '{}'));

        await controller.close();
        await subscription.cancel();

        expect(groups.length, equals(1));
        expect(groups[0].length, equals(1));
        expect(groups[0][0], isA<ToolCallChunkEvent>());
      });

      test('routes ReasoningMessageChunkEvent into open reasoning group',
          () async {
        final controller = StreamController<BaseEvent>();
        final grouped =
            EventStreamAdapter.groupRelatedEvents(controller.stream);

        final groups = <List<BaseEvent>>[];
        final subscription = grouped.listen(groups.add);

        controller.add(ReasoningMessageStartEvent(messageId: 'rm1'));
        controller.add(
            ReasoningMessageChunkEvent(messageId: 'rm1', delta: 'thinking'));
        controller.add(ReasoningMessageEndEvent(messageId: 'rm1'));

        await controller.close();
        await subscription.cancel();

        // All three must land in a single group, not 2 groups
        expect(groups.length, equals(1));
        expect(groups[0].length, equals(3));
        expect(groups[0][1], isA<ReasoningMessageChunkEvent>());
      });

      test(
          'emits standalone ReasoningMessageChunkEvent when no open group exists',
          () async {
        final controller = StreamController<BaseEvent>();
        final grouped =
            EventStreamAdapter.groupRelatedEvents(controller.stream);

        final groups = <List<BaseEvent>>[];
        final subscription = grouped.listen(groups.add);

        controller.add(
            ReasoningMessageChunkEvent(messageId: 'rm1', delta: 'standalone'));

        await controller.close();
        await subscription.cancel();

        expect(groups.length, equals(1));
        expect(groups[0].length, equals(1));
        expect(groups[0][0], isA<ReasoningMessageChunkEvent>());
      });

      test('orphan *_End events are emitted as standalone groups (I3 fix)',
          () async {
        // Regression for Opus2 I3: a *_End event with no matching *_Start
        // (e.g. after a reconnect that missed the opening event) was silently
        // dropped. It must now be emitted as a standalone single-element group,
        // consistent with how orphan *_Chunk events are handled.
        final controller = StreamController<BaseEvent>();
        final grouped =
            EventStreamAdapter.groupRelatedEvents(controller.stream);

        final groups = <List<BaseEvent>>[];
        final subscription = grouped.listen(groups.add);

        // Orphan End events — no preceding Start
        controller.add(TextMessageEndEvent(messageId: 'no-start-text'));
        controller.add(ToolCallEndEvent(toolCallId: 'no-start-tool'));
        controller
            .add(ReasoningMessageEndEvent(messageId: 'no-start-reasoning'));

        await controller.close();
        await subscription.cancel();

        expect(groups.length, equals(3),
            reason: 'each orphan *_End must emit as a standalone group');
        expect(groups[0].length, equals(1));
        expect(groups[0][0], isA<TextMessageEndEvent>());
        expect(groups[1].length, equals(1));
        expect(groups[1][0], isA<ToolCallEndEvent>());
        expect(groups[2].length, equals(1));
        expect(groups[2][0], isA<ReasoningMessageEndEvent>());
      });
      test(
          'duplicate *_Start discards prior accumulated events (last-Start-wins)',
          () async {
        // Regression for Opus2 S4: the dartdoc at groupRelatedEvents promises
        // that a duplicate *_Start discards the prior open group's events
        // silently and starts fresh. This contract previously lacked a
        // regression guard.
        final controller = StreamController<BaseEvent>();
        final groups = <List<BaseEvent>>[];
        final subscription =
            EventStreamAdapter.groupRelatedEvents(controller.stream)
                .listen(groups.add);

        controller.add(TextMessageStartEvent(messageId: 'm1'));
        controller
            .add(TextMessageContentEvent(messageId: 'm1', delta: 'first'));
        // Duplicate Start with same id — silently discards the prior group
        // (no emission) and starts fresh.
        controller.add(TextMessageStartEvent(messageId: 'm1'));
        controller
            .add(TextMessageContentEvent(messageId: 'm1', delta: 'second'));
        controller.add(TextMessageEndEvent(messageId: 'm1'));

        await controller.close();
        await subscription.cancel();

        // Only the second group is emitted (completed by its End event).
        // The prior group's events are discarded without being emitted.
        expect(groups, hasLength(1),
            reason: 'only the second (post-duplicate-Start) group is emitted');
        expect(
          groups[0].whereType<TextMessageContentEvent>().single.delta,
          'second',
        );
      });

      test('maxOpenGroups cap evicts oldest open group when exceeded',
          () async {
        // Regression for Opus2 S4: the maxOpenGroups cap eviction path
        // previously lacked a regression guard.
        final controller = StreamController<BaseEvent>();
        final groups = <List<BaseEvent>>[];
        final subscription = EventStreamAdapter.groupRelatedEvents(
          controller.stream,
          maxOpenGroups: 2,
        ).listen(groups.add);

        controller.add(TextMessageStartEvent(messageId: 'm1'));
        controller.add(TextMessageStartEvent(messageId: 'm2'));
        // Third Start exceeds cap — evicts m1 (oldest insertion-order entry).
        controller.add(TextMessageStartEvent(messageId: 'm3'));

        await controller.close();
        await subscription.cancel();

        // m1 is evicted immediately when m3 arrives; m2 and m3 are flushed
        // on stream close. Total: 3 groups emitted.
        expect(groups, hasLength(3),
            reason: 'evicted m1 + stream-close flush of m2 and m3');
        // The evicted group is the first emitted.
        expect(
          groups[0].whereType<TextMessageStartEvent>().single.messageId,
          'm1',
        );
      });
    });

    group('accumulateTextMessages', () {
      test('accumulates text message content', () async {
        final controller = StreamController<BaseEvent>();
        final accumulated = EventStreamAdapter.accumulateTextMessages(
          controller.stream,
        );

        final messages = <String>[];
        final subscription = accumulated.listen(messages.add);

        // Complete message
        controller.add(TextMessageStartEvent(messageId: 'msg1'));
        controller
            .add(TextMessageContentEvent(messageId: 'msg1', delta: 'Hello'));
        controller.add(TextMessageContentEvent(messageId: 'msg1', delta: ', '));
        controller
            .add(TextMessageContentEvent(messageId: 'msg1', delta: 'world!'));
        controller.add(TextMessageEndEvent(messageId: 'msg1'));

        await controller.close();
        await subscription.cancel();

        expect(messages.length, equals(1));
        expect(messages[0], equals('Hello, world!'));
      });

      test('handles multiple concurrent messages', () async {
        final controller = StreamController<BaseEvent>();
        final accumulated = EventStreamAdapter.accumulateTextMessages(
          controller.stream,
        );

        final messages = <String>[];
        final subscription = accumulated.listen(messages.add);

        // Interleaved messages
        controller.add(TextMessageStartEvent(messageId: 'msg1'));
        controller.add(TextMessageStartEvent(messageId: 'msg2'));
        controller
            .add(TextMessageContentEvent(messageId: 'msg1', delta: 'First'));
        controller
            .add(TextMessageContentEvent(messageId: 'msg2', delta: 'Second'));
        controller.add(TextMessageEndEvent(messageId: 'msg1'));
        controller
            .add(TextMessageContentEvent(messageId: 'msg2', delta: ' message'));
        controller.add(TextMessageEndEvent(messageId: 'msg2'));

        await controller.close();
        await subscription.cancel();

        expect(messages.length, equals(2));
        expect(messages[0], equals('First'));
        expect(messages[1], equals('Second message'));
      });

      test('handles chunk events', () async {
        final controller = StreamController<BaseEvent>();
        final accumulated = EventStreamAdapter.accumulateTextMessages(
          controller.stream,
        );

        final messages = <String>[];
        final subscription = accumulated.listen(messages.add);

        // Chunk events (complete content in single event)
        controller.add(TextMessageChunkEvent(
          messageId: 'msg1',
          delta: 'Complete message 1',
        ));
        controller.add(TextMessageChunkEvent(
          messageId: 'msg2',
          delta: 'Complete message 2',
        ));

        await controller.close();
        await subscription.cancel();

        expect(messages.length, equals(2));
        expect(messages[0], equals('Complete message 1'));
        expect(messages[1], equals('Complete message 2'));
      });

      test('ignores non-text message events', () async {
        final controller = StreamController<BaseEvent>();
        final accumulated = EventStreamAdapter.accumulateTextMessages(
          controller.stream,
        );

        final messages = <String>[];
        final subscription = accumulated.listen(messages.add);

        controller.add(RunStartedEvent(threadId: 't1', runId: 'r1'));
        controller.add(TextMessageStartEvent(messageId: 'msg1'));
        controller.add(ToolCallStartEvent(
          toolCallId: 'tool1',
          toolCallName: 'search',
        ));
        controller
            .add(TextMessageContentEvent(messageId: 'msg1', delta: 'Test'));
        controller.add(StateSnapshotEvent(snapshot: {}));
        controller.add(TextMessageEndEvent(messageId: 'msg1'));

        await controller.close();
        await subscription.cancel();

        expect(messages.length, equals(1));
        expect(messages[0], equals('Test'));
      });

      test('Start→End with no content emits nothing (S11 fix)', () async {
        // Regression for Opus2 S11: empty Start→End cycles previously emitted
        // an empty string. Now they are skipped — consistent with the onDone
        // flush which already drops empty buffers.
        final controller = StreamController<BaseEvent>();
        final accumulated = EventStreamAdapter.accumulateTextMessages(
          controller.stream,
        );

        final messages = <String>[];
        final subscription = accumulated.listen(messages.add);

        controller.add(TextMessageStartEvent(messageId: 'msg1'));
        controller.add(TextMessageEndEvent(messageId: 'msg1'));

        await controller.close();
        await subscription.cancel();

        expect(messages.length, equals(0),
            reason: 'empty Start→End cycle must not emit an empty string');
      });

      test('flushes partial content on stream close without TextMessageEnd',
          () async {
        // Regression: When the upstream closes abnormally (no TextMessageEnd),
        // accumulated content must be flushed rather than silently discarded.
        // Mirrors groupRelatedEvents which emits incomplete groups on close.
        final controller = StreamController<BaseEvent>();
        final accumulated = EventStreamAdapter.accumulateTextMessages(
          controller.stream,
        );

        final messages = <String>[];
        final completer = Completer<void>();
        final subscription = accumulated.listen(
          messages.add,
          onDone: completer.complete,
        );

        controller.add(TextMessageStartEvent(messageId: 'msg1'));
        controller
            .add(TextMessageContentEvent(messageId: 'msg1', delta: 'partial'));
        // No TextMessageEndEvent — simulates abnormal stream close
        await controller.close();
        await completer.future;
        await subscription.cancel();

        expect(messages.length, equals(1));
        expect(messages[0], equals('partial'));
      });

      test(
          'accumulateTextMessages duplicate Start drops prior buffered content',
          () async {
        // Regression for Opus2 S4: a duplicate TextMessageStart (same
        // messageId while a buffer is open) should discard the prior buffer
        // and start fresh — matching the groupRelatedEvents last-Start-wins
        // policy at the content-accumulation layer.
        final controller = StreamController<BaseEvent>();
        final accumulated =
            EventStreamAdapter.accumulateTextMessages(controller.stream);

        final messages = <String>[];
        final completer = Completer<void>();
        final subscription = accumulated.listen(
          messages.add,
          onDone: completer.complete,
        );

        controller.add(TextMessageStartEvent(messageId: 'msg1'));
        controller
            .add(TextMessageContentEvent(messageId: 'msg1', delta: 'first'));
        // Duplicate Start — prior buffered content should be dropped.
        controller.add(TextMessageStartEvent(messageId: 'msg1'));
        controller
            .add(TextMessageContentEvent(messageId: 'msg1', delta: 'second'));
        controller.add(TextMessageEndEvent(messageId: 'msg1'));

        await controller.close();
        await completer.future;
        await subscription.cancel();

        // Only the second message body should be emitted.
        expect(messages, hasLength(1));
        expect(messages[0], equals('second'));
      });

      test(
          'accumulateTextMessages buffers chunk-before-Start and folds it '
          'into the Start+Content+End sequence without duplicate emission',
          () async {
        // Verifies the fix for the pre-Start chunk hazard: a Chunk that
        // arrives before its Start is now buffered (not emitted immediately),
        // then drained into the active buffer when Start arrives. The final
        // emission is a single string containing both the pre-Start chunk
        // and any subsequent Content, preventing the duplicate-emission bug
        // that the original TODO at stream_adapter.dart:1026-1035 described.
        final controller = StreamController<BaseEvent>();
        final accumulated =
            EventStreamAdapter.accumulateTextMessages(controller.stream);

        final messages = <String>[];
        final completer = Completer<void>();
        final subscription = accumulated.listen(
          messages.add,
          onDone: completer.complete,
        );

        // Chunk arrives before Start — must be buffered, not emitted yet.
        controller.add(
            TextMessageChunkEvent(messageId: 'msg1', delta: 'pre-start'));
        controller.add(TextMessageStartEvent(messageId: 'msg1'));
        controller
            .add(TextMessageContentEvent(messageId: 'msg1', delta: 'body'));
        controller.add(TextMessageEndEvent(messageId: 'msg1'));

        await controller.close();
        await completer.future;
        await subscription.cancel();

        // Fixed behavior: pre-Start chunk is drained into the active buffer
        // when Start arrives, so a single emission contains the full text.
        expect(messages, hasLength(1));
        expect(messages[0], equals('pre-startbody'));
      });
    });
  });

  _reentrancyContractTests();
}

// I-5 re-entrancy contract tests live at the top level so they can use
// private imports. These pin the StateError vs DecodingError distinction.
// fromRawSseStream uses sync: true internally; these tests verify externally
// observable error-type routing and per-invocation isolation.
void _reentrancyContractTests() {
  group('fromRawSseStream error-type contract (I-5)', () {
    test(
        'wire decode errors surface as DecodingError, not StateError (I-5)',
        () async {
      // I-5: Pins the distinction — StateError is the re-entrancy
      // programmer-error guard; ordinary wire errors become DecodingError.
      // If this expectation ever fails, the two error types have been merged
      // and the re-entrancy guard is no longer diagnosable.
      final adapter = EventStreamAdapter();
      final errors = <Object>[];
      final sub = adapter
          .fromRawSseStream(
        Stream.fromIterable(['data: invalid json\n\n']),
      )
          .listen(
        (_) {},
        onError: errors.add,
        cancelOnError: false,
      );

      await Future<void>.delayed(Duration.zero);
      await sub.cancel();

      expect(errors, hasLength(1));
      expect(errors[0], isA<DecodingError>(),
          reason: 'wire error must be DecodingError, not StateError');
      expect(errors[0], isNot(isA<StateError>()),
          reason: 'StateError is reserved for programmer-error re-entrancy');
    });

    test(
        'fromRawSseStream per-invocation isolation: sequential calls are '
        'independent (I-5)', () async {
      // I-5: Per-invocation locals in fromRawSseStream guarantee that two
      // sequential calls on the same adapter cannot share parser state
      // (buffer, dataBuffer, inDataBlock, lastWasLoneCr).
      final adapter = EventStreamAdapter();

      final events1 = await adapter.fromRawSseStream(
        Stream.fromIterable(
            ['data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}\n\n']),
      ).toList();

      final events2 = await adapter.fromRawSseStream(
        Stream.fromIterable([
          'data: {"type":"RUN_FINISHED","threadId":"t2","runId":"r2"}\n\n',
        ]),
      ).toList();

      expect(events1, hasLength(1));
      expect(events1.single, isA<RunStartedEvent>());
      expect(events2, hasLength(1));
      expect(events2.single, isA<RunFinishedEvent>());
    });
  });
}
