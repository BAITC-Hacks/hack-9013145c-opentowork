"""Ансамбль каскада и прямой модели + конформная калибровка интервалов.

Веса и поправки интервалов подбираются только на прогнозах прошлых месяцев бэктеста
(out-of-sample), отдельно для каждого дня выпуска N — точность погоды падает с N.
Квантили смешиваются усреднением квантилей (Vincentization).
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field

import numpy as np
import pandas as pd

from windcast.metrics import QCOLS

WEIGHT_GRID = np.round(np.arange(0, 1.0001, 0.05), 2)
MIN_CALIB_ROWS = 300


@dataclass
class EnsembleState:
    weights: dict[int, float] = field(default_factory=lambda: {1: 0.5, 2: 0.5, 3: 0.5})
    # Аддитивное расширение (CQR) для 80% и 90% интервалов по дню выпуска.
    widen80: dict[int, float] = field(default_factory=dict)
    widen90: dict[int, float] = field(default_factory=dict)
    calibrated_on: int = 0

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False)


def blend(
    cascade: pd.DataFrame, direct: pd.DataFrame, nwp_day: np.ndarray, state: EnsembleState
) -> pd.DataFrame:
    w = np.array([state.weights.get(int(d), 0.5) for d in nwp_day])[:, None]
    cols = list(QCOLS) + ["mean"]
    out = pd.DataFrame(
        w * cascade[cols].to_numpy() + (1 - w) * direct[cols].to_numpy(),
        index=cascade.index,
        columns=cols,
    )
    q = np.sort(out[list(QCOLS)].to_numpy(), axis=1)
    for d in np.unique(nwp_day):
        m = nwp_day == d
        a80 = state.widen80.get(int(d), 0.0)
        a90 = state.widen90.get(int(d), 0.0)
        q[m, 1] -= a80
        q[m, 5] += a80
        q[m, 0] -= a90
        q[m, 6] += a90
    q = np.clip(np.sort(q, axis=1), 0, 1)
    out[list(QCOLS)] = q
    return out


def calibrate(history: pd.DataFrame, before: pd.Timestamp | None = None) -> EnsembleState:
    """history — прогнозы прошлых выпусков с колонками cas_*, dir_*, actual, nwp_day."""
    if before is not None:
        history = history[history.index < before]
    state = EnsembleState()
    h = history.dropna(subset=["actual"])
    state.calibrated_on = len(h)
    if len(h) < MIN_CALIB_ROWS:
        return state
    for d, g in h.groupby("nwp_day"):
        y = g["actual"].to_numpy()
        maes = [
            np.mean(np.abs(y - (w * g["cas_q50"] + (1 - w) * g["dir_q50"]))) for w in WEIGHT_GRID
        ]
        state.weights[int(d)] = float(WEIGHT_GRID[int(np.argmin(maes))])
    blended = blend(
        history[[f"cas_{c}" for c in [*QCOLS, "mean"]]].set_axis([*QCOLS, "mean"], axis=1),
        history[[f"dir_{c}" for c in [*QCOLS, "mean"]]].set_axis([*QCOLS, "mean"], axis=1),
        history["nwp_day"].to_numpy(),
        EnsembleState(weights=state.weights),
    )
    blended["actual"] = history["actual"].to_numpy()
    blended["nwp_day"] = history["nwp_day"].to_numpy()
    for d, g in blended.dropna(subset=["actual"]).groupby("nwp_day"):
        y = g["actual"].to_numpy()
        n = len(y)
        # Conformalized Quantile Regression: насколько расширить интервал, чтобы покрыть 80/90%.
        e80 = np.maximum(g["q10"] - y, y - g["q90"])
        e90 = np.maximum(g["q05"] - y, y - g["q95"])
        state.widen80[int(d)] = float(np.quantile(e80, min(1, 0.8 * (n + 1) / n)))
        state.widen90[int(d)] = float(np.quantile(e90, min(1, 0.9 * (n + 1) / n)))
    return state
