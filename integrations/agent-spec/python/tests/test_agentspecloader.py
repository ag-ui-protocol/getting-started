# Copyright © 2025 Oracle and/or its affiliates.
#
# This software is under the Apache License 2.0
# (LICENSE-APACHE or http://www.apache.org/licenses/LICENSE-2.0) or Universal Permissive License
# (UPL) 1.0 (LICENSE-UPL or https://oss.oracle.com/licenses/upl), at your option.
"""Tests for the runtime dispatch in load_agent_spec.

The langgraph/wayflow branches need the heavy framework loaders, but the
dispatch's error handling for an unknown runtime is pure and worth pinning.
"""

import pytest

from ag_ui_agentspec.agentspecloader import load_agent_spec


class TestLoadAgentSpecDispatch:
    def test_unsupported_runtime_raises_value_error(self):
        with pytest.raises(ValueError, match="Unsupported runtime"):
            load_agent_spec("crewai", "{}")  # type: ignore[arg-type]
