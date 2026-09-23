import { useState } from "react";
import type { ForecastRun } from "../api";
import { ForecastChart, LineChart } from "./charts";
import { fmtDay, ORIGINS, pct, useBacktest } from "./data";
import type { Origin } from "./data";

const COLORS: Record<string, string> = {
  Persistence: "#93a7a4",
  "Power Curve": "#c8b98a",
  LightGBM: "#7fd4d9",
  Ensemble: "#e6eeec",
};

interface Props {
  run: ForecastRun | null;
  originIso: string;
  onOrigin: (iso: string) => void;
  dataOrigin: Origin;
}

export default function Backtest({ run, originIso, onOrigin, dataOrigin }: Props) {
  const { data, origin } = useBacktest();
  const [cursor, setCursor] = useState(0);
  const points = run?.predictions ?? [];
  const known = points.filter((p) => p.actual != null);
  const runMae = known.length
    ? known.reduce((a, p) => a + Math.abs((p.actual ?? 0) - p.p50), 0) / known.length
    : null;
  const inBand = known.length
    ? known.filter((p) => (p.actual ?? 0) >= p.p10 && (p.actual ?? 0) <= p.p90).length / known.length
    : null;
  const models = data?.metrics.map((m) => m.model) ?? [];
  const best = data?.metrics.find((m) => m.selected);
  const persistence = data?.metrics.find((m) => m.model === "Persistence");

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Бэктест · {data?.period ?? "февраль 2026"}</h1>
          <p className="dim">
            Walk-forward: для каждого дня прогноз строится только по погоде, выпущенной до
            forecast origin. Модель выбрана на валидации (до 31.01.2026), тест не участвует в выборе.
          </p>
        </div>
        {(origin === "demo" || dataOrigin === "demo") && (
          <span className="demo-flag inline">Демо-данные — заменятся результатами бэктеста</span>
        )}
      </div>

      <div className="grid-2">
        <section className="card">
          <h2>Сравнение моделей</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Модель</th>
                <th>MAE</th>
                <th>RMSE</th>
                <th>vs persistence</th>
              </tr>
            </thead>
            <tbody>
              {data?.metrics.map((m) => (
                <tr key={m.model} className={m.selected ? "selected" : ""}>
                  <td>
                    <i className="dot-c" style={{ background: COLORS[m.model] ?? "#aaa" }} />
                    {m.model}
                    {m.selected && <span className="pill ok">выбрана</span>}
                  </td>
                  <td className="mono">{pct(m.mae, 1)}</td>
                  <td className="mono">{pct(m.rmse, 1)}</td>
                  <td className="mono">
                    {persistence && m.model !== "Persistence"
                      ? `${(((m.mae - persistence.mae) / persistence.mae) * 100).toFixed(0)}%`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="hint">MAE и RMSE — в процентах номинальной мощности (nMAE / nRMSE).</div>
        </section>

        <section className="card">
          <h2>Ошибка по горизонту</h2>
          {data && (
            <LineChart
              labels={data.by_horizon.map((h) => `+${h.horizon_h}`)}
              series={[
                {
                  name: `MAE ${best?.model ?? "модели"}`,
                  color: "#7fd4d9",
                  values: data.by_horizon.map((h) => h.mae),
                },
              ]}
              unit={(v) => pct(v)}
              height={200}
            />
          )}
          <div className="hint">Чем дальше горизонт, тем выше ошибка — поэтому интервал P10–P90 расширяется.</div>
        </section>
      </div>

      <section className="card">
        <h2>MAE по дням теста</h2>
        {data && (
          <LineChart
            labels={data.daily.map((d) => fmtDay(d.date))}
            series={models.map((m) => ({
              name: m,
              color: COLORS[m] ?? "#aaa",
              values: data.daily.map((d) => d.mae[m] ?? 0),
              dashed: m === "Persistence",
            }))}
            unit={(v) => pct(v)}
          />
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Прогноз против факта</h2>
          <div className="day-chips">
            {ORIGINS.map((o) => (
              <button key={o} className={o === originIso ? "on" : ""} onClick={() => onOrigin(o)}>
                {fmtDay(o)}
              </button>
            ))}
          </div>
        </div>
        <div className="stat-row">
          <span>
            origin <b>{fmtDay(originIso)} 00:00</b>
          </span>
          <span>
            погода выпущена <b>{run ? `${fmtDay(run.weather_run)} ${run.weather_run.slice(11, 16)}` : "—"}</b>
          </span>
          <span>
            MAE прогона <b>{runMae != null ? pct(runMae, 1) : "—"}</b>
          </span>
          <span>
            факт внутри P10–P90 <b>{inBand != null ? pct(inBand) : "—"}</b>
          </span>
        </div>
        <ForecastChart
          points={points}
          cursor={cursor}
          onCursor={setCursor}
          show={{ actual: true, baseline: true, band: true }}
          height={260}
        />
      </section>
    </div>
  );
}
