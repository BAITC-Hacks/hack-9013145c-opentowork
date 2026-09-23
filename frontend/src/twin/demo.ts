// Демо-данные на время, пока бэкенд прогноза не готов. Форма совпадает с
// контрактом из api.ts, поэтому замена на реальные данные — это замена
// источника в data.ts, а не правка компонентов. Числа синтетические: на
// экране они всегда помечены плашкой «демо-данные».

import type {
  AgentStep,
  BacktestSummary,
  ForecastPoint,
  ForecastRun,
  Station,
  Turbine,
  UnitSample,
} from "../api";

export const SITE = {
  name: "ВЭС Нурлы",
  // Центр между турбинами кейса, Алматинская область.
  lat: 43.644174,
  lon: 78.537216,
  utcOffset: 5,
};

// Координаты турбин из датасета кейса (переданы организатором).
export const DEMO_TURBINES: Turbine[] = [
  { id: "T1", name: "Турбина 1", lat: 43.64515, lon: 78.535604, model: "Goldwind GW109/2500" },
  { id: "T2", name: "Турбина 2", lat: 43.643198, lon: 78.538828, model: "Goldwind GW109/2500" },
];

const HOUR = 3_600_000;
const EPOCH = Date.UTC(2026, 0, 25);

export function parseTs(iso: string): number {
  return Date.parse(iso.endsWith("Z") ? iso : `${iso}Z`);
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19);
}

function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function smoothNoise(t: number, seed: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f);
  return hash(i + seed) * (1 - u) + hash(i + 1 + seed) * u - 0.5;
}

/** Нормализованная кривая мощности: cut-in 3, номинал 12.5, cut-out 25 м/с. */
export function powerCurve(v: number): number {
  if (v < 3 || v >= 25) return 0;
  if (v >= 12.5) return 1;
  return (v ** 3 - 27) / (12.5 ** 3 - 27);
}

export function trueWind(t: number): number {
  const h = (t - EPOCH) / HOUR;
  let w =
    7.2 +
    2.8 * Math.sin((2 * Math.PI * h) / 31) +
    1.9 * Math.sin((2 * Math.PI * h) / 83 + 1.3) +
    1.1 * Math.sin((2 * Math.PI * h) / 24 + 2.1) +
    2.2 * smoothNoise(h / 5, 17);
  // Шторм 14 февраля — чтобы на демо было что показать в предупреждениях.
  const storm = (t - Date.UTC(2026, 1, 14, 6)) / HOUR;
  w += 11 * Math.exp(-(storm * storm) / 40);
  return Math.max(0.3, w);
}

export function trueDir(t: number): number {
  const h = (t - EPOCH) / HOUR;
  return (280 + 35 * Math.sin((2 * Math.PI * h) / 60) + 25 * smoothNoise(h / 8, 5) + 360) % 360;
}

export function temperature(t: number): number {
  const h = (t - EPOCH) / HOUR;
  const hourOfDay = new Date(t).getUTCHours();
  return -13 + 4 * Math.sin((2 * Math.PI * (hourOfDay - 9)) / 24) + 5 * smoothNoise(h / 30, 9);
}

export function cloudCover(t: number): number {
  const h = (t - EPOCH) / HOUR;
  return Math.min(1, Math.max(0, 0.45 + 0.9 * smoothNoise(h / 9, 41)));
}

const LOSSES = 0.93;

