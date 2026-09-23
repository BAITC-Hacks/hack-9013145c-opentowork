import { useEffect, useState } from "react";
import { api } from "../api";
import type { BacktestSummary, ForecastRun, SourceKind, Station, StationWind, UnitSample } from "../api";
import { demoBacktest, demoRun, demoSolarRun, DEMO_STATIONS } from "./demo";

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
  const [state, setState] = useState<{ stations: Station[]; origin: Origin; loading: boolean }>({
    stations: DEMO_STATIONS,
    origin: "demo",
    loading: true,
  });
  useEffect(() => {
    if (!authed) return;
    setState((s) => ({ ...s, loading: true }));
    // ВЭС — справочник в БД, СЭС — каталог OSM; виртуальная СЭС только без API.
    withFallback(
      () => api.stations(),
      () => DEMO_STATIONS,
    ).then(([stations, origin]) => setState({ stations, origin, loading: false }));
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
    // Тестовый период станции кейса — сохранённые прогоны агента (с фактом для сравнения).
    // Всё остальное — расчёт на реальной погоде Open-Meteo: для Нурлы обученной моделью,
    // для других ВЭС кривой мощности, для СЭС по радиации. Демо — только если API недоступен.
    const live = () =>
      station.data === "history" && ORIGINS.includes(originIso)
        ? nonce > 0
          ? api.runForecast(station.id, originIso, horizon)
          : api.forecastAt(station.id, originIso, horizon)
        : api.predictRun(station, originIso, horizon);
    withFallback(live, () => demoFor(station, originIso, horizon)).then(([run, origin]) => {
      if (alive) setState({ run, origin, loading: false });
    });
    return () => {
      alive = false;
    };
  }, [station, originIso, horizon, nonce]);

  return state;
}

/** Фактическая SCADA агрегата; null — фактов нет (станция без истории или API недоступен).
 *  Синтетику сюда не подставляем: панель показывала бы её как «выработала». */
export function useUnitHistory(station: Station, unitId: string | null, fromIso: string, toIso: string) {
  const [samples, setSamples] = useState<UnitSample[] | null>(null);
  useEffect(() => {
    if (!unitId) return;
    let alive = true;
    setSamples(null);
    if (station.data !== "history") {
      setSamples(null);
      return;
    }
    api.unitHistory(station.id, unitId, fromIso, toIso).then(
      (data) => alive && setSamples(data),
      () => alive && setSamples(null),
    );
    return () => {
      alive = false;
    };
  }, [station, unitId, fromIso, toIso]);
  return samples;
}

