import { useState } from "react";
import { api, ApiError } from "../api";
import type { ChatResponse, ForecastRun } from "../api";
import { MetaBadge } from "../components";
import { fmtDayTime } from "./data";
import { parseTs } from "./demo";

const SUGGESTIONS = [
  "Почему завтра снизится генерация?",
  "Когда ожидается пик выработки?",
  "Какая неопределённость через 48 часов?",
  "Что будет, если ветер окажется на 15% слабее?",
];

const STATUS_ICON = { ok: "✓", warn: "!", fail: "✕", running: "…" } as const;

interface Message {
  role: "user" | "ai";
  text: string;
  response?: ChatResponse;
}

export default function Agent({ run, onRerun, loading }: { run: ForecastRun | null; onRerun: () => void; loading: boolean }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [liveBaseline, setLiveBaseline] = useState<number | null>(null);
  const steps = run?.agent_steps ?? [];
  const total = steps.reduce((a, s) => a + s.duration_ms, 0);
  const pitOk = run ? parseTs(run.weather_run) <= parseTs(run.forecast_origin) : false;

  const ask = async (text: string) => {
    if (!text.trim() || busy) return;
    setDraft("");
    setBusy(true);
    setMessages((m) => [...m, { role: "user", text }]);
    try {
      // LLM получает только идентификатор прогона: числа он берёт из
      // инструментов, а не придумывает сам (ТЗ §43).
      const response = await api.chat(text, {
        forecast_id: run?.forecast_id ?? "",
        forecast_origin: run?.forecast_origin ?? "",
        horizon: run?.horizon ?? 48,
      });
      if (response.meta.source === "live") setLiveBaseline(response.meta.latency_ms);
      setMessages((m) => [...m, { role: "ai", text: response.answer.summary, response }]);
    } catch (exc) {
      const msg = exc instanceof ApiError ? exc.message : String(exc);
      setMessages((m) => [...m, { role: "ai", text: `Ошибка: ${msg}` }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Агент прогнозирования</h1>
          <p className="dim">
            Агент проверяет погоду и прогноз. Copilot анализирует выбранный выпуск и вызывает
            расчёт сценария; без API-ключа ответ формируется по проверенным числам.
          </p>
        </div>
        <button className="primary" onClick={onRerun} disabled={loading}>
          {loading ? <span className="spin" /> : "Запустить цикл прогноза"}
        </button>
      </div>

      <div className="grid-2 agent-grid">
        <div>
          <section className="card">
            <div className="card-head">
              <h2>Последний прогон</h2>
              <span className="mono dim">{run?.forecast_id}</span>
            </div>
            <ol className="steps">
              {steps.map((s, i) => (
                <li key={i} className={s.status}>
                  <span className="st">{STATUS_ICON[s.status]}</span>
                  <div className="body">
                    <div>
                      <b>{s.agent}</b> <code>{s.action}()</code>
                    </div>
                    {s.detail && <div className="dim">{s.detail}</div>}
                  </div>
                  <span className="mono dim">{s.duration_ms} мс</span>
                </li>
              ))}
            </ol>
            <div className="hint">Всего {(total / 1000).toFixed(1)} с</div>
          </section>

          <section className="card">
            <h2>Происхождение прогноза</h2>
            <dl className="lineage">
              <dt>forecast_origin</dt>
              <dd>{run ? fmtDayTime(run.forecast_origin) : "—"}</dd>
              <dt>weather issued_at</dt>
              <dd>
                {run ? fmtDayTime(run.weather_run) : "—"}{" "}
                <span className={`pill ${pitOk ? "ok" : "high"}`}>
                  {pitOk ? "≤ origin, утечки нет" : "позже origin!"}
                </span>
              </dd>
              <dt>провайдер</dt>
              <dd>{run?.weather_provider ?? "—"}</dd>
              <dt>модель</dt>
              <dd>{run?.model_version ?? "—"}</dd>
              <dt>горизонт</dt>
              <dd>{run?.horizon ?? "—"} ч, почасово</dd>
            </dl>
          </section>

          {run?.explanation && (
            <section className="card explain">
              <h2>Анализ прогноза</h2>
              <p>{run.explanation}</p>
            </section>
          )}
        </div>

        <section className="card copilot">
          <h2>AI Copilot</h2>
          <div className="messages">
            {messages.length === 0 && (
              <div className="dim">Спросите о прогнозе — агент вызовет нужные инструменты.</div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                {m.response && <MetaBadge meta={m.response.meta} liveBaseline={liveBaseline} />}
                <div>{m.text}</div>
                {m.response?.meta.tools?.length ? <div className="hint">Выполнено: {m.response.meta.tools.join(" → ")}</div> : null}
                {m.response?.answer.sources.map((s) => <div className="hint" key={s.doc_id}>Источник: {s.title} · {s.doc_id}</div>)}
              </div>
            ))}
            {busy && (
              <div className="msg ai">
                <span className="spin" /> агент вызывает инструменты…
              </div>
            )}
          </div>
          <div className="suggest">
            {SUGGESTIONS.map((s) => (
              <button key={s} className="ghost" onClick={() => ask(s)} disabled={busy || !run}>
                {s}
              </button>
            ))}
          </div>
          <form
            className="ask"
            onSubmit={(e) => {
              e.preventDefault();
              ask(draft);
            }}
          >
            <input value={draft} placeholder="Почему прогноз изменился?" onChange={(e) => setDraft(e.target.value)} />
            <button className="primary" type="submit" disabled={busy || !draft.trim()}>
              Спросить
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
