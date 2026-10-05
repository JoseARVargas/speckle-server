"""Postgres access for clash runs. Parameterized SQL only (A05).

The coord_worker role can read/update coord_clash_runs (status columns),
read coord_clash_run_elements and write coord_clash_raw - see
sql/coord_worker_role.sql.
"""

from dataclasses import dataclass

import psycopg
from psycopg.rows import dict_row

from coord_worker.clash import RawPair


@dataclass(frozen=True)
class ClashRun:
    id: str
    object_key_a: str
    object_key_b: str
    settings: dict


class ClashRepository:
    def __init__(self, conn: psycopg.Connection):
        self.conn = conn

    def claim_clash_run(self) -> ClashRun | None:
        """geometry -> geometry_running for the oldest run (SKIP LOCKED)."""
        with self.conn.transaction(), self.conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """
                SELECT id, "objectKeyA", "objectKeyB", settings
                FROM coord_clash_runs
                WHERE status = 'geometry'
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
                UPDATE coord_clash_runs
                SET status = 'geometry_running', attempt = attempt + 1,
                    "startedAt" = now(), error = NULL
                WHERE id = %s
                """,
                (row["id"],),
            )
            return ClashRun(
                row["id"], row["objectKeyA"], row["objectKeyB"], row["settings"]
            )

    def load_keys(self, run_id: str) -> tuple[list[str], list[str]]:
        with self.conn.cursor() as cur:
            cur.execute(
                'SELECT side, "elementKey" FROM coord_clash_run_elements '
                'WHERE "runId" = %s',
                (run_id,),
            )
            rows = cur.fetchall()
        self.conn.commit()
        keys_a = [key for side, key in rows if side == "a"]
        keys_b = [key for side, key in rows if side == "b"]
        return keys_a, keys_b

    def replace_raw(self, run_id: str, pairs: list[RawPair]) -> None:
        with self.conn.transaction(), self.conn.cursor() as cur:
            cur.execute('DELETE FROM coord_clash_raw WHERE "runId" = %s', (run_id,))
            with cur.copy(
                "COPY coord_clash_raw "
                '("runId", "keyA", "keyB", "distanceMm", point, "clashType", relation) '
                "FROM STDIN"
            ) as copy:
                for p in pairs:
                    copy.write_row(
                        (
                            run_id,
                            p.key_a,
                            p.key_b,
                            p.distance_mm,
                            list(p.point),
                            p.clash_type,
                            p.relation,
                        )
                    )

    def mark_clash_done(self, run_id: str, seconds: float, peak_rss_mb: int) -> None:
        with self.conn.transaction(), self.conn.cursor() as cur:
            cur.execute(
                """
                UPDATE coord_clash_runs
                SET status = 'geometry_done', "geometrySeconds" = %s, "peakRssMb" = %s
                WHERE id = %s
                """,
                (seconds, peak_rss_mb, run_id),
            )

    def mark_clash_failed(self, run_id: str, error: str) -> None:
        with self.conn.transaction(), self.conn.cursor() as cur:
            cur.execute(
                """
                UPDATE coord_clash_runs
                SET status = 'failed', error = %s, "finishedAt" = now()
                WHERE id = %s
                """,
                (error[:500], run_id),
            )
