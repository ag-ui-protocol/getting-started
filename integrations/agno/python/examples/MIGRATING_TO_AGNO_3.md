# Migrating a durable database to Agno 3

This example does not configure a database by default. If your deployment adds
an Agno database, migrate it from the v2 schema to schema version `3.0.0` before
serving normal application traffic from the upgraded application.

The v3 migration separates runs from session rows, adds user-isolation fields
and indexes, changes the metrics uniqueness key, and rekeys user-scoped learned
entities. The migration keeps the legacy session `runs` column as a backup.

## Upgrade sequence

1. Stop application writes and keep the upgraded service out of traffic.
2. Take a complete database backup and test restoring it.
3. Test the migration on a copy of production data.
4. Install this example's frozen environment with `uv sync --frozen`.
5. Run the migration to target schema version `3.0.0`.
6. Verify schema stamps, session ownership, run counts, run identifiers, run
   payloads, and the learning rekey report before allowing traffic.
7. Restart AgentOS after the migration.

Do not serve normal traffic from an Agno 3 application connected to an
unmigrated durable database. A maintenance-only AgentOS instance may expose the
authenticated migration endpoint while it remains out of normal traffic.

## Fail-closed repository helper

The repository helper uses Agno's published `MigrationManager` API. Configure
the same database class and table names as the application:

```python
import asyncio

from agno.db.sqlite import SqliteDb

from migrate_v3 import migrate_to_v3

database = SqliteDb(db_file="tmp/agents.db")

asyncio.run(migrate_to_v3(database))
```

This fail-closed helper deliberately accepts only Agno's exact synchronous
`SqliteDb` class, the path installed by this lock and covered by the repository's
behavior tests. It rejects subclasses, async adapters, and other providers.
Those deployments need their own provider dependencies declared in their
project lock and provider-specific migration/reconciliation tests; do not treat
this SQLite helper or the stock endpoint as proof for them.

The helper verifies every selected table reached the target version.
For sessions it snapshots every legacy run before migration and requires the v3
runs store to contain the same identity, session, owner, routing fields, status,
index, timestamp, and payload afterward. This catches a stamped no-op, malformed
legacy entry, corrupt destination, or partial copy.
If post-copy reconciliation fails, the helper restores the prior session schema
stamp before raising. The v3 runs table may still contain copied or conflicting
rows; reconcile those rows against the legacy backup or restore the tested
database backup before retrying the focused session migration.
For the learnings table it inspects Agno's rekey report before writing the v3
stamp. It fails without stamping when rows remain in `conflicts`, `failed`,
`malformed`, `contaminated_keyed`, or `unowned`, so the operator can reconcile
those rows. After reconciliation, retry only the learning phase with
`asyncio.run(migrate_to_v3(database, table_type="learnings"))`; the successful
structural phases from the default call are already stamped and deliberately
block a blind all-table retry. Verify the learning stamp before restoring
traffic. Use Agno's public
`rekey_user_entity_learnings(database, dry_run=True)` helper to inspect the
affected learning identifiers.

For structural tables, the helper refuses a database that was already stamped
at `3.0.0` before this invocation. A stamp alone cannot prove that Agno's stock
endpoint actually changed the schema or copied legacy runs. Treat that refusal
as a recovery checkpoint: restore the tested pre-upgrade backup instead of
lowering a production stamp and rerunning blindly. The learnings table is the
exception because its public rekey operation is safely rechecked even behind an
existing v3 stamp.
The helper also refuses learning stamps newer than `3.0.0`; an older maintenance
environment must not rewrite data owned by a schema it does not understand.
After handling a structural-table refusal, recheck an exactly v3 learning stamp
with the focused call
`asyncio.run(migrate_to_v3(database, table_type="learnings"))`; the default
all-table call stops at the structural recovery checkpoint first.

## Stock AgentOS migration endpoint

Agno also exposes `POST /databases/all/migrate` and
`POST /databases/{db_id}/migrate`. These stock endpoints call
`MigrationManager` directly and do not use this repository's preflight or
post-migration checks. They can return HTTP `200` after an unsupported adapter
or an unstamped table was skipped, so an HTTP status is not proof that migration
ran.

Prefer the repository helper above for SQLite. If an authenticated
maintenance-only AgentOS instance is used for another provider, handle HTTP
`207` as partial failure, migrate remote databases on their owning AgentOS
instances, and run provider-specific structural and row reconciliation before
allowing traffic.

## Verification and cleanup

- Confirm every configured local table in `agno_schema_versions` is stamped
  `3.0.0`.
- Confirm every v2 session is present with the expected owner.
- Confirm every legacy run identifier and payload is present in the v3 runs
  table. The default table is `agno_runs`; a custom session table uses its
  configured runs-table name.
- Inspect `PRAGMA table_info(agno_runs)` and confirm the runs table has the v3
  identity, owner, payload, and timestamp columns. For every configured metrics,
  evals, components, knowledge, schedules, and schedule-runs table, inspect
  `PRAGMA table_info(<table>)` and confirm the expected v3 `user_id` column.
  Inspect `PRAGMA index_list(<table>)` and `PRAGMA index_info(<index>)`; the
  metrics uniqueness key must include `user_id`, `date`, and
  `aggregation_period`.
- Exercise session history, paused-run resume, and new writes in staging.
- Confirm the learning rekey has no unresolved `conflicts`, `failed`,
  `malformed`, `contaminated_keyed`, or `unowned` rows.
- Keep the database backup and the legacy session `runs` column until the
  upgraded deployment has been stable and the migrated rows are verified.

Cleanup is intentionally separate from migration. SQLite exposes
`cleanup_legacy_runs_column()`. Do not call it during the initial upgrade. If
you later remove the backup column, take another database backup and verify
every migrated run first. The method requires `force=True` while legacy backup
values remain.

For a full rollback, stop traffic and writes, redeploy the previous Agno 2
application with its prior locked environment and configuration, restore the
pre-upgrade database backup, verify that v2 application/database pairing, and
only then resume traffic. Do not rely on a blanket down-migration after writes
have reached v3 because the user-scoped learning rekey is not reversible.

The migration regression test creates a legacy v2 SQLite session, migrates it,
and checks the v3 run row, ownership, schema stamp, payload, and retained backup
column:

```bash
uv run --frozen python -m unittest tests/test_database_migration.py
```
