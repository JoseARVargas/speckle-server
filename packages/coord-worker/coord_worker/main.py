"""Polling loop: drains queued IDS runs, then sleeps. Never exits on a job
error (A10); stops cleanly on SIGTERM/SIGINT."""

import logging
import signal
import sys
import time

import psycopg

from coord_worker.config import Settings
from coord_worker.db import PostgresRepository
from coord_worker.jobs import process_next_ids_run
from coord_worker.storage import S3Storage

log = logging.getLogger("coord_worker")
_stopping = False


def _stop(_signum, _frame):
    global _stopping
    _stopping = True


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        stream=sys.stdout,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    settings = Settings.from_env()
    storage = S3Storage(
        endpoint=settings.s3_endpoint,
        access_key=settings.s3_access_key,
        secret_key=settings.s3_secret_key,
        bucket=settings.s3_bucket,
        region=settings.s3_region,
    )
    log.info("coord-worker started")

    while not _stopping:
        try:
            with psycopg.connect(settings.database_url) as conn:
                repo = PostgresRepository(conn)
                while not _stopping and process_next_ids_run(
                    repo,
                    storage,
                    max_ifc_mb=settings.max_ifc_mb,
                    max_validation_seconds=settings.max_validation_seconds,
                ):
                    pass
        except Exception:
            log.exception("coord-worker tick failed")
        # sleep in small steps so SIGTERM is honoured quickly
        for _ in range(int(settings.poll_seconds * 10)):
            if _stopping:
                break
            time.sleep(0.1)

    log.info("coord-worker stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
