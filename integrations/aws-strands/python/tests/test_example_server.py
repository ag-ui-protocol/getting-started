"""The dojo server under `examples/server` that mounts every demo.

The demo modules build a Strands agent and reach for a provider SDK at import
time, so `server.api` is replaced here with stand-ins built the same way the
demos build theirs. That leaves the real dojo app under test: its CORS
configuration, its mounts, its route listing and its entry point. What the
stand-ins cannot cover is whether each demo really is wired that way, so a
separate test reads the demo sources for it.
"""

from __future__ import annotations

import ast
import importlib.util
import runpy
import sys
import types
import warnings
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.routing import Mount

from ag_ui_strands.utils import create_strands_app

EXAMPLES = Path(__file__).parent.parent / "examples"
DEMOS = EXAMPLES / "server" / "api"
README = Path(__file__).parent.parent / "README.md"
EXAMPLES_README = EXAMPLES / "README.md"

ALLOWED_ORIGIN = "http://localhost:3000"
DISALLOWED_ORIGIN = "https://evil.example"


def _load_settings():
    """`examples/server/settings.py`, loaded without running the package."""
    spec = importlib.util.spec_from_file_location(
        "_strands_example_settings", EXAMPLES / "server" / "settings.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


settings = _load_settings()


def _demo_app(name: str, origins: list[str] | None) -> FastAPI:
    """A stand-in for one demo, built the way the demo modules build theirs."""
    if origins is None:
        # The pre-fix shape, which one test needs on purpose; its FutureWarning
        # is expected here and must not be suppressed for any other call.
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", FutureWarning)
            return create_strands_app(SimpleNamespace(name=name), "/", origins=None)
    return create_strands_app(SimpleNamespace(name=name), "/", origins=origins)


@pytest.fixture
def dojo(monkeypatch):
    """Import the real `server` package with its demo apps stood in for.

    Returns a factory taking the CORS_ALLOW_ORIGINS value to import under, so
    each test sees the module-level app built from its own environment.
    """
    monkeypatch.syspath_prepend(str(EXAMPLES))
    # monkeypatch can undo the entries it sets, but `import server` ADDS entries
    # it never saw, so they would outlive the test and hand the next one a
    # package wired to the stand-ins.
    preexisting = {n: m for n, m in sys.modules.items() if _is_server_module(n)}

    def build(
        cors_allow_origins: str | None = None,
        demo_origins: object = "shared",
        probed: tuple[str, ...] = settings.DEMO_PATHS,
    ):
        # A bare string would substring-match in the membership test below, so
        # probed="/agentic-chat-reasoning" would quietly also probe
        # "/agentic-chat".
        assert isinstance(probed, tuple), "probed must be a tuple of paths"
        if cors_allow_origins is None:
            monkeypatch.delenv(settings.CORS_ORIGINS_VAR, raising=False)
        else:
            monkeypatch.setenv(settings.CORS_ORIGINS_VAR, cors_allow_origins)

        # `load_dotenv` would otherwise read whatever `examples/.env` a
        # developer happens to have, which decides the very thing under test.
        monkeypatch.setitem(
            sys.modules, "dotenv", SimpleNamespace(load_dotenv=lambda **kwargs: None)
        )

        origins = settings.cors_origins() if demo_origins == "shared" else demo_origins
        # Every demo path is mounted either way. Only the ones a test actually
        # sends a request to need the real factory-built app; `create_strands_app`
        # generates a JSON schema per call, which costs about a second for the
        # full set, and the demos a test never probes only have to exist.
        api = types.ModuleType("server.api")
        for path in settings.DEMO_PATHS:
            app = (
                _demo_app(settings.mount_name(path), origins)
                if path in probed
                else FastAPI()
            )
            setattr(api, settings.app_attribute(path), app)
        monkeypatch.setitem(sys.modules, "server.api", api)

        # Plain del, not monkeypatch.delitem: monkeypatch would restore these
        # after this fixture's own teardown has already cleared them, putting
        # stand-in-wired modules back for the next test.
        for name in [n for n in sys.modules if _is_server_module(n) and n != "server.api"]:
            del sys.modules[name]

        import server

        return server

    yield build

    for name in [n for n in sys.modules if _is_server_module(n)]:
        del sys.modules[name]
    sys.modules.update(preexisting)


def _is_server_module(name: str) -> bool:
    return name == "server" or name.startswith("server.")


# ---------------------------------------------------------------------------
# Cross-origin behaviour across the two layers
# ---------------------------------------------------------------------------


def test_a_disallowed_origin_is_not_granted_access_to_a_mounted_demo(dojo):
    client = TestClient(dojo(ALLOWED_ORIGIN).app)

    resp = client.get("/agentic-chat/ping", headers={"Origin": DISALLOWED_ORIGIN})

    assert resp.status_code == 200
    assert resp.headers.get("access-control-allow-origin") is None


def test_the_dojo_app_applies_the_allowlist_to_its_own_routes(dojo):
    """`/` belongs to the dojo, not to any mount, so only its own middleware
    can answer for it. Without this, deleting that middleware outright leaves
    the suite almost entirely green."""
    client = TestClient(dojo(ALLOWED_ORIGIN).app)

    granted = client.get("/", headers={"Origin": ALLOWED_ORIGIN})
    refused = client.get("/", headers={"Origin": DISALLOWED_ORIGIN})

    assert granted.headers.get("access-control-allow-origin") == ALLOWED_ORIGIN
    assert granted.headers.get("access-control-allow-credentials") == "true"
    assert refused.headers.get("access-control-allow-origin") is None


def test_the_dojo_app_refuses_a_preflight_for_its_own_routes(dojo):
    client = TestClient(dojo(ALLOWED_ORIGIN).app)

    resp = client.options(
        "/",
        headers={
            "Origin": DISALLOWED_ORIGIN,
            "Access-Control-Request-Method": "GET",
        },
    )

    assert resp.status_code == 400


def test_a_preflight_is_answered_before_routing_reaches_a_mount(dojo):
    """Why the leak was bounded: a preflight never reaches a demo at all.

    The dojo's middleware answers OPTIONS before the request is routed, so the
    agent endpoints stayed unreachable cross-origin even while a demo was
    answering simple requests with a wildcard. A path that does not exist gets
    the same answer, which is what makes this the dojo's decision and not a
    demo's.
    """
    client = TestClient(dojo(ALLOWED_ORIGIN).app)
    headers = {
        "Origin": ALLOWED_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
    }

    mounted = client.options("/agentic-chat/", headers=headers)
    absent = client.options("/does-not-exist/", headers=headers)

    assert mounted.status_code == absent.status_code == 200
    assert mounted.headers.get("access-control-allow-origin") == ALLOWED_ORIGIN
    assert absent.headers.get("access-control-allow-origin") == ALLOWED_ORIGIN


@pytest.mark.parametrize("typo", ["/", "*/", "//", ",", " / "])
def test_a_typo_in_the_allowlist_does_not_let_an_evil_origin_through(dojo, typo):
    """The whole point of setting the variable is to refuse somebody.

    Both spellings used to resolve to the wildcard: "/" trimmed to empty and
    dropped out of the list, leaving it empty, and "*/" trimmed to "*". The
    preflight below then succeeded for any origin at all.
    """
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        app = dojo(typo, probed=("/agentic-chat",)).app
    client = TestClient(app)

    simple = client.get("/agentic-chat/ping", headers={"Origin": DISALLOWED_ORIGIN})
    preflight = client.options(
        "/agentic-chat/",
        headers={
            "Origin": DISALLOWED_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )

    assert simple.headers.get("access-control-allow-origin") is None
    assert preflight.status_code == 400


def test_a_written_but_unusable_allowlist_is_reported_at_startup(dojo):
    """It refuses the operator's own frontend, so it cannot be silent."""
    with pytest.warns(UserWarning, match="names no origin a browser can send"):
        dojo("/", probed=())


def test_an_unset_allowlist_is_reported_as_unset(dojo):
    with pytest.warns(UserWarning, match="is unset"):
        dojo(None, probed=())


def test_a_disallowed_origin_is_never_offered_a_wildcard_with_credentials(dojo):
    client = TestClient(dojo(ALLOWED_ORIGIN).app)

    resp = client.get("/agentic-chat/ping", headers={"Origin": DISALLOWED_ORIGIN})

    # Not just "never that pair": a total CORS failure satisfies that too.
    assert resp.headers.get("access-control-allow-origin") is None
    assert (
        resp.headers.get("access-control-allow-origin"),
        resp.headers.get("access-control-allow-credentials"),
    ) != ("*", "true")


def test_an_allowed_origin_reaches_a_mounted_demo(dojo):
    client = TestClient(dojo(ALLOWED_ORIGIN).app)

    resp = client.get("/agentic-chat/ping", headers={"Origin": ALLOWED_ORIGIN})

    assert resp.headers.get("access-control-allow-origin") == ALLOWED_ORIGIN


def test_an_allowed_origin_may_use_credentials(dojo):
    client = TestClient(dojo(ALLOWED_ORIGIN).app)

    resp = client.get("/agentic-chat/ping", headers={"Origin": ALLOWED_ORIGIN})

    assert resp.headers.get("access-control-allow-credentials") == "true"


def test_a_preflight_from_a_disallowed_origin_is_refused(dojo):
    client = TestClient(dojo(ALLOWED_ORIGIN).app)

    resp = client.options(
        "/agentic-chat/",
        headers={
            "Origin": DISALLOWED_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )

    assert resp.status_code == 400
    assert resp.headers.get("access-control-allow-origin") is None


def test_falling_back_to_the_wildcard_says_so(dojo):
    """The factory's own FutureWarning stops firing once origins are passed."""
    with pytest.warns(UserWarning, match=settings.CORS_ORIGINS_VAR):
        dojo(None)


def test_a_configured_allowlist_does_not_warn(dojo):
    """Scoped to this message: an unrelated dependency warning is not a failure.

    This asserts the dojo stays quiet, not that the factory does; the factory's
    own implicit-wildcard warning is covered in test_cors_and_auth.py.
    """
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        dojo(ALLOWED_ORIGIN)

    assert [w for w in caught if settings.CORS_ORIGINS_VAR in str(w.message)] == []


def test_the_unconfigured_default_is_a_wildcard_without_credentials(dojo):
    with pytest.warns(UserWarning):
        app = dojo(None).app
    client = TestClient(app)

    resp = client.get("/agentic-chat/ping", headers={"Origin": DISALLOWED_ORIGIN})

    assert resp.headers.get("access-control-allow-origin") == "*"
    assert resp.headers.get("access-control-allow-credentials") is None


# Every spelling an operator plausibly writes for one intended origin. Each
# round of review has turned up another one that parsed, reported itself
# configured, and then matched no request at all: a trailing slash, a capital
# letter, a value that normalised to empty. Asserting the intent end to end
# closes the class instead of the spelling.
INTENDED_ORIGIN = "http://localhost:3000"
SPELLINGS = [
    "http://localhost:3000",
    "http://localhost:3000/",
    "  http://localhost:3000  ",
    "HTTP://LOCALHOST:3000",
    "Http://LocalHost:3000/",
    "http://localhost:3000,",
    ",http://localhost:3000",
    "http://localhost:3000,,https://app.example",
]


@pytest.mark.parametrize("spelling", SPELLINGS)
def test_any_spelling_of_an_origin_actually_grants_that_origin(dojo, spelling):
    client = TestClient(dojo(spelling, probed=("/agentic-chat",)).app)

    granted = client.get("/agentic-chat/ping", headers={"Origin": INTENDED_ORIGIN})
    refused = client.get("/agentic-chat/ping", headers={"Origin": DISALLOWED_ORIGIN})

    assert granted.headers.get("access-control-allow-origin") == INTENDED_ORIGIN
    assert refused.headers.get("access-control-allow-origin") is None


@pytest.mark.parametrize("spelling", SPELLINGS)
def test_any_spelling_of_an_origin_counts_as_configured(dojo, spelling):
    """A spelling that normalises to nothing would silently reopen the wildcard."""
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        dojo(spelling, probed=())

    assert INTENDED_ORIGIN in settings.configured_origins()
    assert [w for w in caught if settings.CORS_ORIGINS_VAR in str(w.message)] == []


def test_a_demo_on_the_wildcard_default_leaks_past_the_dojo_allowlist(dojo):
    """Why every demo has to be given the allowlist rather than defaulting.

    The demo's own middleware answers first with a wildcard, and the dojo
    app's adds the credentials header on the way out. Neither layer produces
    that pair alone, and the wildcard alone is enough for a disallowed origin
    to read the response.
    """
    client = TestClient(dojo(ALLOWED_ORIGIN, demo_origins=None).app)

    resp = client.get("/agentic-chat/ping", headers={"Origin": DISALLOWED_ORIGIN})

    assert resp.headers.get("access-control-allow-origin") == "*"
    assert resp.headers.get("access-control-allow-credentials") == "true"


def _factory_calls(source: str) -> list[ast.Call]:
    """Every `create_strands_app` call in *source*, however it is spelled."""
    return [
        node
        for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.Call) and _callee(node.func) == "create_strands_app"
    ]


def _callee(func: ast.expr) -> str | None:
    """The trailing name of a call target, for `f()` and `mod.f()` alike."""
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return None


@pytest.mark.parametrize("path", settings.DEMO_PATHS)
def test_every_demo_hands_the_shared_origins_to_the_factory(path):
    """The stand-ins above cannot see this, and defaulting is what leaks."""
    demo = DEMOS / f"{settings.mount_name(path)}.py"
    calls = _factory_calls(demo.read_text())

    assert calls, f"{demo.name} never calls create_strands_app"
    # Bound to `app` specifically: that is the name `server.api` imports, and a
    # rename here breaks the real server at import while every other assertion
    # in this file still passes.
    bound_to_app = [
        node
        for node in ast.parse(demo.read_text()).body
        if isinstance(node, ast.Assign)
        and any(getattr(t, "id", None) == "app" for t in node.targets)
        and isinstance(node.value, ast.Call)
        and _callee(node.value.func) == "create_strands_app"
    ]
    assert bound_to_app, f"{demo.name} does not bind create_strands_app(...) to `app`"

    for call in calls:
        origins = [kw.value for kw in call.keywords if kw.arg == "origins"]
        assert origins, (
            f"{demo.name} leaves create_strands_app on the wildcard default; "
            "pass origins=cors_origins()"
        )
        called = origins[0].func if isinstance(origins[0], ast.Call) else None
        assert called is not None and _callee(called) == "cors_origins", (
            f"{demo.name} passes origins={ast.unparse(origins[0])}, "
            "which is not a cors_origins() call"
        )


def test_the_demo_modules_on_disk_are_exactly_the_demo_paths():
    """Otherwise the guard above silently skips a demo nobody listed.

    Equality, not a subset: `api/` holds one module per demo and nothing else,
    so an unlisted module there is a demo that escaped the route table rather
    than a helper. A helper would move under `server/` beside `settings.py`.
    """
    on_disk = {p.stem for p in DEMOS.glob("*.py") if p.name != "__init__.py"}

    assert on_disk == {settings.mount_name(p) for p in settings.DEMO_PATHS}


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("https://a.example", ["https://a.example"]),
        ("https://a.example,https://b.example", ["https://a.example", "https://b.example"]),
        ("  https://a.example ,  https://b.example  ", ["https://a.example", "https://b.example"]),
        ("https://a.example,,", ["https://a.example"]),
        ("https://a.example,https://a.example/", ["https://a.example"]),
        ("https://a.example/", ["https://a.example"]),
        ("HTTPS://A.example", ["https://a.example"]),
        ("*", ["*"]),
    ],
)
def test_the_allowlist_is_parsed_from_the_variable(monkeypatch, raw, expected):
    monkeypatch.setenv(settings.CORS_ORIGINS_VAR, raw)

    assert settings.cors_origins() == expected


