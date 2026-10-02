"""Postgres access for the worker. Parameterized SQL only (A05).

Runs as the least-privilege role coord_worker: it can read/update
coord_check_runs, read coord_rule_set_versions / coord_rules and write
coord_check_results - nothing else (see README for the GRANTs).
"""

from dataclasses import dataclass

import psycopg
from psycopg.rows import dict_row

from coord_worker.ids_validation import IdsResult


@dataclass(frozen=True)
class Run:
    id: str
    rule_set_version_id: str
    ifc_object_key: str | None


class PostgresRepository:
    def __init__(self, conn: psycopg.Connection):
        self.conn = conn

    def claim_ids_run(self) -> Run | None:
        """queued -> ids_running for the oldest IDS run. SKIP LOCKED lets
        several workers poll the same table without blocking each other."""
        with self.conn.transaction(), self.conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """
                SELECT id, "ruleSetVersionId", "ifcObjectKey"
                FROM coord_check_runs
                WHERE status = 'queued' AND engine = 'ids'
                ORDER BY "queuedAt"
                FOR UPDATE SKIP LOCKED
                LIMIT 1
                """
            )
            row = cur.fetchone()
            if row is None:
                return None
            cur.execute(
                """
                UPDATE coord_check_runs
                SET status = 'ids_running', attempt = attempt + 1,
                    "startedAt" = now(), error = NULL
                WHERE id = %s
                """,
                (row["id"],),
            )
            return Run(row["id"], row["ruleSetVersionId"], row["ifcObjectKey"])

    def load_ids_xml(self, rule_set_version_id: str) -> str | None:
        with self.conn.cursor() as cur:
            cur.execute(
                'SELECT "idsXml" FROM coord_rule_set_versions WHERE id = %s',
                (rule_set_version_id,),
            )
            row = cur.fetchone()
        self.conn.commit()
        return row[0] if row else None

    def load_rule_by_spec(self, rule_set_version_id: str) -> dict[int, str]:
        with self.conn.cursor() as cur:
            cur.execute(
                'SELECT id, definition FROM coord_rules WHERE "ruleSetVersionId" = %s',
                (rule_set_version_id,),
            )
            rows = cur.fetchall()
        self.conn.commit()
        rule_by_spec: dict[int, str] = {}
        for rule_id, definition in rows:
            if isinstance(definition, dict) and definition.get("kind") == "ids":
                rule_by_spec[int(definition["specIndex"])] = rule_id
        return rule_by_spec

    def replace_results(self, run_id: str, results: list[IdsResult]) -> None:
        """Clears a previous attempt's rows and bulk loads the new ones."""
        with self.conn.transaction(), self.conn.cursor() as cur:
            cur.execute('DELETE FROM coord_check_results WHERE "runId" = %s', (run_id,))
            with cur.copy(
                "COPY coord_check_results "
                '("runId", "ruleId", "elementKey", status, message) FROM STDIN'
            ) as copy:
                for r in results:
                    copy.write_row(
                        (run_id, r.rule_id, r.element_key, r.status, r.message)
                    )

    def mark_done(self, run_id: str) -> None:
        with self.conn.transaction(), self.conn.cursor() as cur:
            cur.execute(
                "UPDATE coord_check_runs SET status = 'ids_done' WHERE id = %s",
                (run_id,),
            )

    def mark_failed(self, run_id: str, error: str) -> None:
        with self.conn.transaction(), self.conn.cursor() as cur:
            cur.execute(
                """
                UPDATE coord_check_runs
                SET status = 'failed', error = %s, "finishedAt" = now()
                WHERE id = %s
                """,
                (error[:500], run_id),
            )
