import { useEffect, useState } from "react";
import { api } from "../api";
import type { BacktestSummary, ForecastRun } from "../api";
import { demoBacktest, demoRun } from "./demo";

export type Origin = "api" | "demo";

// Пока эндпоинтов прогноза нет, бэкенд отвечает 404 — это ожидаемо, и
// экран не должен превращаться в ошибку. Источник данных возвращается
// наружу, чтобы интерфейс честно показывал плашку «демо-данные».
async function withFallback<T>(live: () => Promise<T>, demo: () => T): Promise<[T, Origin]> {
  try {
    return [await live(), "api"];
  } catch {
    return [demo(), "demo"];
  }
}

export function useForecast(originIso: string, horizon: number, nonce = 0) {
  const [state, setState] = useState<{ run: ForecastRun | null; origin: Origin; loading: boolean }>({
    run: null,
    origin: "demo",
    loading: true,
  });

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    const live = () =>
      nonce > 0 ? api.runForecast(originIso, horizon) : api.forecastAt(originIso);
    withFallback(live, () => demoRun(originIso, horizon)).then(([run, origin]) => {
      if (alive) setState({ run, origin, loading: false });
    });
    return () => {
      alive = false;
    };
  }, [originIso, horizon, nonce]);

  return state;
}

export function useBacktest() {
  const [state, setState] = useState<{ data: BacktestSummary | null; origin: Origin }>({
    data: null,
    origin: "demo",
  });
  useEffect(() => {
    withFallback(api.backtest, demoBacktest).then(([data, origin]) => setState({ data, origin }));
  }, []);
  return state;
}

/** Дни тестового периода: прогноз строится в 00:00 на следующие 24–48 ч. */
export const ORIGINS: string[] = Array.from({ length: 28 }, (_, i) =>
  new Date(Date.UTC(2026, 0, 31 + i)).toISOString().slice(0, 19),
);

const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

export function fmtDay(iso: string): string {
  const d = new Date(`${iso.slice(0, 19)}Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function fmtDayTime(iso: string): string {
  return `${fmtDay(iso)}, ${iso.slice(11, 16)}`;
}

export function pct(x: number, digits = 0): string {
  return `${(x * 100).toFixed(digits)}%`;
}