@pytest.mark.parametrize("raw", [None, "", "   ", "\t\n "])
def test_only_an_unset_or_blank_allowlist_falls_back_to_the_wildcard(monkeypatch, raw):
    """The one case that may widen, and the local-development default."""
    if raw is None:
        monkeypatch.delenv(settings.CORS_ORIGINS_VAR, raising=False)
    else:
        monkeypatch.setenv(settings.CORS_ORIGINS_VAR, raw)

    assert settings.names_nothing()
    assert settings.cors_origins() == ["*"]


@pytest.mark.parametrize("raw", ["/", " / ", "//", "*/", " */ ", "*//", ",", ",,", ",/,"])
def test_a_written_but_unusable_allowlist_never_becomes_the_wildcard(monkeypatch, raw):
    """A typo must not widen access.

    "/" trimmed to empty and dropped out of the list, and "*/" trimmed to "*".
    Either one turned a mistake into "allow every origin", which is the reverse
    of what the operator asked for by setting the variable at all.
    """
    monkeypatch.setenv(settings.CORS_ORIGINS_VAR, raw)

    resolved = settings.cors_origins()

    assert not settings.names_nothing()
    assert resolved != ["*"]
    assert settings.WILDCARD not in resolved
    assert resolved, "an empty list is widened back to the wildcard by the factory"


