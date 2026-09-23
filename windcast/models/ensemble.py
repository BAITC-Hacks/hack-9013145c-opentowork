"""Итоговый прогноз: каскад + конформная калибровка интервалов (CQR).

Раньше итог был смесью каскада и прямой модели. Бэктест показал, что смесь не даёт
выигрыша ни по MAE (0.1566 против 0.1566), ни по интервалам: покрытие давала калибровка,
а прямая модель учится на тех же признаках и ошибается так же. Поэтому итог — каскад,
а прямая модель осталась у Критика агента как независимое второе мнение. Механизм весов
сохранён (веса = 1.0), чтобы смесь можно было вернуть, если появится разнородная модель.

Калибровка — отдельно по дню выпуска N и по «сложности часа» (четверть ширины интервала
каскада до калибровки). Одна поправка на всё давала 89% покрытия в лёгких часах и 78%
в сложных; по корзинам интервал честен в каждом режиме. Поправки считаются только на
прогнозах прошлых месяцев бэктеста (out-of-sample).
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field

import numpy as np
import pandas as pd

from windcast.metrics import QCOLS

MIN_CALIB_ROWS = 300
MIN_BIN_ROWS = 200
FINAL_WEIGHT = 1.0  # доля каскада в итоге; см. докстринг


@dataclass
class EnsembleState:
    weights: dict[int, float] = field(
        default_factory=lambda: {1: FINAL_WEIGHT, 2: FINAL_WEIGHT, 3: FINAL_WEIGHT}
    )
    # Аддитивное расширение (CQR) для 80% и 90% интервалов: ключ «N|корзина» или «N».
    widen80: dict = field(default_factory=dict)
    widen90: dict = field(default_factory=dict)
    # Границы четвертей ширины интервала каскада до калибровки — «сложность часа».
    width_edges: list[float] = field(default_factory=list)
    calibrated_on: int = 0

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False)


def difficulty_bin(cascade: pd.DataFrame, state: EnsembleState) -> np.ndarray:
    edges = getattr(state, "width_edges", None) or []
    width = (cascade["q90"] - cascade["q10"]).to_numpy()
    return np.digitize(width, edges) if edges else np.zeros(len(width), dtype=int)


def _widen(table: dict, day: int, b: int) -> float:
    # Совместимость с моделями старого формата: там ключи — int(N).
    for key in (f"{day}|{b}", str(day), day):
        if key in table:
            return table[key]
    return 0.0


def blend(
    cascade: pd.DataFrame, direct: pd.DataFrame, nwp_day: np.ndarray, state: EnsembleState
) -> pd.DataFrame:
    w = np.array([state.weights.get(int(d), FINAL_WEIGHT) for d in nwp_day])[:, None]
    cols = list(QCOLS) + ["mean"]
    out = pd.DataFrame(
        w * cascade[cols].to_numpy() + (1 - w) * direct[cols].to_numpy(),
        index=cascade.index,
        columns=cols,
    )
    q = np.sort(out[list(QCOLS)].to_numpy(), axis=1)
    bins = difficulty_bin(cascade, state)
    for d, b in set(zip(nwp_day.astype(int).tolist(), bins.tolist(), strict=True)):
        m = (nwp_day == d) & (bins == b)
        a80 = _widen(state.widen80, d, b)
        a90 = _widen(state.widen90, d, b)
        q[m, 1] -= a80
        q[m, 5] += a80
        q[m, 0] -= a90
        q[m, 6] += a90
    out[list(QCOLS)] = np.clip(np.sort(q, axis=1), 0, 1)
    return out


def _cqr(y: np.ndarray, q: pd.DataFrame) -> tuple[float, float]:
    """Conformalized Quantile Regression: на сколько сдвинуть границы, чтобы покрыть 80/90%.
    Поправка может быть и отрицательной — тогда интервал сужается."""
    n = len(y)
    e80 = np.maximum(q["q10"] - y, y - q["q90"])
    e90 = np.maximum(q["q05"] - y, y - q["q95"])
    return (
        float(np.quantile(e80, min(1, 0.8 * (n + 1) / n))),
        float(np.quantile(e90, min(1, 0.9 * (n + 1) / n))),
    )


def calibrate(history: pd.DataFrame, before: pd.Timestamp | None = None) -> EnsembleState:
    """history — прогнозы прошлых выпусков с колонками cas_*, actual, nwp_day."""
    if before is not None:
        history = history[history.index < before]
    state = EnsembleState()
    h = history.dropna(subset=["actual"])
    state.calibrated_on = len(h)
    if len(h) < MIN_CALIB_ROWS:
        return state
    cas = h[[f"cas_{c}" for c in QCOLS]].set_axis(list(QCOLS), axis=1)
    state.width_edges = [float(v) for v in np.quantile(cas["q90"] - cas["q10"], [0.25, 0.5, 0.75])]
    bins = difficulty_bin(cas, state)
    y = h["actual"].to_numpy()
    days = h["nwp_day"].to_numpy().astype(int)
    for d in np.unique(days):
        m = days == d
        state.widen80[str(d)], state.widen90[str(d)] = _cqr(y[m], cas[m])
        for b in np.unique(bins[m]):
            mb = m & (bins == b)
            if mb.sum() >= MIN_BIN_ROWS:
                state.widen80[f"{d}|{b}"], state.widen90[f"{d}|{b}"] = _cqr(y[mb], cas[mb])
    return state
