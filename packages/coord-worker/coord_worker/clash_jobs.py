"""One clash run end to end: wait for memory, claim, download the IFC(s),
compute the geometry, store the raw pairs. Database, storage and the memory
probe are injected, so the flow is testable without Postgres, MinIO or load.
"""

import logging
import os
import tempfile
import time
from collections.abc import Callable
from typing import Protocol

from coord_worker.clash import (
    ClashLimitError,
    ClashSettings,
    RawPair,
    compute_clashes,
    peak_rss_mb,
)
from coord_worker.jobs import JobLimitError, Storage, _with_timeout

log = logging.getLogger("coord_worker")

GENERIC_CLASH_ERROR = "Falha ao calcular o clash"


class ClaimedClashRun(Protocol):
    id: str
    object_key_a: str
    object_key_b: str
    settings: dict


class ClashRepo(Protocol):
    def claim_clash_run(self) -> ClaimedClashRun | None: ...
    def load_keys(self, run_id: str) -> tuple[list[str], list[str]]: ...
    def replace_raw(self, run_id: str, pairs: list[RawPair]) -> None: ...
    def mark_clash_done(
        self, run_id: str, seconds: float, peak_rss_mb: int
    ) -> None: ...
    def mark_clash_failed(self, run_id: str, error: str) -> None: ...


def available_memory_mb() -> int:
    """MemAvailable of the host (a container sees the host's /proc/meminfo)."""
    with open("/proc/meminfo", encoding="ascii") as f:
        for line in f:
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) // 1024
    return 0


def _settings(raw: dict) -> ClashSettings:
    clearance = raw.get("clearanceMm")
    return ClashSettings(
        type=raw.get("type", "hard"),
        tolerance_mm=float(raw.get("toleranceMm", 5)),
        clearance_mm=float(clearance) if clearance is not None else None,
    )


def process_next_clash_run(
    repo: ClashRepo,
    storage: Storage,
    *,
    max_ifc_mb: int,
    max_seconds: int,
    min_free_mb: int,
    slice_size: int,
    max_pairs: int,
    free_memory: Callable[[], int] = available_memory_mb,
) -> bool:
    """Processes one clash run. Returns False when there is nothing to do now:
    an empty queue, or not enough free memory (the run waits in the queue,
    e.g. while the other stack converts a large IFC)."""
    free = free_memory()
    if free < min_free_mb:
        log.info(
            "clash waiting for memory", extra={"free_mb": free, "min_mb": min_free_mb}
        )
        return False

    run = repo.claim_clash_run()
    if run is None:
        return False

    started = time.monotonic()
    paths: dict[str, str] = {}
    try:
        settings = _settings(run.settings)
        keys_a, keys_b = repo.load_keys(run.id)
        for key in dict.fromkeys((run.object_key_a, run.object_key_b)):
            if storage.object_size(key) > max_ifc_mb * 1024 * 1024:
                raise JobLimitError(
                    "Arquivo IFC grande demais para o clash "
                    f"(limite de {max_ifc_mb} MB)"
                )
            fd, path = tempfile.mkstemp(suffix=".ifc")
            os.close(fd)
            paths[key] = path
            storage.download(key, path)

        pairs = _with_timeout(
            max_seconds,
            lambda: compute_clashes(
                path_a=paths[run.object_key_a],
                path_b=paths[run.object_key_b],
                keys_a=keys_a,
                keys_b=keys_b,
                settings=settings,
                slice_size=slice_size,
                max_pairs=max_pairs,
            ),
            "O cálculo do clash excedeu o tempo limite; refine os grupos",
        )
        repo.replace_raw(run.id, pairs)
        repo.mark_clash_done(
            run.id, round(time.monotonic() - started, 1), peak_rss_mb()
        )
        log.info("clash run computed", extra={"run_id": run.id, "pairs": len(pairs)})
    except (JobLimitError, ClashLimitError) as err:
        log.warning("clash run refused", extra={"run_id": run.id, "reason": str(err)})
        repo.mark_clash_failed(run.id, str(err))
    except Exception:
        # A10: details only in the log, generic message to the user
        log.exception("clash run failed", extra={"run_id": run.id})
        repo.mark_clash_failed(run.id, GENERIC_CLASH_ERROR)
    finally:
        for path in paths.values():
            if os.path.exists(path):
                os.remove(path)
    return True
