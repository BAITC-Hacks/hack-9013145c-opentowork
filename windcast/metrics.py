"""Метрики точечного и вероятностного прогноза. Мощность нормирована на номинал,
поэтому MAE здесь сразу nMAE (доля номинала)."""

from __future__ import annotations

import numpy as np
import pandas as pd

QUANTILES = (0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95)
QCOLS = tuple(f"q{int(q * 100):02d}" for q in QUANTILES)


def mae(y, p) -> float:
    m = ~(np.isnan(y) | np.isnan(p))
    return float(np.mean(np.abs(y[m] - p[m])))


def rmse(y, p) -> float:
    m = ~(np.isnan(y) | np.isnan(p))
    return float(np.sqrt(np.mean((y[m] - p[m]) ** 2)))


def bias(y, p) -> float:
    m = ~(np.isnan(y) | np.isnan(p))
    return float(np.mean(p[m] - y[m]))


def pinball(y, q_pred, q: float) -> float:
    d = y - q_pred
    return float(np.nanmean(np.maximum(q * d, (q - 1) * d)))


def crps_from_quantiles(y: np.ndarray, qmat: np.ndarray, qs=QUANTILES) -> float:
    """CRPS ≈ 2·среднее pinball по квантилям — стандартная аппроксимация по сетке квантилей."""
    return float(2 * np.mean([pinball(y, qmat[:, i], q) for i, q in enumerate(qs)]))


def coverage(y, lo, hi) -> float:
    m = ~np.isnan(y)
    return float(np.mean((y[m] >= lo[m]) & (y[m] <= hi[m])))


def summarize(df: pd.DataFrame, pred_col: str, y_col: str = "actual") -> dict:
    y = df[y_col].to_numpy(float)
    p = df[pred_col].to_numpy(float)
    return {
        "mae": mae(y, p),
        "rmse": rmse(y, p),
        "bias": bias(y, p),
        "n": int((~np.isnan(y)).sum()),
    }


def summarize_probabilistic(df: pd.DataFrame, prefix: str, y_col: str = "actual") -> dict:
    cols = [f"{prefix}{c}" for c in QCOLS]
    if not all(c in df for c in cols):
        return {}
    d = df.dropna(subset=[y_col, *cols])
    y = d[y_col].to_numpy(float)
    q = d[cols].to_numpy(float)
    return {
        "crps": crps_from_quantiles(y, q),
        "cov80": coverage(y, q[:, 1], q[:, 5]),
        "cov90": coverage(y, q[:, 0], q[:, 6]),
        "width80": float(np.mean(q[:, 5] - q[:, 1])),
    }
