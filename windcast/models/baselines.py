"""Baseline — то, что у станции есть без ML. Всё, что сложнее, обязано их обыгрывать."""

from __future__ import annotations

import numpy as np
import pandas as pd

from windcast.config import SCADA_UTC_OFFSET_H
from windcast.scada import empirical_power_curve


def persistence(origin: pd.Timestamp, times: pd.DatetimeIndex, observed: pd.Series) -> np.ndarray:
    """«Как вчера»: мощность в тот же час последних суток, полностью известных к origin."""
    out = []
    for t in times:
        h = int((t - origin) / pd.Timedelta(hours=1))
        k = int(np.ceil((h + 1) / 24))
        src = t - pd.Timedelta(hours=24 * k)
        out.append(observed.get(src, np.nan))
    return np.asarray(out, dtype=float)


class RawPowerCurve:
    """Эмпирическая кривая «измеренный ветер → мощность», в которую подставлен сырой
    ансамблевый прогноз ветра. Так прогноз делают без поправки ошибок погоды."""

    name = "raw_nwp_curve"

    def fit(self, train: pd.DataFrame) -> RawPowerCurve:
        d = train[train["usable"].astype(bool)].drop_duplicates(["obs_ws", "obs_power"])
        curve = empirical_power_curve(d["obs_ws"], d["obs_power"])
        curve = curve[curve.index <= 25].cummax()  # монотонность до номинала
        self.ws, self.pw = curve.index.values, curve.values
        return self

    def predict(self, x: pd.DataFrame) -> np.ndarray:
        return np.interp(x["ens_ws100_mean"].to_numpy(float), self.ws, self.pw)


class Climatology:
    """Средняя мощность по (месяц, час суток) — нижняя планка без погоды вовсе."""

    name = "climatology"

    def fit(self, train: pd.DataFrame) -> Climatology:
        d = train[train["nwp_day"] == 1].dropna(subset=["obs_power"])
        local = d.index + pd.Timedelta(hours=SCADA_UTC_OFFSET_H)
        self.table = d.groupby([local.month, local.hour])["obs_power"].mean()
        self.fallback = float(d["obs_power"].mean())
        return self

    def predict(self, x: pd.DataFrame) -> np.ndarray:
        local = x.index + pd.Timedelta(hours=SCADA_UTC_OFFSET_H)
        keys = list(zip(local.month, local.hour, strict=True))
        return np.array([self.table.get(k, self.fallback) for k in keys], dtype=float)
