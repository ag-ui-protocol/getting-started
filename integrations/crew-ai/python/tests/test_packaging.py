"""Packaging guard: no published artifact may reference a module it does not contain.

The regression this locks down: ``[project.scripts] dev = "ag_ui_crewai.dojo:main"``
coexisted with a ``[tool.hatch.build] exclude`` that removes ``ag_ui_crewai/dojo.py``,
so every published wheel and sdist installed a ``dev`` command that raised
``ModuleNotFoundError: No module named 'ag_ui_crewai.dojo'``. Nothing caught it: the
suite runs against an editable install, which makes an excluded module importable
from the source tree, so the break was invisible until a consumer ran the command.
The same blind spot hides the second failure mode, a shipped module importing an
excluded one, so both are checked here.

crew-ai is the integration exposed to this because its dojo lives inside the
publishable package. Where another integration declares a ``dev`` script, it sits in
a ``python/examples/`` project that is never published.

THE ORACLE IS THE ARTIFACT, NOT A MODEL OF IT. Earlier revisions of this file
re-implemented hatchling's file selection (its default-exclude constants, its
``pathspec`` specs, its whitelist precedence) so the checks could run without a
build. That model was wrong in the dangerous direction repeatedly: it called
configurations green that ship a broken wheel, and reported ``.gitignore`` as
stripped from an sdist that in fact contains it. So the session fixture below runs
the real build once and every assertion reads the bytes it produced. There is
nothing left for the guard to be incomplete about, and ``uv build`` costs under a
second, which is noise against the rest of the suite.

Two details of the build command are load-bearing. It is plain ``uv build``, which
builds the sdist and then the wheel *from that sdist* — the same command
``build-python-preview.yml`` and ``publish-release.yml`` run, so the wheel checked
here is bounded by the sdist exactly as the published one is. And it is
``--no-build-isolation``, so the backend comes from this project's own locked dev
dependencies rather than a fresh network resolve: the guard works offline, and a
hatchling upgrade arrives as a reviewable ``uv.lock`` change instead of a silent
shift in what gets published.
"""

import ast
import configparser
import importlib
import os
import re
import runpy
import shutil
import subprocess
import tarfile
import zipfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

import pytest
import uvicorn

try:  # tomllib is 3.11+, and requires-python still admits 3.10.
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - depends on the interpreter
    import tomli as tomllib

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
IMPORT_NAME = "ag_ui_crewai"

# Development-only code: the dojo server, the ``python -m ag_ui_crewai`` launcher
# that runs it, and the demo flows. No artifact may ship any of it, and every other
# file in the package must ship. Update these two lists (not the assertions) when
# that split changes on purpose.
DEV_ONLY_FILES = (f"{IMPORT_NAME}/dojo.py", f"{IMPORT_NAME}/__main__.py")
DEV_ONLY_TREES = (f"{IMPORT_NAME}/examples/",)

# Modules the published package exists to provide. Named so the set-equality check
# below cannot pass by comparing two empty sets.
CORE_MODULES = (
    f"{IMPORT_NAME}/__init__.py",
    f"{IMPORT_NAME}/endpoint.py",
    f"{IMPORT_NAME}/sdk.py",
    f"{IMPORT_NAME}/a2ui_tool.py",
)

# The sdist payload outside the package directory, as the built tarball actually
# carries it. Every one of these is force-included by the backend rather than
# selected by ``[tool.hatch.build.targets.sdist] include``: the readme and the
# license because ``[project]`` names them, ``pyproject.toml`` and ``PKG-INFO``
# because an sdist is not a build input without them, and ``.gitignore`` which
# hatchling adds to every sdist unconditionally. Emptying the include list of all
# but ``ag_ui_crewai`` leaves this set unchanged, which is checkable and was checked.
# Closed set on purpose: this is what catches an sdist that quietly starts shipping
# the test suite and the lockfile.
SDIST_NON_PACKAGE_FILES = frozenset(
    {"README.md", "LICENSE", "pyproject.toml", "PKG-INFO", ".gitignore"}
)

# Byte-compilation and Finder droppings in a source checkout. They are not part of
# the package, so they are not expected in an artifact; if a build ever started
# shipping them the set-equality check would report them as extra files.
DROPPING_SUFFIXES = (".pyc", ".pyo")
DROPPING_NAMES = (".DS_Store",)
DROPPING_DIRS = ("__pycache__",)

