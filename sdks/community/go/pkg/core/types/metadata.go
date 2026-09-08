package types

import "maps"

// AGUIMetadataKey is the key reserved for AG-UI's own use inside a metadata
// object. Every other key is user space.
//
// Reservation is by convention: nothing rejects a write to this key at runtime,
// because metadata is open by key and validating its shape would contradict
// that.
const AGUIMetadataKey = "ag-ui"

// Metadata is extra information attached to an event, a message, or a tool call.
//
// Open by key — any JSON value is allowed under a key, including nil. A nil
// value under a key is meaningful data and is preserved.
//
// Deliberately map[string]any rather than a recursive JSON-value type. Every
// dynamic payload in the protocol already uses the permissive form — State,
// RawEvent, CustomEvent.Value, InputContent.Metadata, Interrupt.Metadata — so
// tightening this one field would make it the sole outlier while fixing nothing
// elsewhere. A recursive validation would also walk every value on every event,
// on the streaming hot path, to catch a mistake that already fails loudly at
// encode time.
//
// The object itself is absent or a mapping. Go collapses an explicit JSON null
// into the same nil map as an absent field, and omitempty drops it again on the
// way out, so a null never survives a round trip. That matches Python and .NET;
// the TypeScript client is stricter and rejects a null metadata object outright.
type Metadata map[string]any

// MergeMetadata folds incoming into existing, key by key, with the last write
// winning.
//
// A message is assembled from a sequence of events, and the interesting values
// — token usage and finish reason among them — are only known at the end. So
// metadata accumulates as the sequence arrives rather than being fixed at the
// start.
//
// A key's value is replaced outright. This never recurses, so a slice or map
// under any key — including AGUIMetadataKey — is replaced wholesale rather than
// blended with what was there before.
//
// Returns a new map rather than mutating either argument. A nil incoming
// returns existing untouched; an empty incoming changes nothing.
func MergeMetadata(existing, incoming Metadata) Metadata {
	if incoming == nil {
		return existing
	}

	merged := make(Metadata, len(existing)+len(incoming))
	maps.Copy(merged, existing)
	maps.Copy(merged, incoming)

	return merged
}
