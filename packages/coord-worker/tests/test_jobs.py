import shutil
from dataclasses import dataclass, field

from coord_worker.jobs import GENERIC_ERROR, process_next_ids_run


@dataclass
class FakeRun:
    id: str = "run1"
    rule_set_version_id: str = "ver1"
    ifc_object_key: str | None = "proj/blob.ifc"


@dataclass
class FakeRepo:
    xml: str
    run: FakeRun | None = field(default_factory=FakeRun)
    results: list = field(default_factory=list)
    done: list = field(default_factory=list)
    failed: list = field(default_factory=list)

    def claim_ids_run(self):
        run, self.run = self.run, None
        return run

    def load_ids_xml(self, _version):
        return self.xml

    def load_rule_by_spec(self, _version):
        return {0: "rule-columns", 1: "rule-doors"}

    def replace_results(self, run_id, results):
        self.results = results

    def mark_done(self, run_id):
        self.done.append(run_id)

    def mark_failed(self, run_id, error):
        self.failed.append((run_id, error))


class FakeStorage:
    def __init__(self, source_path: str, size: int | None = None):
        self.source_path = source_path
        self.size = size

    def object_size(self, _key):
        return self.size if self.size is not None else 1024

    def download(self, _key, path):
        shutil.copyfile(self.source_path, path)


def run_job(repo, storage, **limits):
    return process_next_ids_run(
        repo,
        storage,
        max_ifc_mb=limits.get("max_ifc_mb", 200),
        max_validation_seconds=limits.get("max_validation_seconds", 60),
    )


def test_validates_and_marks_done(sample_ifc, sample_ids):
    repo = FakeRepo(sample_ids)
    assert run_job(repo, FakeStorage(sample_ifc["path"])) is True
    assert repo.done == ["run1"]
    assert repo.failed == []
    assert len(repo.results) == 3


def test_empty_queue_returns_false(sample_ids):
    repo = FakeRepo(sample_ids, run=None)
    assert run_job(repo, FakeStorage("unused")) is False


def test_refuses_ifc_over_the_size_limit(sample_ifc, sample_ids):
    repo = FakeRepo(sample_ids)
    run_job(
        repo, FakeStorage(sample_ifc["path"], size=300 * 1024 * 1024), max_ifc_mb=200
    )
    assert repo.failed and "grande demais" in repo.failed[0][1]
    assert repo.done == []


def test_run_without_ifc_fails_clearly(sample_ids):
    repo = FakeRepo(sample_ids, run=FakeRun(ifc_object_key=None))
    run_job(repo, FakeStorage("unused"))
    assert repo.failed == [("run1", "Versão sem arquivo IFC original")]


def test_unexpected_errors_fail_with_a_generic_message(sample_ids, tmp_path):
    broken = tmp_path / "broken.ifc"
    broken.write_text("not an ifc")
    repo = FakeRepo(sample_ids)
    run_job(repo, FakeStorage(str(broken)))
    assert repo.failed == [("run1", GENERIC_ERROR)]