# entry_points.txt group -> the pyproject table a maintainer would edit.
ENTRY_POINT_TABLES = {
    "console_scripts": "project.scripts",
    "gui_scripts": "project.gui-scripts",
}


# -- the artifacts, built once per session ----------------------------------


@dataclass(frozen=True)
class Artifact:
    """One built distribution, addressed by the paths a consumer sees.

    ``contents`` is keyed relative to the archive's own root: for a wheel that is
    the directory it unpacks into ``site-packages``, so ``ag_ui_crewai/sdk.py`` is
    the installed import path; for an sdist it is the project root the backend
    rebuilds from, with the ``<name>-<version>/`` prefix stripped.
    """

    kind: str
    filename: str
    contents: Mapping[str, bytes]

    def text(self, path):
        return self.contents[path].decode("utf-8")

    @property
    def package_files(self):
        """Files the artifact carries inside the package directory."""
        return {
            path for path in self.contents if path.startswith(f"{IMPORT_NAME}/")
        }

    def resolve_module(self, module):
        """The file in this artifact that ``module`` imports from, or None."""
        for candidate in _module_candidates(module):
            if candidate in self.contents:
                return candidate
        return None


def _read_wheel(path):
    with zipfile.ZipFile(path) as archive:
        return {
            info.filename: archive.read(info)
            for info in archive.infolist()
            if not info.is_dir()
        }


def _read_sdist(path):
    with tarfile.open(path, "r:gz") as archive:
        members = [member for member in archive.getmembers() if member.isfile()]
        prefixes = {PurePosixPath(member.name).parts[0] for member in members}
        assert len(prefixes) == 1, (
            f"{path.name} has more than one top-level directory {sorted(prefixes)!r}; "
            "an sdist is required to unpack into exactly one"
        )
        prefix = prefixes.pop()
        return {
            PurePosixPath(member.name).relative_to(prefix).as_posix(): archive.extractfile(
                member
            ).read()
            for member in members
        }