def test_an_unattributable_origin_never_reaches_the_credentials_rule(dojo):
    """`null` matches, but it names no site, so credentials must stay off."""
    client = TestClient(dojo(settings.NON_ATTRIBUTABLE_ORIGIN, probed=("/agentic-chat",)).app)

    granted = client.get(
        "/agentic-chat/ping", headers={"Origin": settings.NON_ATTRIBUTABLE_ORIGIN}
    )
    other = client.get("/agentic-chat/ping", headers={"Origin": DISALLOWED_ORIGIN})

    # The positive matters as much as the absent header: dropping the entry
    # instead would empty the list, fall back to the wildcard, and satisfy the
    # credentials assertion while granting every origin.
    assert granted.headers.get("access-control-allow-origin") == settings.NON_ATTRIBUTABLE_ORIGIN
    assert granted.headers.get("access-control-allow-credentials") is None
    assert other.headers.get("access-control-allow-origin") is None


@pytest.mark.parametrize(
    "origins,expected",
    [
        (["https://a.example"], True),
        (["*"], False),
        (["https://a.example", "*"], False),
        ([], False),
        # Names no site, so credentials for it are credentials for anyone.
        ([settings.NON_ATTRIBUTABLE_ORIGIN], False),
        (["https://a.example", settings.NON_ATTRIBUTABLE_ORIGIN], False),
    ],
)
def test_credentials_are_refused_for_an_origin_naming_no_single_site(origins, expected):
    assert settings.allow_credentials(origins) is expected


