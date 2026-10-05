"""Worker settings, read only from the environment (secrets never in code)."""

import os
from dataclasses import dataclass


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable {name}")
    return value


@dataclass(frozen=True)
class Settings:
    database_url: str
    s3_endpoint: str
    s3_access_key: str
    s3_secret_key: str
    s3_bucket: str
    s3_region: str
    poll_seconds: float
    max_ifc_mb: int
    max_validation_seconds: int
    # clash (sized for a 1 vCPU / 4 GB VPS, see the clash plan)
    max_clash_seconds: int
    clash_min_free_mb: int
    clash_slice_size: int
    clash_max_pairs: int

    @staticmethod
    def from_env() -> "Settings":
        return Settings(
            # Dedicated least-privilege role (coord_worker), not the server's
            database_url=_required("COORD_WORKER_DATABASE_URL"),
            s3_endpoint=_required("S3_ENDPOINT"),
            s3_access_key=_required("S3_ACCESS_KEY"),
            s3_secret_key=_required("S3_SECRET_KEY"),
            s3_bucket=_required("S3_BUCKET"),
            s3_region=os.environ.get("S3_REGION", "us-east-1"),
            poll_seconds=float(os.environ.get("COORD_WORKER_POLL_SECONDS", "5")),
            max_ifc_mb=int(os.environ.get("COORD_WORKER_MAX_IFC_MB", "200")),
            max_validation_seconds=int(
                os.environ.get("COORD_WORKER_MAX_VALIDATION_SECONDS", "900")
            ),
            max_clash_seconds=int(
                os.environ.get("COORD_WORKER_MAX_CLASH_SECONDS", "3600")
            ),
            # don't start clash geometry below this much free host memory
            clash_min_free_mb=int(
                os.environ.get("COORD_WORKER_CLASH_MIN_FREE_MB", "1200")
            ),
            clash_slice_size=int(os.environ.get("COORD_WORKER_CLASH_SLICE", "1500")),
            clash_max_pairs=int(
                os.environ.get("COORD_WORKER_CLASH_MAX_PAIRS", "50000")
            ),
        )
