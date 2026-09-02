from __future__ import annotations

import asyncio
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agno.db.in_memory import InMemoryDb
from agno.db.sqlite import SqliteDb as AgnoSqliteDb
from agno.db.migrations.manager import MigrationManager
from agno.learn.utils import build_learning_id, legacy_entity_learning_id

from migrate_v3 import migrate_to_v3


LEGACY_RUN = {
    "run_id": "legacy-run",
    "agent_id": "legacy-agent",
    "status": "COMPLETED",
    "content": "preserved",
    "created_at": 1_700_000_000,
}


class WrappedSqliteDb(AgnoSqliteDb):
    pass


class SqliteDb(AgnoSqliteDb):
    pass


def _create_legacy_database(database_file: Path) -> None:
    connection = sqlite3.connect(database_file)
    try:
        connection.executescript(
            """
            CREATE TABLE agno_sessions (
                session_id VARCHAR PRIMARY KEY NOT NULL,
                session_type VARCHAR NOT NULL,
                agent_id VARCHAR,
                team_id VARCHAR,
                workflow_id VARCHAR,
                user_id VARCHAR,
                session_data JSON,
                agent_data JSON,
                team_data JSON,
                workflow_data JSON,
                metadata JSON,
                runs JSON,
                summary JSON,
                created_at BIGINT NOT NULL,
                updated_at BIGINT
            );
            CREATE TABLE agno_schema_versions (
                table_name VARCHAR PRIMARY KEY NOT NULL,
                version VARCHAR NOT NULL,
                created_at VARCHAR NOT NULL,
                updated_at VARCHAR
            );
            """
        )
        connection.execute(
            """
            INSERT INTO agno_sessions (
                session_id, session_type, agent_id, user_id, runs, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                "legacy-session",
                "agent",
                "legacy-agent",
                "legacy-user",
                json.dumps([LEGACY_RUN]),
                1_700_000_000,
            ),
        )
        connection.execute(
            """
            INSERT INTO agno_schema_versions (
                table_name, version, created_at, updated_at
            ) VALUES (?, ?, ?, ?)
            """,
            ("agno_sessions", "2.5.6", "2026-01-01T00:00:00", None),
        )
        connection.commit()
    finally:
        connection.close()


class DatabaseMigrationTests(unittest.TestCase):
    def test_invalid_table_type_fails_instead_of_reporting_success(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database = AgnoSqliteDb(
                db_file=str(Path(temporary_directory) / "invalid-table-type.db")
            )
            try:
                with self.assertRaisesRegex(ValueError, "Unsupported table type"):
                    asyncio.run(migrate_to_v3(database, table_type="session"))
            finally:
                database.close()

    def test_adapter_that_cannot_report_session_schema_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database = AgnoSqliteDb(
                db_file=str(Path(temporary_directory) / "unstamped-session.db")
            )
            try:
                with patch.object(
                    database, "get_latest_schema_version", return_value=None
                ):
                    with self.assertRaisesRegex(RuntimeError, "did not reach schema"):
                        asyncio.run(migrate_to_v3(database, table_type="sessions"))
            finally:
                database.close()

    def test_unsupported_adapter_fails_before_poisoning_schema_stamp(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_file = Path(temporary_directory) / "unsupported-adapter.db"
            _create_legacy_database(database_file)
            database = WrappedSqliteDb(db_file=str(database_file))
            try:
                with self.assertRaisesRegex(TypeError, "Unsupported database adapter"):
                    asyncio.run(migrate_to_v3(database, table_type="sessions"))

                self.assertEqual(
                    database.get_latest_schema_version("agno_sessions"), "2.5.6"
                )
                connection = sqlite3.connect(database_file)
                try:
                    runs_table = connection.execute(
                        "SELECT name FROM sqlite_master WHERE name = 'agno_runs'"
                    ).fetchone()
                finally:
                    connection.close()
                self.assertIsNone(runs_table)
            finally:
                database.close()

    def test_unverified_published_adapter_is_rejected(self) -> None:
        database = InMemoryDb()
        with self.assertRaisesRegex(TypeError, "Unsupported database adapter"):
            asyncio.run(migrate_to_v3(database, table_type="sessions"))

    def test_same_named_subclass_cannot_bypass_adapter_preflight(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_file = Path(temporary_directory) / "spoofed-adapter.db"
            _create_legacy_database(database_file)
            database = SqliteDb(db_file=str(database_file))
            try:
                with self.assertRaisesRegex(TypeError, "Unsupported database adapter"):
                    asyncio.run(migrate_to_v3(database, table_type="sessions"))

                self.assertEqual(
                    database.get_latest_schema_version("agno_sessions"), "2.5.6"
                )
            finally:
                database.close()

    def test_learning_only_database_migrates_without_a_sessions_table(self) -> None:
        entity_id = "learning-only-entity"
        entity_type = "person"
        user_id = "learning-only-user"
        legacy_learning_id = legacy_entity_learning_id(
            entity_id, entity_type, "user"
        )
        migrated_learning_id = build_learning_id(
            "entity_memory",
            user_id=user_id,
            entity_id=entity_id,
            entity_type=entity_type,
            namespace="user",
        )
        with tempfile.TemporaryDirectory() as temporary_directory:
            database = AgnoSqliteDb(
                db_file=str(Path(temporary_directory) / "learning-only.db")
            )
            try:
                database.upsert_learning(
                    id=legacy_learning_id,
                    learning_type="entity_memory",
                    content={"user_id": user_id, "facts": ["preserved"]},
                    user_id=user_id,
                    namespace="user",
                    entity_id=entity_id,
                    entity_type=entity_type,
                )
                database.upsert_schema_version(
                    database.learnings_table_name, "2.5.6"
                )
                self.assertFalse(database.table_exists(database.session_table_name))

                asyncio.run(migrate_to_v3(database))

                self.assertEqual(
                    database.get_latest_schema_version(database.session_table_name),
                    "3.0.0",
                )
                self.assertEqual(
                    database.get_latest_schema_version(database.learnings_table_name),
                    "3.0.0",
                )
                migrated_learning = database.get_learning_by_id(migrated_learning_id)
                self.assertIsNotNone(migrated_learning)
                self.assertEqual(
                    migrated_learning["content"],
                    {"user_id": user_id, "facts": ["preserved"]},
                )
            finally:
                database.close()

    def test_malformed_learning_fails_before_v3_schema_stamp(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_file = Path(temporary_directory) / "malformed-learning.db"
            database = AgnoSqliteDb(db_file=str(database_file))
            try:
                database.upsert_learning(
                    id="legacy-malformed",
                    learning_type="entity_memory",
                    content={"user_id": "user-1"},
                    user_id="user-1",
                    namespace="user",
                    entity_type="person",
                )
                database.upsert_schema_version(database.learnings_table_name, "2.5.6")

                with self.assertRaisesRegex(RuntimeError, "unresolved learning"):
                    asyncio.run(migrate_to_v3(database, table_type="learnings"))

                self.assertEqual(
                    database.get_latest_schema_version(database.learnings_table_name),
                    "2.5.6",
                )
                self.assertIsNotNone(database.get_learning_by_id("legacy-malformed"))
            finally:
                database.close()

    def test_existing_v3_stamp_does_not_hide_unresolved_learning(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database = AgnoSqliteDb(
                db_file=str(Path(temporary_directory) / "stamped-learning.db")
            )
            try:
                database.upsert_learning(
                    id="stamped-malformed",
                    learning_type="entity_memory",
                    content={"user_id": "user-1"},
                    user_id="user-1",
                    namespace="user",
                    entity_type="person",
                )
                database.upsert_schema_version(
                    database.learnings_table_name, "3.0.0"
                )

                with self.assertRaisesRegex(RuntimeError, "unresolved learning"):
                    asyncio.run(migrate_to_v3(database, table_type="learnings"))
            finally:
                database.close()

    def test_existing_v3_session_stamp_cannot_hide_unmigrated_runs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_file = Path(temporary_directory) / "stamped-session.db"
            _create_legacy_database(database_file)
            connection = sqlite3.connect(database_file)
            try:
                connection.execute(
                    "UPDATE agno_schema_versions SET version = '3.0.0' "
                    "WHERE table_name = 'agno_sessions'"
                )
                connection.commit()
            finally:
                connection.close()

            database = AgnoSqliteDb(db_file=str(database_file))
            try:
                with self.assertRaisesRegex(RuntimeError, "already stamped"):
                    asyncio.run(migrate_to_v3(database, table_type="sessions"))
                self.assertIsNone(database.get_run("legacy-run", deserialize=False))
            finally:
                database.close()

    def test_session_migration_rejects_stamped_no_op(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_file = Path(temporary_directory) / "no-op-session.db"
            _create_legacy_database(database_file)
            database = AgnoSqliteDb(db_file=str(database_file))

            async def stamp_without_copy(manager, *args, **kwargs) -> None:
                manager.db.upsert_schema_version(
                    manager.db.session_table_name, "3.0.0"
                )

            try:
                with patch.object(MigrationManager, "up", new=stamp_without_copy):
                    with self.assertRaisesRegex(RuntimeError, "legacy session runs"):
                        asyncio.run(migrate_to_v3(database, table_type="sessions"))
            finally:
                database.close()

    def test_session_migration_rejects_malformed_legacy_run(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_file = Path(temporary_directory) / "malformed-run.db"
            _create_legacy_database(database_file)
            connection = sqlite3.connect(database_file)
            try:
                connection.execute(
                    "UPDATE agno_sessions SET runs = ? WHERE session_id = ?",
                    (
                        json.dumps([{"agent_id": "legacy-agent", "content": "orphan"}]),
                        "legacy-session",
                    ),
                )
                connection.commit()
            finally:
                connection.close()

            database = AgnoSqliteDb(db_file=str(database_file))
            try:
                with self.assertRaisesRegex(RuntimeError, "malformed legacy run"):
                    asyncio.run(migrate_to_v3(database, table_type="sessions"))
                self.assertEqual(
                    database.get_latest_schema_version("agno_sessions"), "2.5.6"
                )
            finally:
                database.close()

    def test_session_retry_compares_against_raw_legacy_payload(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_file = Path(temporary_directory) / "corrupt-retry.db"
            _create_legacy_database(database_file)
            database = AgnoSqliteDb(db_file=str(database_file))
            try:
                asyncio.run(
                    MigrationManager(database).up(
                        target_version="3.0.0", table_type="sessions"
                    )
                )
                connection = sqlite3.connect(database_file)
                try:
                    connection.execute(
                        "UPDATE agno_runs SET run_data = ? WHERE run_id = ?",
                        (json.dumps({**LEGACY_RUN, "content": "corrupted"}), "legacy-run"),
                    )
                    connection.execute(
                        "UPDATE agno_schema_versions SET version = '2.5.6' "
                        "WHERE table_name = 'agno_sessions'"
                    )
                    connection.commit()
                finally:
                    connection.close()

                with self.assertRaisesRegex(RuntimeError, "legacy session runs"):
                    asyncio.run(migrate_to_v3(database, table_type="sessions"))
                self.assertEqual(
                    database.get_latest_schema_version(database.session_table_name),
                    "2.5.6",
                )
            finally:
                database.close()

    def test_session_migration_accepts_double_encoded_legacy_runs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_file = Path(temporary_directory) / "double-encoded-runs.db"
            _create_legacy_database(database_file)
            connection = sqlite3.connect(database_file)
            try:
                connection.execute(
                    "UPDATE agno_sessions SET runs = ? WHERE session_id = ?",
                    (json.dumps(json.dumps([LEGACY_RUN])), "legacy-session"),
                )
                connection.commit()
            finally:
                connection.close()

            database = AgnoSqliteDb(db_file=str(database_file))
            try:
                asyncio.run(migrate_to_v3(database, table_type="sessions"))
                migrated_run = database.get_run("legacy-run", deserialize=False)
                self.assertEqual(migrated_run["run_data"], LEGACY_RUN)
                self.assertEqual(
                    database.get_latest_schema_version(database.session_table_name),
                    "3.0.0",
                )
            finally:
                database.close()

    def test_session_retry_rejects_a_conflicting_run_with_the_wrong_owner(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_file = Path(temporary_directory) / "wrong-owner-retry.db"
            _create_legacy_database(database_file)
            database = AgnoSqliteDb(db_file=str(database_file))
            try:
                asyncio.run(
                    MigrationManager(database).up(
                        target_version="3.0.0", table_type="sessions"
                    )
                )
                connection = sqlite3.connect(database_file)
                try:
                    connection.execute(
                        "UPDATE agno_runs SET user_id = ? WHERE run_id = ?",
                        ("wrong-user", "legacy-run"),
                    )
                    connection.execute(
                        "UPDATE agno_schema_versions SET version = '2.5.6' "
                        "WHERE table_name = 'agno_sessions'"
                    )
                    connection.commit()
                finally:
                    connection.close()

                with self.assertRaisesRegex(RuntimeError, "legacy session runs"):
                    asyncio.run(migrate_to_v3(database, table_type="sessions"))
                self.assertEqual(
                    database.get_latest_schema_version(database.session_table_name),
                    "2.5.6",
                )
            finally:
                database.close()

    def test_session_migration_rejects_partial_run_copy(self) -> None:
        second_run = {**LEGACY_RUN, "run_id": "legacy-run-2", "content": "second"}
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_file = Path(temporary_directory) / "partial-session.db"
            _create_legacy_database(database_file)
            connection = sqlite3.connect(database_file)
            try:
                connection.execute(
                    "UPDATE agno_sessions SET runs = ? WHERE session_id = ?",
                    (json.dumps([LEGACY_RUN, second_run]), "legacy-session"),
                )
                connection.commit()
            finally:
                connection.close()

            database = AgnoSqliteDb(db_file=str(database_file))
            original_up = MigrationManager.up

            async def drop_one_copied_run(manager, *args, **kwargs) -> None:
                await original_up(manager, *args, **kwargs)
                manager.db.delete_run("legacy-run-2")

            try:
                with patch.object(MigrationManager, "up", new=drop_one_copied_run):
                    with self.assertRaisesRegex(RuntimeError, "legacy session runs"):
                        asyncio.run(migrate_to_v3(database, table_type="sessions"))
            finally:
                database.close()

    def test_future_learning_stamp_is_not_rewritten(self) -> None:
        entity_id = "future-entity"
        entity_type = "person"
        learning_id = legacy_entity_learning_id(entity_id, entity_type, "user")
        with tempfile.TemporaryDirectory() as temporary_directory:
            database = AgnoSqliteDb(
                db_file=str(Path(temporary_directory) / "future-learning.db")
            )
            try:
                database.upsert_learning(
                    id=learning_id,
                    learning_type="entity_memory",
                    content={"user_id": "user-1", "facts": []},
                    user_id="user-1",
                    namespace="user",
                    entity_id=entity_id,
                    entity_type=entity_type,
                )
                database.upsert_schema_version(
                    database.learnings_table_name, "4.0.0"
                )

                with self.assertRaisesRegex(RuntimeError, "newer schema"):
                    asyncio.run(migrate_to_v3(database, table_type="learnings"))

                self.assertIsNotNone(database.get_learning_by_id(learning_id))
                self.assertEqual(
                    database.get_latest_schema_version(database.learnings_table_name),
                    "4.0.0",
                )
            finally:
                database.close()

    def test_learning_rekey_not_implemented_fails_without_v3_stamp(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database = AgnoSqliteDb(
                db_file=str(Path(temporary_directory) / "unsupported-rekey.db")
            )
            try:
                database.upsert_schema_version(database.learnings_table_name, "2.5.6")
                with patch(
                    "agno.learn.migrations.rekey_user_entity_learnings",
                    side_effect=NotImplementedError("rekey unavailable"),
                ):
                    with self.assertRaisesRegex(NotImplementedError, "rekey unavailable"):
                        asyncio.run(migrate_to_v3(database, table_type="learnings"))

                self.assertEqual(
                    database.get_latest_schema_version(database.learnings_table_name),
                    "2.5.6",
                )
            finally:
                database.close()

    def test_learning_failure_recovers_through_focused_retry(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_file = Path(temporary_directory) / "focused-learning-retry.db"
            _create_legacy_database(database_file)
            database = AgnoSqliteDb(db_file=str(database_file))
            try:
                database.upsert_learning(
                    id="retry-malformed",
                    learning_type="entity_memory",
                    content={"user_id": "user-1"},
                    user_id="user-1",
                    namespace="user",
                    entity_type="person",
                )
                with self.assertRaisesRegex(RuntimeError, "unresolved learning"):
                    asyncio.run(migrate_to_v3(database))

                self.assertEqual(
                    database.get_latest_schema_version(database.session_table_name),
                    "3.0.0",
                )
                database.delete_learning("retry-malformed")
                asyncio.run(migrate_to_v3(database, table_type="learnings"))
                self.assertEqual(
                    database.get_latest_schema_version(database.learnings_table_name),
                    "3.0.0",
                )
            finally:
                database.close()

    def test_v2_session_runs_move_to_the_v3_runs_table_without_losing_backup(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_file = Path(temporary_directory) / "legacy.db"
            _create_legacy_database(database_file)
            database = AgnoSqliteDb(db_file=str(database_file))
            try:
                asyncio.run(migrate_to_v3(database))

                migrated_run = database.get_run("legacy-run", deserialize=False)
                self.assertIsNotNone(migrated_run)
                self.assertEqual(migrated_run["session_id"], "legacy-session")
                self.assertEqual(migrated_run["agent_id"], "legacy-agent")
                self.assertEqual(migrated_run["user_id"], "legacy-user")
                self.assertEqual(migrated_run["run_data"]["status"], "COMPLETED")
                self.assertEqual(migrated_run["run_data"]["content"], "preserved")
                self.assertEqual(migrated_run["created_at"], 1_700_000_000)
                self.assertEqual(
                    database.get_latest_schema_version("agno_sessions"), "3.0.0"
                )

                connection = sqlite3.connect(database_file)
                try:
                    legacy_runs = connection.execute(
                        "SELECT runs FROM agno_sessions WHERE session_id = ?",
                        ("legacy-session",),
                    ).fetchone()[0]
                finally:
                    connection.close()

                self.assertEqual(json.loads(legacy_runs), [LEGACY_RUN])
            finally:
                database.close()


if __name__ == "__main__":
    unittest.main()
