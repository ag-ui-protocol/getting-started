"""A response stub for tests that drive :func:`_fetch_url_bytes`."""

from io import BytesIO
from unittest.mock import MagicMock


def stub_response(payload: bytes) -> MagicMock:
    """Return a response stub whose reads behave like a real stream.

    A bare ``MagicMock`` hands back the same bytes for every ``read`` and never
    signals EOF, so no bounded or chunked reader can terminate on it. Backing
    the stub with a ``BytesIO`` keeps the call recording while giving the
    reader real stream semantics.
    """
    stream = BytesIO(payload)
    read = lambda n=None: stream.read() if n is None else stream.read(n)  # noqa: E731
    resp = MagicMock()
    resp.read.side_effect = read
    resp.read1.side_effect = read
    resp.__enter__ = lambda s: s
    resp.__exit__ = MagicMock(return_value=False)
    return resp
