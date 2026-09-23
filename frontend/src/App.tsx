import { useCallback, useEffect, useState } from "react";
import { api, ApiError, token } from "./api";
import type { ChatResponse, JobStatus, SearchHit, Stats } from "./api";
import { AnswerView, MetaBadge, StatsPanel } from "./components";
import Agent from "./twin/Agent";
import Backtest from "./twin/Backtest";
import Predictions from "./twin/Predictions";
import { canOpen, fmtDay, fmtDayTime, LIVE_ORIGIN, ORIGINS, useForecast, useRoute, useStations } from "./twin/data";
import type { Route, StationTab } from "./twin/data";
import { Home, KindPick, StationPick } from "./twin/Flow";
import Placement from "./twin/Placement";
import Rooftops from "./twin/Rooftops";
import StationView from "./twin/StationView";

type Tab = "chat" | "knowledge" | "jobs" | "stats";

const TABS: [Tab, string][] = [
  ["chat", "Запрос"],
  ["knowledge", "База знаний"],
  ["jobs", "Асинхронный анализ"],
  ["stats", "Метрики"],
];

function useError() {
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (exc) {
      if (exc instanceof ApiError) {
        setError(
          exc.requestId ? `${exc.message} (request_id: ${exc.requestId})` : exc.message,
        );
      } else {
        setError(String(exc));
      }
    }
  }, []);
  return { error, setError, run };
}

function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("demo@demo.kz");
  const [password, setPassword] = useState("demo1234");
  const [busy, setBusy] = useState(false);
  const { error, run } = useError();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    run(async () => {
      const result = await api.login(email, password);
      token.set(result.access_token);
      onDone();
    }).finally(() => setBusy(false));
  };

  return (
    <form className="card login stack" onSubmit={submit}>
      <div className="login-brand"><Logo /> Renewable Twin</div>
      <h2>Энергия начинается с понимания</h2>
      <p className="login-intro">Прогнозы ветра, солнечные станции и потенциал городских крыш — в одном пространстве.</p>
      {error && <div className="error">{error}</div>}
      <div>
        <label htmlFor="email">Почта</label>
        <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div>
        <label htmlFor="password">Пароль</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <button className="primary" type="submit" disabled={busy}>
        {busy ? <span className="spin" /> : "Открыть рабочее пространство →"}
      </button>
      <div className="hint">Демо-учётка подставлена: проверка не требует своих аккаунтов.</div>
    </form>
  );
}

