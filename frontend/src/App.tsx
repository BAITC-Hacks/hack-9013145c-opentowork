import { useCallback, useEffect, useState } from "react";
import { api, ApiError, token } from "./api";
import type { ChatResponse, JobStatus, SearchHit, Stats } from "./api";
import { AnswerView, MetaBadge, StatsPanel } from "./components";

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
      <h2>Вход</h2>
      {error && <div className="error">{error}</div>}
      <div>
        <label htmlFor="email">Почта</label>
        <input id="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div>
        <label htmlFor="password">Пароль</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <button className="primary" type="submit" disabled={busy}>
        {busy ? <span className="spin" /> : "Войти"}
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

export default function App() {
  const [authed, setAuthed] = useState(Boolean(token.get()));
  const [tab, setTab] = useState<Tab>("chat");
  const [who, setWho] = useState<string>("");

  useEffect(() => {
    if (!authed) return;
    api
      .me()
      .then((user) => setWho(`${user.email} · ${user.role}`))
      .catch(() => {
        // Токен мог протухнуть между сессиями — возвращаем на вход.
        token.clear();
        setAuthed(false);
      });
  }, [authed]);

  if (!authed) return <div className="app"><Login onDone={() => setAuthed(true)} /></div>;

  return (
    <div className="app">
      <header className="top">
        <h1>HackAlem AI · OpenToWork</h1>
        <nav className="tabs">
          {TABS.map(([key, label]) => (
            <button
              key={key}
              className={tab === key ? "active" : ""}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <span className="hint">{who}</span>
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

      {tab === "chat" && <ChatTab />}
      {tab === "knowledge" && <KnowledgeTab />}
      {tab === "jobs" && <JobsTab />}
      {tab === "stats" && <StatsTab />}
    </div>
  );
}
