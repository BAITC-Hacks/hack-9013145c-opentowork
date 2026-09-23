import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { ForecastRun, Overview, OverviewStation, Station } from "../api";
import { ForecastChart, Sparkline } from "./charts";
import { fmtDayTime, mw, pct } from "./data";

// Раздел «Прогнозы»: живой прогноз выработки всех ВЭС на реальной погоде.
// Нурлы считается обученной моделью, остальные — ветром Open-Meteo через кривую мощности.

const RUMBS = ["С", "ССВ", "СВ", "ВСВ", "В", "ВЮВ", "ЮВ", "ЮЮВ", "Ю", "ЮЮЗ", "ЮЗ", "ЗЮЗ", "З", "ЗСЗ", "СЗ", "ССЗ"];
const rumb = (deg: number) => RUMBS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

type Sort = "mwh" | "wind" | "cf" | "name";

const METHOD: Record<OverviewStation["method"], { short: string; long: string }> = {
  ml: { short: "ML-модель", long: "обученная модель windcast на истории турбин" },
  curve: { short: "Кривая мощности", long: "ветер Open-Meteo на 100 м → кривая мощности ВЭС Нурлы (доля номинала), без ML" },
};

function num(v: number | null | undefined): number {
  return v ?? 0;
}

export default function Predictions({
  stations,
  onOpen,
}: {
  stations: Station[];
  onOpen: (s: Station) => void;
}) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const [sort, setSort] = useState<Sort>("mwh");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.predictionsOverview(48).then(
      (d) => {
        if (!alive) return;
        setData(d);
        setError(null);
        setLoading(false);
        setSelectedId((cur) => cur ?? d.stations.find((s) => s.method === "ml")?.id ?? d.stations[0]?.id ?? null);
      },
      (e: Error) => {
        if (!alive) return;
        setError(e.message);
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [nonce]);

  const rows = useMemo(() => {
    const list = (data?.stations ?? []).filter((s) =>
      `${s.name} ${s.region}`.toLowerCase().includes(query.trim().toLowerCase()),
    );
    const key: Record<Sort, (s: OverviewStation) => number | string> = {
      mwh: (s) => -num(s.mwh24),
      wind: (s) => -num(s.wind_speed[0]),
      cf: (s) => -num(s.cf24),
      name: (s) => s.name,
    };
    return [...list].sort((a, b) => {
      const ka = key[sort](a);
      const kb = key[sort](b);
      return typeof ka === "number" ? ka - (kb as number) : String(ka).localeCompare(String(kb), "ru");
    });
  }, [data, sort, query]);

  const totals = useMemo(() => {
    const all = data?.stations ?? [];
    const withRated = all.filter((s) => s.rated_mw && s.mwh24 != null);
    const mwh = withRated.reduce((a, s) => a + num(s.mwh24), 0);
    const rated = withRated.reduce((a, s) => a + num(s.rated_mw), 0);
    const windy = [...all].sort((a, b) => num(b.wind_speed[0]) - num(a.wind_speed[0]))[0];
    return { mwh, rated, cf: rated ? mwh / (rated * 24) : 0, windy, n: all.length };
  }, [data]);

  const selected = data?.stations.find((s) => s.id === selectedId) ?? null;
  const selectedStation = stations.find((s) => s.id === selectedId) ?? null;

  return (
    <div className="predictions">
      <div className="pred-head">
        <div>
          <span className="eyebrow">Живой прогноз · реальная погода</span>
          <h1>Прогноз выработки ВЭС на 48 часов</h1>
          <p>
            Считается сейчас по свежим выпускам погодных моделей Open-Meteo.
            {data && <> Момент выпуска — {fmtDayTime(data.origin)} UTC.</>}
          </p>
        </div>
        <button className="refresh-forecast" onClick={() => setNonce((n) => n + 1)} disabled={loading}>
          {loading ? "Считаем…" : "↻ Обновить"}
        </button>
      </div>

      {error && (
        <div className="error">
          Не удалось получить прогноз: {error}. Нужен доступ API к интернету (Open-Meteo).
        </div>
      )}
      {loading && !data && (
        <div className="card pred-loading">
          <span className="spin" /> Запрашиваем погоду по {stations.filter((s) => s.kind === "wind" && s.lat != null).length || ""} станциям и прогоняем модель…
        </div>
      )}

      {data && (
        <>
          <div className="pred-kpis">
            <div className="card">
              <span className="kpi-label">Выработка парка за сутки</span>
              <b>{mw(totals.mwh)}<small>МВт·ч</small></b>
              <span className="kpi-sub">станции с известной мощностью, {mw(totals.rated)} МВт</span>
            </div>
            <div className="card">
              <span className="kpi-label">Средняя загрузка</span>
              <b>{pct(totals.cf)}</b>
              <span className="kpi-sub">КИУМ на ближайшие 24 ч</span>
            </div>
            <div className="card">
              <span className="kpi-label">Сильнее всего дует</span>
              <b className="kpi-text">{totals.windy?.name ?? "—"}</b>
              <span className="kpi-sub">
                {totals.windy?.wind_speed[0] != null ? `${totals.windy.wind_speed[0].toFixed(1)} м/с на 100 м` : ""}
              </span>
            </div>
            <div className="card">
              <span className="kpi-label">Станций в прогнозе</span>
              <b>{totals.n}</b>
              <span className="kpi-sub">все ВЭС справочника с координатами</span>
            </div>
          </div>

          {selected && (
            <SelectedForecast summary={selected} station={selectedStation} onOpen={onOpen} explanation={selected.method === "ml" ? data.ml_explanation : null} />
          )}

          <div className="card pred-table-card">
            <div className="pred-table-head">
              <h2>Все станции</h2>
              <div className="pred-filters">
                <input
                  type="search"
                  placeholder="Станция или область"
                  aria-label="Поиск станции"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <select aria-label="Сортировка" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                  <option value="mwh">по выработке</option>
                  <option value="wind">по ветру сейчас</option>
                  <option value="cf">по загрузке</option>
                  <option value="name">по названию</option>
                </select>
              </div>
            </div>
            <div className="pred-table-wrap">
              <table className="pred-table">
                <thead>
                  <tr>
                    <th>Станция</th>
                    <th>Метод</th>
                    <th className="num">Ветер сейчас</th>
                    <th className="num">Мощность сейчас</th>
                    <th className="num">За 24 ч</th>
                    <th className="num">Загрузка</th>
                    <th>Пик</th>
                    <th>48 ч</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => {
                    const now = s.p50[0];
                    return (
                      <tr
                        key={s.id}
                        className={s.id === selectedId ? "active" : ""}
                        onClick={() => setSelectedId(s.id)}
                        tabIndex={0}
                        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setSelectedId(s.id)}
                        aria-selected={s.id === selectedId}
                      >
                        <td>
                          <b>{s.name}</b>
                          <span className="dim">{s.region}</span>
                        </td>
                        <td>
                          <span className={`method-badge ${s.method}`} title={METHOD[s.method].long}>
                            {METHOD[s.method].short}
                          </span>
                        </td>
                        <td className="num">
                          {s.wind_speed[0] != null ? (
                            <>
                              {s.wind_speed[0].toFixed(1)} <small>м/с</small>{" "}
                              {s.wind_dir[0] != null && <span className="dim">{rumb(s.wind_dir[0])}</span>}
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="num">
                          {now != null && s.rated_mw ? (
                            <>
                              {mw(now * s.rated_mw)} <small>МВт</small>
                            </>
                          ) : now != null ? (
                            pct(now)
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="num">
                          {s.mwh24 != null ? (
                            <>
                              {mw(s.mwh24)} <small>МВт·ч</small>
                            </>
                          ) : (
                            <span className="dim" title="Мощность станции неизвестна">—</span>
                          )}
                        </td>
                        <td className="num">{s.cf24 != null ? pct(s.cf24) : "—"}</td>
                        <td>{s.peak_at ? fmtDayTime(s.peak_at) : "—"}</td>
                        <td>
                          <Sparkline
                            values={s.p50.map((v) => v ?? 0)}
                            color={s.method === "ml" ? "var(--glacier)" : "var(--steppe)"}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="hint">
              ML-модель: {data.sources.ml}. Кривая мощности: {data.sources.curve}. Время — UTC.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

function SelectedForecast({
  summary,
  station,
  onOpen,
  explanation,
}: {
  summary: OverviewStation;
  station: Station | null;
  onOpen: (s: Station) => void;
  explanation: string | null;
}) {
  const [run, setRun] = useState<ForecastRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);

  // Подробный прогноз: для ML — полный прогон агента, для остальных — ансамбль
  // Previous Runs с диапазоном P10–P90 (в сводке у них только P50).
  useEffect(() => {
    if (!station) return;
    let alive = true;
    setRun(null);
    setError(null);
    setCursor(0);
    api.predictRun(station, "now", 48).then(
      (r) => alive && setRun(r),
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [station]);

  const rated = summary.rated_mw ?? undefined;
  const point = run?.predictions[cursor];

  return (
    <div className="card pred-selected">
      <div className="pred-selected-head">
        <div>
          <span className={`method-badge ${summary.method}`}>{METHOD[summary.method].short}</span>
          <h2>{summary.name}</h2>
          <span className="dim">
            {summary.region}
            {rated ? ` · ${mw(rated)} МВт` : " · мощность не опубликована, график в % номинала"}
          </span>
        </div>
        {station && summary.can_open && (
          <button className="primary" onClick={() => onOpen(station)}>
            Открыть станцию →
          </button>
        )}
      </div>
      {!run && !error && (
        <div className="pred-loading">
          <span className="spin" /> {summary.method === "ml" ? "Прогоняем модель на свежей погоде…" : "Собираем ансамбль погодных моделей…"}
        </div>
      )}
      {error && <div className="error">Подробный прогноз недоступен: {error}</div>}
      {run && (
        <>
          <ForecastChart
            points={run.predictions}
            cursor={cursor}
            onCursor={setCursor}
            show={{ actual: false, baseline: false, band: true }}
            rated={rated}
          />
          {point && (
            <div className="pred-point">
              <span>{fmtDayTime(point.forecast_for)} UTC</span>
              <span>
                ветер <b>{point.wind_speed.toFixed(1)} м/с</b> {rumb(point.wind_dir)}
              </span>
              <span>
                мощность <b>{rated ? `${mw(point.p50 * rated)} МВт` : pct(point.p50)}</b>
              </span>
              <span className="dim">
                P10–P90: {rated ? `${mw(point.p10 * rated)}–${mw(point.p90 * rated)} МВт` : `${pct(point.p10)}–${pct(point.p90)}`}
              </span>
              <span className="dim">{point.temperature.toFixed(0)} °C</span>
            </div>
          )}
          {(explanation || run.explanation) && <p className="pred-explain">{run.explanation || explanation}</p>}
          {run.agent_steps && run.agent_steps.length > 0 && (
            <ol className="pred-steps">
              {run.agent_steps.map((s, i) => (
                <li key={i} className={s.status}>
                  <b>{s.agent}</b> {s.action}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
