"""Neutralize each containment guard and require the suite to notice.

"Every containment guard has a test that fails when the guard is neutralized" was
a claim confirmed by hand, once, which is the same shape of problem as a README
claim with no executable check. This makes it a check.

Opt-in: it reruns the whole suite once per mutation, so it is deselected by
default and CI time is unchanged.

    uv run python -m pytest tests/test_conversational_guard_mutations.py -m mutation

Line-anchored, and the anchor is the WHOLE line: each entry names the line it
expects and that line's exact text, indentation included. A mismatch, or an
anchor that is no longer unique in its file, is a HARD ERROR rather than a skip.
That is deliberate and load bearing: the first hand-run of this reported "12
killed, no survivors" precisely because absent anchors passed silently. Requiring
the whole line is what makes uniqueness reachable at all, since the guards that
repeat verbatim (three ``self._release_lease()`` calls, two ``if
self._abandoned:``) are told apart by nothing else. An anchor that drifted has to
be re-pointed by a human who checks the guard is still there.

A SURVIVOR means the guard it names is not tested by anything.
"""

import os
import pathlib
import subprocess
import sys

import pytest

import ag_ui_crewai

from .conftest import MUTATION_BACKUP_SUFFIX, MUTATION_IN_FLIGHT_ENV_VAR

pytestmark = pytest.mark.mutation

PACKAGE = pathlib.Path(ag_ui_crewai.__file__).parent
PROJECT = PACKAGE.parent
CONV = PACKAGE / "_conversation.py"
EP = PACKAGE / "endpoint.py"


class Mutation:
    """One guard, neutralized: where it lives and what replaces it."""

    __slots__ = ("label", "path", "line", "expected", "replacement")

    def __init__(self, label, path, line, expected, replacement):
        self.label = label
        self.path = path
        self.line = line
        self.expected = expected
        self.replacement = replacement

    def __repr__(self):
        return self.label


