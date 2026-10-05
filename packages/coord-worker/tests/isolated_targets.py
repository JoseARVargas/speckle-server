"""Targets for test_isolated.py. They run in a spawned child, so they must
live at module level in an importable module."""

import os
import signal
import time

from coord_worker.clash import ClashLimitError


def add(a, b, *, times=1):
    return (a + b) * times


def sleep_forever():
    time.sleep(3600)


def die_like_oom():
    os.kill(os.getpid(), signal.SIGKILL)


def exit_silently():
    os._exit(3)


def refuse():
    raise ClashLimitError("mensagem para o usuário")


def boom():
    raise RuntimeError("detalhe interno")


def hold_memory(mb):
    block = bytearray(mb * 1024 * 1024)
    block[::4096] = b"x" * len(block[::4096])  # touch every page
    return len(block) // (1024 * 1024)
