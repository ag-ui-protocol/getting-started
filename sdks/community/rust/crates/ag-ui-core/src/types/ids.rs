use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::hash::{Hash, Hasher};
use std::ops::Deref;
use uuid::Uuid;

/// Namespace UUID for generating deterministic UUIDs from arbitrary strings.
/// Using OID namespace as it's appropriate for identifiers.
const ID_NAMESPACE: Uuid = Uuid::NAMESPACE_OID;

/// Macro to define a newtype ID whose identity is a protocol string, with a
/// derived UUID as a compatibility view.
///
/// These ID types support the AG-UI protocol, which identifies everything by
/// plain strings (the official TypeScript SDK types IDs as `string`; docs use
/// values like `msg_1`, `thread1`). This Rust SDK layers a UUID view on top
/// for callers that want one, but **the canonical protocol string is the
/// identity** — `PartialEq`, `Eq`, `Hash`, `Serialize`, and `Display` are all
/// keyed on it. The UUID is derived and MUST NOT be used for equality: two
/// different strings could (in principle) collide under UUID v5 hashing, and
/// treating the hash as identity would silently merge distinct protocol IDs
/// in a `HashMap`/`HashSet`.
///
/// The canonical string is:
/// - the original string, when constructed from a string (valid UUID or not)
/// - the UUID's canonical hyphenated form, when constructed from a `Uuid`
///   directly (`random()`, `From<Uuid>`)
///
/// For a non-UUID string, a deterministic UUID v5 hash (namespace + string)
/// is cached for `as_uuid()`. For a UUID (or valid-UUID string), `as_uuid()`
/// returns that exact UUID.
macro_rules! define_id_type {
    // This arm of the macro handles calls that don't specify extra derives.
    ($name:ident) => {
        define_id_type!($name,);
    };
    // This arm handles calls that do specify extra derives (like Eq).
    ($name:ident, $($extra_derive:ident),*) => {
        #[doc = concat!(stringify!($name), ": A newtype wrapper providing type-safe identifiers.")]
        ///
        /// Identity is the canonical protocol string (see module docs). A
        /// derived UUID is always available via [`Self::as_uuid`] but is not
        /// part of equality/hashing/serialization.
        #[derive(Debug, Clone, $($extra_derive),*)]
        pub struct $name {
            /// Canonical protocol string — the identity of this ID. Either
            /// the original string as received, or (for UUID-constructed
            /// ids) the UUID's canonical hyphenated form.
            raw: String,
            /// Derived UUID view: the exact UUID for UUID-constructed ids,
            /// or a deterministic UUID v5 hash of `raw` for arbitrary
            /// strings. Not part of identity — see module docs.
            uuid: Uuid,
            /// `true` if this ID was constructed from a string that is not
            /// itself a valid UUID.
            coerced: bool,
        }

        impl $name {
            /// Creates a new random ID.
            pub fn random() -> Self {
                let uuid = Uuid::new_v4();
                Self {
                    raw: uuid.to_string(),
                    uuid,
                    coerced: false,
                }
            }

            /// Creates a new ID from a string.
            ///
            /// The string itself becomes the identity (used for equality,
            /// hashing, and serialization). If it happens to be a valid
            /// UUID, `as_uuid()` returns that UUID directly; otherwise a
            /// deterministic UUID v5 hash is cached for `as_uuid()`.
            pub fn new(s: impl AsRef<str>) -> Self {
                let s = s.as_ref();
                match Uuid::parse_str(s) {
                    Ok(uuid) => Self {
                        raw: s.to_owned(),
                        uuid,
                        coerced: false,
                    },
                    Err(_) => Self {
                        raw: s.to_owned(),
                        uuid: Uuid::new_v5(&ID_NAMESPACE, s.as_bytes()),
                        coerced: true,
                    },
                }
            }

            /// Returns the derived UUID view.
            ///
            /// This is always available, even for non-UUID string IDs
            /// (in which case it's a deterministic hash of the original).
            /// This is a compatibility view, not the identity of the ID —
            /// use `==`/`Hash` (keyed on the protocol string) for equality.
            pub fn as_uuid(&self) -> &Uuid {
                &self.uuid
            }

            /// Returns `true` if this ID was created from a non-UUID string.
            ///
            /// Useful for logging/debugging to identify IDs that were coerced
            /// from arbitrary strings (e.g., LangGraph format).
            pub fn was_coerced(&self) -> bool {
                self.coerced
            }

            /// Returns the original string if this ID was coerced, or `None` if
            /// it was created from a valid UUID.
            pub fn original_string(&self) -> Option<&str> {
                self.coerced.then_some(self.raw.as_str())
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let s = String::deserialize(deserializer)?;
                Ok(Self::new(&s))
            }
        }

        impl Serialize for $name {
            fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
            where
                S: Serializer,
            {
                serializer.serialize_str(&self.raw)
            }
        }

        // Manual PartialEq: identity is the canonical protocol string.
        // Deriving equality from the UUID view would let two distinct
        // strings that collide under UUID v5 compare equal.
        impl PartialEq for $name {
            fn eq(&self, other: &Self) -> bool {
                self.raw == other.raw
            }
        }

        impl Eq for $name {}

        // Manual Hash: hash the canonical string, consistent with PartialEq.
        impl Hash for $name {
            fn hash<H: Hasher>(&self, state: &mut H) {
                self.raw.hash(state);
            }
        }

        /// Allows creating an ID from a Uuid. The UUID's canonical string
        /// form becomes the identity.
        impl From<Uuid> for $name {
            fn from(uuid: Uuid) -> Self {
                Self {
                    raw: uuid.to_string(),
                    uuid,
                    coerced: false,
                }
            }
        }

        /// Allows converting an ID back into a Uuid (the derived view).
        impl From<$name> for Uuid {
            fn from(id: $name) -> Self {
                id.uuid
            }
        }

        /// Allows getting a reference to the derived Uuid view.
        impl AsRef<Uuid> for $name {
            fn as_ref(&self) -> &Uuid {
                &self.uuid
            }
        }

        /// Allows printing the ID. Always shows the canonical protocol
        /// string (the identity).
        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "{}", self.raw)
            }
        }

        /// Allows parsing an ID from a string slice.
        ///
        /// Note: This accepts any string (not just valid UUIDs), matching
        /// the behavior of `new()` and `Deserialize`.
        impl std::str::FromStr for $name {
            type Err = std::convert::Infallible;

            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Ok(Self::new(s))
            }
        }

        /// Allows comparing the ID with a Uuid (compares the derived view).
        impl PartialEq<Uuid> for $name {
            fn eq(&self, other: &Uuid) -> bool {
                self.uuid == *other
            }
        }

        /// Allows comparing the ID with a string slice (compares identity).
        impl PartialEq<str> for $name {
            fn eq(&self, other: &str) -> bool {
                self.raw == other
            }
        }
    };
}