# ---------------------------------------------------------------------------
# Port
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("raw", [None, "", "   "])
def test_an_unset_port_takes_the_default(raw):
    assert settings.resolve_port(raw, default=8123) == 8123


@pytest.mark.parametrize("raw,expected", [("9000", 9000), (" 9000 ", 9000), ("1", 1), ("65535", 65535)])
def test_a_usable_port_is_accepted(raw, expected):
    assert settings.resolve_port(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "0", "-1", "65536", "abc", "8000.5", "80 80",
        # int() would take these; the first two silently become a different port.
        "1_0", "8_000", "\uff18\uff10\uff10\uff10", "0x1f", "1e3",
        # A port is written in plain decimal digits and nothing else.
        "+8000", "8000.0",
        # A leading zero is the same silent reinterpretation as "1_0": 0100 -> 100.
        "0100", "007", "00",
    ],
)
def test_an_unusable_port_is_refused_by_name_and_value(raw):
    with pytest.raises(ValueError) as excinfo:
        settings.resolve_port(raw)

    message = str(excinfo.value)
    assert settings.PORT_VAR in message
    assert repr(raw) in message


def test_the_server_refuses_to_start_on_an_unusable_port(dojo, monkeypatch):
    server = dojo(ALLOWED_ORIGIN)
    started = []
    monkeypatch.setattr(server.uvicorn, "run", lambda *a, **kw: started.append(kw))
    monkeypatch.setenv(settings.PORT_VAR, "0")

    with pytest.raises(ValueError) as excinfo:
        server.main()

    assert settings.PORT_VAR in str(excinfo.value)
    assert "'0'" in str(excinfo.value)
    assert started == []


