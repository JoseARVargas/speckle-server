"""Manual integration check (not collected by pytest): the clash job against a
real Postgres with the least-privilege coord_worker role.

Needs ADMIN_URL (a role that can insert the fixture rows) and WORKER_URL
(coord_worker). Run inside the worker image with the repo mounted.
"""

import json
import os
import tempfile
from pathlib import Path

import psycopg

from coord_worker.clash_db import ClashRepository
from coord_worker.clash_jobs import process_next_clash_run
from tests.clash_fixtures import build_clash_models

admin = psycopg.connect(os.environ["ADMIN_URL"], autocommit=True)
models = build_clash_models(Path(tempfile.mkdtemp()))
run_id, test_id = "itclashrun", "itclashtst"

admin.execute("DELETE FROM coord_clash_tests WHERE id = %s", (test_id,))
group = {"modelId": "m1", "where": []}
admin.execute(
    """INSERT INTO coord_clash_tests (id, "projectId", name, type, "groupA", "groupB", ignore)
       VALUES (%s, 'itproj', 'it', 'hard', %s, %s, '{}')""",
    (test_id, json.dumps(group), json.dumps(group)),
)
admin.execute(
    """INSERT INTO coord_clash_runs (id, "projectId", "testId", "modelIdA", "versionIdA",
       "objectKeyA", "modelIdB", "versionIdB", "objectKeyB", trigger, status, settings)
       VALUES (%s, 'itproj', %s, 'm1', 'v1', 'struct.ifc', 'm2', 'v2', 'arch.ifc',
               'manual', 'geometry', %s)""",
    (run_id, test_id, json.dumps({"type": "hard", "toleranceMm": 5})),
)
for side, key in (("a", models["column"]), ("b", models["slab"]), ("b", models["far"])):
    admin.execute(
        'INSERT INTO coord_clash_run_elements ("runId", side, "elementKey") '
        "VALUES (%s, %s, %s)",
        (run_id, side, key),
    )


class LocalStorage:
    files = {"struct.ifc": models["struct"], "arch.ifc": models["arch"]}

    def object_size(self, key):
        return os.path.getsize(self.files[key])

    def download(self, key, path):
        Path(path).write_bytes(Path(self.files[key]).read_bytes())


with psycopg.connect(os.environ["WORKER_URL"]) as worker:
    worked = process_next_clash_run(
        ClashRepository(worker),
        LocalStorage(),
        max_ifc_mb=10,
        max_seconds=60,
        min_free_mb=0,
        slice_size=1500,
        max_pairs=1000,
    )
    print("processed:", worked)

    # least privilege: the worker must not read unrelated tables
    try:
        worker.execute("SELECT count(*) FROM users")
        print("users readable: YES (bad)")
    except psycopg.errors.InsufficientPrivilege:
        worker.rollback()
        print("users readable: no")

row = admin.execute(
    'SELECT status, error, "geometrySeconds", "peakRssMb" FROM coord_clash_runs '
    "WHERE id = %s",
    (run_id,),
).fetchone()
raw = admin.execute(
    'SELECT "keyA", "keyB", "distanceMm", "clashType" FROM coord_clash_raw '
    'WHERE "runId" = %s',
    (run_id,),
).fetchall()
print("run:", row)
print("raw:", raw)
admin.execute("DELETE FROM coord_clash_tests WHERE id = %s", (test_id,))
