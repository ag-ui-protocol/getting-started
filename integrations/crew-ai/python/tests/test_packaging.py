"""Packaging guard: the built artifacts carry the library and nothing else.

History, because it explains why this file is small. The dojo server and demo flows
used to live inside this package and were stripped from the artifacts by a
``[tool.hatch.build] exclude``, while ``[project.scripts] dev = "ag_ui_crewai.dojo:main"``
survived that exclude. Every published wheel installed a ``dev`` command whose target
was not in the package, and the suite could not see it, because it runs against an
editable install where the excluded file is still on disk.

The dojo now lives in its own project next door. There is no dev-only code in the
package, no exclude list, and nothing for metadata to point at wrongly, so most of what
this guard used to police cannot happen any more. What is left worth asserting is that
the artifacts contain what they should and no more, and that any entry point this
package ever declares resolves inside them.

THE ORACLE IS THE ARTIFACT. An earlier revision modelled hatchling's file selection so
the checks could run without a build, and the model called configurations green that
ship a broken wheel. The fixture below runs the real build once and every assertion
reads only the bytes it produced.
"""

import configparser
import importlib.metadata
import shutil
import subprocess
import tarfile
import zipfile
from pathlib import Path, PurePosixPath

import pytest

try:  # tomllib is 3.11+, and requires-python still admits 3.10.
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - depends on the interpreter
    import tomli as tomllib

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
IMPORT_NAME = "ag_ui_crewai"

# Modules the published package exists to provide, so a content check cannot pass by
# comparing two empty sets.
CORE_MODULES = (
    f"{IMPORT_NAME}/__init__.py",
    f"{IMPORT_NAME}/endpoint.py",
    f"{IMPORT_NAME}/sdk.py",
    f"{IMPORT_NAME}/a2ui_tool.py",
)

# What an sdist carries outside the package directory, as the tarball actually has it.
# The readme and license because ``[project]`` names them, ``pyproject.toml`` and
# ``PKG-INFO`` because an sdist is not a build input without them, and ``.gitignore``
# which hatchling force-includes into every sdist whatever the include list says.
# Closed on purpose: this is what catches an sdist that quietly starts shipping the
# test suite, the lockfile, or the examples project.
SDIST_NON_PACKAGE_FILES = frozenset(
    {"README.md", "LICENSE", "pyproject.toml", "PKG-INFO", ".gitignore"}
)

ENTRY_POINT_TABLES = {
    "console_scripts": "project.scripts",
    "gui_scripts": "project.gui-scripts",
}


@pytest.fixture(scope="session")
def built_artifacts(tmp_path_factory):
    """Build the real wheel and sdist once, into a directory outside the repo.

    ``uv build`` builds the sdist and then the wheel from that sdist, the same command
    ``build-python-preview.yml`` and ``publish-release.yml`` run, so a wheel reaching
    this fixture also proves the sdist is a complete build input. ``--no-build-isolation``
    takes the backend from this project's locked dev dependencies, which is why
    ``build-system.requires`` pins hatchling to that same exact version.
    """
    uv = shutil.which("uv")
    if uv is None:
        pytest.fail(
            "this guard asserts against real built artifacts and `uv` is not on PATH. "
            "Run the suite with `uv run python -m pytest`."
        )

    out_dir = tmp_path_factory.mktemp("dist")
    command = [
        uv,
        "build",
        "--offline",
        "--no-build-isolation",
        "--out-dir",
        str(out_dir),
    ]
    result = subprocess.run(
        command, cwd=PACKAGE_ROOT, capture_output=True, text=True, check=False
    )
    if result.returncode != 0:
        pytest.fail(
            f"`{' '.join(command)}` exited {result.returncode}, so there is nothing to "
            "check the published layout against. Run `uv sync` if hatchling is missing "
            f"from the environment.\n{result.stdout}\n{result.stderr}"
        )

    wheels = list(out_dir.glob("*.whl"))
    sdists = list(out_dir.glob("*.tar.gz"))
    assert len(wheels) == 1 and len(sdists) == 1, (
        f"expected one wheel and one sdist, got {sorted(p.name for p in out_dir.iterdir())!r}"
    )

    with zipfile.ZipFile(wheels[0]) as archive:
        wheel_names = {i.filename for i in archive.infolist() if not i.is_dir()}
        wheel_contents = {name: archive.read(name) for name in wheel_names}

    with tarfile.open(sdists[0], "r:gz") as archive:
        members = [m for m in archive.getmembers() if m.isfile()]
        prefixes = {PurePosixPath(m.name).parts[0] for m in members}
        assert len(prefixes) == 1, (
            f"{sdists[0].name} unpacks into {sorted(prefixes)!r}; an sdist has to unpack "
            "into exactly one directory"
        )
        prefix = prefixes.pop()
        sdist_names = {
            PurePosixPath(m.name).relative_to(prefix).as_posix() for m in members
        }

    return {
        "wheel_names": wheel_names,
        "wheel_contents": wheel_contents,
        "sdist_names": sdist_names,
    }


