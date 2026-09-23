import { useEffect, useState } from "react";
import { api } from "../api";
import type { BacktestSummary, ForecastRun, SourceKind, Station, UnitSample } from "../api";
import { demoBacktest, demoRun, demoSolarRun, demoUnitHistory, DEMO_SOLAR_STATIONS, DEMO_STATIONS } from "./demo";

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

// До входа /stations отвечает 401 — запрашиваем заново, когда появился токен.
export function useStations(authed = true) {
  const [state, setState] = useState<{ stations: Station[]; origin: Origin }>({
    stations: DEMO_STATIONS,
    origin: "demo",
  });
  useEffect(() => {
    if (!authed) return;
    // ВЭС — из справочника в БД; СЭС в нём нет, виртуальная остаётся на фронте.
    withFallback(
      async () => [...(await api.stations()), ...DEMO_SOLAR_STATIONS],
      () => DEMO_STATIONS,
    ).then(([stations, origin]) => setState({ stations, origin }));
  }, [authed]);
  return state;
}

function demoFor(station: Station, originIso: string, horizon: number): ForecastRun {
  return station.kind === "solar"
    ? demoSolarRun(station, originIso, horizon)
    : demoRun(originIso, horizon);
}

export function useForecast(station: Station | null, originIso: string, horizon: number, nonce = 0) {
  const [state, setState] = useState<{ run: ForecastRun | null; origin: Origin; loading: boolean }>({
    run: null,
    origin: "demo",
    loading: true,
  });

  useEffect(() => {
    if (!station) return;
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    // Модель обучена только на SCADA станции кейса; /forecast/* не различает
    // station_id, поэтому остальным станциям — демо с плашкой, а не чужой прогноз.
    const live = () =>
      station.data !== "history"
        ? Promise.reject(new Error("no model for station"))
        : nonce > 0
        ? api.runForecast(station.id, originIso, horizon)
        : api.forecastAt(station.id, originIso);
    withFallback(live, () => demoFor(station, originIso, horizon)).then(([run, origin]) => {
      if (alive) setState({ run, origin, loading: false });
    });
    return () => {
      alive = false;
    };
  }, [station, originIso, horizon, nonce]);

  return state;
}

export function useUnitHistory(station: Station, unitId: string | null, fromIso: string, toIso: string) {
  const [samples, setSamples] = useState<UnitSample[]>([]);
  useEffect(() => {
    if (!unitId) return;
    let alive = true;
    withFallback(
      () => api.unitHistory(station.id, unitId, fromIso, toIso),
      () => demoUnitHistory(station, unitId, fromIso, toIso),
    ).then(([data]) => {
      if (alive) setSamples(data);
    });
    return () => {
      alive = false;
    };
  }, [station, unitId, fromIso, toIso]);
  return samples;
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

// ─── Маршрут в адресной строке ──────────────────────────────────────────────
// Шаги мастера лежат в hash: кнопка «назад» браузера возвращает на шаг
// назад, а после перезагрузки открывается тот же экран.

export type Mode = "forecast" | "place";
export type StationTab = "map" | "accuracy" | "agent";

export type Route =
  | { page: "home" }
  | { page: "kind"; mode: Mode }
  | { page: "stations"; kind: SourceKind }
  | { page: "station"; kind: SourceKind; stationId: string; tab: StationTab }
  | { page: "place"; kind: SourceKind }
  | { page: "roofs" }
  | { page: "platform" };

export function parseRoute(hash: string): Route {
  const [mode, kind, stationId, tab] = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const k: SourceKind | null = kind === "wind" || kind === "solar" ? kind : null;
  if (mode === "platform") return { page: "platform" };
  if (mode === "forecast" || mode === "place") {
    if (mode === "place" && kind === "roofs") return { page: "roofs" };
    if (!k) return { page: "kind", mode };
    if (mode === "place") return { page: "place", kind: k };
    if (!stationId) return { page: "stations", kind: k };
    const t: StationTab = tab === "accuracy" || tab === "agent" ? tab : "map";
    return { page: "station", kind: k, stationId, tab: t };
  }
  return { page: "home" };
}

export function routeHash(r: Route): string {
  switch (r.page) {
    case "home":
      return "#/";
    case "platform":
      return "#/platform";
    case "kind":
      return `#/${r.mode}`;
    case "stations":
      return `#/forecast/${r.kind}`;
    case "place":
      return `#/place/${r.kind}`;
    case "roofs":
      return "#/place/roofs";
    case "station":
      return `#/forecast/${r.kind}/${r.stationId}${r.tab === "map" ? "" : `/${r.tab}`}`;
  }
}

export function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onHash = () => {
      setRoute(parseRoute(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return [route, (r) => (window.location.hash = routeHash(r))];
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

export function mw(x: number): string {
  return x >= 10 ? x.toFixed(0) : x.toFixed(1);
}

export function stationRated(s: Station): number {
  const units = s.units.reduce((a, u) => a + (u.rated_mw ?? 0), 0);
  return units || s.capacity_mw || 0;
}

/** Станцию можно открыть, если известно, где стоят её агрегаты. */
export function canOpen(s: Station): boolean {
  return s.units.length > 0;
}
