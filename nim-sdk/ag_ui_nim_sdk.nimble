# Package Information
version       = "0.0.0"
author        = "jasagiri"
description   = "Nim SDK for AG-UI (Agent-User Interaction Protocol)"
license       = "MIT"
srcDir        = "src"
installExt    = @["nim"]
binDir        = "bin"

# Dependencies
requires "nim >= 1.6.0"
requires "chronos >= 3.0.0"

# Tasks
task test, "Run the test suite":
  exec "nim c -r tests/test_types.nim"
  exec "nim c -r tests/test_events.nim"
  exec "nim c -r tests/test_encoder.nim"
  exec "nim c -r tests/test_agent.nim"
  exec "nim c -r tests/test_http_agent.nim"
  exec "nim c -r tests/test_complex_validation.nim"
  # Enabled fixed tests
  exec "nim c -r tests/test_stream.nim"
  exec "nim c -r tests/test_verify.nim"
  exec "nim c -r tests/test_proto.nim"
  # exec "nim c -r tests/test_transform.nim"
  # exec "nim c -r tests/test_observable.nim"
  # exec "nim c -r tests/test_legacy.nim"

task testTypes, "Run types tests":
  exec "nim c -r tests/test_types.nim"

task testEvents, "Run events tests":
  exec "nim c -r tests/test_events.nim"

task testEncoder, "Run encoder tests":
  exec "nim c -r tests/test_encoder.nim"

task testAgent, "Run agent tests":
  exec "nim c -r tests/test_agent.nim"

task testHttpAgent, "Run HTTP agent tests":
  exec "nim c -r tests/test_http_agent.nim"

task testStream, "Run stream tests":
  exec "nim c -r tests/test_stream.nim"

task testVerify, "Run verification tests":
  exec "nim c -r tests/test_verify.nim"

task testTransform, "Run transformation tests":
  exec "nim c -r tests/test_transform.nim"

task testObservable, "Run observable tests":
  exec "nim c -r tests/test_observable.nim"

task testProto, "Run protocol buffer tests":
  exec "nim c -r tests/test_proto.nim"

task testLegacy, "Run legacy format tests":
  exec "nim c -r tests/test_legacy.nim"

task testValidation, "Run validation tests":
  exec "nim c -r tests/test_validation.nim"
  exec "nim c -r tests/test_complex_validation.nim"

task docs, "Generate documentation":
  exec "nim doc --project --index:on --outdir:htmldocs src/ag_ui_nim.nim"

task lint, "Run linting tools":
  exec "nim check --styleCheck:hint src/ag_ui_nim.nim"

task clean, "Clean build artifacts":
  exec "rm -rf htmldocs nimcache coverage build"
  echo "Cleaned build artifacts"

task build, "Build the project":
  exec "nim c -o:build/ag_ui_nim src/ag_ui_nim.nim"

task coverage, "Generate code coverage report":
  echo "Running tests with coverage flags enabled..."
  
  # Create coverage directory structure
  exec "mkdir -p coverage/nimcache coverage/reports"
  
  # Run tests with coverage flags
  # --passC:--coverage and --passL:--coverage enable GCC coverage
  exec "nim c --passC:--coverage --passL:--coverage --nimcache:coverage/nimcache -r --debugger:native --lineDir:on --debugInfo:on tests/test_types.nim"
  exec "nim c --passC:--coverage --passL:--coverage --nimcache:coverage/nimcache -r --debugger:native --lineDir:on --debugInfo:on tests/test_events.nim"
  exec "nim c --passC:--coverage --passL:--coverage --nimcache:coverage/nimcache -r --debugger:native --lineDir:on --debugInfo:on tests/test_encoder.nim"
  exec "nim c --passC:--coverage --passL:--coverage --nimcache:coverage/nimcache -r --debugger:native --lineDir:on --debugInfo:on tests/test_proto.nim"
  # Additional tests for 100% coverage
  exec "nim c --passC:--coverage --passL:--coverage --nimcache:coverage/nimcache -r --debugger:native --lineDir:on --debugInfo:on tests/test_coverage_complete.nim"
  exec "nim c --passC:--coverage --passL:--coverage --nimcache:coverage/nimcache -r --debugger:native --lineDir:on --debugInfo:on tests/test_events_complete.nim"
  exec "nim c --passC:--coverage --passL:--coverage --nimcache:coverage/nimcache -r --debugger:native --lineDir:on --debugInfo:on tests/test_encoder_complete.nim"
  exec "nim c --passC:--coverage --passL:--coverage --nimcache:coverage/nimcache -r --debugger:native --lineDir:on --debugInfo:on tests/test_proto_simple.nim"
  
  echo "Test coverage completed. Raw coverage data (.gcda files) generated in coverage/nimcache/"
  echo ""
  echo "To generate coverage reports, run:"
  echo "nimble coverageReport"

task coverageReport, "Generate coverage report from collected data":
  echo "Generating coverage report..."
  # Change to coverage directory to generate files there
  exec "cd coverage && gcov nimcache/*.gcda"
  # Move generated gcov files to reports directory
  exec "cd coverage && mv *.gcov reports/ 2>/dev/null || true"
  # Generate lcov report
  exec "lcov --capture --directory . --output-file coverage/coverage.info --ignore-errors mismatch"
  echo "Coverage report generated: coverage/coverage.info"
  echo "To generate HTML report, run: genhtml coverage/coverage.info --output-directory coverage/html"