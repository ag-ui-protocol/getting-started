from __future__ import annotations

import importlib
import json
from typing import Optional

from agno.db.base import AsyncBaseDb, BaseDb
from agno.db.migrations.manager import MigrationManager
from packaging.version import Version


TARGET_SCHEMA_VERSION = "3.0.0"
PREVIOUS_SCHEMA_VERSION = "2.5.6"
TABLE_TYPE_TO_ATTRIBUTE = {
    "memories": "memory_table_name",
    "sessions": "session_table_name",
    "metrics": "metrics_table_name",
    "evals": "eval_table_name",
    "knowledge": "knowledge_table_name",
    "approvals": "approvals_table_name",
    "components": "components_table_name",
    "schedules": "schedules_table_name",
    "schedule_runs": "schedule_runs_table_name",
    "learnings": "learnings_table_name",
}
SUPPORTED_TABLE_TYPES = frozenset(TABLE_TYPE_TO_ATTRIBUTE)
SUPPORTED_DATABASE_ADAPTERS = {
    "SqliteDb": "agno.db.sqlite.sqlite",
}
UNRESOLVED_LEARNING_BUCKETS = (
    "conflicts",
    "failed",
    "malformed",
    "contaminated_keyed",
    "unowned",
)


def _is_exact_published_adapter(database: BaseDb | AsyncBaseDb) -> bool:
    adapter_type = type(database)
    adapter_name = adapter_type.__name__
    adapter_module_name = SUPPORTED_DATABASE_ADAPTERS.get(adapter_name)
    if adapter_module_name is None:
        return False
    adapter_module = importlib.import_module(adapter_module_name)
    return getattr(adapter_module, adapter_name, None) is adapter_type


async def _get_schema_version(
    database: BaseDb | AsyncBaseDb, table_name: str
) -> Optional[str]:
    if isinstance(database, AsyncBaseDb):
        return await database.get_latest_schema_version(table_name)
    return database.get_latest_schema_version(table_name)


async def _set_schema_version(
    database: BaseDb | AsyncBaseDb, table_name: str, version: str
) -> None:
    if isinstance(database, AsyncBaseDb):
        await database.upsert_schema_version(table_name, version)
    else:
        database.upsert_schema_version(table_name, version)


async def _table_exists(database: BaseDb | AsyncBaseDb, table_name: str) -> bool:
    if isinstance(database, AsyncBaseDb):
        return await database.table_exists(table_name)
    return database.table_exists(table_name)


async def _snapshot_legacy_session_runs(
    database: BaseDb | AsyncBaseDb,
) -> list[tuple[str, Optional[str], int, dict]]:
    if not await _table_exists(database, database.session_table_name):
        return []

    table_name = database.db_engine.dialect.identifier_preparer.quote(
        database.session_table_name
    )
    with database.db_engine.connect() as connection:
        rows = connection.exec_driver_sql(
            f"SELECT session_id, user_id, runs FROM {table_name}"
        ).mappings()
        legacy_session_runs = []
        for row in rows:
            runs = row["runs"]
            if isinstance(runs, (bytes, bytearray)):
                runs = runs.decode()
            if isinstance(runs, str):
                runs = json.loads(runs)
            if isinstance(runs, str):
                runs = json.loads(runs)
            if runs is None:
                continue
            if not isinstance(runs, list):
                raise RuntimeError(
                    f"Session {row['session_id']} has malformed legacy runs data"
                )
            for run_index, run in enumerate(runs):
                if not isinstance(run, dict) or not run.get("run_id"):
                    raise RuntimeError(
                        f"Session {row['session_id']} has a malformed legacy run"
                    )
                legacy_session_runs.append(
                    (row["session_id"], row["user_id"], run_index, run)
                )
    return legacy_session_runs


async def _verify_legacy_session_runs(
    database: BaseDb | AsyncBaseDb,
    legacy_session_runs: list[tuple[str, Optional[str], int, dict]],
) -> None:
    incomplete_run_ids = []
    for session_id, user_id, run_index, legacy_run in legacy_session_runs:
        run_id = legacy_run["run_id"]
        if isinstance(database, AsyncBaseDb):
            migrated_run = await database.get_run(run_id, deserialize=False)
        else:
            migrated_run = database.get_run(run_id, deserialize=False)
        expected_run_type = (
            "agent"
            if legacy_run.get("agent_id")
            else "team"
            if legacy_run.get("team_id")
            else "workflow"
        )
        if (
            not isinstance(migrated_run, dict)
            or migrated_run.get("session_id") != session_id
            or migrated_run.get("run_type") != expected_run_type
            or migrated_run.get("agent_id") != legacy_run.get("agent_id")
            or migrated_run.get("team_id") != legacy_run.get("team_id")
            or migrated_run.get("workflow_id") != legacy_run.get("workflow_id")
            or migrated_run.get("user_id") != user_id
            or migrated_run.get("parent_run_id") != legacy_run.get("parent_run_id")
            or migrated_run.get("status") != legacy_run.get("status")
            or migrated_run.get("run_index") != run_index
            or migrated_run.get("run_data") != legacy_run
            or (
                legacy_run.get("created_at") is not None
                and migrated_run.get("created_at") != legacy_run["created_at"]
            )
        ):
            incomplete_run_ids.append(run_id)

    if incomplete_run_ids:
        details = ", ".join(incomplete_run_ids)
        raise RuntimeError(
            f"Migration did not preserve all legacy session runs: {details}"
        )


