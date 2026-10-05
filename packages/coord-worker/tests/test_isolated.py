import resource
import time

import pytest

from coord_worker.clash import ClashLimitError
from coord_worker.isolated import ChildFailedError, run_isolated
from coord_worker.jobs import JobLimitError
from tests import isolated_targets as t

MSG = dict(timeout_message="tempo esgotado", oom_message="sem memória")


def test_returns_the_result_and_the_child_peak():
    result, peak = run_isolated(t.add, 2, 3, times=2, timeout=60, **MSG)
    assert result == 10
    assert peak > 0


def test_timeout_kills_the_child():
    started = time.monotonic()
    with pytest.raises(JobLimitError, match="tempo esgotado"):
        run_isolated(t.sleep_forever, timeout=2, **MSG)
    assert time.monotonic() - started < 20


def test_killed_child_is_reported_as_out_of_memory():
    with pytest.raises(JobLimitError, match="sem memória"):
        run_isolated(t.die_like_oom, timeout=60, **MSG)


def test_child_exiting_without_a_result_is_a_generic_failure():
    with pytest.raises(ChildFailedError, match="code 3"):
        run_isolated(t.exit_silently, timeout=60, **MSG)


def test_user_facing_refusal_keeps_its_message():
    with pytest.raises(ClashLimitError, match="mensagem para o usuário"):
        run_isolated(t.refuse, timeout=60, **MSG)


def test_other_errors_carry_the_traceback_for_the_log():
    with pytest.raises(ChildFailedError, match="detalhe interno"):
        run_isolated(t.boom, timeout=60, **MSG)


def test_memory_used_by_the_job_stays_in_the_child():
    before = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024
    held, peak = run_isolated(t.hold_memory, 300, timeout=60, **MSG)
    after = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024
    assert held == 300
    assert peak >= 300
    # the parent (the long-lived worker) never held the 300 MB
    assert after - before < 100
