// Единственное место, где фронтенд знает про HTTP. Компоненты работают
// с типами, а не с fetch, поэтому смена контракта правится в одном файле.

export interface SourceRef {
  doc_id: string;
  title: string;
  uri?: string | null;
}

export interface Recommendation {
  title: string;
  action: string;
  priority: "low" | "medium" | "high";
}

export interface AIAnswer {
  summary: string;
  possible_causes: string[];
  recommendations: Recommendation[];
  confidence: number;
  sources: SourceRef[];
  needs_expert_review: boolean;
}

export interface AIMeta {
  tools?: string[];
  source: "live" | "exact_cache" | "semantic_cache" | "degraded";
  similarity: number | null;
  model: string;
  latency_ms: number;
  tokens: { prompt: number; completion: number };
  saved_tokens: { prompt: number; completion: number };
  cost_usd: number;
  saved_usd: number;
  degraded: boolean;
  validation_retries: number;
  retrieved: number;
}

export interface ChatResponse {
  request_id: string;
  answer: AIAnswer;
  meta: AIMeta;
}

export interface SearchHit {
  doc_id: string;
  title: string;
  content: string;
  similarity: number;
}

export interface Stats {
  total_requests: number;
  cache_hits: number;
  hit_rate: number;
  avg_latency_live_ms: number;
  avg_latency_cached_ms: number;
  degraded: number;
  cache_entries: number;
  saved_usd_estimate: number;
  spent_usd: number;
  llm_mode: string;
  note: string;
}

export interface JobStatus {
  job_id: string;
  status: string;
  progress: number;
  result: Record<string, unknown>;
  error: string | null;
}

// ─── Контракт прогноза ВЭС ─────────────────────────────────────────────────
// Мощность нормализована к номиналу (0..1): установленная мощность в
// датасете не дана, поэтому фронтенд не придумывает мегаватты.

export interface Turbine {
  id: string;
  name: string;
  lat: number;
  lon: number;
  rated_mw?: number | null; // номинал; в датасете не дан, поэтому необязателен
  model?: string | null;
}

export type SourceKind = "wind" | "solar";

export interface Station {
  id: string;
  kind: SourceKind;
  name: string;
  region: string;
  lat: number | null; // null — станция есть в реестре, координаты не опубликованы
  lon: number | null;
  units: Turbine[]; // турбины ВЭС или блоки панелей СЭС
  data: "history" | "model" | "none"; // есть ли фактические данные
  note?: string | null;
  // Справочник ВЭС (реестр Минэнерго + OSM), см. /stations
  location?: "turbines" | "plant" | "district" | null;
  capacity_mw?: number | null;
  capacity_source?: "registry" | "osm" | null;
  operators?: string[];
  commissioned?: string | null;
  in_registry?: boolean;
  osm?: string | null;
}

// Ветер у станции по часам: /stations/{id}/wind. Open-Meteo, скорость в м/с,
// направление — откуда дует, в градусах.
export interface WindHour {
  time: string;
  speed_10m: number | null;
  speed_100m: number;
  dir_10m: number | null;
  dir_100m: number | null;
  gust_10m: number | null;
  temperature: number | null;
  beaufort: number;
  shear_alpha: number | null; // показатель профиля v ∝ h^α
}

export interface StationWind {
  station_id: string;
  lat: number;
  lon: number;
  source: "snapshot" | "archive" | "forecast";
  provider: string;
  hours: WindHour[];
}

export interface UnitSample {
  ts: string;
  power: number; // доля номинала 0..1
  wind_speed?: number;
}

export interface ForecastPoint {
  forecast_for: string; // ISO, час, на который прогноз
  horizon_h: number; // часов от forecast_origin
  p10: number;
  p50: number;
  p90: number;
  baseline?: number | null; // persistence или power curve
  actual?: number | null; // только для исторического периода
  wind_speed: number; // м/с, из погодного прогноза, выпущенного до origin
  wind_dir: number; // градусы, откуда дует
  temperature: number;
  cloud_cover?: number; // 0..1, для СЭС
  per_turbine?: Record<string, number>; // по id агрегата: турбины или блока
}

