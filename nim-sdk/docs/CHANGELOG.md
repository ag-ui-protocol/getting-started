# AG-UI Nim SDK Changes

## Unreleased [Current Development]

### Added
- Added validation for all 16 standard event types
- Added proper handling for chunk events (TextMessageChunk, ToolCallChunk)
- Added validation for complex objects with optional fields
- Added optional field validation helpers (validateOptionalString, validateOptionalInt64, validateOptionalBool)
- Added tests for the validation module (test_validation.nim, test_complex_validation.nim)
- Added comprehensive validation for complex object types:
  - JSON Schema validation for tool parameters
  - RFC 6902 validation for JSON Patch operations
  - Function call argument validation with JSON syntax checking
  - Proper validation for nested structures
- Fixed and integrated stream utilities with working tests

### Fixed
- Fixed import paths in stream utilities (changed ../types to ./types)
- Fixed type mismatches in validation functions (content vs delta field names)
- Fixed timestamp handling for events (using int64 instead of int)
- Fixed the validateEvent function to handle all event types correctly
- Fixed the validateRunAgentInput function to better handle optional fields
- Fixed error reporting with more detailed path information

### Changed
- Updated TODO.md to reflect current status and progress
- Improved error handling with ValidationErrorKind enums for better categorization
- Enhanced type safety by using proper Option[T] types
- Added more detailed error messages with expected vs actual types
- Strengthened validation for empty strings and required fields
- Improved validation of StateDeltaEvent with proper JSON Patch validation

## v0.1.0 [Initial Implementation]

### Added
- Core AG-UI Protocol types and events with serialization
- Event encoding with SSE support
- Agent implementation with HTTP transport
- Stream utilities for state handling
- Event verification for validation
- Basic test coverage for core functionality