/** Ветер у ВЭС из Open-Meteo. wind = null — нет данных (СЭС, нет сети): панель не рисуется. */
export function useStationWind(station: Station, originIso: string, horizon: number) {
  const [state, setState] = useState<{ wind: StationWind | null; loading: boolean }>({ wind: null, loading: false });
  useEffect(() => {
    if (station.kind !== "wind" || station.lat == null) {
      setState({ wind: null, loading: false });
      return;
    }
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    api.stationWind(station.id, originIso, horizon).then(
      (w) => alive && setState({ wind: w, loading: false }),
      () => alive && setState({ wind: null, loading: false }),
    );
    return () => {
      alive = false;
    };
  }, [station, originIso, horizon]);
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

// ─── Маршрут в адресной строке ──────────────────────────────────────────────
// Шаги мастера лежат в hash: кнопка «назад» браузера возвращает на шаг
// назад, а после перезагрузки открывается тот же экран.

export type Mode = "forecast" | "place";
export type StationTab = "map" | "accuracy" | "agent" | "bid";

export type Route =
  | { page: "home" }
  | { page: "kind"; mode: Mode }
  | { page: "stations"; kind: SourceKind }
  | { page: "station"; kind: SourceKind; stationId: string; tab: StationTab }
  | { page: "place"; kind: SourceKind }
  | { page: "roofs" }
  | { page: "predictions" }
  | { page: "explain"; kind: SourceKind; stationId: string; origin: string }
  | { page: "platform" };

export function parseRoute(hash: string): Route {
  const [mode, kind, stationId, tab] = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const k: SourceKind | null = kind === "wind" || kind === "solar" ? kind : null;
  if (mode === "platform") return { page: "platform" };
  if (mode === "predictions") return { page: "predictions" };
  // #/explain/wind/<станция>/<момент прогноза> — страница «почему такой прогноз»
  if (mode === "explain" && k && stationId && tab)
    return { page: "explain", kind: k, stationId, origin: decodeURIComponent(tab) };
  if (mode === "forecast" || mode === "place") {
    if (mode === "place" && kind === "roofs") return { page: "roofs" };
    if (!k) return { page: "kind", mode };
    if (mode === "place") return { page: "place", kind: k };
    if (!stationId) return { page: "stations", kind: k };
    const t: StationTab = tab === "accuracy" || tab === "agent" || tab === "bid" ? tab : "map";
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
    case "predictions":
      return "#/predictions";
    case "explain":
      return `#/explain/${r.kind}/${r.stationId}/${encodeURIComponent(r.origin)}`;
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

/** Живой прогноз: начало текущего часа UTC. Считается на реальной погоде, факта ещё нет.
 *  Функция, а не константа: вкладка может жить часами, и «сейчас» должно сдвигаться. */
export function liveOrigin(): string {
  return new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString().slice(0, 19);
}

/** Всё, что не день тестового периода, — живой прогноз. */
export function isLive(iso: string): boolean {
  return !ORIGINS.includes(iso);
}

/** Выбор даты на экране станции: «сейчас» и дни тестового периода. */
export function stationOrigins(current: string): string[] {
  return [isLive(current) ? current : liveOrigin(), ...ORIGINS];
}

export function originLabel(iso: string): string {
  return isLive(iso) ? "Сейчас · живой прогноз" : `${fmtDay(iso)} ${iso.slice(0, 4)}`;
}

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

export type CapacitySource = "units" | "registry" | "osm" | "none";

/**
 * Номинал станции и откуда он взят. Порядок тот же, что в `_rated_mw` бэкенда:
 * 1) станция с историей SCADA — по её турбинам (их номиналы известны);
 * 2) официальный реестр Минэнерго — OSM бывает неполным или захватывает соседнюю очередь
 *    (Аршалы: в OSM 77.5 МВт при 45 в реестре; Шокпар: 43.2 при 100);
 * 3) сумма турбин OSM, если номинал известен у каждой;
 * 4) мощность станции из OSM. Иначе номинал неизвестен (0).
 */
export function stationCapacity(s: Station): { mw: number; source: CapacitySource; unitsMw: number } {
  const allKnown = s.units.length > 0 && s.units.every((u) => u.rated_mw);
  const unitsMw = s.units.reduce((a, u) => a + (u.rated_mw ?? 0), 0);
  if (s.data === "history" && allKnown) return { mw: unitsMw, source: "units", unitsMw };
  if (s.in_registry && s.capacity_mw) return { mw: s.capacity_mw, source: "registry", unitsMw };
  if (allKnown) return { mw: unitsMw, source: "units", unitsMw };
  if (s.capacity_mw) return { mw: s.capacity_mw, source: "osm", unitsMw };
  return { mw: 0, source: "none", unitsMw };
}

export function stationRated(s: Station): number {
  return stationCapacity(s).mw;
}

/** Номинал агрегата: свой из OSM, иначе доля номинала станции, иначе допущение. */
export function unitRated(s: Station, u: Station["units"][number], fallback: number): number {
  if (u.rated_mw) return u.rated_mw;
  const capacity = stationCapacity(s).mw;
  return capacity && s.units.length ? capacity / s.units.length : fallback;
}

export const CAPACITY_SOURCE_LABEL: Record<CapacitySource, string> = {
  units: "по номиналам турбин",
  registry: "по реестру Минэнерго",
  osm: "по OpenStreetMap",
  none: "допущение: турбины по 2.5 МВт",
};

/** Станцию можно открыть, если известно, где стоят её агрегаты. */
export function canOpen(s: Station): boolean {
  return s.units.length > 0;
}
