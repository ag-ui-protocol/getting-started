/// Default cap for SSE data buffers, shared by [SseParser] and
/// [EventStreamAdapter] to prevent the two layers from drifting apart.
///
/// Measured in UTF-16 code units (Dart's internal string unit). ASCII has a
/// 1:1 ratio; supplementary characters (emoji, etc.) count as two.
const int kSseDefaultMaxDataCodeUnits = 8 * 1024 * 1024;