export interface AgentStep {
  agent: string;
  action: string;
  status: "ok" | "warn" | "fail" | "running";
  duration_ms: number;
  detail?: string;
}

export interface ForecastRun {
  forecast_id: string;
  forecast_origin: string;
  horizon: number;
  model_version: string;
  weather_provider: string;
  weather_run: string; // issued_at использованного прогноза погоды
  created_at: string;
  predictions: ForecastPoint[];
  agent_steps?: AgentStep[];
  explanation?: string;
  live?: boolean; // посчитан сейчас на свежей погоде, а не взят из сохранённого прогона
  method?: "ml" | "curve" | "solar";
  degraded?: boolean;
}

// Живая сводка по всем ВЭС: /predictions/overview. Ряды — доля номинала по часам.
export interface OverviewStation {
  id: string;
  name: string;
  region: string;
  lat: number;
  lon: number;
  rated_mw: number | null;
  can_open: boolean;
  method: "ml" | "curve";
  times: string[];
  p50: (number | null)[];
  p10: (number | null)[] | null;
  p90: (number | null)[] | null;
  wind_speed: (number | null)[];
  wind_dir: (number | null)[];
  cf24: number | null;
  mwh24: number | null;
  peak_at: string | null;
  peak: number | null;
}

export interface Overview {
  origin: string;
  generated_at: string;
  horizon: number;
  sources: Record<string, string>;
  ml_explanation: string | null;
  stations: OverviewStation[];
}

// ─── Интерпретация прогноза (/explain) ───────────────────────────────────────

export interface ExplainGroup {
  group: string;
  label: string;
  wind_ms: number; // вклад в поправку ветра, м/с (TreeSHAP)
  power_via_wind: number; // тот же вклад, переведённый в мощность через наклон кривой
  power_direct: number; // вклад в прямую модель, доля номинала
}

export interface ExplainStep {
  key: "raw" | "corrected" | "uncertainty" | "final";
  label: string;
  power: number;
  wind?: number;
}

export interface ExplainHour {
  time: string;
  local: string;
  horizon_h: number;
  nwp_day: number;
  steps: ExplainStep[];
  direct_p50: number;
  cascade_mean: number;
  interval: [number, number];
  wind: {
    raw: number;
    spread: number;
    corrected: number;
    p10: number;
    p90: number;
    base: number;
    by_model: Record<string, number | null>;
  };
  groups: ExplainGroup[];
  temp: number;
}

export interface ExplainRevision {
  from: string;
  to: string;
  summary: string;
  mean_abs_change?: number;
  hours: {
    time: string;
    local: string;
    delta_power: number;
    was: number;
    now: number;
    raw_wind_change: number;
    model_wind_change: Record<string, number | null>;
    group_changes: { label: string; delta_wind_ms: number }[];
  }[];
}

export interface Explanation {
  origin: string;
  forecast_id?: string;
  published?: boolean;
  live?: boolean;
  summary: string;
  hours: ExplainHour[];
  overall: { group: string; label: string; mean_abs_wind_ms: number; mean_wind_ms: number }[];
  revision?: ExplainRevision;
  versions?: { origin: string; published: boolean; revision?: ExplainRevision | null }[];
}

export interface GlobalExplanation {
  power_curve: { ws: number[]; curves: Record<string, number[]> };
  importance_wind_correction: { group: string; label: string; share: number }[];
  importance_direct: { group: string; label: string; share: number }[];
  weather_models: { model: string; hours: number; corr: number; mae_ms: number; bias_ms: number }[];
  ensemble_weights: Record<string, number>;
  calibration: {
    reliability?: Record<string, number>;
    cov80?: number;
    cov90?: number;
    by_horizon?: { h: number; ensemble: number; raw: number }[];
  };
  trained_until: string;
}

