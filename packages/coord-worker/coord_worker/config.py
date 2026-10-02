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
        )
