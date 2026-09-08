import 'package:test/test.dart';
import 'package:ag_ui/src/sse/backoff_strategy.dart';

void main() {
  group('ExponentialBackoff', () {
    test('calculates exponential backoff correctly', () {
      final backoff = ExponentialBackoff(
        initialDelay: Duration(seconds: 1),
        maxDelay: Duration(seconds: 30),
        multiplier: 2.0,
        jitterFactor: 0.0, // No jitter for predictable testing
      );

      // First attempt: 1s
      expect(backoff.nextDelay(0), Duration(seconds: 1));

      // Second attempt: 2s
      expect(backoff.nextDelay(1), Duration(seconds: 2));

      // Third attempt: 4s
      expect(backoff.nextDelay(2), Duration(seconds: 4));

      // Fourth attempt: 8s
      expect(backoff.nextDelay(3), Duration(seconds: 8));

      // Fifth attempt: 16s
      expect(backoff.nextDelay(4), Duration(seconds: 16));

      // Sixth attempt: 32s, but capped at 30s
      expect(backoff.nextDelay(5), Duration(seconds: 30));

      // Seventh attempt: still capped at 30s
      expect(backoff.nextDelay(6), Duration(seconds: 30));
    });

    test('applies jitter within expected bounds', () {
      final backoff = ExponentialBackoff(
        initialDelay: Duration(seconds: 10),
        maxDelay: Duration(seconds: 100),
        multiplier: 1.0, // Keep delay constant to test jitter
        jitterFactor: 0.3, // ±30% jitter
      );

      // Run multiple times to test jitter randomness
      for (var i = 0; i < 20; i++) {
        final delay = backoff.nextDelay(0);
        final delayMs = delay.inMilliseconds;

        // Expected: 10000ms ± 30% = 7000ms to 13000ms
        expect(delayMs, greaterThanOrEqualTo(7000));
        expect(delayMs, lessThanOrEqualTo(13000));
      }
    });
  });

  group('LegacyBackoffStrategy', () {
    test('maintains state with stateful nextDelay', () {
      final backoff = LegacyBackoffStrategy(
        initialDelay: Duration(seconds: 1),
        maxDelay: Duration(seconds: 30),
        multiplier: 2.0,
        jitterFactor: 0.0, // No jitter for predictable testing
      );

      // First attempt: 1s
      expect(backoff.nextDelayStateful(), Duration(seconds: 1));
      expect(backoff.attempt, 1);

      // Second attempt: 2s
      expect(backoff.nextDelayStateful(), Duration(seconds: 2));
      expect(backoff.attempt, 2);

      // Third attempt: 4s
      expect(backoff.nextDelayStateful(), Duration(seconds: 4));
      expect(backoff.attempt, 3);

      // Fourth attempt: 8s
      expect(backoff.nextDelayStateful(), Duration(seconds: 8));
      expect(backoff.attempt, 4);

      // Fifth attempt: 16s
      expect(backoff.nextDelayStateful(), Duration(seconds: 16));
      expect(backoff.attempt, 5);

      // Sixth attempt: 32s, but capped at 30s
      expect(backoff.nextDelayStateful(), Duration(seconds: 30));
      expect(backoff.attempt, 6);

      // Seventh attempt: still capped at 30s
      expect(backoff.nextDelayStateful(), Duration(seconds: 30));
      expect(backoff.attempt, 7);
    });

    test('reset() resets attempt counter', () {
      final backoff = LegacyBackoffStrategy(
        initialDelay: Duration(seconds: 1),
        jitterFactor: 0.0,
      );

      // Make several attempts
      backoff.nextDelayStateful();
      backoff.nextDelayStateful();
      backoff.nextDelayStateful();
      expect(backoff.attempt, 3);

      // Reset
      backoff.reset();
      expect(backoff.attempt, 0);

      // Next delay should be initial delay again
      expect(backoff.nextDelayStateful(), Duration(seconds: 1));
      expect(backoff.attempt, 1);
    });
  });
}
