# AG-UI Nim SDK Changes

## Unreleased [2026-03-06]

### Added
- **Protocol Completeness**: Updated types and events to achieve full parity with the AG-UI protocol (matching Python SDK).
  - Added `parent_run_id` and `input` fields to `RunStartedEvent` and `RunAgentInput`.
  - Added `result` field to `RunFinishedEvent`.
  - Added `encrypted_value` to `ToolCall`, `ActivityMessage`, and `ReasoningMessage`.
  - Implemented `ActivityMessage` and `ReasoningMessage` types.
- **Environment Management**: Added `mise.toml` to manage Nim versioning (pinned to `2.2.8`).

### Changed
- **Toolchain Upgrade**: Upgraded Nim version from `1.6.0` to `2.2.8`.
- **CI/CD Improvements**: 
  - Updated GitHub Actions workflow (`unit-nim-sdk.yml`) to use `mise` for environment setup.
  - Pinned GitHub Actions to specific commit SHAs for enhanced security.
- **Repository Cleanup**: Removed build artifacts, binary files, and internal/AI working files (`TODO.md`, `CLAUDE.md`, etc.) from the repository.
- **Git Hygiene**: Updated root `.gitignore` to exclude `sdks/build/` and cleared existing binaries from git history.

### Fixed
- Fixed missing optional fields in JSON serialization/deserialization for core types.

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