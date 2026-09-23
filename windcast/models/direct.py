"""Прямая модель: погода → мощность, квантильный LightGBM.

Учится только на «доступных» часах (без простоев и ограничений) — прогнозируем то,
что станция может выдать при такой погоде.
"""

from __future__ import annotations

import lightgbm as lgb
import numpy as np
import pandas as pd

from windcast.metrics import QCOLS, QUANTILES
from windcast.models.cascade import LGB_PARAMS, fix_crossing


class Direct:
    name = "direct"

    def __init__(self, features: list[str]):
        self.features = features

    def fit(self, train: pd.DataFrame) -> Direct:
        d = train[train["usable"].astype(bool)].dropna(subset=["obs_power"])
        self.models = {}
        for q in QUANTILES:
            m = lgb.LGBMRegressor(objective="quantile", alpha=q, **LGB_PARAMS)
            m.fit(d[self.features], d["obs_power"])
            self.models[q] = m
        self.mean_model = lgb.LGBMRegressor(objective="l2", **LGB_PARAMS).fit(
            d[self.features], d["obs_power"]
        )
        return self

    def predict(self, x: pd.DataFrame) -> pd.DataFrame:
        q = np.column_stack([self.models[q].predict(x[self.features]) for q in QUANTILES])
        q = np.clip(fix_crossing(q), 0, 1)
        out = pd.DataFrame(q, index=x.index, columns=list(QCOLS))
        out["mean"] = np.clip(self.mean_model.predict(x[self.features]), 0, 1)
        return out

    def importance(self, top: int = 15) -> pd.Series:
        m = self.models[0.5]
        imp = pd.Series(m.booster_.feature_importance("gain"), index=self.features)
        return (imp / imp.sum()).sort_values(ascending=False).head(top)