MUTATIONS = [
    # --- the terminal predicate: what counts as an abandoned run ---
    Mutation(
        "terminal: run_finished dropped from the predicate",
        EP,
        2848,
        "                if not (translator.run_finished or stream_exhausted):",
        "                if not stream_exhausted:",
    ),
    Mutation(
        "terminal: nothing is ever abandoned",
        EP,
        2848,
        "                if not (translator.run_finished or stream_exhausted):",
        "                if False:",
    ),
    # --- the raw-event sink, both halves of its gate ---
    Mutation(
        "sink: the whole gate removed",
        EP,
        2362,
        "        if request_torn_down.is_set() or abandonment.abandoned:",
        "        if False:",
    ),
    Mutation(
        "sink: only the abandonment half removed",
        EP,
        2362,
        "        if request_torn_down.is_set() or abandonment.abandoned:",
        "        if request_torn_down.is_set():",
    ),
    Mutation(
        "sink: only the teardown half removed",
        EP,
        2362,
        "        if request_torn_down.is_set() or abandonment.abandoned:",
        "        if abandonment.abandoned:",
    ),
    # --- the driver closing what it opened ---
    Mutation(
        # The helper's body, not its call: replacing a call whose arguments span
        # lines strands them and the suite dies of a SyntaxError, which reads as a
        # kill but proves nothing.
        "teardown: the frame iterator is left to the collector",
        EP,
        2040,
        '    aclose = getattr(aiter, "aclose", None)',
        "    aclose = None",
    ),
    # --- the conversation the pool slot is keyed by ---
    Mutation(
        "pool key: the flow identity dropped, so one threadId is one conversation",
        CONV,
        326,
        "            if flow_key is not None and held.flow_key != flow_key:",
        "            if False:",
    ),
    # --- the adapter's publish and drain gates ---
    Mutation(
        "publish: abandonment gate removed",
        CONV,
        1473,
        "            if self._abandoned:",
        "            if False:",
    ),
    Mutation(
        "drain: discard gate removed, so late frames publish",
        CONV,
        1511,
        "                    if self._abandoned:",
        "                    if False:",
    ),
    Mutation(
        "drain: continue -> break, leaving the session unexhausted",
        CONV,
        1526,
        "                        continue",
        "                        break",
    ),
    Mutation(
        "plumbing: dereferenced without the accessor's snapshot",
        CONV,
        1470,
        "            plumbing = self._consumer_plumbing()",
        "            plumbing = self._plumbing\n            loop, queue = plumbing",
    ),
    # --- the pool slot, on each of its release paths ---
    Mutation(
        "lease: worker-exit release removed",
        CONV,
        1578,
        "                    self._release_lease()",
        "                    pass",
    ),
    Mutation(
        "lease: never-started release removed",
        CONV,
        1595,
        "            self._release_lease()",
        "            pass",
    ),
    Mutation(
        "lease: aclose release removed",
        CONV,
        1684,
        "                self._release_lease()",
        "                pass",
    ),
    # --- per-run gating on a possibly-shared flow ---
    Mutation(
        "per-run: the caller's own run is ignored, so one binding serves both",
        CONV,
        801,
        "        active = _ACTIVE_GATE.get(None)",
        "        active = None",
    ),
    Mutation(
        # The repoint's body rather than its call site: replacing the call would
        # strand its continuation lines and the suite would die of a SyntaxError
        # instead of on a guard, which reads as a kill but proves nothing.
        "per-run: the fallback keeps the previous run's binding",
        CONV,
        792,
        "        self._agui_bind(self._agui_backend_ref, binding)",
        "        return",
    ),
    Mutation(
        "per-run: the lazy guard keeps the first run's binding",
        CONV,
        1129,
        "    object.__setattr__(flow, _GUARD_ATTR, binding)",
        "    if getattr(flow, _GUARD_ATTR, None) is None:\n"
        "        object.__setattr__(flow, _GUARD_ATTR, binding)",
    ),
    # --- the persistence write gate, in both directions ---
    Mutation(
        "persistence: never drops, so an abandoned turn writes",
        CONV,
        827,
        "        if not binding.abandonment.abandoned:",
        "        if True:",
    ),
    Mutation(
        "persistence: always drops, so a terminal tail loses its writes",
        CONV,
        827,
        "        if not binding.abandonment.abandoned:",
        "        if False:",
    ),
    # --- the observability an operator reads the containment through ---
    Mutation(
        "counter: thread conflicts are not counted",
        CONV,
        237,
        "                self._thread_conflict_rejections += 1",
        "                pass",
    ),
    Mutation(
        "counter: capacity rejections are not counted",
        CONV,
        245,
        "                self._capacity_rejections += 1",
        "                pass",
    ),
    Mutation(
        "stats: active always reports 0",
        CONV,
        422,
        "            active=len(self._leases),",
        "            active=0,",
    ),
    Mutation(
        "stats: abandoned_active always reports 0",
        CONV,
        423,
        "            abandoned_active=len(abandoned),",
        "            abandoned_active=0,",
    ),
    Mutation(
        "stats: the oldest abandoned age is always unknown",
        CONV,
        424,
        "            oldest_abandoned_age_seconds=oldest,",
        "            oldest_abandoned_age_seconds=None,",
    ),
    Mutation(
        "warning: the ungated @persist limitation is not reported",
        CONV,
        1211,
        "    definitions = _enabled_persist_definitions(flow)",
        "    definitions = []",
    ),
    Mutation(
        "warning: the @persist gap is reported even where the writes ARE gated",
        CONV,
        1209,
        "    if _persist_writes_reach_the_gate(flow):",
        "    if False:",
    ),
]


