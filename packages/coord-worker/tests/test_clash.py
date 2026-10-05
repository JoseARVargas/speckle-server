"""Clash geometry and job flow on IFCs generated with known positions."""

import pytest

from coord_worker.clash import ClashLimitError, ClashSettings, compute_clashes
from coord_worker.clash_jobs import process_next_clash_run
from tests.clash_fixtures import build_clash_models

HARD = ClashSettings(type="hard", tolerance_mm=5, clearance_mm=None)


@pytest.fixture
def models(tmp_path) -> dict:
    return build_clash_models(tmp_path)


def by_pair(pairs):
    return {(p.key_a, p.key_b): p for p in pairs}


def test_hard_clash_between_two_ifc_files(models):
    # two different IFCs in one tree (IfcOpenShell issue #6062 territory)
    pairs = by_pair(
        compute_clashes(
            path_a=models["struct"],
            path_b=models["arch"],
            keys_a=[models["column"]],
            keys_b=[models["slab"], models["far"]],
            settings=HARD,
        )
    )
    assert set(pairs) == {(models["column"], models["slab"])}
    clash = pairs[(models["column"], models["slab"])]
    assert clash.distance_mm < 0  # penetration is negative
    assert clash.relation is None
    assert len(clash.point) == 3


def test_clearance_reports_30mm_gap_not_80mm(models):
    settings = ClashSettings(type="clearance", tolerance_mm=0, clearance_mm=50)
    pairs = by_pair(
        compute_clashes(
            path_a=models["struct"],
            path_b=models["arch"],
            keys_a=[models["column"]],
            keys_b=[models["near30"], models["near80"]],
            settings=settings,
        )
    )
    assert set(pairs) == {(models["column"], models["near30"])}
    assert pairs[(models["column"], models["near30"])].distance_mm == pytest.approx(
        30, abs=1
    )


def test_hosted_and_connected_relations_in_one_model(models):
    keys = [models["host"], models["door"], models["w1"], models["w2"]]
    pairs = compute_clashes(
        path_a=models["arch"],
        path_b=models["arch"],
        keys_a=keys,
        keys_b=keys,
        settings=HARD,
    )
    relations = {frozenset((p.key_a, p.key_b)): p.relation for p in pairs}
    assert relations[frozenset((models["host"], models["door"]))] == "hosted"
    assert relations[frozenset((models["w1"], models["w2"]))] == "connected"
    # an element never clashes with itself
    assert all(p.key_a != p.key_b for p in pairs)


def test_slicing_gives_the_same_result(models):
    common = dict(
        path_a=models["struct"],
        path_b=models["arch"],
        keys_a=[models["column"]],
        keys_b=[models["slab"], models["far"], models["near30"], models["near80"]],
        settings=HARD,
    )
    whole = by_pair(compute_clashes(**common, slice_size=1500))
    sliced = by_pair(compute_clashes(**common, slice_size=1))
    assert whole.keys() == sliced.keys()
    for key, pair in whole.items():
        assert sliced[key].distance_mm == pytest.approx(pair.distance_mm, abs=0.01)


def test_missing_elements_and_pair_limit(models):
    with pytest.raises(ClashLimitError, match="não foram encontrados"):
        compute_clashes(
            path_a=models["struct"],
            path_b=models["arch"],
            keys_a=["0000000000000000000000"],
            keys_b=[models["slab"]],
            settings=HARD,
        )
    with pytest.raises(ClashLimitError, match="mais de 0 pares"):
        compute_clashes(
            path_a=models["struct"],
            path_b=models["arch"],
            keys_a=[models["column"]],
            keys_b=[models["slab"]],
            settings=HARD,
            max_pairs=0,
        )


# ---- job flow -------------------------------------------------------------------


class FakeRun:
    def __init__(self, models):
        self.id = "run1"
        self.object_key_a = "struct.ifc"
        self.object_key_b = "arch.ifc"
        self.settings = {"type": "hard", "toleranceMm": 5, "clearanceMm": None}
        self.models = models


class FakeRepo:
    def __init__(self, run, keys):
        self.run, self.keys = run, keys
        self.claimed = False
        self.raw = None
        self.done = None
        self.failed = None

    def claim_clash_run(self):
        if self.claimed or self.run is None:
            return None
        self.claimed = True
        return self.run

    def load_keys(self, run_id):
        return self.keys

    def replace_raw(self, run_id, pairs):
        self.raw = pairs

    def mark_clash_done(self, run_id, seconds, peak_rss_mb):
        self.done = (seconds, peak_rss_mb)

    def mark_clash_failed(self, run_id, error):
        self.failed = error


class FakeStorage:
    def __init__(self, files, size=1000):
        self.files, self.size = files, size

    def object_size(self, key):
        return self.size

    def download(self, key, path):
        with open(self.files[key], "rb") as src, open(path, "wb") as dst:
            dst.write(src.read())


JOB = dict(
    max_ifc_mb=10, max_seconds=60, min_free_mb=1200, slice_size=1500, max_pairs=1000
)


def test_job_waits_for_memory_without_claiming(models):
    repo = FakeRepo(FakeRun(models), ([models["column"]], [models["slab"]]))
    storage = FakeStorage({"struct.ifc": models["struct"], "arch.ifc": models["arch"]})
    assert (
        process_next_clash_run(repo, storage, **JOB, free_memory=lambda: 500) is False
    )
    assert repo.claimed is False


def test_job_computes_and_stores_raw_pairs(models):
    repo = FakeRepo(
        FakeRun(models), ([models["column"]], [models["slab"], models["far"]])
    )
    storage = FakeStorage({"struct.ifc": models["struct"], "arch.ifc": models["arch"]})
    assert (
        process_next_clash_run(repo, storage, **JOB, free_memory=lambda: 4000) is True
    )
    assert repo.failed is None
    assert [(p.key_a, p.key_b) for p in repo.raw] == [
        (models["column"], models["slab"])
    ]
    seconds, peak = repo.done
    assert seconds >= 0 and peak > 0


def test_job_refuses_oversized_ifc_with_a_clear_message(models):
    repo = FakeRepo(FakeRun(models), ([models["column"]], [models["slab"]]))
    storage = FakeStorage(
        {"struct.ifc": models["struct"], "arch.ifc": models["arch"]},
        size=20 * 1024 * 1024,
    )
    assert (
        process_next_clash_run(repo, storage, **JOB, free_memory=lambda: 4000) is True
    )
    assert "grande demais" in repo.failed
    assert repo.raw is None


def test_job_reports_a_limit_raised_in_the_child_process(models):
    repo = FakeRepo(FakeRun(models), ([models["column"]], [models["slab"]]))
    storage = FakeStorage({"struct.ifc": models["struct"], "arch.ifc": models["arch"]})
    job = {**JOB, "max_pairs": 0}
    assert process_next_clash_run(repo, storage, **job, free_memory=lambda: 4000)
    assert "mais de 0 pares" in repo.failed
    assert repo.raw is None