define_id_type!(AgentId);
define_id_type!(ThreadId);
define_id_type!(RunId);
define_id_type!(MessageId);

/// A tool call ID.
/// Used by some providers to denote a specific ID for a tool call generation,
/// where the result of the tool call must also use this ID.
///
/// Unlike other ID types, ToolCallId uses plain strings without UUID conversion,
/// as tool call IDs follow provider-specific formats (e.g., OpenAI's `call_xxx`).
#[derive(Debug, PartialEq, Eq, Deserialize, Serialize, Clone, Hash)]
pub struct ToolCallId(String);

/// Tool Call ID
///
/// Does not follow UUID format, instead uses provider-specific formats
/// like "call_xxxxxxxx" for OpenAI.
impl ToolCallId {
    pub fn random() -> Self {
        let uuid = &Uuid::new_v4().to_string()[..8];
        let id = format!("call_{uuid}");
        Self(id)
    }

    /// Creates a new ToolCallId from a string.
    ///
    /// The string is used directly as the ID value.
    pub fn new(s: impl Into<String>) -> Self {
        Self(s.into())
    }
}

impl Deref for ToolCallId {
    type Target = str;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Test whether tool call ID has same format as rest of AG-UI
    #[test]
    fn test_tool_call_random() {
        let id = super::ToolCallId::random();
        assert_eq!(id.0.len(), 5 + 8);
        assert!(id.0.starts_with("call_"));
        dbg!(id);
    }

    #[test]
    fn test_message_id_deserialize_valid_uuid() {
        let uuid_str = "\"550e8400-e29b-41d4-a716-446655440000\"";
        let id: MessageId = serde_json::from_str(uuid_str).unwrap();
        assert_eq!(id.to_string(), "550e8400-e29b-41d4-a716-446655440000");
        assert!(!id.was_coerced());
    }

