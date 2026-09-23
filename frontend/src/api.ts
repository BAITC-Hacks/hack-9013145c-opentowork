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
};
