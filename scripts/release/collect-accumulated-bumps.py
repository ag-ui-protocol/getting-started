#!/usr/bin/env python3
"""
collect-accumulated-bumps.py

Walks every package.json, pyproject.toml, enrolled .NET Directory.Build.props and
enrolled Maven reactor pom.xml
that changed between two git refs and reports which ones had their version field bumped. Used to build a
release PR's summary from the accumulated state of the release/next branch.

Usage:
  ./collect-accumulated-bumps.py <base-ref> <head-ref>

Output (stdout):
  JSON array of {scope, name, path, file, ecosystem, oldVersion, newVersion}
  for every package whose version changed.

Scopes are resolved from scripts/release/release.config.json by matching
the file path to a scope's package paths.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import tomllib
import xml.etree.ElementTree as ET
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent.parent
CONFIG_PATH = REPO_ROOT / "scripts" / "release" / "release.config.json"


def run(cmd: list[str]) -> str:
    return subprocess.run(
        cmd, check=True, capture_output=True, text=True, cwd=REPO_ROOT
    ).stdout


def changed_files(base: str, head: str) -> list[str]:
    out = run(["git", "diff", "--name-only", f"{base}..{head}"])
    return [line for line in out.splitlines() if line]


def read_file_at_ref(ref: str, path: str) -> str | None:
    try:
        return subprocess.run(
            ["git", "show", f"{ref}:{path}"],
            check=True,
            capture_output=True,
            text=True,
            cwd=REPO_ROOT,
        ).stdout
    except subprocess.CalledProcessError:
        return None


def parse_package_json(content: str) -> tuple[str | None, str | None]:
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        return None, None
    return data.get("name"), data.get("version")


def parse_pyproject(content: str) -> tuple[str | None, str | None]:
    try:
        data = tomllib.loads(content)
    except tomllib.TOMLDecodeError:
        return None, None
    project = data.get("project", {})
    poetry = data.get("tool", {}).get("poetry", {})
    name = project.get("name") or poetry.get("name")
    version = project.get("version") or poetry.get("version")
    return name, version


def parse_directory_build_props(content: str) -> str | None:
    match = re.search(r"<VersionPrefix(?:\s+[^>]*)?>([^<]+)</VersionPrefix>", content)
    return match.group(1) if match else None


def parse_maven_pom(content: str) -> str | None:
    """Read the reactor version: the <version> that is a DIRECT child of <project>.

    A pom carries <version> for its parent, every dependency and every plugin, so
    a regex would read the wrong one. Parse the XML and take the direct child.
    """
    ns = "{http://maven.apache.org/POM/4.0.0}"
    try:
        root = ET.fromstring(content)
    except ET.ParseError:
        return None
    version = root.findtext(f"{ns}version")
    if version is None:
        version = root.findtext("version")
    return version.strip() if version and version.strip() else None


def load_scope_maps() -> tuple[dict[str, tuple[str, str]], dict[str, tuple[str, list[dict]]]]:
    """Map package path -> (scope name, ecosystem), and versionSource -> (scope, packages)."""
    with CONFIG_PATH.open("rb") as f:
        config = json.load(f)

    scope_map: dict[str, tuple[str, str]] = {}
    version_source_map: dict[str, tuple[str, list[dict]]] = {}
    for scope_name, scope_data in config["scopes"].items():
        for pkg in scope_data["packages"]:
            scope_map[pkg["path"]] = (scope_name, pkg["ecosystem"])
        version_source = scope_data.get("versionSource")
        if version_source:
            version_source_map[version_source] = (scope_name, scope_data["packages"])
    return scope_map, version_source_map


def find_scope(file_path: str, scope_map: dict[str, tuple[str, str]]) -> tuple[str, str] | None:
    """Find the scope containing this manifest file."""
    # file_path is like "integrations/langgraph/python/pyproject.toml"
    # scope paths are like "integrations/langgraph/python"
    directory = str(Path(file_path).parent)
    return scope_map.get(directory)


def main() -> None:
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <base-ref> <head-ref>", file=sys.stderr)
        sys.exit(1)

    base, head = sys.argv[1], sys.argv[2]
    scope_map, version_source_map = load_scope_maps()

    results: list[dict] = []

    for path in changed_files(base, head):
        name_new = name_old = version_new = version_old = None

        if path.endswith("package.json"):
            new_content = read_file_at_ref(head, path)
            old_content = read_file_at_ref(base, path)
            if new_content is None:
                continue
            name_new, version_new = parse_package_json(new_content)
            if old_content is not None:
                _, version_old = parse_package_json(old_content)
            ecosystem_default = "typescript"

        elif path.endswith("pyproject.toml"):
            new_content = read_file_at_ref(head, path)
            old_content = read_file_at_ref(base, path)
            if new_content is None:
                continue
            name_new, version_new = parse_pyproject(new_content)
            if old_content is not None:
                _, version_old = parse_pyproject(old_content)
            ecosystem_default = "python"

        elif path in version_source_map and path.endswith(
            ("Directory.Build.props", "pom.xml")
        ):
            # Shared-version sources: one file drives every package in the scope.
            # A Maven MODULE pom is not in version_source_map (it only repeats
            # its <parent><version>), so it falls through to the else and is
            # correctly ignored rather than double-counted.
            parse = (
                parse_directory_build_props
                if path.endswith("Directory.Build.props")
                else parse_maven_pom
            )
            new_content = read_file_at_ref(head, path)
            old_content = read_file_at_ref(base, path)
            if new_content is None:
                continue
            version_new = parse(new_content)
            if old_content is not None:
                version_old = parse(old_content)
            if not version_new or version_old == version_new:
                continue

            scope_name, packages = version_source_map[path]
            for pkg in packages:
                results.append(
                    {
                        "scope": scope_name,
                        "name": pkg["name"],
                        "path": pkg["path"],
                        "file": path,
                        "ecosystem": pkg["ecosystem"],
                        "oldVersion": version_old or "(new)",
                        "newVersion": version_new,
                    }
                )
            continue

        else:
            continue

        # Skip if no version on head, or version didn't actually change
        if not version_new or not name_new:
            continue
        if version_old == version_new:
            continue

        scope_info = find_scope(path, scope_map)
        if scope_info is None:
            # File isn't declared in any release scope — ignore
            continue
        scope_name, ecosystem = scope_info

        results.append(
            {
                "scope": scope_name,
                "name": name_new,
                "path": str(Path(path).parent),
                "file": path,
                "ecosystem": ecosystem,
                "oldVersion": version_old or "(new)",
                "newVersion": version_new,
            }
        )

    json.dump(results, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
