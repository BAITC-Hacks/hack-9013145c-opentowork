"""Короткоживущие результаты живого расчёта для объяснения и сценариев."""

from collections import OrderedDict
from copy import deepcopy
from threading import Lock
from time import monotonic

_runs: OrderedDict[str, tuple[float, dict]] = OrderedDict()
_lock = Lock()


def remember(run: dict) -> dict:
    with _lock:
        _runs[run["forecast_id"]] = (monotonic(), deepcopy(run))
        _runs.move_to_end(run["forecast_id"])
        while len(_runs) > 128:
            _runs.popitem(last=False)
    return run


def recalled(forecast_id: str) -> dict | None:
    with _lock:
        hit = _runs.get(forecast_id)
        if hit and monotonic() - hit[0] < 3600:
            return deepcopy(hit[1])
    return None
