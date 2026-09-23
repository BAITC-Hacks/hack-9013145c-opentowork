import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { ExplainHour, Explanation, GlobalExplanation, Station } from "../api";
import "./explain.css";

// Страница «Почему прогноз такой». Все числа — из /explain: разбор каскада по шагам и
// вклады групп признаков (TreeSHAP из LightGBM). Фронтенд ничего не досчитывает,
// кроме перевода долей номинала в МВт.

interface Props {
  station: Station | null;
  stationId: string;
  origin: string;
  rated: number; // МВт станции — только для подписи в МВт
  onBack: () => void;
}

const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`;
const signed = (x: number, d = 2) => `${x > 0 ? "+" : x < 0 ? "−" : "±"}${Math.abs(x).toFixed(d)}`;

export default function Explain({ station, stationId, origin, rated, onBack }: Props) {
  const [doc, setDoc] = useState<Explanation | null>(null);
  const [glob, setGlob] = useState<GlobalExplanation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    setDoc(null);
    setError(null);
    api
      .explain(stationId, origin)
      .then((d) => alive && setDoc(d))
      .catch((e: Error) => alive && setError(e.message || "не удалось получить объяснение"));
    api
      .explainGlobal()
      .then((g) => alive && setGlob(g))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [stationId, origin]);

  // По умолчанию — час, где модель сильнее всего разошлась с сырым прогнозом погоды.
  const defaultHour = useMemo(() => {
    if (!doc) return 0;
    let best = 0;
    doc.hours.forEach((h, i) => {
      const d = Math.abs(h.steps[3].power - h.steps[0].power);
      if (d > Math.abs(doc.hours[best].steps[3].power - doc.hours[best].steps[0].power)) best = i;
    });
    return best;
  }, [doc]);
  const idx = sel ?? defaultHour;
  const hour = doc?.hours[idx];

  return (
    <div className="explain">
      <div className="explain-head">
        <button className="ghost" onClick={onBack}>
          ← К прогнозу
        </button>
        <div>
          <span className="eyebrow">Интерпретация модели</span>
          <h1>Почему прогноз такой</h1>
          <p className="explain-sub">
            {station?.name ?? stationId} · прогноз от {origin.slice(8, 10)}.{origin.slice(5, 7)} {origin.slice(11, 16)} UTC
            {doc?.live && <span className="tag">считается на лету</span>}
          </p>
        </div>
      </div>

      {error && (
        <div className="card explain-error">
          Объяснение недоступно: {error}. Оно есть для станции с обученной моделью — для прогнозов
          тестового периода и живого прогноза.
        </div>
      )}
      {!doc && !error && <div className="card explain-loading">Считаем вклады факторов…</div>}

      {doc && hour && (
        <>
          <section className="card explain-summary">
            <h2>Коротко</h2>
            <p>{doc.summary}</p>
            {doc.revision?.summary && (
              <p className="explain-rev-line">
                <b>Что изменилось с прошлой версии:</b> {doc.revision.summary}
              </p>
            )}
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Выберите час</h2>
              <span className="hint">столбик — итоговый прогноз, точка — сырой прогноз погоды через кривую</span>
            </div>
            <HourStrip hours={doc.hours} selected={idx} onSelect={setSel} />
          </section>

          <div className="explain-grid">
            <section className="card">
              <h2>
                Как получилось число · <span className="accent">{hour.local}</span>
              </h2>
              <Waterfall hour={hour} rated={rated} />
            </section>

            <section className="card">
              <h2>Почему модель поправила ветер</h2>
              <Contributions hour={hour} />
            </section>
          </div>

          <div className="explain-grid">
            <section className="card">
              <h2>Погодные модели в этот час</h2>
              <ModelsHour hour={hour} />
            </section>
            <section className="card">
              <h2>Главные факторы за весь прогноз</h2>
              <Overall doc={doc} />
            </section>
          </div>

          {doc.versions && doc.versions.some((v) => v.revision) && (
            <section className="card">
              <h2>Почему менялся прогноз в течение суток</h2>
              <Revisions doc={doc} rated={rated} />
            </section>
          )}
        </>
      )}

      {glob && (
        <section className="card">
          <h2>Модель в целом</h2>
          <p className="hint">Обучена на данных до {glob.trained_until.slice(0, 10)}; эти свойства одинаковы для всех прогнозов.</p>
          <div className="explain-grid three">
            <div>
              <h3>Кривая мощности (выучена на истории турбин)</h3>
              <PowerCurve glob={glob} />
              <p className="hint">Монотонна по ветру — ограничение модели, а не совпадение. Зимой плотный воздух даёт больше мощности при том же ветре.</p>
            </div>
            <div>
              <h3>На что опирается поправка ветра</h3>
              <Bars rows={glob.importance_wind_correction.slice(0, 7).map((r) => ({ label: r.label, value: r.share }))} fmt={(v) => pct(v)} />
            </div>
            <div>
              <h3>Насколько точна каждая погодная модель здесь</h3>
              <table className="explain-table">
                <thead>
                  <tr>
                    <th>Модель</th>
                    <th>Корреляция</th>
                    <th>Ошибка, м/с</th>
                    <th>Смещение</th>
                  </tr>
                </thead>
                <tbody>
                  {glob.weather_models.map((m) => (
                    <tr key={m.model} className={m.model.startsWith("Ансамбль") ? "best" : ""}>
                      <td>{m.model}</td>
                      <td>{m.corr.toFixed(2)}</td>
                      <td>{m.mae_ms.toFixed(2)}</td>
                      <td>{signed(m.bias_ms, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {glob.calibration.cov80 != null && (
                <p className="hint">
                  Интервал P10–P90 на бэктесте накрыл {pct(glob.calibration.cov80, 1)} фактов (цель 80%), P5–P95 —{" "}
                  {pct(glob.calibration.cov90 ?? 0, 1)} (цель 90%).
                </p>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function HourStrip({ hours, selected, onSelect }: { hours: ExplainHour[]; selected: number; onSelect: (i: number) => void }) {
  const w = 960;
  const h = 120;
  const bw = w / hours.length;
  return (
    <svg className="hour-strip" viewBox={`0 0 ${w} ${h + 22}`} role="list" aria-label="Часы прогноза">
      {hours.map((hr, i) => {
        const v = hr.steps[3].power;
        const raw = hr.steps[0].power;
        const x = i * bw;
        return (
          <g key={hr.time} role="listitem" className={i === selected ? "sel" : ""} onClick={() => onSelect(i)}>
            <title>{`${hr.local}: прогноз ${pct(v)}, сырой ${pct(raw)}`}</title>
            <rect className="hit" x={x} y={0} width={bw} height={h + 22} />
            <rect className="bar" x={x + 2} y={h - v * h} width={bw - 4} height={Math.max(1, v * h)} rx={2} />
            <circle className="raw" cx={x + bw / 2} cy={h - raw * h} r={2.6} />
            {i % 6 === 0 && (
              <text x={x + 2} y={h + 16}>
                {hr.local.slice(6)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function Waterfall({ hour, rated }: { hour: ExplainHour; rated: number }) {
  const max = Math.max(0.05, ...hour.steps.map((s) => s.power), hour.interval[1]);
  return (
    <div className="waterfall">
      {hour.steps.map((s, i) => {
        const prev = i > 0 ? hour.steps[i - 1].power : null;
        const d = prev == null ? null : s.power - prev;
        return (
          <div key={s.key} className={`wf-row ${s.key}`}>
            <div className="wf-label">
              <span className="wf-n">{i + 1}</span>
              {s.label}
              {s.wind != null && <span className="wf-wind">ветер {s.wind.toFixed(1)} м/с</span>}
            </div>
            <div className="wf-track">
              <div className="wf-bar" style={{ width: `${(s.power / max) * 100}%` }} />
              {s.key === "final" && (
                <div
                  className="wf-band"
                  style={{ left: `${(hour.interval[0] / max) * 100}%`, width: `${((hour.interval[1] - hour.interval[0]) / max) * 100}%` }}
                  title="Интервал P10–P90"
                />
              )}
            </div>
            <div className="wf-val">
              <b>{pct(s.power)}</b> <span>{(s.power * rated).toFixed(2)} МВт</span>
              {d != null && <span className={`wf-d ${d >= 0 ? "up" : "down"}`}>{signed(d * 100, 0)} п.п.</span>}
            </div>
          </div>
        );
      })}
      <p className="hint">
        Интервал P10–P90: {pct(hour.interval[0])}–{pct(hour.interval[1])}. Прямая модель без каскада дала бы {pct(hour.direct_p50)}.
        Среднее ожидание (не медиана) по Монте-Карло — {pct(hour.cascade_mean)}: из-за нелинейной кривой оно отличается от медианы.
      </p>
    </div>
  );
}

function Contributions({ hour }: { hour: ExplainHour }) {
  const rows = hour.groups.filter((g) => Math.abs(g.wind_ms) >= 0.02).slice(0, 8);
  const max = Math.max(0.1, ...rows.map((g) => Math.abs(g.wind_ms)));
  return (
    <div className="contrib">
      <p className="contrib-base">
        Типичная поправка по обучению — <b>{hour.wind.base.toFixed(2)} м/с</b>. Для этого часа модель выдала{" "}
        <b>{hour.wind.corrected.toFixed(2)} м/с</b> (сырой ансамбль {hour.wind.raw.toFixed(2)} м/с). Разница складывается из вкладов:
      </p>
      {rows.map((g) => (
        <div key={g.group} className="contrib-row">
          <span className="contrib-label">{g.label}</span>
          <div className="contrib-track">
            <div
              className={`contrib-bar ${g.wind_ms >= 0 ? "pos" : "neg"}`}
              style={{
                width: `${(Math.abs(g.wind_ms) / max) * 50}%`,
                left: g.wind_ms >= 0 ? "50%" : `${50 - (Math.abs(g.wind_ms) / max) * 50}%`,
              }}
            />
          </div>
          <span className="contrib-val">
            {signed(g.wind_ms)} м/с <small>≈ {signed(g.power_via_wind * 100, 1)} п.п.</small>
          </span>
        </div>
      ))}
      <p className="hint">
        TreeSHAP: вклады точные и складываются — база плюс сумма вкладов даёт поправленный ветер.
        «п.п.» — тот же вклад, переведённый в мощность через наклон кривой в этой точке.
      </p>
    </div>
  );
}

function ModelsHour({ hour }: { hour: ExplainHour }) {
  const entries = Object.entries(hour.wind.by_model);
  const vals = entries.map(([, v]) => v ?? 0);
  const max = Math.max(1, ...vals, hour.wind.corrected, hour.wind.p90);
  return (
    <div className="models-hour">
      {entries.map(([m, v]) => (
        <div key={m} className="mh-row">
          <span>{m}</span>
          <div className="mh-track">{v != null && <div className="mh-bar" style={{ width: `${(v / max) * 100}%` }} />}</div>
          <b>{v == null ? "нет данных" : `${v.toFixed(1)} м/с`}</b>
        </div>
      ))}
      <div className="mh-row ens">
        <span>Ансамбль (среднее)</span>
        <div className="mh-track">
          <div className="mh-bar" style={{ width: `${(hour.wind.raw / max) * 100}%` }} />
        </div>
        <b>{hour.wind.raw.toFixed(1)} м/с</b>
      </div>
      <div className="mh-row corr">
        <span>После поправки под площадку</span>
        <div className="mh-track">
          <div className="mh-band" style={{ left: `${(hour.wind.p10 / max) * 100}%`, width: `${((hour.wind.p90 - hour.wind.p10) / max) * 100}%` }} />
          <div className="mh-mark" style={{ left: `${(hour.wind.corrected / max) * 100}%` }} />
        </div>
        <b>{hour.wind.corrected.toFixed(1)} м/с</b>
      </div>
      <p className="hint">
        Разброс между моделями {hour.wind.spread.toFixed(1)} м/с
        {hour.wind.spread > 2.5 ? " — модели сильно расходятся, уверенность ниже." : "."} Серая полоса — ветер P10–P90 после поправки.
      </p>
    </div>
  );
}

function Overall({ doc }: { doc: Explanation }) {
  return (
    <>
      <Bars rows={doc.overall.filter((o) => o.mean_abs_wind_ms >= 0.02).slice(0, 7).map((o) => ({ label: o.label, value: o.mean_abs_wind_ms }))} fmt={(v) => `±${v.toFixed(2)} м/с`} />
      <p className="hint">Средний модуль вклада в поправку ветра за {doc.hours.length} ч прогноза.</p>
    </>
  );
}

function Bars({ rows, fmt }: { rows: { label: string; value: number }[]; fmt: (v: number) => string }) {
  const max = Math.max(1e-6, ...rows.map((r) => r.value));
  return (
    <div className="bars">
      {rows.map((r) => (
        <div key={r.label} className="bars-row">
          <span>{r.label}</span>
          <div className="bars-track">
            <div className="bars-bar" style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
          <b>{fmt(r.value)}</b>
        </div>
      ))}
    </div>
  );
}

function Revisions({ doc, rated }: { doc: Explanation; rated: number }) {
  return (
    <div className="revisions">
      {doc.versions!
        .filter((v) => v.revision)
        .map((v) => (
          <div key={v.origin} className="rev">
            <div className="rev-head">
              Версия {v.origin.slice(11, 16)} UTC <span className={`tag ${v.published ? "" : "muted"}`}>{v.published ? "опубликована" : "не опубликована — сдвиг мал"}</span>
            </div>
            <p>{v.revision!.summary}</p>
            <ul>
              {v.revision!.hours.slice(0, 3).map((h) => (
                <li key={h.time}>
                  {h.local}: {pct(h.was)} → {pct(h.now)} ({signed(h.delta_power * rated, 2)} МВт); ветер {signed(h.raw_wind_change, 1)} м/с
                  {h.group_changes[0] && <> · главный сдвиг — {h.group_changes[0].label.toLowerCase()} ({signed(h.group_changes[0].delta_wind_ms)} м/с)</>}
                </li>
              ))}
            </ul>
          </div>
        ))}
    </div>
  );
}

function PowerCurve({ glob }: { glob: GlobalExplanation }) {
  const w = 320;
  const h = 170;
  const ws = glob.power_curve.ws;
  const xs = (v: number) => (v / ws[ws.length - 1]) * (w - 30) + 26;
  const ys = (p: number) => h - 18 - p * (h - 28);
  const colors = ["curve-a", "curve-b"];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="power-curve" aria-label="Кривая мощности">
      {[0, 0.5, 1].map((p) => (
        <g key={p}>
          <line x1={26} x2={w - 4} y1={ys(p)} y2={ys(p)} className="grid" />
          <text x={2} y={ys(p) + 4}>{pct(p)}</text>
        </g>
      ))}
      {[0, 5, 10, 15, 20, 25].map((v) => (
        <text key={v} x={xs(v) - 4} y={h - 2}>
          {v}
        </text>
      ))}
      {Object.entries(glob.power_curve.curves).map(([label, ys_], i) => (
        <g key={label}>
          <polyline className={colors[i % 2]} points={ys_.map((p, j) => `${xs(ws[j])},${ys(p)}`).join(" ")} />
          <text className={`legend ${colors[i % 2]}`} x={w - 110} y={ys(0.2) - i * 14}>
            {label}
          </text>
        </g>
      ))}
    </svg>
  );
}
