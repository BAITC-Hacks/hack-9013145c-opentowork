"""Каскад: A) поправка прогноза ветра → B) кривая мощности, неопределённость через Монте-Карло.

A учится на парах «погода → измеренный ветер у турбины» (есть с 2024 года).
B учится на всей истории «измеренный ветер → мощность» с 2023 года, связь r≈0.95.
Распределение ветра из A прогоняется через нелинейную кривую B выборками: подставлять
средний ветер в кривую смещённо (неравенство Йенсена).
"""

from __future__ import annotations

import lightgbm as lgb
import numpy as np
import pandas as pd

from windcast.metrics import QCOLS, QUANTILES

LGB_PARAMS = dict(
    n_estimators=400, learning_rate=0.04, num_leaves=31, min_child_samples=40,
    subsample=0.8, subsample_freq=1, colsample_bytree=0.8, reg_lambda=1.0, verbose=-1,
)


def fix_crossing(q: np.ndarray) -> np.ndarray:
    return np.sort(q, axis=1)


def sample_from_quantiles(qmat: np.ndarray, n: int, rng: np.random.Generator) -> np.ndarray:
    """Выборки из распределения, заданного квантилями (кусочно-линейная обратная ФР,
    хвосты линейно экстраполируются до 0.5% / 99.5%)."""
    qs = np.asarray(QUANTILES)
    lo_slope = (qmat[:, 1] - qmat[:, 0]) / (qs[1] - qs[0])
    hi_slope = (qmat[:, -1] - qmat[:, -2]) / (qs[-1] - qs[-2])
    grid = np.concatenate([[0.005], qs, [0.995]])
    ext = np.column_stack(
        [qmat[:, 0] - lo_slope * (qs[0] - 0.005), qmat, qmat[:, -1] + hi_slope * (0.995 - qs[-1])]
    )
    u = rng.uniform(0.005, 0.995, size=(qmat.shape[0], n))
    idx = np.clip(np.searchsorted(grid, u) - 1, 0, len(grid) - 2)
    g0, g1 = grid[idx], grid[idx + 1]
    rows = np.arange(qmat.shape[0])[:, None]
    v0, v1 = ext[rows, idx], ext[rows, idx + 1]
    return v0 + (u - g0) / (g1 - g0) * (v1 - v0)


class WindMOS:
    """A: квантильная поправка прогноза ветра к измеренному ветру у турбины."""

    def __init__(self, features: list[str]):
        self.features = features

    def fit(self, train: pd.DataFrame) -> WindMOS:
        d = train.dropna(subset=["obs_ws", "ens_ws100_mean"])
        self.models = {}
        for q in QUANTILES:
            m = lgb.LGBMRegressor(objective="quantile", alpha=q, **LGB_PARAMS)
            m.fit(d[self.features], d["obs_ws"])
            self.models[q] = m
        return self

    def predict_quantiles(self, x: pd.DataFrame) -> np.ndarray:
        q = np.column_stack([self.models[q].predict(x[self.features]) for q in QUANTILES])
        return np.clip(fix_crossing(q), 0, None)


class PowerCurve:
    """B: мощность от ветра, температуры (плотность воздуха) и турбины.
    Монотонна по ветру — физически мощность не падает с ростом ветра до номинала.
    Разброс вокруг кривой берётся из остатков обучения по бинам ветра."""

    features = ["ws", "temp", "turbine_code"]

    def fit(self, scada: pd.DataFrame) -> PowerCurve:
        d = scada[scada["usable"].astype(bool)].dropna(subset=["obs_ws", "obs_power"])
        x = pd.DataFrame({"ws": d["obs_ws"], "temp": d["obs_temp"], "turbine_code": d["turbine_code"]})
        self.model = lgb.LGBMRegressor(
            objective="l2", monotone_constraints=[1, 0, 0], **{**LGB_PARAMS, "n_estimators": 300}
        )
        self.model.fit(x, d["obs_power"])
        resid = d["obs_power"].to_numpy() - self.model.predict(x)
        bins = np.clip(np.floor(d["obs_ws"].to_numpy()), 0, 25).astype(int)
        self.resid_by_bin = {b: resid[bins == b] for b in np.unique(bins)}
        return self

    def predict(self, ws: np.ndarray, temp: np.ndarray, turbine_code: np.ndarray) -> np.ndarray:
        x = pd.DataFrame({"ws": ws, "temp": temp, "turbine_code": turbine_code})
        return np.clip(self.model.predict(x), 0, 1)

    def sample_residuals(self, ws: np.ndarray, rng: np.random.Generator) -> np.ndarray:
        bins = np.clip(np.floor(ws), 0, 25).astype(int)
        out = np.zeros_like(ws)
        for b in np.unique(bins):
            pool = self.resid_by_bin.get(b)
            if pool is None or len(pool) == 0:
                continue
            m = bins == b
            out[m] = rng.choice(pool, size=m.sum())
        return out


class Cascade:
    name = "cascade"

    def __init__(self, features: list[str], n_samples: int = 400, seed: int = 7):
        self.mos = WindMOS(features)
        self.curve = PowerCurve()
        self.n_samples = n_samples
        self.seed = seed

    def fit(self, train: pd.DataFrame, scada_rows: pd.DataFrame) -> Cascade:
        self.mos.fit(train)
        self.curve.fit(scada_rows)
        return self

    def predict(self, x: pd.DataFrame) -> pd.DataFrame:
        rng = np.random.default_rng(self.seed)
        wq = self.mos.predict_quantiles(x)
        ws = np.clip(sample_from_quantiles(wq, self.n_samples, rng), 0, 35)
        n, k = ws.shape
        temp = np.repeat(x["temp"].to_numpy(float), k)
        code = np.repeat(x["turbine_code"].to_numpy(float), k)
        flat = ws.ravel()
        power = self.curve.predict(flat, temp, code) + self.curve.sample_residuals(flat, rng)
        power = np.clip(power, 0, 1).reshape(n, k)
        out = pd.DataFrame(np.quantile(power, QUANTILES, axis=1).T, index=x.index, columns=list(QCOLS))
        out["mean"] = power.mean(axis=1)
        out["wind_q50"] = wq[:, 3]
        out["wind_q10"] = wq[:, 1]
        out["wind_q90"] = wq[:, 5]
        # Для сравнения: наивная подстановка медианы ветра в кривую — видно смещение Йенсена.
        out["naive_curve"] = self.curve.predict(wq[:, 3], x["temp"].to_numpy(float), x["turbine_code"].to_numpy(float))
        return out