@pytest.fixture(scope="session")
def built_artifacts(tmp_path_factory):
    """Build the real wheel and sdist once, into a directory outside the repo.

    ``uv build`` builds the sdist and then the wheel *from that sdist*, so a wheel
    reaching this fixture is also proof the sdist is a complete build input. Keep the
    command in step with the release workflows; a wheel built straight from the tree
    is not the artifact consumers install.
    """
    uv = shutil.which("uv")
    if uv is None:
        pytest.fail(
            "this guard asserts against real built artifacts and `uv` is not on PATH. "
            "Run the suite with `uv run python -m pytest` (see the package README)."
        )

    out_dir = tmp_path_factory.mktemp("dist")
    command = [
        uv,
        "build",
        "--offline",
        # The backend comes from this project's locked dev dependencies, so the
        # build needs no network and no populated uv cache.
        "--no-build-isolation",
        "--out-dir",
        str(out_dir),
    ]
    result = subprocess.run(
        command,
        cwd=PACKAGE_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        pytest.fail(
            "\n".join(
                [
                    f"`{' '.join(command)}` failed with exit status "
                    f"{result.returncode}, so there is nothing to check the "
                    "published layout against.",
                    "Fix the build, or run `uv sync` if hatchling is missing from the "
                    "environment.",
                    result.stdout,
                    result.stderr,
                ]
            )
        )

    artifacts = {}
    for kind, pattern, reader in (
        ("wheel", "*.whl", _read_wheel),
        ("sdist", "*.tar.gz", _read_sdist),
    ):
        found = sorted(out_dir.glob(pattern))
        assert len(found) == 1, f"expected exactly one {kind}, got {found!r}"
        artifacts[kind] = Artifact(kind, found[0].name, reader(found[0]))
    return artifacts


@pytest.fixture(params=["wheel", "sdist"])
def artifact(request, built_artifacts):
    """Each invariant below runs against both published artifacts."""
    return built_artifacts[request.param]


# -- shared helpers ---------------------------------------------------------


def _module_candidates(module):
    """The paths a dotted module name can occupy, module before package."""
    parts = module.split(".")
    return (
        PurePosixPath(*parts).with_suffix(".py").as_posix(),
        PurePosixPath(*parts, "__init__.py").as_posix(),
    )


def _source_package_files():
    """Every file under the package directory in the source checkout."""
    root = PACKAGE_ROOT / IMPORT_NAME
    found = set()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [name for name in dirnames if name not in DROPPING_DIRS]
        for filename in filenames:
            if filename.endswith(DROPPING_SUFFIXES) or filename in DROPPING_NAMES:
                continue
            path = Path(dirpath, filename).relative_to(PACKAGE_ROOT)
            found.add(path.as_posix())
    return found


def _is_dev_only(relpath):
    return relpath in DEV_ONLY_FILES or relpath.startswith(DEV_ONLY_TREES)


def _entry_points(artifact):
    """Yield ``(label, value)`` for every entry point the artifact would install.

    For a wheel that is the backend's own ``entry_points.txt``, the file pip turns
    into commands on a consumer's PATH. An sdist carries no such file, so it is read
    from the ``pyproject.toml`` inside the sdist, which is what a wheel built from it
    declares. Both are the artifact's own bytes; neither is the working tree's.
    """
    if artifact.kind == "wheel":
        matches = [
            path
            for path in artifact.contents
            if re.fullmatch(r"[^/]+\.dist-info/entry_points\.txt", path)
        ]
        if not matches:
            return
        parser = configparser.ConfigParser()
        parser.optionxform = str  # entry point names are case-sensitive
        parser.read_string(artifact.text(matches[0]))
        for group in parser.sections():
            table = ENTRY_POINT_TABLES.get(group, f"project.entry-points.{group}")
            for name, value in parser.items(group):
                yield f"{table}.{name}", value
        return

    project = tomllib.loads(artifact.text("pyproject.toml")).get("project", {})
    for table in ("scripts", "gui-scripts"):
        for name, value in project.get(table, {}).items():
            yield f"project.{table}.{name}", value
    for group, entries in project.get("entry-points", {}).items():
        for name, value in entries.items():
            yield f"project.entry-points.{group}.{name}", value


def _docstring_node_ids(tree):
    """Ids of the string constants that are docstrings rather than values.

    A docstring naming a module is prose. Every other string literal can be a
    runtime import target, which is exactly how the launcher reaches the dojo, so
    those are scanned. Distinguishing the two is what stops this check from being
    satisfied by a module's own documentation.
    """
    ids = set()
    for node in ast.walk(tree):
        if not isinstance(
            node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)
        ):
            continue
        if not node.body:
            continue
        first = node.body[0]
        if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant):
            if isinstance(first.value.value, str):
                ids.add(id(first.value))
    return ids


_DOTTED_SELF_REFERENCE = re.compile(rf"\b{IMPORT_NAME}(?:\.[A-Za-z_]\w*)*")


def _referenced_modules(source, relpath):
    """Dotted module names ``relpath`` names, as absolute paths from the root.

    Covers both mechanisms a module can name another by: ``import`` / ``from``
    statements, and string literals such as the ``"ag_ui_crewai.dojo:app"`` uvicorn
    target. An AST-only scan is blind to the second, and the second is the mechanism
    the dojo launcher itself uses.
    """
    tree = ast.parse(source, filename=relpath)
    package = PurePosixPath(relpath).parts[:-1]

    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level > len(package):
                continue
            base = list(package[: len(package) - node.level + 1]) if node.level else []
            prefix = base + (node.module.split(".") if node.module else [])
            if prefix:
                names.add(".".join(prefix))
            names.update(".".join([*prefix, alias.name]) for alias in node.names)

    docstrings = _docstring_node_ids(tree)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
            continue
        if id(node) in docstrings:
            continue
        # The pattern stops at the ":" of an import string, so
        # "ag_ui_crewai.dojo:app" yields the module and drops the attribute.
        names.update(_DOTTED_SELF_REFERENCE.findall(node.value))

    # Importing ``a.b.c`` needs ``a`` and ``a.b`` too, so every dotted prefix is a
    # reference in its own right. Prefixes that name nothing in the tree (a
    # third-party root, or the attribute tail of a ``from`` import) drop out during
    # resolution.
    return {
        ".".join(name.split(".")[:depth])
        for name in names
        for depth in range(1, name.count(".") + 2)
    }