export interface ModelMetric {
  model: string;
  mae: number;
  rmse: number;
  nmae?: number;
  selected?: boolean;
}

export interface BacktestSummary {
  period: string;
  metrics: ModelMetric[];
  daily: { date: string; mae: Record<string, number> }[];
  by_horizon: { horizon_h: number; mae: number }[];
}

export interface SimulationResult {
  scenario: string;
  base_energy: number;
  scenario_energy: number;
  points: { forecast_for: string; p50: number }[];
}

// ─── Солнечный потенциал крыш ──────────────────────────────────────────────
// Расчёт по физике (PVGIS + тени от соседей по OSM), не обучаемая модель.

export interface Rooftop {
  id: string; // way/<osm id>
  rank: number;
  name: string | null;
  type: string | null;
  height_m: number;
  height_source: "osm_height" | "osm_levels" | "assumed";
  pitched: boolean;
  roof_m2: number;
  usable_m2: number;
  kwp: number;
  kwh_year: number;
  kwh_per_kwp: number; // «качество места»: сколько даёт 1 кВт панелей с учётом теней
  shading_loss: number; // доля годовой выработки, которую съедают тени
  monthly_kwh: number[];
  monthly_shading: number[]; // доля прямого света в тени, по месяцам
  notes: string[];
  polygon: [number, number][]; // [lat, lon]
}

export interface RooftopsResponse {
  district: string;
  bbox: [number, number, number, number]; // south, west, north, east
  sources: { buildings: string; irradiance: string; fetched: string };
  irradiance: {
    tilt_deg: number;
    kwh_per_kwp_year: number;
    months: { month: number; kwh_per_kwp: number; diffuse_share: number }[];
  };
  assumptions: Record<string, number>;
  summary: {
    buildings: number;
    height_known_share: number;
    total_kwp: number;
    total_mwh_year: number;
    top10_mwh_year: number;
  };
  buildings: Rooftop[];
}

const TOKEN_KEY = "hackalem.token";

export interface WindTurbineModel {
  id: string;
  name: string;
  manufacturer: string;
  rated_power_kw: number;
  rotor_diameter_m: number;
  hub_heights_m: number[];
  high_wind_zero_ms: number;
  source_url: string;
  metadata_source_url: string;
  curve: [number, number][];
  notes: string[];
}

export interface WindSimulationInput {
  latitude: number;
  longitude: number;
  turbine_id: string;
  hub_height_m: number;
  horizon_hours: 24 | 48;
  loss_percent: number;
}

export interface WindSimulation {
  method: "engineering_power_curve_v1";
  calibrated: false;
  request: WindSimulationInput;
  turbine: WindTurbineModel;
  hub_height_m: number;
  weather_provider: string;
  weather_source_url: string;
  weather_retrieved_at: string;
  weather_run_issued_at: string | null;
  weather_grid: { latitude: number; longitude: number; elevation_m: number };
  forecast_start: string;
  forecast_end: string;
  generated_at: string;
  gross_energy_kwh: number;
  net_energy_kwh: number;
  capacity_factor: number;
  mean_wind_hub_ms: number;
  peak_net_power_kw: number;
  high_wind_shutdown_hours: number;
  hours: {
    time: string;
    wind_hub_ms: number;
    density_kg_m3: number;
    gross_power_kw: number;
    net_power_kw: number;
    energy_kwh: number;
    high_wind_shutdown: boolean;
  }[];
  assumptions: string[];
}