    #[test]
    fn test_message_id_deserialize_langgraph_format() {
        // LangGraph uses "lc_run--<uuid>" format which is NOT a valid UUID
        let langgraph_id = "\"lc_run--019bcffd-726e-7ca1-9708-98f26a168272\"";
        let id: MessageId = serde_json::from_str(langgraph_id).unwrap();

        // Should not panic, and should produce a deterministic UUID
        assert!(!id.to_string().is_empty());
        assert!(id.was_coerced());

        // Verify it's deterministic (same input = same output)
        let id2: MessageId = serde_json::from_str(langgraph_id).unwrap();
        assert_eq!(id, id2);
    }

    #[test]
    fn test_run_id_deserialize_non_uuid_string() {
        let arbitrary_id = "\"my-custom-run-id-123\"";
        let id: RunId = serde_json::from_str(arbitrary_id).unwrap();
        assert!(!id.to_string().is_empty());
        assert!(id.was_coerced());

        // Verify determinism
        let id2: RunId = serde_json::from_str(arbitrary_id).unwrap();
        assert_eq!(id, id2);
    }

    #[test]
    fn test_new_and_deserialize_produce_same_result() {
        // The new() method and deserialize should produce the same UUID for the same input
        let langgraph_id = "lc_run--019bcffd-726e-7ca1-9708-98f26a168272";
        let from_new = MessageId::new(langgraph_id);
        let from_deser: MessageId = serde_json::from_str(&format!("\"{}\"", langgraph_id)).unwrap();
        assert_eq!(from_new, from_deser);
    }

    #[test]
    fn test_serialize_roundtrip_valid_uuid() {
        let original = MessageId::random();
        let serialized = serde_json::to_string(&original).unwrap();
        let deserialized: MessageId = serde_json::from_str(&serialized).unwrap();
        assert_eq!(original, deserialized);
        assert!(!deserialized.was_coerced());
    }

    // New tests for round-trip fidelity with non-UUID strings

    #[test]
    fn test_serialize_roundtrip_langgraph_format() {
        // This is the key test: non-UUID strings should round-trip perfectly
        let langgraph_id = "lc_run--019bcffd-726e-7ca1-9708-98f26a168272";
        let id = MessageId::new(langgraph_id);

        // Serialize should produce the original string, not a UUID
        let serialized = serde_json::to_string(&id).unwrap();
        assert_eq!(serialized, format!("\"{}\"", langgraph_id));

        // Deserialize should produce an equal ID
        let deserialized: MessageId = serde_json::from_str(&serialized).unwrap();
        assert_eq!(id, deserialized);
        assert!(deserialized.was_coerced());
        assert_eq!(deserialized.original_string(), Some(langgraph_id));
    }

    #[test]
    fn test_serialize_roundtrip_arbitrary_string() {
        let arbitrary_id = "my-custom-run-id-123";
        let id = RunId::new(arbitrary_id);

        let serialized = serde_json::to_string(&id).unwrap();
        assert_eq!(serialized, format!("\"{}\"", arbitrary_id));

        let deserialized: RunId = serde_json::from_str(&serialized).unwrap();
        assert_eq!(id, deserialized);
    }

    #[test]
    fn test_display_preserves_original() {
        let langgraph_id = "lc_run--019bcffd-726e-7ca1-9708-98f26a168272";
        let id = MessageId::new(langgraph_id);

        // Display should show the original string, not the hashed UUID
        assert_eq!(id.to_string(), langgraph_id);
    }

    #[test]
    fn test_display_shows_uuid_for_valid_uuid() {
        let uuid_str = "550e8400-e29b-41d4-a716-446655440000";
        let id = MessageId::new(uuid_str);

        // Display should show the UUID
        assert_eq!(id.to_string(), uuid_str);
        assert!(!id.was_coerced());
    }

    #[test]
    fn test_was_coerced_flag() {
        let uuid_id = MessageId::new("550e8400-e29b-41d4-a716-446655440000");
        assert!(!uuid_id.was_coerced());
        assert!(uuid_id.original_string().is_none());

        let coerced_id = MessageId::new("not-a-uuid");
        assert!(coerced_id.was_coerced());
        assert_eq!(coerced_id.original_string(), Some("not-a-uuid"));
    }

