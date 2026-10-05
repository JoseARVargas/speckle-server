"""Runs a heavy job in a child process.

IfcOpenShell/OpenCascade keep the memory of a large clash after it ends (the
allocator doesn't give it back), so a long-lived worker would sit on ~1 GB and
the next clash would wait forever for free memory. A child process returns
everything to the system when it exits, and the time limit can actually stop
the computation (kill), not just stop waiting for it.
"""

import multiprocessing
import signal
import traceback
from collections.abc import Callable
from multiprocessing.connection import Connection
from typing import Any

from coord_worker.clash import ClashLimitError, peak_rss_mb
from coord_worker.jobs import JobLimitError

# spawn: a fresh interpreter, nothing inherited from the parent's heap
_ctx = multiprocessing.get_context("spawn")


class ChildFailedError(Exception):
    """The child crashed or raised; the details go to the log, not to the user."""


def _child(conn: Connection, target: Callable[..., Any], args, kwargs) -> None:
    try:
        result = target(*args, **kwargs)
        conn.send(("ok", result, peak_rss_mb()))
    except ClashLimitError as err:
        conn.send(("limit", str(err), peak_rss_mb()))
    except BaseException:
        conn.send(("error", traceback.format_exc(), peak_rss_mb()))
    finally:
        conn.close()


def run_isolated[T](
    target: Callable[..., T],
    *args: Any,
    timeout: float,
    timeout_message: str,
    oom_message: str,
    **kwargs: Any,
) -> tuple[T, int]:
    """Returns (target's result, the child's peak RSS in MB).

    Raises JobLimitError on timeout or when the child is killed (out of
    memory), ClashLimitError when the job refuses with a user-facing message,
    and ChildFailedError on any other failure. `target` must be importable
    (module level), since the child is a fresh interpreter.
    """
    receiver, sender = _ctx.Pipe(duplex=False)
    proc = _ctx.Process(target=_child, args=(sender, target, args, kwargs), daemon=True)
    proc.start()
    sender.close()
    try:
        if not receiver.poll(timeout):
            raise JobLimitError(timeout_message)
        try:
            kind, payload, peak = receiver.recv()
        except EOFError:
            # Died without answering. SIGKILL is what the OOM killer sends.
            proc.join(10)
            if proc.exitcode == -signal.SIGKILL:
                raise JobLimitError(oom_message) from None
            raise ChildFailedError(
                f"child exited with code {proc.exitcode} without a result"
            ) from None
    finally:
        receiver.close()
        if proc.is_alive():
            proc.kill()
        proc.join(10)

    if kind == "ok":
        return payload, peak
    if kind == "limit":
        raise ClashLimitError(payload)
    raise ChildFailedError(payload)