def test_an_unset_port_uses_the_documented_default(monkeypatch):
    monkeypatch.delenv(settings.PORT_VAR, raising=False)

    assert settings.port_from_env() == settings.DEFAULT_PORT == 8000


def test_the_server_listens_on_the_default_port_when_unset(dojo, monkeypatch):
    server = dojo(ALLOWED_ORIGIN)
    started = []
    monkeypatch.setattr(server.uvicorn, "run", lambda *a, **kw: started.append(kw))
    monkeypatch.delenv(settings.PORT_VAR, raising=False)

    server.main()

    assert [kw["port"] for kw in started] == [settings.DEFAULT_PORT]


def test_the_server_listens_on_a_configured_port(dojo, monkeypatch):
    server = dojo(ALLOWED_ORIGIN)
    started = []
    monkeypatch.setattr(server.uvicorn, "run", lambda *a, **kw: started.append(kw))
    monkeypatch.setenv(settings.PORT_VAR, "9123")

    server.main()

    assert [kw["port"] for kw in started] == [9123]


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


def test_every_demo_path_is_mounted(dojo):
    app = dojo(ALLOWED_ORIGIN).app

    mounted = {route.path for route in app.routes if isinstance(route, Mount)}

    assert mounted == set(settings.DEMO_PATHS)