    #[test]
    fn test_as_uuid_always_available() {
        let uuid_str = "550e8400-e29b-41d4-a716-446655440000";
        let uuid_id = MessageId::new(uuid_str);
        assert_eq!(uuid_id.as_uuid(), &Uuid::parse_str(uuid_str).unwrap());

        let coerced_id = MessageId::new("not-a-uuid");
        // as_uuid should return a valid UUID (the v5 hash)
        let uuid = coerced_id.as_uuid();
        assert!(!uuid.is_nil());
    }

    #[test]
    fn test_hash_consistency() {
        use std::collections::HashMap;

        let id1 = ThreadId::new("lc_run--abc");
        let id2 = ThreadId::new("lc_run--abc");

        let mut map = HashMap::new();
        map.insert(id1.clone(), "value1");

        // id2 should find the same entry as id1
        assert_eq!(map.get(&id2), Some(&"value1"));
    }

    #[test]
    fn test_equality_with_string() {
        let langgraph_id = "lc_run--019bcffd-726e-7ca1-9708-98f26a168272";
        let id = MessageId::new(langgraph_id);

        // Should be equal to the original string
        assert!(id == *langgraph_id);
    }

    #[test]
    fn test_from_uuid() {
        let uuid = Uuid::new_v4();
        let id: MessageId = uuid.into();

        assert!(!id.was_coerced());
        assert_eq!(id.as_uuid(), &uuid);
    }

    #[test]
    fn test_into_uuid() {
        let original_uuid = Uuid::new_v4();
        let id: MessageId = original_uuid.into();
        let recovered: Uuid = id.into();

        assert_eq!(original_uuid, recovered);
    }

    #[test]
    fn test_from_str_accepts_any_string() {
        // FromStr should now accept any string, not just UUIDs
        let id: MessageId = "not-a-uuid".parse().unwrap();
        assert!(id.was_coerced());

        let id2: MessageId = "550e8400-e29b-41d4-a716-446655440000".parse().unwrap();
        assert!(!id2.was_coerced());
    }

    #[test]
    fn test_uuid_v5_is_deterministic() {
        // Verify that UUID v5 produces the same result for the same input
        let input = "lc_run--019bcffd-726e-7ca1-9708-98f26a168272";

        let id1 = MessageId::new(input);
        let id2 = MessageId::new(input);

        // Both should have the same internal UUID
        assert_eq!(id1.as_uuid(), id2.as_uuid());

        // And that UUID should be deterministic
        let expected = Uuid::new_v5(&ID_NAMESPACE, input.as_bytes());
        assert_eq!(id1.as_uuid(), &expected);
    }

    // --- Identity is the protocol string, not the derived UUID ---

    #[test]
    fn test_same_string_is_equal_and_hash_equal() {
        use std::collections::hash_map::DefaultHasher;

        let a = ThreadId::new("thread-abc");
        let b = ThreadId::new("thread-abc");
        assert_eq!(a, b);

        let mut hasher_a = DefaultHasher::new();
        let mut hasher_b = DefaultHasher::new();
        a.hash(&mut hasher_a);
        b.hash(&mut hasher_b);
        assert_eq!(hasher_a.finish(), hasher_b.finish());
    }

    #[test]
    fn test_different_strings_are_not_equal() {
        let a = ThreadId::new("thread-abc");
        let b = ThreadId::new("thread-xyz");
        assert_ne!(a, b);
    }

    #[test]
    fn test_string_constructed_id_survives_serde_roundtrip_as_equal() {
        let id = RunId::new("arbitrary-run-id");
        let serialized = serde_json::to_string(&id).unwrap();
        let roundtripped: RunId = serde_json::from_str(&serialized).unwrap();
        assert_eq!(
            id, roundtripped,
            "serialize -> deserialize must preserve identity"
        );
    }

    #[test]
    fn test_valid_uuid_string_roundtrips_to_canonical_uuid_string() {
        let uuid = Uuid::new_v4();
        let id = MessageId::new(uuid.to_string());

        // Canonical string form is the UUID itself, and as_uuid() returns it.
        assert_eq!(id.to_string(), uuid.to_string());
        assert_eq!(id.as_uuid(), &uuid);
        assert!(!id.was_coerced());

        let serialized = serde_json::to_string(&id).unwrap();
        assert_eq!(serialized, format!("\"{}\"", uuid));
        let deserialized: MessageId = serde_json::from_str(&serialized).unwrap();
        assert_eq!(id, deserialized);
        assert_eq!(deserialized.as_uuid(), &uuid);
    }

