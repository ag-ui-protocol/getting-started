# Global config for all tests
# This file will apply to all tests in this directory

# Set path to src directory
switch("path", "../src")

# Set output directory for compiled binaries
import os
switch("out", "../build/tests/" & projectName().splitFile.name)

# Set nimcache location
switch("nimcache", "../build/nimcache")

# Debug info for testing
switch("debuginfo")
switch("debugger", "native")