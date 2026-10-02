"""One IDS run end to end: claim, download the IFC, validate, store results.

Database and storage are passed in (see db.py / storage.py) so the flow is
testable without Postgres or MinIO.
"""

import logging
import os
import signal
import tempfile
from collections.abc import Callable
from typing import Protocol

from coord_worker.ids_validation import IdsResult, validate_ifc

log = logging.getLogger("coord_worker")

GENERIC_ERROR = "Falha ao executar a verificação"


class JobLimitError(Exception):
    """A failure whose message is safe and useful to show the user as is."""


class ClaimedRun(Protocol):
    id: str
    rule_set_version_id: str
    ifc_object_key: str | None


class Repository(Protocol):
    def claim_ids_run(self) -> ClaimedRun | None: ...
    def load_ids_xml(self, rule_set_version_id: str) -> str | None: ...
    def load_rule_by_spec(self, rule_set_version_id: str) -> dict[int, str]: ...
    def replace_results(self, run_id: str, results: list[IdsResult]) -> None: ...
    def mark_done(self, run_id: str) -> None: ...
    def mark_failed(self, run_id: str, error: str) -> None: ...


class Storage(Protocol):
    def object_size(self, key: str) -> int: ...
    def download(self, key: str, path: str) -> None: ...


def _with_timeout(seconds: int, fn: Callable[[], list[IdsResult]]) -> list[IdsResult]:
    """Hard time limit for the validation (A06): IDS regexes and large models
    can take very long; SIGALRM interrupts the main thread."""

    def on_timeout(_signum, _frame):
        raise JobLimitError("Validação IDS excedeu o tempo limite para este modelo")

    previous = signal.signal(signal.SIGALRM, on_timeout)
    signal.alarm(seconds)
    try:
        return fn()
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)


def process_next_ids_run(
    repo: Repository,
    storage: Storage,
    *,
    max_ifc_mb: int,
    max_validation_seconds: int,
) -> bool:
    """Processes one queued IDS run. Returns False when the queue is empty."""
    run = repo.claim_ids_run()
    if run is None:
        return False

    tmp_path = None
    try:
        if not run.ifc_object_key:
            raise JobLimitError("Versão sem arquivo IFC original")
        ids_xml = repo.load_ids_xml(run.rule_set_version_id)
        if not ids_xml:
            raise JobLimitError("Conjunto de regras IDS sem arquivo IDS")
        rule_by_spec = repo.load_rule_by_spec(run.rule_set_version_id)

        size = storage.object_size(run.ifc_object_key)
        if size > max_ifc_mb * 1024 * 1024:
            raise JobLimitError(
                "Arquivo IFC grande demais para a validação "
                f"(limite de {max_ifc_mb} MB)"
            )

        fd, tmp_path = tempfile.mkstemp(suffix=".ifc")
        os.close(fd)
        storage.download(run.ifc_object_key, tmp_path)

        results = _with_timeout(
            max_validation_seconds,
            lambda: validate_ifc(tmp_path, ids_xml, rule_by_spec),
        )
        repo.replace_results(run.id, results)
        repo.mark_done(run.id)
        log.info("IDS run validated", extra={"run_id": run.id, "results": len(results)})
    except JobLimitError as err:
        log.warning("IDS run refused", extra={"run_id": run.id, "reason": str(err)})
        repo.mark_failed(run.id, str(err))
    except Exception:
        # A10: details only in the log, generic message to the user
        log.exception("IDS run failed", extra={"run_id": run.id})
        repo.mark_failed(run.id, GENERIC_ERROR)
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)
    return True