    #[test]
    fn test_identity_is_independent_of_backing_uuid() {
        // Directly construct two ids that share the same derived UUID (as if
        // two different strings had collided under UUID v5) but have
        // different canonical strings. Equality must be decided by the
        // string, not the UUID -- this is the property that keeps
        // HashMap/HashSet keys from silently merging distinct protocol IDs.
        let shared_uuid = Uuid::new_v5(&ID_NAMESPACE, b"irrelevant-for-this-test");
        let a = MessageId {
            raw: "string-a".to_string(),
            uuid: shared_uuid,
            coerced: true,
        };
        let b = MessageId {
            raw: "string-b".to_string(),
            uuid: shared_uuid,
            coerced: true,
        };

        assert_eq!(a.as_uuid(), b.as_uuid(), "precondition: same derived UUID");
        assert_ne!(a, b, "different canonical strings must not compare equal");
    }

    #[test]
    fn test_different_uuid_spellings_of_same_uuid_are_distinct_ids() {
        use std::collections::hash_map::DefaultHasher;

        // Simple (no hyphens) and hyphenated spellings of the SAME uuid.
        let simple = "67e5504410b1426f9247bb680e5fe0c8";
        let hyphenated = "67e55044-10b1-426f-9247-bb680e5fe0c8";

        // Precondition: Uuid::parse_str treats both as the same uuid.
        assert_eq!(
            Uuid::parse_str(simple).unwrap(),
            Uuid::parse_str(hyphenated).unwrap()
        );

        let a = MessageId::new(simple);
        let b = MessageId::new(hyphenated);

        // Both are valid-UUID-shaped strings, so neither is "coerced" ...
        assert!(!a.was_coerced());
        assert!(!b.was_coerced());
        // ... but they are different protocol strings, so they must be
        // distinct ids: not equal, and not hash-equal.
        assert_ne!(
            a, b,
            "different spellings of the same uuid must not be equal"
        );

        let mut hasher_a = DefaultHasher::new();
        let mut hasher_b = DefaultHasher::new();
        a.hash(&mut hasher_a);
        b.hash(&mut hasher_b);
        assert_ne!(
            hasher_a.finish(),
            hasher_b.finish(),
            "different spellings of the same uuid should not hash-collide \
             (not guaranteed in general, but true for DefaultHasher over \
             these two distinct strings, and required for HashSet distinctness)"
        );

        // Both still resolve to the same underlying uuid via the derived view.
        assert_eq!(a.as_uuid(), b.as_uuid());
    }

    #[test]
    fn test_hyphenated_uuid_input_serializes_and_displays_exactly() {
        let hyphenated = "67e55044-10b1-426f-9247-bb680e5fe0c8";
        let id = MessageId::new(hyphenated);

        // Display must be byte-identical to the exact input string, not
        // re-canonicalized (even though in this case the input already IS
        // the canonical hyphenated form, `new()` must not reconstruct it
        // via `Uuid::to_string()`).
        assert_eq!(id.to_string(), hyphenated);
        assert_eq!(id.to_string().as_bytes(), hyphenated.as_bytes());

        let serialized = serde_json::to_string(&id).unwrap();
        assert_eq!(serialized, format!("\"{}\"", hyphenated));

        let deserialized: MessageId = serde_json::from_str(&serialized).unwrap();
        assert_eq!(id, deserialized);
        assert_eq!(deserialized.to_string(), hyphenated);
    }

    #[test]
    fn test_simple_uuid_input_preserves_exact_spelling() {
        // A "simple" (no-hyphen) valid-UUID-shaped string must round-trip
        // as itself, not get rewritten into the hyphenated canonical form.
        let simple = "67e5504410b1426f9247bb680e5fe0c8";
        let id = MessageId::new(simple);

        assert!(!id.was_coerced());
        assert_eq!(id.to_string(), simple);

        let serialized = serde_json::to_string(&id).unwrap();
        assert_eq!(serialized, format!("\"{}\"", simple));

        let deserialized: MessageId = serde_json::from_str(&serialized).unwrap();
        assert_eq!(id, deserialized);
        assert_eq!(deserialized.to_string(), simple);
    }
}