def test_the_route_listing_matches_the_mounted_paths(dojo):
    client = TestClient(dojo(ALLOWED_ORIGIN).app)

    listed = client.get("/").json()["endpoints"]

    assert listed == {settings.mount_name(p): p for p in settings.DEMO_PATHS}


def test_every_demo_path_names_an_app_the_api_package_exports():
    """The one place the derived names have to land somewhere real.

    A demo path yields its route name, its key in the listing at `/`, and the
    attribute `server.api` is asked for at mount time. The stand-in api module
    the other tests use is built from the same derivation, so only the real
    package's exports can say whether the derivation is right.
    """
    tree = ast.parse((DEMOS / "__init__.py").read_text())
    exported = {
        element.value
        for node in tree.body
        if isinstance(node, ast.Assign)
        and any(getattr(t, "id", None) == "__all__" for t in node.targets)
        for element in node.value.elts
    }
    # The bound names too, not just __all__: a renamed alias leaves __all__ intact
    # and fails at mount time with AttributeError instead.
    bound = {
        alias.asname or alias.name
        for node in tree.body
        if isinstance(node, ast.ImportFrom)
        for alias in node.names
    }
    expected = {settings.app_attribute(p) for p in settings.DEMO_PATHS}

    assert exported == expected
    # Subset, not equality: an unrelated import here is nobody's bug.
    assert expected <= bound, f"never bound: {sorted(expected - bound)}"


def test_a_longer_path_is_not_swallowed_by_a_shorter_mount(dojo):
    """`/agentic-chat` is a strict prefix of two sibling demo paths."""
    shadowed = [
        path
        for path in settings.DEMO_PATHS
        if any(path != other and path.startswith(other + "-") for other in settings.DEMO_PATHS)
    ]
    assert shadowed, "no prefix pair left to guard"

    client = TestClient(dojo(ALLOWED_ORIGIN, probed=tuple(shadowed)).app)

    for path in shadowed:
        assert client.get(f"{path}/ping").json() == {"status": "healthy"}


def test_a_mount_is_named_and_resolves_back_to_its_path(dojo):
    """Starlette matches route names by exact string, so a display label
    would resolve too. What the slug buys is one name for the route, the
    listing key and the `server.api` attribute rather than three."""
    app = dojo(ALLOWED_ORIGIN).app

    for path in settings.DEMO_PATHS:
        assert app.url_path_for(settings.mount_name(path), path="/ping") == f"{path}/ping"


def test_no_demo_path_is_listed_twice():
    """A set comparison anywhere else would hide a double mount."""
    assert len(settings.DEMO_PATHS) == len(set(settings.DEMO_PATHS))


def test_no_two_demo_paths_derive_the_same_name():
    """`/a-b` and `/a_b` would collide, silently dropping one from the listing."""
    names = [settings.mount_name(path) for path in settings.DEMO_PATHS]

    assert len(names) == len(set(names))


def _documented_routes(readme: Path) -> list[str]:
    return [
        line.split("|")[1].strip().strip("`")
        for line in readme.read_text().splitlines()
        if line.startswith("| `/")
    ]


@pytest.mark.parametrize("readme", [README, EXAMPLES_README], ids=["package", "examples"])
def test_every_readme_route_table_lists_every_mounted_route(readme):
    documented = _documented_routes(readme)

    # Length too, so a duplicated row cannot hide inside the set comparison.
    assert len(documented) == len(settings.DEMO_PATHS)
    assert set(documented) == set(settings.DEMO_PATHS)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def test_running_the_package_as_a_module_starts_the_server(dojo, monkeypatch):
    """`python -m server` runs `__main__.py`, which is why `__init__.py`
    carries no entry-point guard of its own: its `__name__` is never
    `__main__` on that path."""
    monkeypatch.delenv(settings.PORT_VAR, raising=False)
    server = dojo(ALLOWED_ORIGIN)
    started = []
    monkeypatch.setattr(server.uvicorn, "run", lambda *a, **kw: started.append(kw))

    runpy.run_module("server", run_name="__main__")

    assert len(started) == 1
