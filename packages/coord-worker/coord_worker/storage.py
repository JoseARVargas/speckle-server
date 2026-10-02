"""Read-only access to the original uploads in MinIO / S3."""

import boto3
from botocore.config import Config


class S3Storage:
    def __init__(
        self,
        *,
        endpoint: str,
        access_key: str,
        secret_key: str,
        bucket: str,
        region: str,
    ):
        self.bucket = bucket
        self.client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name=region,
            config=Config(
                signature_version="s3v4",
                s3={"addressing_style": "path"},
                retries={"max_attempts": 3},
                connect_timeout=10,
                read_timeout=120,
            ),
        )

    def object_size(self, key: str) -> int:
        return int(
            self.client.head_object(Bucket=self.bucket, Key=key)["ContentLength"]
        )

    def download(self, key: str, path: str) -> None:
        self.client.download_file(self.bucket, key, path)
