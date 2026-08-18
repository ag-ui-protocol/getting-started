#!/usr/bin/env python
"""Tests for utils/__init__.py module."""

import pytest


class TestUtilsInit:
    """Tests for utils module initialization."""

    def test_imports_available(self):
        """Test that all expected imports are available."""
        from ag_ui_adk.utils import (
            convert_ag_ui_messages_to_adk,
            convert_adk_event_to_ag_ui_message,
            convert_state_to_json_patch,
            convert_json_patch_to_state
        )

        # Should be able to import all expected functions
        assert callable(convert_ag_ui_messages_to_adk)
        assert callable(convert_adk_event_to_ag_ui_message)
        assert callable(convert_state_to_json_patch)
        assert callable(convert_json_patch_to_state)

    def test_module_has_all_attribute(self):
        """Test that the module has the correct __all__ attribute."""
        from ag_ui_adk import utils

        expected_all = [
            'convert_ag_ui_messages_to_adk',
            'convert_adk_event_to_ag_ui_message',
            'convert_state_to_json_patch',
            'convert_json_patch_to_state'
        ]

        assert hasattr(utils, '__all__')
        assert utils.__all__ == expected_all

    def test_direct_import_from_utils(self):
        """Test direct import from utils module."""
        from ag_ui_adk.utils import convert_ag_ui_messages_to_adk

        # Should be able to import directly from utils
        assert callable(convert_ag_ui_messages_to_adk)

        # Should be the same function as imported from converters
        from ag_ui_adk.utils.converters import convert_ag_ui_messages_to_adk as direct_import
        assert convert_ag_ui_messages_to_adk is direct_import

    def test_utils_module_docstring(self):
        """Test that the utils module has a proper docstring."""
        from ag_ui_adk import utils

        assert utils.__doc__ is not None
        assert "Utility functions for ADK middleware" in utils.__doc__

    def test_re_export_functionality(self):
        """Test that re-exported functions work correctly."""
        from ag_ui_adk.utils import convert_state_to_json_patch, convert_json_patch_to_state

        # Test basic functionality of re-exported functions
        state_delta = {"test_key": "test_value"}
        patches = convert_state_to_json_patch(state_delta)

        assert len(patches) == 1
        assert patches[0]["op"] == "add"
        assert patches[0]["path"] == "/test_key"
        assert patches[0]["value"] == "test_value"

        # Test roundtrip
        converted_back = convert_json_patch_to_state(patches)
        assert converted_back == state_delta
