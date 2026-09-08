#!/usr/bin/env python3
"""
extract-changelog-entry.py

Extracts one version's entry from a package's CHANGELOG.md, for the publish
workflow to place into the GitHub Release body. The CHANGELOG files are the
human-approved source of truth written on the release PR (see
generate-changelog-entries.ts); this script only reads what was merged.

Usage:
  ./extract-changelog-entry.py <package-name> <version> [--demote N]

The package's directory is resolved from scripts/release/release.config.json
by exact package name. The entry is the block starting at the line
`## <version>` (an em-dash date suffix is allowed) up to the next `## `
heading or end of file, without the heading line itself.

--demote N prefixes N extra '#' to every Markdown heading in the body
(outside fenced code blocks), so the entry nests correctly under the release
body's own headings.

Exit codes (see the EXIT_* constants below):
  0 - entry printed to stdout
  1 - bad invocation (wrong argument count, non-integer --demote) or an
      operational failure such as an unreadable config or an undecodable
      changelog. Callers MUST NOT treat this as an absent entry: it means the
      notes could not be read, not that none were approved.
  3 - no entry (unknown package, missing CHANGELOG.md, or version absent);
      nothing printed. Callers treat this as "no approved notes".
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

# AGUI_RELEASE_REPO_ROOT exists for tests, which point it at a fixture tree
# carrying its own scripts/release/release.config.json.
REPO_ROOT = Path(
    os.environ.get(
        "AGUI_RELEASE_REPO_ROOT",
        Path(__file__).resolve().parent.parent.parent,
    )
)
CONFIG_PATH = REPO_ROOT / "scripts" / "release" / "release.config.json"

# Callers (create-or-update-release.sh, reconcile-release.sh) branch on these,
# so they are part of this script's contract rather than incidental numbers.
EXIT_OK = 0
EXIT_USAGE = 1
EXIT_NO_ENTRY = 3


def resolve_package_path(name: str) -> Path | None:
    with CONFIG_PATH.open("rb") as f:
        config = json.load(f)
    for scope_data in config["scopes"].values():
        for pkg in scope_data["packages"]:
            if pkg["name"] == name:
                return REPO_ROOT / pkg["path"]
    return None


# Fences follow CommonMark (https://spec.commonmark.org/0.31.2/#fenced-code-blocks):
# an opener is three or more backticks or tildes indented at most three spaces,
# and it closes only on a line of the SAME character, at least as long as the
# opener, followed by nothing but whitespace. An opener may carry an info
# string, but a backtick fence's info string may not contain a backtick.
#
# Every clause of that rule is load-bearing here, because getting any of them
# wrong moves where an entry ends:
#   - A ``` line inside a ```` block is content. Tracking only the delimiter
#     character would leave the block "closed", so a literal `## ` line inside
#     it reads as structural and the entry TRUNCATES there.
#   - An info string is legal on an opener but never on a closer. Accepting a
#     suffix as a closer ends the block early, with the same result.
#   - A backtick-containing info string means the line is ordinary text, not an
#     opener. Treating it as one opens a block that never closes, which
#     swallows the next version's heading — so the entry OVER-RUNS instead,
#     publishing older releases' notes as part of this one.
#
# Must stay behaviourally identical to stepFence() in
# generate-changelog-entries.ts: generation and publication have to agree on
# where an entry ends.
_FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")


def _step_fence(
    line: str, open_fence: tuple[str, int] | None
) -> tuple[tuple[str, int] | None, bool]:
    """Advance fence state by one line, returning (open_fence, is_fence).
    `is_fence` marks the opener and closer lines themselves, which belong to the
    block rather than to the surrounding prose."""
    match = _FENCE_RE.match(line)
    if not match:
        return open_fence, False
    marker, suffix = match.group(1), match.group(2)
    if open_fence is None:
        # A backtick in a backtick fence's info string makes the line text, not
        # an opener; tildes carry no such restriction.
        if marker[0] == "`" and "`" in suffix:
            return open_fence, False
        return (marker[0], len(marker)), True
    char, length = open_fence
    if marker[0] == char and len(marker) >= length and suffix.strip() == "":
        return None, True
    return open_fence, False


def _scan_lines(content: str) -> list[tuple[str, bool]]:
    """Yield (line, is_heading) with fence awareness across the WHOLE file:
    a `## ` line inside a fenced code block is content, not a heading. Tracking
    must start at line one — a `## <version>` inside a fenced example ABOVE the
    real entry must not be mistaken for it."""
    out: list[tuple[str, bool]] = []
    open_fence: tuple[str, int] | None = None
    for line in content.split("\n"):
        open_fence, is_fence = _step_fence(line, open_fence)
        is_heading = open_fence is None and not is_fence and line.startswith("## ")
        out.append((line, is_heading))
    return out


def extract_entry(content: str, version: str) -> str | None:
    """The heading may be either this pipeline's `## 0.7.0 — date` or the
    Keep-a-Changelog `## [0.7.0] - date` that some hand-maintained files use."""
    escaped = re.escape(version)
    heading = re.compile(rf"^## \[?{escaped}\]?(?:\s|$)")
    body: list[str] = []
    in_entry = False
    for line, is_heading in _scan_lines(content):
        if not in_entry:
            if is_heading and heading.match(line):
                in_entry = True
            continue
        if is_heading:
            break
        body.append(line)
    if not in_entry:
        return None
    return "\n".join(body).strip()


def demote_headings(body: str, levels: int) -> str:
    out: list[str] = []
    open_fence: tuple[str, int] | None = None
    for line in body.split("\n"):
        open_fence, is_fence = _step_fence(line, open_fence)
        if open_fence is None and not is_fence and re.match(r"^#{1,6} ", line):
            out.append("#" * levels + line)
        else:
            out.append(line)
    return "\n".join(out)


def main() -> int:
    args = list(sys.argv[1:])
    demote = 0
    if "--demote" in args:
        i = args.index("--demote")
        try:
            demote = int(args[i + 1])
        except (IndexError, ValueError):
            print("ERROR: --demote requires an integer", file=sys.stderr)
            return EXIT_USAGE
        del args[i : i + 2]
    if len(args) != 2:
        print(
            f"Usage: {sys.argv[0]} <package-name> <version> [--demote N]",
            file=sys.stderr,
        )
        return EXIT_USAGE

    name, version = args
    # An unreadable or malformed config is a fault, and it reaches an operator
    # through a workflow annotation — so report it in one line rather than as
    # an uncaught traceback.
    try:
        pkg_path = resolve_package_path(name)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"ERROR: cannot read {CONFIG_PATH}: {exc}", file=sys.stderr)
        return EXIT_USAGE
    if pkg_path is None:
        print(f"package '{name}' not found in release.config.json", file=sys.stderr)
        return EXIT_NO_ENTRY

    changelog = pkg_path / "CHANGELOG.md"
    if not changelog.is_file():
        print(f"no CHANGELOG.md at {changelog}", file=sys.stderr)
        return EXIT_NO_ENTRY

    # A changelog that exists but cannot be decoded is a FAULT, not an absent
    # entry: exiting 3 here would tell the caller "no notes were approved" and
    # publish that as fact.
    try:
        content = changelog.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        print(f"ERROR: cannot read {changelog}: {exc}", file=sys.stderr)
        return EXIT_USAGE

    entry = extract_entry(content, version)
    if entry is None:
        print(f"no entry for {name} {version} in {changelog}", file=sys.stderr)
        return EXIT_NO_ENTRY

    if demote:
        entry = demote_headings(entry, demote)

    # Neutralise marker-looking comments. The publisher greps the assembled
    # release body for a per-package marker, so an entry that QUOTES one -
    # entirely plausible for a changelog describing this very mechanism -
    # would make a later package look already recorded and drop its row and
    # notes. Escaping the opening bracket means only markers the publisher
    # writes are real, and the quoted example renders as visible text rather
    # than an invisible comment.
    #
    # This lives here, not in the calling shell script: bash 5.2 enables
    # patsub_replacement by default, where an unquoted `&` in a ${v//a/b}
    # replacement expands to the matched text. The portable spellings differ
    # between bash 3.2 and 5.2, so the same line cannot be correct on a
    # developer's macOS shell and on the Linux CI runner at once.
    entry = entry.replace("<!-- ag-ui-", "&lt;!-- ag-ui-")

    print(entry)
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
