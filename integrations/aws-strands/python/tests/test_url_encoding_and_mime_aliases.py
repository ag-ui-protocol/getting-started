"""Tests for non-ASCII URL encoding and MIME type alias resolution."""

from __future__ import annotations

from unittest.mock import patch, MagicMock

import pytest

from ag_ui_strands.utils import _fetch_url_bytes, _mime_to_format


# ---------------------------------------------------------------------------
# _fetch_url_bytes — non-ASCII URL encoding
# ---------------------------------------------------------------------------


class TestFetchUrlBytesEncoding:
    """Verify that URLs with non-ASCII characters are percent-encoded."""

    @patch("ag_ui_strands.utils.urllib.request.urlopen")
    def test_ascii_url_unchanged(self, mock_urlopen):
        """A plain ASCII URL should be passed through without modification."""
        mock_resp = MagicMock()
        mock_resp.read.return_value = b"data"
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_resp

        result = _fetch_url_bytes("https://example.com/path/file.txt")

        assert result == b"data"
        called_url = mock_urlopen.call_args[0][0]
        assert called_url == "https://example.com/path/file.txt"

    @patch("ag_ui_strands.utils.urllib.request.urlopen")
    def test_chinese_filename_is_percent_encoded(self, mock_urlopen):
        """Chinese characters in the URL path must be percent-encoded."""
        mock_resp = MagicMock()
        mock_resp.read.return_value = b"content"
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_resp

        url = "https://cdn.example.com/docs/大模型学习路线.txt"
        result = _fetch_url_bytes(url)

        assert result == b"content"
        called_url = mock_urlopen.call_args[0][0]
        # The Chinese characters should be percent-encoded
        assert "大模型" not in called_url
        assert "%E5%A4%A7%E6%A8%A1%E5%9E%8B" in called_url
        # .txt extension should remain intact
        assert called_url.endswith(".txt")

    @patch("ag_ui_strands.utils.urllib.request.urlopen")
    def test_chinese_query_string_is_encoded(self, mock_urlopen):
        """Non-ASCII characters in query string must also be percent-encoded."""
        mock_resp = MagicMock()
        mock_resp.read.return_value = b"ok"
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_resp

        url = "https://example.com/doc/file.txt?name=大模型"
        _fetch_url_bytes(url)

        called_url = mock_urlopen.call_args[0][0]
        assert "大模型" not in called_url
        assert "name=%E5%A4%A7%E6%A8%A1%E5%9E%8B" in called_url

    @pytest.mark.parametrize(
        "query",
        [
            "next=/home/page&t=2021-01-01T00:00:00Z",
            "sig=ab/cd+ef=",
            "X-Amz-Credential=AKIA/20260807/us-east-1/s3/aws4_request",
            "redirect=http://x.com/?a=b",
        ],
    )
    @patch("ag_ui_strands.utils.urllib.request.urlopen")
    def test_ascii_query_string_unchanged(self, mock_urlopen, query):
        """ASCII query strings with RFC 3986 allowed chars must not be rewritten."""
        mock_resp = MagicMock()
        mock_resp.read.return_value = b"ok"
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_resp

        url = f"https://example.com/file.txt?{query}"
        _fetch_url_bytes(url)

        called_url = mock_urlopen.call_args[0][0]
        assert called_url == url

    @pytest.mark.parametrize(
        ("path", "expected_path"),
        [
            ("my%20file.txt", "my%20file.txt"),
            ("a%2Fb.txt", "a%2Fb.txt"),
            ("raw%FF.bin", "raw%FF.bin"),
            ("100%大.txt", "100%25%E5%A4%A7.txt"),
            ("50%off.pdf", "50%25off.pdf"),
        ],
    )
    @patch("ag_ui_strands.utils.urllib.request.urlopen")
    def test_path_percent_encoding(self, mock_urlopen, path, expected_path):
        """Valid %HH escapes are preserved; stray % becomes %25."""
        mock_resp = MagicMock()
        mock_resp.read.return_value = b"ok"
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_resp

        _fetch_url_bytes(f"https://example.com/{path}")

        called_url = mock_urlopen.call_args[0][0]
        assert called_url == f"https://example.com/{expected_path}"

    @patch("ag_ui_strands.utils.urllib.request.urlopen")
    def test_network_error_returns_none(self, mock_urlopen):
        """Network errors should return None, not raise."""
        mock_urlopen.side_effect = OSError("Connection refused")

        result = _fetch_url_bytes("https://example.com/file.txt")

        assert result is None


# ---------------------------------------------------------------------------
# _mime_to_format — alias resolution and parameter stripping
# ---------------------------------------------------------------------------


class TestMimeToFormatAliases:
    """Verify MIME subtypes are resolved via the alias table and parameters are stripped."""

    _DOC_ALLOWED = {"txt", "pdf", "csv", "doc", "docx", "html", "md", "xls", "xlsx"}
    _IMG_ALLOWED = {"png", "jpeg", "gif", "webp"}

    @pytest.mark.parametrize(
        ("mime_type", "expected"),
        [
            ("text/plain", "txt"),
            ("text/plain; charset=utf-8", "txt"),
            ("text/markdown", "md"),
            ("text/markdown; charset=utf-8", "md"),
            ("text/x-markdown", "md"),
            ("application/pdf", "pdf"),
            ("application/msword", "doc"),
            ("application/vnd.ms-excel", "xls"),
        ],
    )
    def test_document_mime_aliases(self, mime_type, expected):
        assert _mime_to_format(mime_type, self._DOC_ALLOWED) == expected

    @pytest.mark.parametrize(
        ("mime_type", "expected"),
        [
            ("image/png", "png"),
            ("image/jpeg", "jpeg"),
            ("image/jpg", "jpeg"),
        ],
    )
    def test_image_mime_aliases(self, mime_type, expected):
        assert _mime_to_format(mime_type, self._IMG_ALLOWED) == expected

    def test_unsupported_mime_returns_none(self):
        assert _mime_to_format("application/octet-stream", {"png", "jpeg"}) is None

    def test_none_mime_returns_none(self):
        assert _mime_to_format(None, {"txt", "pdf"}) is None

    def test_empty_string_mime_returns_none(self):
        assert _mime_to_format("", {"txt", "pdf"}) is None
