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
  login: (email: string, password: string) =>
    request<{ access_token: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  me: () => request<{ email: string; role: string }>("/users/me"),

  chat: (query: string, context: Record<string, string>) =>
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

  forecastAt: (stationId: string, origin: string) =>
    request<ForecastRun>(
      `/forecast/latest?station_id=${encodeURIComponent(stationId)}&origin=${encodeURIComponent(origin)}`,
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

  rooftops: () => request<RooftopsResponse>("/solar/rooftops"),

  simulate: (forecastId: string, windChangePct: number) =>
    request<SimulationResult>("/simulation", {
      method: "POST",
      body: JSON.stringify({ forecast_id: forecastId, wind_change_pct: windChangePct }),
    }),
};