def test_the_guard_and_a_publish_agree_on_hatchling():
    """This guard builds ``--no-build-isolation``, against the hatchling in the
    environment. A publish runs a plain ``uv build``, which resolves the backend fresh
    from ``build-system.requires``. Overlapping ranges do not make those the same
    version, and hatchling changes artifact selection in minor releases, so only an
    exact pin on both sides makes what this guard checks the thing that ships.
    """
    requires = tomllib.loads((PACKAGE_ROOT / "pyproject.toml").read_text())[
        "build-system"
    ]["requires"]
    pinned = [s for s in requires if s.replace(" ", "").startswith("hatchling")]

    assert len(pinned) == 1, (
        f"expected exactly one hatchling requirement in build-system.requires, got "
        f"{requires!r}"
    )
    spec = pinned[0].replace(" ", "")
    assert "==" in spec, (
        f"build-system.requires pins hatchling as {spec!r}, which a publish can resolve "
        "to a version this guard never built with; pin it exactly"
    )
    declared = spec.split("==", 1)[1]
    installed = importlib.metadata.version("hatchling")

    assert installed == declared, (
        f"this guard builds with hatchling {installed} but a publish resolves "
        f"{declared} from build-system.requires, so the artifacts asserted here are not "
        "the artifacts that ship. Move both pins together."
    )


def test_every_entry_point_resolves_in_the_artifact(built_artifacts):
    """The original bug was a published ``dev`` command whose module was not in the
    wheel. There are no entry points today; if one is added, its module has to be
    something the wheel actually carries."""
    entry_point_files = [
        name for name in built_artifacts["wheel_names"] if name.endswith("entry_points.txt")
    ]
    if not entry_point_files:
        pytest.skip("the package declares no entry points, so there is nothing to resolve")

    parser = configparser.ConfigParser(interpolation=None)
    parser.read_string(built_artifacts["wheel_contents"][entry_point_files[0]].decode("utf-8"))

    missing = []
    for group in parser.sections():
        table = ENTRY_POINT_TABLES.get(group, f"project.entry-points.{group}")
        for name, value in parser.items(group):
            module = value.split(":", 1)[0].strip()
            parts = module.split(".")
            candidates = {
                PurePosixPath(*parts).with_suffix(".py").as_posix(),
                PurePosixPath(*parts, "__init__.py").as_posix(),
            }
            if not candidates & built_artifacts["wheel_names"]:
                missing.append(
                    f"  [{table}] {name} = {value!r} names {module}, absent from the wheel"
                )

    assert missing == [], "\n".join(
        ["entry points naming modules the wheel does not carry:", *missing]
    )


def test_the_wheel_contains_nothing_but_the_package_and_its_metadata(built_artifacts):
    names = built_artifacts["wheel_names"]
    package = {name for name in names if name.startswith(f"{IMPORT_NAME}/")}
    metadata = {name for name in names if ".dist-info/" in name}
    strays = names - package - metadata

    assert strays == set(), (
        f"the wheel carries files outside the package and its metadata: {sorted(strays)!r}"
    )
    assert set(CORE_MODULES) <= package, (
        "the wheel is missing modules the package exists to provide: "
        f"{sorted(set(CORE_MODULES) - package)!r}"
    )


def test_the_sdist_carries_only_the_package_and_its_metadata(built_artifacts):
    names = built_artifacts["sdist_names"]
    package = {name for name in names if name.startswith(f"{IMPORT_NAME}/")}
    strays = names - package - SDIST_NON_PACKAGE_FILES

    assert strays == set(), (
        f"the sdist carries unexpected files: {sorted(strays)!r}. Tests, lockfiles and "
        "the examples project are not build inputs; if one of these belongs now, add it "
        "to SDIST_NON_PACKAGE_FILES deliberately."
    )
    assert set(CORE_MODULES) <= package, (
        "the sdist is missing modules the package exists to provide: "
        f"{sorted(set(CORE_MODULES) - package)!r}"
    )