def _stripped_reference_violations(artifact, source_files):
    """Every module in ``artifact`` that names a project module the artifact lacks."""
    violations = []
    for relpath in sorted(path for path in artifact.contents if path.endswith(".py")):
        for name in sorted(_referenced_modules(artifact.text(relpath), relpath)):
            if artifact.resolve_module(name) is not None:
                continue
            in_tree = next(
                (c for c in _module_candidates(name) if c in source_files), None
            )
            if in_tree is None:
                continue  # a dependency or the stdlib, not this project's code
            violations.append(
                f"{relpath} references {name!r}, which is {in_tree} in the source "
                f"tree but is not in the {artifact.kind}"
            )
    return violations


# -- 1. every entry point resolves inside every artifact --------------------


def test_every_entry_point_resolves_in_the_artifact(artifact):
    """No published command may point at a module the build does not ship.

    Entry points survive any exclude list, so an installed ``dev`` command whose
    module was stripped raises ModuleNotFoundError on a consumer's machine.
    """
    violations = []
    for label, value in _entry_points(artifact):
        module = value.split(":", 1)[0].strip()
        if artifact.resolve_module(module) is not None:
            continue
        if module.split(".")[0] != IMPORT_NAME:
            continue  # provided by a dependency; not ours to verify
        tried = ", ".join(_module_candidates(module))
        violations.append(
            f"{label} = {value!r} needs module {module!r}, which the "
            f"{artifact.kind} does not contain (looked for {tried})"
        )

    assert violations == [], "\n".join(
        [
            f"{artifact.filename} installs entry points whose modules it does not "
            "contain, so running the command raises ModuleNotFoundError:",
            *(f"  - {v}" for v in violations),
            "Either drop the entry point (dev-only code runs via "
            "`uv run python -m ag_ui_crewai` from a checkout) or stop excluding the "
            "module in [tool.hatch.build].",
        ]
    )


# -- 2. nothing shipped references anything stripped ------------------------


def test_no_shipped_module_references_a_stripped_module(artifact):
    """The other half of the invariant: what a shipped module names has to ship too.

    An editable install hides this completely, so a ``from .examples import ...``
    added to a runtime module would only fail on a consumer's machine.
    """
    violations = _stripped_reference_violations(artifact, _source_package_files())

    assert violations == [], "\n".join(
        [
            f"{artifact.filename} contains modules that name modules it does not "
            "contain, so importing the installed package raises ModuleNotFoundError:",
            *(f"  - {v}" for v in violations),
            "Either move the reference out of the shipped module or stop excluding "
            "the module it names in [tool.hatch.build].",
        ]
    )


# -- 3. the dev-only split, over complete file sets -------------------------


def test_the_source_tree_still_has_the_split_this_guard_pins():
    """Preconditions, so the set comparisons below cannot pass by comparing nothing."""
    source_files = _source_package_files()
    dev_only = {path for path in source_files if _is_dev_only(path)}

    assert set(DEV_ONLY_FILES) <= dev_only, (
        "a module listed in DEV_ONLY_FILES is gone from the tree; update the list or "
        "restore the file"
    )
    assert set(CORE_MODULES) <= source_files - dev_only, (
        "a module listed in CORE_MODULES is gone from the tree; update the list or "
        "restore the file"
    )
    assert len(dev_only) > len(DEV_ONLY_FILES), "the examples tree is gone"
    assert any(not path.endswith(".py") for path in dev_only), (
        "the examples tree has no non-.py payload left, so `examples/**` staying out "
        "of the artifacts would only be pinned for modules"
    )


def test_the_artifact_contains_exactly_the_runtime_package(artifact):
    """Complete file sets, every extension, in both directions.

    Equality rather than a one-way check: dropping ``__main__.py`` from the exclude
    list fails here just as loudly as excluding a module the package needs at
    runtime, and a package-data file going missing fails the same way a module does.
    """
    source_files = _source_package_files()
    expected = {path for path in source_files if not _is_dev_only(path)}
    shipped = artifact.package_files

    assert shipped == expected, "\n".join(
        [
            f"{artifact.filename} does not contain exactly the runtime package:",
            *(
                f"  - needed at runtime but missing: {path}"
                for path in sorted(expected - shipped)
            ),
            *(
                f"  - dev-only but published: {path}"
                for path in sorted(shipped - expected)
            ),
            "Fix [tool.hatch.build] in pyproject.toml, or update DEV_ONLY_FILES / "
            "DEV_ONLY_TREES in this file if the split moved on purpose.",
        ]
    )