export function actualPower(t: number): number {
  const noise = 0.04 * smoothNoise((t - EPOCH) / HOUR / 2, 77);
  return clamp01(powerCurve(trueWind(t)) * LOSSES + noise);
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** Влияние следа T1 на T2: максимум, когда ветер дует вдоль линии турбин. */
export function wakeFactor(dirDeg: number): number {
  const alongLine = 298; // ветер с этого азимута дует от T1 прямо на T2
  const delta = Math.abs(((dirDeg - alongLine + 540) % 360) - 180);
  return 1 - 0.12 * Math.exp(-(delta * delta) / 1250);
}

function forecastWind(origin: number, t: number, bias = 0): number {
  const h = (t - origin) / HOUR;
  const err =
    (3.2 + (5.5 * h) / 48) * smoothNoise((t - EPOCH) / HOUR / 6, origin / HOUR) +
    1.4 * smoothNoise((t - EPOCH) / HOUR / 1.7, origin / HOUR + 3);
  return Math.max(0.3, trueWind(t) + err + bias);
}

export function buildPoints(origin: number, horizon: number, windScale = 1): ForecastPoint[] {
  const points: ForecastPoint[] = [];
  for (let h = 1; h <= horizon; h += 1) {
    const t = origin + h * HOUR;
    const wind = forecastWind(origin, t) * windScale;
    const dir = trueDir(t) + 8 * smoothNoise(h / 6, origin / HOUR);
    const p50 = clamp01(powerCurve(wind) * LOSSES * (1 + wakeFactor(dir)) / 2);
    // Ширина интервала растёт с горизонтом и там, где кривая мощности круче.
    const slope = Math.abs(powerCurve(wind + 1) - powerCurve(wind - 1)) / 2;
    const spread = (0.03 + (0.1 * h) / 48) * (0.6 + 3 * slope);
    const back = Math.ceil(h / 24) * 24 * HOUR;
    const known = t <= Date.UTC(2026, 2, 1);
    points.push({
      forecast_for: toIso(t),
      horizon_h: h,
      p10: clamp01(p50 - spread * 1.1),
      p50,
      p90: clamp01(p50 + spread),
      baseline: actualPower(t - back),
      actual: known ? actualPower(t) : null,
      wind_speed: wind,
      wind_dir: (dir + 360) % 360,
      temperature: temperature(t),
      per_turbine: {
        T1: clamp01(powerCurve(wind) * LOSSES),
        T2: clamp01(powerCurve(wind) * LOSSES * wakeFactor(dir)),
      },
    });
  }
  return points;
}

function agentSteps(origin: number): AgentStep[] {
  const weatherRun = toIso(origin - 6 * HOUR);
  return [
    { agent: "WeatherAgent", action: "get_weather_forecast", status: "ok", duration_ms: 842,
      detail: `Open-Meteo, прогноз выпущен ${weatherRun.replace("T", " ")} ≤ origin` },
    { agent: "DataAgent", action: "validate_data", status: "ok", duration_ms: 118,
      detail: "пропусков 0, дублей 0, мощность в [0; 1]" },
    { agent: "DataAgent", action: "build_features", status: "ok", duration_ms: 206,
      detail: "54 признака, все available_at ≤ origin" },
    { agent: "ForecastAgent", action: "run_forecast", status: "ok", duration_ms: 391,
      detail: "LightGBM quantile P10/P50/P90" },
    { agent: "ForecastAgent", action: "run_baseline", status: "ok", duration_ms: 37,
      detail: "persistence + power curve" },
    { agent: "ValidationAgent", action: "detect_anomaly", status: "warn", duration_ms: 64,
      detail: "интервал шире обычного после +36 ч" },
    { agent: "AnalysisAgent", action: "explain_forecast_change", status: "ok", duration_ms: 1520,
      detail: "объяснение по структурированным результатам" },
  ];
}

function explain(points: ForecastPoint[]): string {
  let worst = 0;
  for (let i = 0; i + 4 < points.length; i += 1) {
    if (points[i + 4].p50 - points[i].p50 < points[worst + 4].p50 - points[worst].p50) worst = i;
  }
  const a = points[worst];
  const b = points[worst + 4];
  const hh = (p: ForecastPoint) => p.forecast_for.slice(11, 16);
  const last = points[points.length - 1];
  return (
    `Наибольшее снижение выработки ожидается между ${hh(a)} и ${hh(b)}: ` +
    `прогнозная скорость ветра падает с ${(a.wind_speed ?? 0).toFixed(1)} до ${(b.wind_speed ?? 0).toFixed(1)} м/с. ` +
    `К горизонту +${last.horizon_h} ч интервал P10–P90 расширяется до ` +
    `${Math.round((last.p90 - last.p10) * 100)} п.п. номинала.`
  );
}

export function demoRun(originIso: string, horizon = 48): ForecastRun {
  const origin = parseTs(originIso);
  const points = buildPoints(origin, horizon);
  return {
    forecast_id: `demo-${originIso.slice(0, 10)}`,
    forecast_origin: toIso(origin),
    horizon,
    model_version: "lgbm-q-v1 (демо)",
    weather_provider: "open-meteo historical-forecast",
    weather_run: toIso(origin - 6 * HOUR),
    created_at: toIso(origin + 4 * 60_000),
    predictions: points,
    agent_steps: agentSteps(origin),
    explanation: explain(points),
  };
}

export function demoBacktest(): BacktestSummary {
  const models = ["Persistence", "Power Curve", "LightGBM", "Ensemble"];
  const daily: BacktestSummary["daily"] = [];
  const total: Record<string, number[]> = Object.fromEntries(models.map((m) => [m, []]));
  const byH: number[][] = Array.from({ length: 48 }, () => []);
  for (let d = 0; d < 28; d += 1) {
    const origin = Date.UTC(2026, 0, 31 + d);
    const pts = buildPoints(origin, 48);
    const errs: Record<string, number[]> = Object.fromEntries(models.map((m) => [m, []]));
    pts.forEach((p, i) => {
      const act = p.actual ?? 0;
      const pc = powerCurve(p.wind_speed ?? 0);
      errs["Persistence"].push(Math.abs((p.baseline ?? 0) - act));
      errs["Power Curve"].push(Math.abs(pc - act));
      errs["LightGBM"].push(Math.abs(p.p50 - act));
      errs["Ensemble"].push(Math.abs(0.25 * pc + 0.75 * p.p50 - act));
      byH[i].push(Math.abs(p.p50 - act));
    });
    const row: Record<string, number> = {};
    models.forEach((m) => {
      row[m] = mean(errs[m]);
      total[m].push(...errs[m]);
    });
    daily.push({ date: toIso(origin + 24 * HOUR).slice(0, 10), mae: row });
  }
  const metrics = models.map((m) => ({
    model: m,
    mae: mean(total[m]),
    rmse: Math.sqrt(mean(total[m].map((e) => e * e))),
  }));
  const best = metrics.reduce((a, b) => (b.mae < a.mae ? b : a));
  return {
    period: "01.02.2026 – 28.02.2026",
    metrics: metrics.map((m) => ({ ...m, nmae: m.mae, selected: m.model === best.model })),
    daily,
    by_horizon: byH.map((errs, i) => ({ horizon_h: i + 1, mae: mean(errs) })),
  };
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Положение солнца по упрощённым формулам NOAA, точность ~0.5°. */
export function sunPosition(utcMs: number, lat: number, lon: number) {
  const d = new Date(utcMs);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const doy = Math.floor((utcMs - start) / 86_400_000) + 1;
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  const g = ((2 * Math.PI) / 365) * (doy - 1 + (hour - 12) / 24);
  const eqTime =
    229.18 *
    (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) -
      0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const tst = hour * 60 + eqTime + 4 * lon;
  const ha = ((tst / 4 - 180) * Math.PI) / 180;
  const phi = (lat * Math.PI) / 180;
  const cosZen = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
  const zen = Math.acos(Math.min(1, Math.max(-1, cosZen)));
  const elevation = 90 - (zen * 180) / Math.PI;
  const az =
    (Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) * 180) /
      Math.PI + 180;
  return { elevation, azimuth: az % 360 };
}

/** Нормализованная выработка СЭС: геометрия солнца × облачность × температура. */
export function solarPower(localMs: number, cloud = cloudCover(localMs)): number {
  const utc = localMs - SITE.utcOffset * HOUR;
  const { elevation } = sunPosition(utc, SITE.lat, SITE.lon);
  if (elevation <= 0) return 0;
  const clear = Math.sin((elevation * Math.PI) / 180) ** 1.15;
  const c = Math.min(1, Math.max(0, cloud));
  const tempGain = 1 + 0.004 * (25 - temperature(localMs));
  return clamp01(clear * (1 - 0.72 * c ** 2.2) * tempGain * 1.1);
}

// ─── Каталог станций ────────────────────────────────────────────────────────
// Данные есть только по одной ВЭС (датасет кейса). Остальные станции видны
// в списке, но без данных — выбрать их нельзя. СЭС — модель, не факт.

export const RATED_ASSUMPTION_MW = 2.5;

// Запасной каталог на случай, если бэкенд недоступен: полный список ВЭС
// приходит из /stations (таблица wind_farms). СЭС пока только виртуальная.
export const DEMO_WIND_STATIONS: Station[] = [
  {
    id: "nurly",
    kind: "wind",
    name: "ВЭС Нурлы",
    region: "Алматинская область",
    lat: SITE.lat,
    lon: SITE.lon,
    location: "turbines",
    units: DEMO_TURBINES.map((t) => ({ ...t, rated_mw: RATED_ASSUMPTION_MW })),
    data: "history",
    capacity_mw: 4.5,
    capacity_source: "registry",
    operators: ["ТОО «ВЭС НУРЛЫ»"],
    note: "Станция из датасета кейса: SCADA с марта 2023 по январь 2026",
  },
];

export const DEMO_SOLAR_STATIONS: Station[] = [
  {
    id: "nurly-pv",
    kind: "solar",
    name: "СЭС у Нурлы",
    region: "Алматинская область · виртуальная",
    lat: SITE.lat - 0.004,
    lon: SITE.lon + 0.012,
    units: ["Б1", "Б2", "Б3", "Б4"].map((id, i) => ({
      id,
      name: `Блок ${i + 1}`,
      lat: SITE.lat + 0.0021 - (i >> 1) * 0.0042,
      lon: SITE.lon - 0.0048 + (i % 2) * 0.0096,
      rated_mw: 1,
    })),
    data: "model",
    note: "Расчёт по положению солнца и облачности, фактических данных нет",
  },
];

export const DEMO_STATIONS: Station[] = [...DEMO_WIND_STATIONS, ...DEMO_SOLAR_STATIONS];

const BLOCK_FACTOR: Record<string, number> = { Б1: 1, Б2: 0.97, Б3: 0.99, Б4: 0.94 };

export function demoSolarRun(station: Station, originIso: string, horizon = 48): ForecastRun {
  const origin = parseTs(originIso);
  const points: ForecastPoint[] = [];
  for (let h = 1; h <= horizon; h += 1) {
    const t = origin + h * HOUR;
    const trueCloud = cloudCover(t);
    const err = (0.06 + (0.22 * h) / 48) * smoothNoise((t - EPOCH) / HOUR / 5, origin / HOUR + 11) * 2;
    const cloud = Math.min(1, Math.max(0, trueCloud + err));
    const p50 = solarPower(t, cloud);
    const spread = p50 > 0 ? (0.04 + (0.12 * h) / 48) * (0.5 + cloud) : 0;
    const known = t <= Date.UTC(2026, 2, 1);
    points.push({
      forecast_for: toIso(t),
      horizon_h: h,
      p10: clamp01(p50 - spread),
      p50,
      p90: clamp01(p50 + spread * 0.8),
      baseline: solarPower(t - Math.ceil(h / 24) * 24 * HOUR),
      actual: known ? solarPower(t) : null,
      wind_speed: forecastWind(origin, t),
      wind_dir: trueDir(t),
      temperature: temperature(t),
      cloud_cover: cloud,
      per_turbine: Object.fromEntries(
        station.units.map((u) => [u.id, clamp01(p50 * (BLOCK_FACTOR[u.id] ?? 1))]),
      ),
    });
  }
  return {
    forecast_id: `demo-${station.id}-${originIso.slice(0, 10)}`,
    forecast_origin: toIso(origin),
    horizon,
    model_version: "pv-physical-v1 (демо)",
    weather_provider: "open-meteo historical-forecast",
    weather_run: toIso(origin - 6 * HOUR),
    created_at: toIso(origin + 3 * 60_000),
    predictions: points,
    agent_steps: agentSteps(origin),
    explanation:
      "Выработка СЭС повторяет ход солнца: пик около полудня, ночью ноль. " +
      "Разброс прогноза задаёт облачность — чем дальше горизонт, тем он шире.",
  };
}

/** Фактическая почасовая мощность агрегата (доля номинала) — для истории. */
export function unitActual(station: Station, unitId: string, t: number): UnitSample {
  if (station.kind === "solar") {
    return { ts: toIso(t), power: clamp01(solarPower(t) * (BLOCK_FACTOR[unitId] ?? 1)) };
  }
  const wind = trueWind(t);
  const base = clamp01(powerCurve(wind) * LOSSES + 0.03 * smoothNoise((t - EPOCH) / HOUR / 2, 77));
  const wake = unitId === "T2" ? wakeFactor(trueDir(t)) : 1;
  return { ts: toIso(t), power: clamp01(base * wake), wind_speed: wind * (unitId === "T2" ? wake ** 0.33 : 1) };
}

export function demoUnitHistory(station: Station, unitId: string, fromIso: string, toIsoStr: string): UnitSample[] {
  const out: UnitSample[] = [];
  for (let t = parseTs(fromIso); t <= parseTs(toIsoStr); t += HOUR) out.push(unitActual(station, unitId, t));
  return out;
}

// ─── Подбор места ───────────────────────────────────────────────────────────
// Синтетическая карта ресурса вокруг Ерейментау. В проде заменяется на
// Global Wind Atlas / ERA5 для ветра и PVGIS / NASA POWER для солнца.

export const REGION = { lat0: 50.8, lat1: 52.3, lon0: 71.2, lon1: 74.4 };

function noise2(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = (x - xi) ** 2 * (3 - 2 * (x - xi));
  const w = (y - yi) ** 2 * (3 - 2 * (y - yi));
  const h = (i: number, j: number) => hash(i * 57.3 + j * 131.9 + seed * 17.1);
  return (
    h(xi, yi) * (1 - u) * (1 - w) + h(xi + 1, yi) * u * (1 - w) +
    h(xi, yi + 1) * (1 - u) * w + h(xi + 1, yi + 1) * u * w
  );
}

function fbm2(x: number, y: number): number {
  let v = 0;
  let a = 0.5;
  let f = 1;
  for (let o = 0; o < 4; o += 1) {
    v += a * noise2(x * f, y * f, o + 1);
    a *= 0.5;
    f *= 2.1;
  }
  return v / 0.9375;
}

/** Среднегодовая скорость ветра на высоте ступицы, м/с. */
export function meanWindAt(lat: number, lon: number): number {
  // Ерейментауский хребет: синтетическая карта ресурса нарисована вокруг него.
  const ridge = Math.exp(-(((lat - 51.62) / 0.35) ** 2)) * 1.1;
  return 5.2 + 3.2 * fbm2(lon * 2.2, lat * 2.6) + ridge;
}

/** Годовая сумма солнечной радиации на горизонтальную поверхность, кВт·ч/м². */
export function ghiAt(lat: number, lon: number): number {
  return 1180 + (52.4 - lat) * 95 + 140 * fbm2(lon * 1.8 + 5, lat * 2.2);
}

/**
 * Коэффициент использования ВЭС при распределении Рэлея со средней
 * скоростью `mean` — честный интеграл кривой мощности, а не константа.
 */
export function windCapacityFactor(mean: number): number {
  const sigma = mean * Math.sqrt(2 / Math.PI);
  let e = 0;
  for (let v = 0.05; v < 30; v += 0.1) {
    e += powerCurve(v) * (v / sigma ** 2) * Math.exp(-(v * v) / (2 * sigma ** 2)) * 0.1;
  }
  return e * LOSSES;
}

/** КИУМ СЭС: GHI × коэффициент производительности 0.8 / 8760 ч. */
export function solarCapacityFactor(ghi: number): number {
  return (ghi * 1.12 * 0.8) / 8760;
}