export const token = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (value: string) => localStorage.setItem(TOKEN_KEY, value),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  const bearer = token.get();
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`);

  const response = await fetch(`/api/v1${path}`, { ...init, headers });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};

  if (!response.ok) {
    // Бэкенд отдаёт единый формат ошибки с request_id — показываем его
    // пользователю, чтобы строку из лога можно было найти по номеру.
    const error = body?.error ?? {};
    throw new ApiError(
      response.status,
      error.code ?? "UNKNOWN",
      error.message ?? response.statusText,
      error.request_id,
    );
  }
  return body as T;
}

export const api = {
  windTurbineModels: () => request<WindTurbineModel[]>("/wind/turbine-models"),
  simulateWind: (input: WindSimulationInput, signal?: AbortSignal) =>
    request<WindSimulation>("/wind/simulate", {
      method: "POST", body: JSON.stringify(input), signal,
    }),
  login: (email: string, password: string) =>
    request<{ access_token: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  me: () => request<{ email: string; role: string }>("/users/me"),

  chat: (query: string, context: Record<string, unknown>) =>
    request<ChatResponse>("/ai/chat", {
      method: "POST",
      body: JSON.stringify({ query, context }),
    }),

  feedback: (requestId: string, rating: number, reason?: string) =>
    request<{ status: string }>("/ai/feedback", {
      method: "POST",
      body: JSON.stringify({ request_id: requestId, rating, reason }),
    }),

  stats: () => request<Stats>("/ai/stats"),

  search: (q: string) =>
    request<SearchHit[]>(`/knowledge/search?q=${encodeURIComponent(q)}`),

  createJob: (type: string, payload: Record<string, unknown>) =>
    request<JobStatus>("/analysis", {
      method: "POST",
      body: JSON.stringify({ type, payload }),
    }),

  job: (id: string) => request<JobStatus>(`/jobs/${id}`),

  stations: () => request<Station[]>("/stations"),

  forecastAt: (stationId: string, origin: string, horizon = 48) =>
    request<ForecastRun>(
      `/forecast/latest?station_id=${encodeURIComponent(stationId)}&origin=${encodeURIComponent(origin)}&horizon=${horizon}`,
    ),

  runForecast: (stationId: string, origin: string, horizon: number) =>
    request<ForecastRun>("/forecast/run", {
      method: "POST",
      body: JSON.stringify({ station_id: stationId, forecast_origin: origin, horizon }),
    }),

  unitHistory: (stationId: string, unitId: string, from: string, to: string) =>
    request<UnitSample[]>(
      `/stations/${encodeURIComponent(stationId)}/units/${encodeURIComponent(unitId)}/history?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),

  backtest: () => request<BacktestSummary>("/metrics"),

  explain: (stationId: string, origin: string) =>
    request<Explanation>(
      `/explain?station_id=${encodeURIComponent(stationId)}&origin=${encodeURIComponent(origin)}`,
    ),

  explainGlobal: () => request<GlobalExplanation>("/explain/global"),

  stationWind: (stationId: string, origin: string, horizon: number) =>
    request<StationWind>(
      `/stations/${encodeURIComponent(stationId)}/wind?origin=${encodeURIComponent(origin)}&horizon=${horizon}`,
    ),

  // Прогноз на реальной погоде Open-Meteo для любой станции и момента (origin = ISO или "now").
  predictRun: (station: Station, origin: string, horizon: number) => {
    const q = new URLSearchParams({ station_id: station.id, origin, horizon: String(horizon), kind: station.kind });
    if (station.kind === "solar" && station.lat != null && station.lon != null) {
      q.set("lat", String(station.lat));
      q.set("lon", String(station.lon));
      q.set("units", station.units.map((u) => u.id).join(","));
    }
    return request<ForecastRun>(`/predictions/run?${q}`);
  },

  predictionsOverview: (horizon = 48) => request<Overview>(`/predictions/overview?horizon=${horizon}`),

  rooftops: () => request<RooftopsResponse>("/solar/rooftops"),

  simulate: (forecastId: string, windChangePct: number, horizon = 48) =>
    request<SimulationResult>("/simulation", {
      method: "POST",
      body: JSON.stringify({ forecast_id: forecastId, wind_change_pct: windChangePct, horizon }),
    }),
};