def test_the_wheel_contains_nothing_but_the_package_and_its_metadata(built_artifacts):
    """A wheel unpacks straight into site-packages, so a stray path is a stray
    top-level install."""
    wheel = built_artifacts["wheel"]
    stray = sorted(
        path
        for path in wheel.contents
        if path not in wheel.package_files
        and not re.match(r"[^/]+\.dist-info/", path)
    )

    assert stray == [], "\n".join(
        [
            f"{wheel.filename} would install these outside {IMPORT_NAME}/ and outside "
            "its .dist-info:",
            *(f"  - {path}" for path in stray),
            "Narrow the wheel's file selection in [tool.hatch.build.targets.wheel] "
            "(including any force-include it declares).",
        ]
    )


def test_the_sdist_carries_only_the_package_and_its_metadata(built_artifacts):
    """The lean-sdist promise, read off the tarball rather than trusted.

    A closed set: this is what catches an sdist that quietly starts shipping the test
    suite and the lockfile because its target table stopped narrowing the build.
    """
    sdist = built_artifacts["sdist"]
    payload = {path for path in sdist.contents if path not in sdist.package_files}

    assert payload == SDIST_NON_PACKAGE_FILES, "\n".join(
        [
            f"{sdist.filename} does not carry exactly the expected metadata payload:",
            *(
                f"  - unexpectedly published: {path}"
                for path in sorted(payload - SDIST_NON_PACKAGE_FILES)
            ),
            *(
                f"  - expected but missing: {path}"
                for path in sorted(SDIST_NON_PACKAGE_FILES - payload)
            ),
            "Fix [tool.hatch.build.targets.sdist] include, or update "
            "SDIST_NON_PACKAGE_FILES in this file if the payload changed on purpose.",
        ]
    )


# -- 4. the launcher no artifact ships still serves the dojo ----------------


def test_python_dash_m_hands_uvicorn_a_resolvable_dojo_target(monkeypatch):
    """``python -m ag_ui_crewai`` is what render.yaml and the dojo runner invoke.

    Executed rather than read: ``runpy`` runs the launcher exactly as ``-m`` does,
    with ``uvicorn.run`` captured, so the assertions are about the call that really
    happens. Reading the file instead is how an earlier version of this test came to
    be satisfied by the launcher's own docstring.
    """
    calls = []
    monkeypatch.setattr(uvicorn, "run", lambda app, **kwargs: calls.append(app))

    try:
        runpy.run_module(IMPORT_NAME, run_name="__main__")
    except SystemExit as exit_signal:
        exit_code = exit_signal.code
    else:
        pytest.fail(
            f"`python -m {IMPORT_NAME}` ran to the end of "
            f"{IMPORT_NAME}/__main__.py without exiting, so it served nothing and "
            'reported success. Call main() under an `if __name__ == "__main__":` '
            "guard."
        )

    assert exit_code == 0, f"`python -m {IMPORT_NAME}` exited {exit_code!r}, not 0"
    assert len(calls) == 1, (
        f"`python -m {IMPORT_NAME}` made {len(calls)} uvicorn.run calls, not 1; the "
        f"launcher has to serve the dojo, and {IMPORT_NAME}/__main__.py is the only "
        "place that can (no artifact ships it, so nothing else covers it)"
    )

    target = calls[0]
    assert isinstance(target, str), (
        f"`python -m {IMPORT_NAME}` passed uvicorn a {type(target).__name__} instead "
        "of an import string. uvicorn sys.exit(1)s on a non-string app whenever "
        "reload or workers is set, and building the app in the reload supervisor "
        "builds a second copy nothing serves. Pass "
        f'"{IMPORT_NAME}.dojo:app" instead.'
    )

    module_name, _, attribute = target.partition(":")
    assert module_name == f"{IMPORT_NAME}.dojo", (
        f"`python -m {IMPORT_NAME}` serves {module_name!r}; the launcher exists to "
        f"serve {IMPORT_NAME}.dojo, which is the module no artifact ships"
    )
    assert attribute, f"uvicorn target {target!r} names no application attribute"

    served = importlib.import_module(module_name)
    assert hasattr(served, attribute), (
        f"uvicorn target {target!r} names {attribute!r}, which {module_name} does not "
        f"define, so `python -m {IMPORT_NAME}` fails at startup"
    )