def _apply(mutation):
    """The mutated source, or a hard error naming the drifted anchor."""
    lines = mutation.path.read_text().splitlines(keepends=True)
    index = mutation.line - 1
    actual = lines[index].rstrip() if index < len(lines) else "<past end of file>"
    if actual != mutation.expected:
        raise AssertionError(
            f"ANCHOR ERROR: {mutation.path.name}:{mutation.line} is not "
            f"{mutation.expected!r}. Actual: {actual!r}. Re-point the anchor by "
            "hand, after checking the guard is still there."
        )
    occurrences = sum(1 for line in lines if line.rstrip() == mutation.expected)
    if occurrences != 1:
        raise AssertionError(
            f"ANCHOR ERROR: {mutation.path.name}:{mutation.line} is one of "
            f"{occurrences} identical lines, so this entry does not say which "
            f"guard it neutralizes: {mutation.expected!r}. Re-point it at a line "
            "that is unique in the file."
        )
    lines[index] = mutation.replacement.rstrip("\n") + "\n"
    return "".join(lines)


def _child_env(*, in_flight=True):
    """The child's environment, with the parent's ``PYTEST_ADDOPTS`` removed.

    Whatever the parent was invoked with must not reach the child. The obvious case
    is ``-m mutation``, which re-selects this file inside every child so each child
    spawns its own children. The dangerous case is quieter: any ``-k`` or ``-m``
    that SHRINKS the child suite silently drops the test that would have caught a
    mutation, and the mutation is then reported as a survivor.

    ``in_flight`` tells the child that its parent is alive and holding a mutation,
    so conftest leaves the backup alone. Only the test that checks the repair
    itself passes False, because it is standing in for a parent that died.
    """
    env = {key: value for key, value in os.environ.items() if key != "PYTEST_ADDOPTS"}
    if in_flight:
        env[MUTATION_IN_FLIGHT_ENV_VAR] = "1"
    else:
        env.pop(MUTATION_IN_FLIGHT_ENV_VAR, None)
    return env


def _child_args(*extra):
    """The child pytest command. Deselects this file explicitly as a second lock."""
    return [
        sys.executable,
        "-m",
        "pytest",
        "tests/",
        "-q",
        "--no-header",
        "-p",
        "no:cacheprovider",
        "-m",
        "not mutation",
        *extra,
    ]


def _run_suite():
    """The whole suite, with this file's own tests kept out of the child run."""
    return subprocess.run(
        _child_args(),
        cwd=PROJECT,
        capture_output=True,
        text=True,
        timeout=1800,
        env=_child_env(),
    )


def test_the_unmutated_suite_passes_first():
    """A baseline, so a mutation that "kills" a suite already red proves nothing."""
    proc = _run_suite()
    assert proc.returncode == 0, proc.stdout[-4000:]


def _collected(env):
    """Test ids the child run would collect under ``env``."""
    proc = subprocess.run(
        _child_args("--collect-only"),
        cwd=PROJECT,
        capture_output=True,
        text=True,
        timeout=300,
        env=env,
    )
    assert proc.returncode == 0, proc.stdout[-2000:]
    return [line for line in proc.stdout.splitlines() if "::" in line]


def test_the_child_run_is_immune_to_inherited_addopts(monkeypatch):
    """The scrub in ``_child_env`` is checked, not trusted.

    A ``-k`` filter is the inherited option worth measuring: unlike ``-m``, the
    explicit marker expression on the command line does not override it, so it
    survives into the child and shrinks the suite each mutation is judged against.
    One test left standing means every guard reads as a survivor.

    Asserted on the collection alone, so the check costs a fraction of a second.
    """
    monkeypatch.setenv("PYTEST_ADDOPTS", "-k test_reads_are_never_gated")

    scrubbed = _collected(_child_env())
    inherited = _collected(dict(os.environ))

    assert "test_conversational_guard_mutations" not in "\n".join(scrubbed), (
        "the child run would rerun the mutation suite inside itself"
    )
    assert len(scrubbed) > 100, f"the child run collected almost nothing: {scrubbed}"
    # The same command carrying the parent's addopts, i.e. what a survivor would
    # otherwise have been measured against.
    assert len(inherited) < 10 < len(scrubbed), (
        "an inherited -k no longer shrinks the child suite, so this test no longer "
        f"shows what the scrub is for: {len(inherited)} vs {len(scrubbed)}"
    )


