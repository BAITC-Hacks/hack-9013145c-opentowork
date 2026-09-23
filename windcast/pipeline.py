"""Прогнозист: обучение всех моделей до момента `until` и прогноз из момента origin.

Обе турбины в ~400 м друг от друга и почти идеально коррелированы, поэтому квантили
станции — среднее квантилей турбин (комонотонное сложение).
"""

from __future__ import annotations

import pickle
import time
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from windcast import __version__
from windcast.config import MODELS_DIR, TURBINES
from windcast.features import TURBINE_CODE, feature_columns, inference_frame, training_frame
from windcast.metrics import QCOLS
from windcast.models.baselines import Climatology, RawPowerCurve, persistence
from windcast.models.cascade import Cascade
from windcast.models.direct import Direct
from windcast.models.ensemble import EnsembleState, blend
from windcast.scada import load_all

MODEL_VERSION = f"windcast-{__version__}-cascade+cqr"


def scada_rows(until: pd.Timestamp) -> pd.DataFrame:
    """Вся история турбин до until — для кривой мощности (она не зависит от погоды)."""
    s = load_all(until).reset_index()
    s = s[s["time"] < until]
    return pd.DataFrame(
        {
            "obs_ws": s["ws"].to_numpy(),
            "obs_power": s["power"].to_numpy(),
            "obs_temp": s["temp"].to_numpy(),
            "turbine_code": s["turbine"].map(TURBINE_CODE).to_numpy(),
            "usable": s["usable"].astype(bool).to_numpy(),
        }
    )


@dataclass
class Forecaster:
    until: pd.Timestamp
    state: EnsembleState = field(default_factory=EnsembleState)
    fit_seconds: float = 0.0

    def fit(self, train: pd.DataFrame | None = None) -> Forecaster:
        t0 = time.time()
        train = training_frame() if train is None else train
        train = train[train.index < self.until].copy()
        # Кривая для выявления ограничений также обучается только на прошлом.
        # Иначе будущая SCADA меняла бы состав обучающей выборки.
        past = load_all(self.until)
        keys = pd.MultiIndex.from_arrays([train.index, train["turbine"]])
        for col in ("usable", "downtime", "curtailed", "expected_power"):
            values = past[col].reindex(keys)
            if col != "expected_power":
                values = values.fillna(False).astype(bool)
            train[col] = values.to_numpy()
        self.features = feature_columns(train)
        self.cascade = Cascade(self.features).fit(train, scada_rows(self.until))
        self.direct = Direct(self.features).fit(train)
        self.raw_curve = RawPowerCurve().fit(train)
        self.climatology = Climatology().fit(train)
        self.n_train = int(train["obs_power"].notna().sum())
        self.fit_seconds = time.time() - t0
        return self

    def predict(
        self, origin: pd.Timestamp, horizon: int = 48, archive: pd.DataFrame | None = None
    ) -> pd.DataFrame:
        """Строки (час, турбина): квантили ансамбля, компоненты, baseline, погода.
        archive — погода в формате load_archive(); по умолчанию сохранённый архив."""
        origin = pd.Timestamp(origin)
        x = inference_frame(origin, horizon, archive)
        cas = self.cascade.predict(x)
        dr = self.direct.predict(x)
        ens = blend(cas, dr, x["nwp_day"].to_numpy(), self.state)

        out = pd.DataFrame(index=x.index)
        out["turbine"] = x["turbine"].to_numpy()
        out["horizon_h"] = x["horizon_h"].to_numpy()
        out["nwp_day"] = x["nwp_day"].to_numpy()
        out["available_at"] = x["available_at"].to_numpy()
        for c in [*QCOLS, "mean"]:
            out[c] = ens[c].to_numpy()
            out[f"cas_{c}"] = cas[c].to_numpy()
            out[f"dir_{c}"] = dr[c].to_numpy()
        out["cas_naive_curve"] = cas["naive_curve"].to_numpy()
        out["wind_corrected"] = cas["wind_q50"].to_numpy()
        out["wind_q10"] = cas["wind_q10"].to_numpy()
        out["wind_q90"] = cas["wind_q90"].to_numpy()
        out["wind_nwp"] = x["ens_ws100_mean"].to_numpy()
        out["wind_nwp_spread"] = x["ens_ws100_std"].to_numpy()
        out["wind_dir"] = x["ens_dir"].to_numpy()
        out["temperature"] = x["temp"].to_numpy()
        out["icing_risk"] = x["icing_risk"].to_numpy()
        out["n_nwp_models"] = x["ens_ws100_n"].to_numpy()
        out["raw_nwp_curve"] = self.raw_curve.predict(x)
        out["climatology"] = self.climatology.predict(x)

        scada = load_all()["power"]
        pers = np.empty(len(out))
        for tid in out["turbine"].unique():
            m = (out["turbine"] == tid).to_numpy()
            obs = scada.xs(tid, level="turbine")
            obs = obs[obs.index < origin]
            pers[m] = persistence(origin, out.index[m], obs)
        out["persistence"] = pers
        out.index.name = "time"
        return out

    def save(self, name: str = "forecaster.pkl") -> str:
        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        path = MODELS_DIR / name
        with open(path, "wb") as fh:
            pickle.dump(self, fh)
        return str(path)

    @staticmethod
    def load(name: str = "forecaster.pkl") -> Forecaster:
        with open(MODELS_DIR / name, "rb") as fh:
            return pickle.load(fh)  # noqa: S301 — собственный артефакт, не пользовательский ввод


def attach_actuals(pred: pd.DataFrame) -> pd.DataFrame:
    s = load_all()[["power", "usable"]]
    keys = pd.MultiIndex.from_arrays([pred.index, pred["turbine"]])
    pred = pred.copy()
    pred["actual"] = s["power"].reindex(keys).to_numpy()
    pred["actual_usable"] = s["usable"].reindex(keys).astype("boolean").to_numpy()
    return pred


def station_view(pred: pd.DataFrame) -> pd.DataFrame:
    """Станция = среднее турбин (нормированная мощность станции)."""
    num = pred.select_dtypes("number").columns.difference(["horizon_h", "nwp_day"])
    g = pred.groupby(level="time")
    st = g[list(num)].mean()
    st["horizon_h"] = g["horizon_h"].first()
    st["nwp_day"] = g["nwp_day"].first()
    st["available_at"] = g["available_at"].first()
    per = pred.pivot_table(index=pred.index, columns="turbine", values="q50")
    st["per_turbine"] = [
        {t.id: round(float(per.loc[i, t.id]), 4) for t in TURBINES if t.id in per} for i in st.index
    ]
    return st
