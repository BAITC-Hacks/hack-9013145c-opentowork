import type { AIAnswer, AIMeta, Stats } from "./api";

const SOURCE_LABEL: Record<AIMeta["source"], string> = {
  live: "Ответ модели",
  exact_cache: "Точный кэш",
  semantic_cache: "Семантический кэш",
  degraded: "Безопасный ответ",
};

function money(value: number): string {
  if (value === 0) return "$0";
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/**
 * Плашка происхождения ответа — то самое, ради чего построен кэш.
 * На демо жюри должно увидеть здесь `Семантический кэш` и падение latency
 * на порядок, не заглядывая в JSON.
 */
export function MetaBadge({ meta, liveBaseline }: { meta: AIMeta; liveBaseline: number | null }) {
  const cached = meta.source === "exact_cache" || meta.source === "semantic_cache";
  const kind = meta.degraded ? "degraded" : cached ? "cache" : "live";
  const speedup =
    cached && liveBaseline && meta.latency_ms > 0
      ? Math.round(liveBaseline / meta.latency_ms)
      : null;

  return (
    <div className={`badge ${kind}`}>
      <span className="tag">{SOURCE_LABEL[meta.source]}</span>
      <span className="item">
        задержка <b>{meta.latency_ms} мс</b>
      </span>
      {speedup && speedup > 1 && (
        <span className="item">
          быстрее в <b>{speedup}×</b> (было {liveBaseline} мс)
        </span>
      )}
      {meta.similarity !== null && (
        <span className="item">
          схожесть <b>{meta.similarity.toFixed(4)}</b>
        </span>
      )}
      {cached && (
        <span className="item">
          сэкономлено <b>{money(meta.saved_usd)}</b>
        </span>
      )}
      {!cached && meta.model && (
        <span className="item">
          модель <b>{meta.model}</b>
        </span>
      )}
      {!cached && meta.retrieved > 0 && (
        <span className="item">
          документов <b>{meta.retrieved}</b>
        </span>
      )}
      {meta.validation_retries > 0 && (
        <span className="item">
          ретраев валидации <b>{meta.validation_retries}</b>
        </span>
      )}
    </div>
  );
}

export function AnswerView({ answer }: { answer: AIAnswer }) {
  return (
    <div>
      <p style={{ margin: "0 0 4px", whiteSpace: "pre-wrap" }}>{answer.summary}</p>
      <div className="hint">
        уверенность {(answer.confidence * 100).toFixed(0)}%
        {answer.needs_expert_review && " · требуется проверка экспертом"}
      </div>

      {answer.possible_causes.length > 0 && (
        <>
          <h3>Возможные причины</h3>
          <ul className="clean">
            {answer.possible_causes.map((cause, i) => (
              <li key={i}>{cause}</li>
            ))}
          </ul>
        </>
      )}

      {answer.recommendations.length > 0 && (
        <>
          <h3>Рекомендации</h3>
          <ul className="clean">
            {answer.recommendations.map((rec, i) => (
              <li key={i}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 3 }}>
                  <b>{rec.title}</b>
                  <span className={`pill ${rec.priority}`}>{rec.priority}</span>
                </div>
                <div className="source">{rec.action}</div>
              </li>
            ))}
          </ul>
        </>
      )}

      {answer.sources.length > 0 && (
        <>
          <h3>Источники</h3>
          <ul className="clean">
            {answer.sources.map((source, i) => (
              <li key={i} className="source">
                {source.title || "без названия"} <code>{source.doc_id.slice(0, 8)}</code>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function StatsPanel({ stats }: { stats: Stats }) {
  const items: [string, string][] = [
    ["Всего запросов", String(stats.total_requests)],
    ["Снято кэшем", `${stats.cache_hits} (${(stats.hit_rate * 100).toFixed(0)}%)`],
    ["Задержка вживую", `${stats.avg_latency_live_ms} мс`],
    ["Задержка из кэша", `${stats.avg_latency_cached_ms} мс`],
    ["Записей в кэше", String(stats.cache_entries)],
    ["Сэкономлено", money(stats.saved_usd_estimate)],
    ["Потрачено", money(stats.spent_usd)],
    ["Degraded-ответов", String(stats.degraded)],
  ];
  return (
    <>
      <div className="grid">
        {items.map(([label, value]) => (
          <div className="metric" key={label}>
            <div className="label">{label}</div>
            <div className="value">{value}</div>
          </div>
        ))}
      </div>
      <div className="hint">{stats.note}</div>
    </>
  );
}