@pytest.mark.parametrize("mutation", MUTATIONS, ids=lambda m: m.label)
def test_neutralizing_a_containment_guard_fails_the_suite(mutation):
    """One guard removed; some test has to notice."""
    original = mutation.path.read_text()
    mutated = _apply(mutation)
    # The original on DISK before the package is touched, because a ``finally``
    # only runs while this process is alive: a timeout, a Ctrl-C at the wrong
    # moment or an OOM kill leaves the mutated file behind, and then every run
    # after it reports a pass for a guard that is switched off. conftest honours
    # this backup at the start of EVERY run and fails the session saying so.
    backup = mutation.path.with_name(mutation.path.name + MUTATION_BACKUP_SUFFIX)
    backup.write_text(original)
    mutation.path.write_text(mutated)
    try:
        proc = _run_suite()
    finally:
        mutation.path.write_text(original)
        backup.unlink(missing_ok=True)

    failed = sorted(
        {
            line.split("::")[-1].split(" ")[0]
            for line in proc.stdout.splitlines()
            if line.startswith("FAILED")
        }
    )
    assert proc.returncode != 0, (
        f"SURVIVOR: nothing fails when this guard is neutralized, so it is not "
        f"tested: {mutation.label}"
    )
    assert failed, (
        "the suite failed without naming a test, so the failure may be a "
        f"collection error rather than a guard being caught: {proc.stdout[-2000:]}"
    )
    # Reported so a mutation caught only by an unrelated collapse is visible.
    print(f"killed by {failed[:3]}")


def test_a_killed_run_is_repaired_and_reported_by_the_next_one():
    """The backup is honoured, and honouring it is not silent.

    This is the failure this harness actually had: it was killed mid-mutation, so
    the ``finally`` never ran, and the package sat in the working tree with a guard
    switched off. Every run after it passed, including the one that reported "no
    survivors". Checked in a CHILD run, because the repair happens before
    collection and cannot be observed from inside the session it repairs.
    """
    target = CONV
    original = target.read_text()
    backup = target.with_name(target.name + MUTATION_BACKUP_SUFFIX)
    # A mutation whose absence no assertion depends on, so what fails in the child
    # is the repair guard rather than some guard's own test.
    marker = "# a mutation the child must not be left holding\n"
    backup.write_text(original)
    target.write_text(original + marker)
    try:
        proc = subprocess.run(
            _child_args("--collect-only"),
            cwd=PROJECT,
            capture_output=True,
            text=True,
            timeout=300,
            env=_child_env(in_flight=False),
        )
        repaired = target.read_text()
    finally:
        target.write_text(original)
        backup.unlink(missing_ok=True)

    reported = proc.stdout + proc.stderr
    assert repaired == original, "the child did not restore the package from its backup"
    assert proc.returncode != 0, (
        "the child repaired the package and said nothing, so a killed run stays "
        f"invisible: {reported[-2000:]}"
    )
    assert "died before restoring" in reported, (
        f"the refusal does not say what happened: {reported[-2000:]}"
    )
    # Refused BEFORE any test ran, not after a suite's worth of results the
    # operator might read as a pass with one odd failure at the end.
    assert "tests collected" not in reported, (
        f"the child collected and ran tests on a tree it had just repaired: {reported[-2000:]}"
    )


def test_every_anchor_still_points_at_its_guard():
    """Cheap enough to run on its own: the anchors alone, no suite reruns.

    Selected with ``-m mutation`` like the rest of this file, but it is the one
    test here that finishes in milliseconds, so it is the quick way to find out
    that the table has drifted.
    """
    drifted = []
    for mutation in MUTATIONS:
        try:
            _apply(mutation)
        except AssertionError as exc:
            drifted.append(str(exc))
    assert drifted == [], drifted
