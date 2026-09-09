# Deprecations

The registry for names this package still answers to but no longer documents.
An entry stays until the earliest-removal version ships; removal is a
deliberate release decision, not an automatic one.

| Name | Deprecated | Replacement | Why | Earliest removal |
| --- | --- | --- | --- | --- |
| `AbstractAgent.maxVersion` | 2026-09-02 | `AbstractAgent.maxProtocolVersion` | The old name said neither whose version it names nor that it is a ceiling — it is the most recent version the PEER speaks, distinct from the generated `PROTOCOL_VERSION` constant that names which spec revision this SDK implements. The alias returns the same value and warns once per process. | 2.0 |