async def _migrate_learnings(database: BaseDb | AsyncBaseDb) -> None:
    table_name = database.learnings_table_name
    current_version = await _get_schema_version(database, table_name)
    if current_version is None:
        raise RuntimeError(f"Database table {table_name} is unstamped")
    parsed_current_version = Version(current_version)
    if parsed_current_version > Version(TARGET_SCHEMA_VERSION):
        raise RuntimeError(
            f"Database table {table_name} has newer schema {current_version}; "
            f"this helper only understands {TARGET_SCHEMA_VERSION}"
        )
    needs_schema_stamp = parsed_current_version < Version(TARGET_SCHEMA_VERSION)
    if needs_schema_stamp:
        await MigrationManager(database).up(
            target_version=PREVIOUS_SCHEMA_VERSION,
            table_type="learnings",
        )

    if isinstance(database, AsyncBaseDb):
        from agno.learn.migrations import arekey_user_entity_learnings

        report = await arekey_user_entity_learnings(database, dry_run=False)
    else:
        from agno.learn.migrations import rekey_user_entity_learnings

        report = rekey_user_entity_learnings(database, dry_run=False)

    unresolved = {
        bucket: report[bucket]
        for bucket in UNRESOLVED_LEARNING_BUCKETS
        if report.get(bucket)
    }
    if unresolved:
        details = ", ".join(
            f"{bucket}={len(learning_ids)}"
            for bucket, learning_ids in unresolved.items()
        )
        raise RuntimeError(f"Migration left unresolved learning rows: {details}")

    if needs_schema_stamp:
        await _set_schema_version(database, table_name, TARGET_SCHEMA_VERSION)


async def migrate_to_v3(
    database: BaseDb | AsyncBaseDb,
    table_type: Optional[str] = None,
) -> None:
    """Migrate an Agno v2 database to the v3 schema."""
    adapter_name = type(database).__name__
    if not _is_exact_published_adapter(database):
        raise TypeError(
            f"Unsupported database adapter {adapter_name!r}. "
            "Agno's v3 migration dispatch requires an exact supported adapter type."
        )

    if table_type is not None and table_type not in SUPPORTED_TABLE_TYPES:
        supported = ", ".join(sorted(SUPPORTED_TABLE_TYPES))
        raise ValueError(
            f"Unsupported table type {table_type!r}. Expected one of: {supported}"
        )

    selected_table_types = [table_type] if table_type else TABLE_TYPE_TO_ATTRIBUTE
    already_stamped_tables = []
    unstamped_tables = []
    original_schema_versions = {}
    for selected_table_type in selected_table_types:
        if selected_table_type == "learnings":
            continue
        table_name = getattr(
            database, TABLE_TYPE_TO_ATTRIBUTE[selected_table_type]
        )
        schema_version = await _get_schema_version(database, table_name)
        if schema_version is None:
            unstamped_tables.append(table_name)
        elif Version(schema_version) >= Version(
            TARGET_SCHEMA_VERSION
        ):
            already_stamped_tables.append(f"{table_name} ({schema_version})")
        else:
            original_schema_versions[selected_table_type] = schema_version

    if unstamped_tables:
        details = ", ".join(unstamped_tables)
        raise RuntimeError(
            f"Database tables did not reach schema {TARGET_SCHEMA_VERSION}: "
            f"{details} (unstamped)"
        )

    if already_stamped_tables:
        details = ", ".join(already_stamped_tables)
        raise RuntimeError(
            "Database tables are already stamped at or above the v3 target, so "
            f"this helper cannot safely prove their migration state: {details}"
        )

    legacy_session_runs = (
        await _snapshot_legacy_session_runs(database)
        if "sessions" in selected_table_types
        else []
    )
    for selected_table_type in selected_table_types:
        if selected_table_type == "learnings":
            await _migrate_learnings(database)
        else:
            table_name = getattr(
                database, TABLE_TYPE_TO_ATTRIBUTE[selected_table_type]
            )
            try:
                await MigrationManager(database).up(
                    target_version=TARGET_SCHEMA_VERSION,
                    table_type=selected_table_type,
                )
                if selected_table_type == "sessions":
                    await _verify_legacy_session_runs(database, legacy_session_runs)
            except Exception:
                await _set_schema_version(
                    database,
                    table_name,
                    original_schema_versions[selected_table_type],
                )
                raise

    incomplete_tables = []
    for selected_table_type in selected_table_types:
        table_name = getattr(
            database, TABLE_TYPE_TO_ATTRIBUTE[selected_table_type]
        )
        schema_version = await _get_schema_version(database, table_name)
        if schema_version is None or Version(schema_version) < Version(
            TARGET_SCHEMA_VERSION
        ):
            incomplete_tables.append(f"{table_name} ({schema_version or 'unstamped'})")

    if incomplete_tables:
        details = ", ".join(incomplete_tables)
        raise RuntimeError(
            f"Database tables did not reach schema {TARGET_SCHEMA_VERSION}: {details}"
        )