function ChatTab() {
  const [query, setQuery] = useState("");
  const [context, setContext] = useState({ language: "ru", region: "astana" });
  const [response, setResponse] = useState<ChatResponse | null>(null);
  const [liveBaseline, setLiveBaseline] = useState<number | null>(null);
  const [rated, setRated] = useState(false);
  const [busy, setBusy] = useState(false);
  const { error, run } = useError();

  const ask = () => {
    if (!query.trim()) return;
    setBusy(true);
    setRated(false);
    run(async () => {
      const result = await api.chat(query, context);
      setResponse(result);
      // Запоминаем время «живого» ответа, чтобы следующий ответ из кэша
      // можно было показать в сравнении, а не абстрактной цифрой.
      if (result.meta.source === "live") setLiveBaseline(result.meta.latency_ms);
    }).finally(() => setBusy(false));
  };

  const rate = (rating: number) => {
    if (!response) return;
    run(async () => {
      await api.feedback(response.request_id, rating);
      setRated(true);
    });
  };

  return (
    <>
      <div className="card stack">
        <h2>Запрос к системе</h2>
        {error && <div className="error">{error}</div>}
        <div>
          <label htmlFor="query">Вопрос</label>
          <textarea
            id="query"
            value={query}
            placeholder="Например: порог срабатывания семантического кэша"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ask();
            }}
          />
        </div>
        <div className="row">
          <div>
            <label htmlFor="lang">Язык</label>
            <select
              id="lang"
              value={context.language}
              onChange={(e) => setContext({ ...context, language: e.target.value })}
            >
              <option value="ru">ru</option>
              <option value="kk">kk</option>
              <option value="en">en</option>
            </select>
          </div>
          <div>
            <label htmlFor="region">Регион</label>
            <input
              id="region"
              value={context.region}
              onChange={(e) => setContext({ ...context, region: e.target.value })}
            />
          </div>
          <button className="primary" onClick={ask} disabled={busy || !query.trim()}>
            {busy ? <span className="spin" /> : "Спросить"}
          </button>
        </div>
        <div className="hint">
          Поля контекста разделяют кэш: один и тот же вопрос для разных регионов —
          разные записи. Ctrl/Cmd+Enter отправляет.
        </div>
      </div>

      {response && (
        <div className="card">
          <MetaBadge meta={response.meta} liveBaseline={liveBaseline} />
          <AnswerView answer={response.answer} />
          <h3>Оценка ответа</h3>
          {rated ? (
            <div className="hint">Спасибо, оценка записана.</div>
          ) : (
            <div style={{ display: "flex", gap: 8 }}>
              <button className="ghost" onClick={() => rate(1)}>
                Полезно
              </button>
              <button className="ghost" onClick={() => rate(-1)}>
                Неверно
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function KnowledgeTab() {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const { error, run } = useError();

  const search = () => {
    if (!query.trim()) return;
    setBusy(true);
    run(async () => setHits(await api.search(query))).finally(() => setBusy(false));
  };

  return (
    <div className="card stack">
      <h2>Поиск по базе знаний</h2>
      <div className="hint">
        Retrieval без обращения к модели — видно, на каких документах строится ответ.
      </div>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <input
          value={query}
          placeholder="Что искать"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
        />
        <button onClick={search} disabled={busy || !query.trim()}>
          {busy ? <span className="spin" /> : "Найти"}
        </button>
      </div>
      {hits && hits.length === 0 && <div className="hint">Релевантных документов нет.</div>}
      {hits && hits.length > 0 && (
        <ul className="clean">
          {hits.map((hit) => (
            <li key={hit.doc_id}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                <b>{hit.title}</b>
                <span className="mono">{hit.similarity.toFixed(4)}</span>
              </div>
              <div className="source">{hit.content}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function JobsTab() {
  const [query, setQuery] = useState("Проверка асинхронной обработки");
  const [job, setJob] = useState<JobStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const { error, run } = useError();

  // Опрос статуса: задача уходит в очередь и обрабатывается отдельным воркером,
  // поэтому ответ приходит не в том же HTTP-запросе.
  useEffect(() => {
    if (!job || job.status === "COMPLETED" || job.status === "FAILED") return;
    const timer = setTimeout(() => {
      run(async () => setJob(await api.job(job.job_id)));
    }, 1000);
    return () => clearTimeout(timer);
  }, [job, run]);

  const start = () => {
    setBusy(true);
    run(async () => setJob(await api.createJob("demo_analysis", { query }))).finally(() =>
      setBusy(false),
    );
  };

  const done = job?.status === "COMPLETED";

  return (
    <div className="card stack">
      <h2>Асинхронный анализ</h2>
      <div className="hint">
        Тяжёлая операция уходит в очередь Redis Streams и выполняется воркером — API
        остаётся отзывчивым и масштабируется отдельно.
      </div>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <input value={query} onChange={(e) => setQuery(e.target.value)} />
        <button onClick={start} disabled={busy}>
          {busy ? <span className="spin" /> : "Запустить"}
        </button>
      </div>
      {job && (
        <div className="metric">
          <div className="label">Задача {job.job_id.slice(0, 8)}</div>
          <div className="value">
            {job.status} · {job.progress}%
          </div>
          {job.error && <div className="error" style={{ marginTop: 10 }}>{job.error}</div>}
        </div>
      )}
      {done && job?.result && (
        <pre className="mono" style={{ whiteSpace: "pre-wrap", overflowX: "auto" }}>
          {JSON.stringify(job.result, null, 2)}
        </pre>
      )}
    </div>
  );
}

function StatsTab() {
  const [stats, setStats] = useState<Stats | null>(null);
  const { error, run } = useError();

  const reload = useCallback(() => {
    run(async () => setStats(await api.stats()));
  }, [run]);

  useEffect(reload, [reload]);

  return (
    <div className="card stack">
      <h2>Экономика решения</h2>
      {error && <div className="error">{error}</div>}
      {stats && <StatsPanel stats={stats} />}
      <div>
        <button className="ghost" onClick={reload}>
          Обновить
        </button>
      </div>
    </div>
  );
}

function PlatformTab() {
  const [tab, setTab] = useState<Tab>("stats");
  return (
    <div className="page narrow">
      <nav className="tabs sub">
        {TABS.map(([key, label]) => (
          <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </nav>
      {tab === "chat" && <ChatTab />}
      {tab === "knowledge" && <KnowledgeTab />}
      {tab === "jobs" && <JobsTab />}
      {tab === "stats" && <StatsTab />}
    </div>
  );
}

const LAST_STATION_KEY = "twin.lastStation";

function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_STATION_KEY);
  } catch {
    return null;
  }
}

function Logo() {
  return (
    <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden>
      <rect width="36" height="36" rx="11" fill="#087f72" />
      <path d="M10 25V12h6.5c4.8 0 7 2 7 5.1 0 2.6-1.8 4.4-5 4.8L25 27" fill="none" stroke="white" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="26" cy="10" r="3" fill="#ecca7d" />
    </svg>
  );
}

const KIND_LABEL = { wind: "Ветер", solar: "Солнце" } as const;
const TAB_LABEL: [StationTab, string][] = [
  ["map", "Обзор станции"],
  ["accuracy", "Точность прогноза"],
  ["agent", "Как считается"],
];

/** Хлебные крошки повторяют шаги мастера — по ним можно вернуться на любой. */
function crumbs(route: Route, stationName: string | null): { label: string; to: Route | null }[] {
  const out: { label: string; to: Route | null }[] = [];
  if (route.page === "platform") return [{ label: "Платформа", to: null }];
  if (route.page === "predictions") return [{ label: "Прогнозы", to: null }];
  if (route.page === "home") return out;
  if (route.page === "roofs")
    return [
      { label: "Новая станция", to: { page: "kind", mode: "place" } },
      { label: "Крыши города", to: null },
    ];
  const mode = route.page === "kind" ? route.mode : route.page === "place" ? "place" : "forecast";
  const first = mode === "place" ? "Новая станция" : "Прогноз";
  if (route.page === "kind") return [{ label: first, to: null }];
  out.push({ label: first, to: { page: "kind", mode } });
  const kind = route.kind;
  out.push({
    label: KIND_LABEL[kind],
    to: route.page === "station" ? { page: "stations", kind } : null,
  });
  if (route.page === "station") out.push({ label: stationName ?? route.stationId, to: null });
  return out;
}

export default function App() {
  const [authed, setAuthed] = useState(Boolean(token.get()));
  const [route, go] = useRoute();
  const { stations } = useStations(authed);
  const [originIso, setOriginIso] = useState(ORIGINS[0]);
  const [horizon, setHorizon] = useState(48);
  const [nonce, setNonce] = useState(0);
  const station =
    route.page === "station" ? stations.find((s) => s.id === route.stationId && canOpen(s)) ?? null : null;
  const forecast = useForecast(station, originIso, horizon, nonce);
  const [lastId, setLastId] = useState(readLast);

  useEffect(() => {
    if (!station) return;
    setLastId(station.id);
    try {
      localStorage.setItem(LAST_STATION_KEY, station.id);
    } catch {
      // Приватный режим браузера: «вернуться к станции» просто не появится.
    }
  }, [station]);

  useEffect(() => {
    if (!authed) return;
    api.me().catch(() => {
      // Токен мог протухнуть между сессиями — возвращаем на вход.
      token.clear();
      setAuthed(false);
    });
  }, [authed]);

  if (!authed) return <div className="app"><Login onDone={() => setAuthed(true)} /></div>;

  const rerun = () => setNonce((n) => n + 1);
  const path = crumbs(route, station?.name ?? null);
  const lastStation = stations.find((s) => s.id === lastId && canOpen(s)) ?? null;
  const activeSection = route.page === "roofs" ? "roofs" : "kind" in route ? route.kind : route.page;
  const primaryNav: { id: string; label: string; to: Route }[] = [
    { id: "home", label: "Обзор", to: { page: "home" } },
    { id: "wind", label: "Ветровая энергия", to: { page: "stations", kind: "wind" } },
    { id: "solar", label: "Солнечная энергия", to: { page: "stations", kind: "solar" } },
    { id: "roofs", label: "Панели на крышах", to: { page: "roofs" } },
    { id: "predictions", label: "Прогнозы", to: { page: "predictions" } },
  ];

  return (
    <div className={`shell ${activeSection === "solar" || activeSection === "roofs" ? "theme-solar" : "theme-wind"}`}>
      <a className="skip-link" href="#workspace" onClick={(e) => { e.preventDefault(); document.getElementById("workspace")?.focus(); }}>К содержимому</a>
      <header className="topbar">
        <button className="brand" onClick={() => go({ page: "home" })} aria-label="На главный экран">
          <Logo />
          <span>
            <span className="brand-name">Renewable Twin</span>
            <span className="brand-sub">Energy workspace</span>
          </span>
        </button>
        <nav className="primary-nav" aria-label="Основные разделы">
          {primaryNav.map((item) => <button key={item.id} className={activeSection === item.id ? "active" : ""} aria-current={activeSection === item.id ? "page" : undefined} onClick={() => go(item.to)}>{item.label}</button>)}
        </nav>
        <div className="spacer" />
        <button
          className="ghost"
          onClick={() => {
            token.clear();
            setAuthed(false);
          }}
        >
          Выйти
        </button>
      </header>

      <main id="workspace" tabIndex={-1}>
      {path.length > 0 && <div className="location-bar"><nav className="crumbs" aria-label="Где вы">
        <button onClick={() => go({ page: "home" })}>Рабочее пространство</button>
        {path.map((c, i) => c.to ? <button key={i} onClick={() => go(c.to!)}>{c.label}</button> : <span key={i} aria-current="page">{c.label}</span>)}
      </nav></div>}
      {route.page === "station" && station && (
        <div className="station-heading">
        <div className="station-title"><span className="eyebrow">{station.kind === "wind" ? "Ветровая электростанция" : "Солнечная электростанция"}</span><h1>{station.name}</h1><p>{station.region} <span>·</span> Почасовой прогноз на {horizon} часов</p></div>
        <div className="station-heading-right"><div className="forecast-date">{originIso === LIVE_ORIGIN ? <>Живой прогноз от {fmtDayTime(originIso)} <span>UTC · погода Open-Meteo</span></> : <>Прогноз от {fmtDay(originIso)} 2026 <span>00:00 · UTC+5</span></>}</div>
        <nav className="station-tabs" aria-label="Разделы станции">
          {TAB_LABEL.filter(([t]) => t === "map" || station.data === "history").map(([t, label]) => (
            <button
              key={t}
              className={route.tab === t ? "active" : ""} aria-current={route.tab === t ? "page" : undefined}
              onClick={() => go({ ...route, tab: t })}
            >
              {label}
            </button>
          ))}
        </nav>
        </div></div>
      )}

      {route.page === "home" && <Home go={go} lastStation={lastStation} stations={stations} />}
      {route.page === "kind" && <KindPick mode={route.mode} stations={stations} go={go} />}
      {route.page === "stations" && (
        <StationPick kind={route.kind} stations={stations} originIso={originIso} go={go} />
      )}
      {route.page === "place" && <Placement kind={route.kind} stations={stations} go={go} />}
      {route.page === "roofs" && <Rooftops go={go} />}
      {route.page === "platform" && <PlatformTab />}
      {route.page === "predictions" && (
        <Predictions
          stations={stations}
          onOpen={(s) => {
            setOriginIso(LIVE_ORIGIN);
            go({ page: "station", kind: s.kind, stationId: s.id, tab: "map" });
          }}
        />
      )}
      {route.page === "station" && !station && (
        <div className="flow">
          <h1 className="flow-q">Станция не найдена</h1>
          <p className="flow-sub">По этой станции нет данных. Выберите другую из списка.</p>
          <button className="primary" onClick={() => go({ page: "stations", kind: route.kind })}>
            К списку станций
          </button>
        </div>
      )}
      {route.page === "station" && station && route.tab === "map" && (
        <StationView
          key={station.id}
          station={station}
          run={forecast.run}
          dataOrigin={forecast.origin}
          loading={forecast.loading}
          originIso={originIso}
          onOrigin={setOriginIso}
          horizon={horizon}
          onHorizon={setHorizon}
          onRerun={rerun}
        />
      )}
      {route.page === "station" && station && route.tab === "accuracy" && (
        <Backtest run={forecast.run} originIso={originIso} onOrigin={setOriginIso} dataOrigin={forecast.origin} />
      )}
      {route.page === "station" && station && route.tab === "agent" && (
        <Agent run={forecast.run} onRerun={rerun} loading={forecast.loading} />
      )}
      </main>
      <footer className="workspace-footer"><span>Renewable Twin <span>·</span> Энергия с ясной перспективой</span><button onClick={() => go({ page: "platform" })}>Платформа и инструменты ↗</button></footer>
    </div>
  );
}
