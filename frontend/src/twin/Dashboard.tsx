import { useEffect, useMemo, useState } from "react";
import type { ForecastPoint, ForecastRun } from "../api";
import { ForecastChart, Sparkline } from "./charts";
import { fmtDay, fmtDayTime, ORIGINS, pct } from "./data";
import type { Origin } from "./data";
import { DEMO_TURBINES, parseTs, powerCurve, SITE, solarPower, sunPosition } from "./demo";
import WindMap, { LEGEND_GRADIENT, SPEED_MARKS } from "./WindMap";
import type { Layers } from "./WindMap";

const LAYER_LABELS: [keyof Layers, string][] = [
  ["speed", "Скорость ветра"],
  ["direction", "Направление ветра"],
  ["wake", "Wake-эффект"],
  ["terrain", "Рельеф"],
  ["solar", "СЭС (виртуальная)"],
];

const SCENARIOS: { key: string; label: string; wind: number }[] = [
  { key: "base", label: "Базовый", wind: 0 },
  { key: "calm", label: "Ветер −15%", wind: -15 },
  { key: "strong", label: "Сильный ветер", wind: 15 },
];

interface Props {
  run: ForecastRun | null;
  dataOrigin: Origin;
  loading: boolean;
  originIso: string;
  onOrigin: (iso: string) => void;
  horizon: number;
  onHorizon: (h: number) => void;
  onRerun: () => void;
}

const RUMBS = ["С", "ССВ", "СВ", "ВСВ", "В", "ВЮВ", "ЮВ", "ЮЮВ", "Ю", "ЮЮЗ", "ЮЗ", "ЗЮЗ", "З", "ЗСЗ", "СЗ", "ССЗ"];

/** Румб, как говорят метеорологи: «ветер ЗСЗ» — откуда дует. */
function rumb(deg: number): string {
  return RUMBS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/**
 * Лента барографа под ползунком: сам прогноз, коридор P10–P90 и штормовые
 * часы. Двигая время, видишь, куда идёшь.
 */
function Barograph({ points }: { points: ForecastPoint[] }) {
  const n = points.length;
  if (n < 2) return null;
  const x = (i: number) => (i / (n - 1)) * 100;
  const y = (v: number) => 100 - v * 100;
  const upper = points.map((p, i) => `${x(i)},${y(p.p90)}`).join(" ");
  const lower = [...points].reverse().map((p, k) => `${x(n - 1 - k)},${y(p.p10)}`).join(" ");
  return (
    <svg className="baro" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
      {points.map((p, i) =>
        p.forecast_for.slice(11, 13) === "00" ? (
          <line key={p.forecast_for} x1={x(i)} x2={x(i)} y1={0} y2={100} className="baro-day" />
        ) : null,
      )}
      {points.map((p, i) =>
        p.wind_speed >= 18 ? (
          <rect key={`s${i}`} x={x(i) - 50 / n} width={100 / n} y={0} height={100} className="baro-storm" />
        ) : null,
      )}
      <polygon points={`${upper} ${lower}`} className="baro-band" />
      <polyline points={points.map((p, i) => `${x(i)},${y(p.p50)}`).join(" ")} className="baro-line" />
    </svg>
  );
}

/** Процент для крупных цифр: в Tektur знак % стилизован до нечитаемого,
 *  поэтому он уходит в моноширинную единицу, как «м/с». */
function Big({ value }: { value: number }) {
  return (
    <>
      {Math.round(value * 100)}
      <small>%</small>
    </>
  );
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

export default function Dashboard({
  run,
  dataOrigin,
  loading,
  originIso,
  onOrigin,
  horizon,
  onHorizon,
  onRerun,
}: Props) {
  const points = run?.predictions ?? [];
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [tilt, setTilt] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [layers, setLayers] = useState<Layers>({
    speed: true,
    direction: true,
    wake: true,
    terrain: true,
    solar: false,
  });
  const [show, setShow] = useState({ actual: true, baseline: true, band: true });
  const [windPct, setWindPct] = useState(0);
  // На телефоне панель слоёв закрывала бы карту — там она свёрнута.
  const [compact] = useState(() => window.matchMedia("(max-width: 720px)").matches);

  useEffect(() => setCursor(0), [run?.forecast_id]);

  useEffect(() => {
    if (!playing || !points.length) return;
    const id = window.setInterval(() => {
      setCursor((c) => (c + 1) % points.length);
    }, 450);
    return () => window.clearInterval(id);
  }, [playing, points.length]);

  const point = points[Math.min(cursor, points.length - 1)] ?? null;
  const tMs = point ? parseTs(point.forecast_for) : parseTs(originIso);
  const sun = sunPosition(tMs - SITE.utcOffset * 3_600_000, SITE.lat, SITE.lon);
  const solarNow = solarPower(tMs);

  // What-if пересчитывает P50 через кривую мощности: отношение P(v·k)/P(v)
  // сохраняет поправки модели. Когда появится POST /simulation, сюда
  // придёт ответ Simulation Engine.
  const scenario = useMemo(() => {
    if (!windPct || !run) return null;
    const k = 1 + windPct / 100;
    return run.predictions.map((p) => {
      const base = powerCurve(p.wind_speed);
      const next = powerCurve(p.wind_speed * k);
      return base > 0.005 ? Math.min(1, (p.p50 * next) / base) : next * 0.9;
    });
  }, [windPct, run]);

  const day = points.slice(0, 24);
  const fullLoadHours = sum(day.map((p) => p.p50));
  const scenarioHours = scenario ? sum(scenario.slice(0, 24)) : fullLoadHours;
  const cf = day.length ? fullLoadHours / day.length : 0;
  const avgWind = day.length ? sum(day.map((p) => p.wind_speed)) / day.length : 0;
  const lastSpread = points.length ? points[points.length - 1].p90 - points[points.length - 1].p10 : 0;
  const storm = points.find((p) => p.wind_speed >= 18);
  const turbineIds = DEMO_TURBINES.map((t) => t.id);
  const perTurbine = turbineIds.map((id) => ({
    id,
    hours: sum(day.map((p) => p.per_turbine?.[id] ?? p.p50)),
  }));
  const bestTurbine = Math.max(...perTurbine.map((t) => t.hours), 1e-6);
  const solarDay = points.slice(0, 24).map((p) => solarPower(parseTs(p.forecast_for)));

  return (
    <div className="dash">
      <section className="map-area">
        <WindMap
          point={point}
          turbines={DEMO_TURBINES}
          layers={layers}
          tilt={tilt}
          selected={selected}
          onSelect={(id) => setSelected((s) => (s === id ? null : id))}
          sun={sun}
          solarOutput={solarNow}
        />

        <details className="float left-top panel" open={!compact}>
          <summary>Период и слои</summary>
          <div className="panel-title">Прогноз на</div>
          <div className="seg">
            {[24, 48].map((h) => (
              <button key={h} className={horizon === h ? "on" : ""} onClick={() => onHorizon(h)}>
                {h} часа
              </button>
            ))}
          </div>
          <div className="panel-title">Прогноз от</div>
          <select value={originIso} onChange={(e) => onOrigin(e.target.value)}>
            {ORIGINS.map((o) => (
              <option key={o} value={o}>
                {fmtDay(o)} 2026, 00:00
              </option>
            ))}
          </select>
          <div className="panel-title">Слои карты</div>
          {LAYER_LABELS.map(([key, label]) => (
            <label key={key} className="check">
              <input
                type="checkbox"
                checked={layers[key]}
                onChange={() => setLayers((l) => ({ ...l, [key]: !l[key] }))}
              />
              <span>{label}</span>
            </label>
          ))}
        </details>

        <div className="float right-bottom panel legend">
          <div className="panel-title">Ветер, м/с</div>
          <div className="legend-body">
            <div className="legend-bar" style={{ background: LEGEND_GRADIENT }} />
            <div className="legend-ticks">
              {SPEED_MARKS.map(([v, label]) => (
                <span key={v} style={{ bottom: `${(v / 25) * 100}%` }}>
                  <b>{v}</b> {label}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="float right-top compass-wrap">
          <button className="view-toggle" onClick={() => setTilt((t) => !t)} aria-pressed={!tilt}>
            {tilt ? "Вид сверху" : "Перспектива"}
          </button>
          <div className="compass" role="img" aria-label={point ? `Ветер ${rumb(point.wind_dir)}` : "Ветер"}>
            {["С", "В", "Ю", "З"].map((c, i) => (
              <span key={c} className={`cardinal c${i}`}>
                {c}
              </span>
            ))}
            {point && (
              <div className="needle" style={{ transform: `rotate(${point.wind_dir + 180}deg)` }} />
            )}
            {sun.elevation > 0 && (
              <div className="sun-dot" style={{ transform: `rotate(${sun.azimuth}deg)` }}>
                <i />
              </div>
            )}
          </div>
          {point && (
            <div className="compass-cap">
              {rumb(point.wind_dir)} · {Math.round(point.wind_dir)}°
            </div>
          )}
        </div>

        {dataOrigin === "demo" && (
          <div className="float top-center demo-flag">
            Демо-данные — модель ещё не подключена
          </div>
        )}

        <div className="float bottom-center timeline panel">
          <button
            className="play"
            onClick={() => setPlaying((p) => !p)}
            aria-label={playing ? "Остановить" : "Проиграть прогноз"}
          >
            {playing ? "❚❚" : "▶"}
          </button>
          <div className="track">
            <Barograph points={points} />
            <input
              type="range"
              min={0}
              max={Math.max(0, points.length - 1)}
              value={cursor}
              aria-label="Час прогноза"
              aria-valuetext={point ? fmtDayTime(point.forecast_for) : undefined}
              onChange={(e) => setCursor(Number(e.target.value))}
            />
            <div className="ticks">
              {points
                .filter((_, i) => i % 6 === 5 || i === 0)
                .map((p) => (
                  <span key={p.forecast_for}>{p.forecast_for.slice(11, 16)}</span>
                ))}
            </div>
          </div>
          <div className="now">
            <span className="now-time">{point ? fmtDayTime(point.forecast_for) : "—"}</span>
            <span className="now-h">+{point?.horizon_h ?? 0} ч</span>
          </div>
        </div>
      </section>

      <aside className="side">
        <div className="card kpi">
          <div className="kpi-label">Мощность в этот час <em>P50</em></div>
          <div className="kpi-big">
            {point ? <Big value={point.p50} /> : "—"} <small>от номинала</small>
          </div>
          {point && (
            <div className="kpi-sub">
              интервал P10–P90: {pct(point.p10)} – {pct(point.p90)}
            </div>
          )}
        </div>
        <div className="card kpi row-kpi">
          <div>
            <div className="kpi-label">Выработка <em>0–24 ч</em></div>
            <div className="kpi-mid">
              {fullLoadHours.toFixed(1)} <small>ч на номинале</small>
            </div>
          </div>
          <Sparkline values={day.map((p) => p.p50)} />
        </div>
        <div className="card kpi">
          <div className="kpi-label">Коэффициент использования <em>0–24 ч</em></div>
          <div className="kpi-mid">
            <Big value={cf} />
          </div>
          <div className="meter">
            <i style={{ width: pct(cf) }} />
          </div>
                  </div>
        <div className="card kpi two">
          <div>
            <div className="kpi-label">Ветер <em>0–24 ч</em></div>
            <div className="kpi-mid">
              {avgWind.toFixed(1)} <small>м/с</small>
            </div>
          </div>
          <div>
            <div className="kpi-label">Разброс <em>+{points.length} ч</em></div>
            <div className="kpi-mid">±{((lastSpread * 100) / 2).toFixed(0)} <small>п.п.</small></div>
          </div>
        </div>
        {selected && point && (
          <div className="card kpi turbine-card">
            <div className="kpi-label">
              {selected} · {DEMO_TURBINES.find((t) => t.id === selected)?.name}
            </div>
            <dl>
              <dt>Прогноз мощности</dt>
              <dd>{pct(point.per_turbine?.[selected] ?? point.p50)}</dd>
              <dt>Ветер (прогноз)</dt>
              <dd>{point.wind_speed.toFixed(1)} м/с, {Math.round(point.wind_dir)}°</dd>
              <dt>Температура</dt>
              <dd>{point.temperature.toFixed(1)} °C</dd>
              <dt>Горизонт</dt>
              <dd>+{point.horizon_h} ч</dd>
            </dl>
          </div>
        )}
        {layers.solar && (
          <div className="card kpi solar-card">
            <div className="kpi-label">СЭС (виртуальная) · солнце</div>
            <div className="kpi-mid">
              <Big value={solarNow} />
            </div>
            <div className="kpi-sub">
              высота {sun.elevation.toFixed(0)}°, азимут {sun.azimuth.toFixed(0)}° · ветер + солнце{" "}
              <b>{point ? pct((point.p50 + solarNow) / 2) : "—"}</b>
            </div>
            <Sparkline values={solarDay} color="var(--steppe)" />
          </div>
        )}
        {storm ? (
          <div className="card alert">
            <div className="alert-title">Штормовой ветер</div>
            <div>
              {fmtDayTime(storm.forecast_for)}: ветер до {storm.wind_speed.toFixed(0)} м/с.
              При 25 м/с турбины остановятся по cut-out.
            </div>
            <button className="link" onClick={() => setCursor(points.indexOf(storm))}>
              Перейти к этому часу
            </button>
          </div>
        ) : (
          <div className="card agent-mini">
            <div className="kpi-label">Прогон агента</div>
            <div className="mono">{run?.model_version ?? "—"}</div>
            <div className="kpi-sub">
              погода выпущена {run ? fmtDayTime(run.weather_run) : "—"} · до origin ✓
            </div>
            <button className="link" onClick={onRerun} disabled={loading}>
              {loading ? "Пересчитываем…" : "Пересчитать прогноз"}
            </button>
          </div>
        )}
      </aside>

      <section className="card bottom chart-card">
        <div className="card-head">
          <h2>Прогноз выработки <span className="unit">% номинала</span></h2>
          <div className="toggles">
            <label className="chip p50">
              <i /> P50
            </label>
            <label className="chip band">
              <input
                type="checkbox"
                checked={show.band}
                onChange={() => setShow((s) => ({ ...s, band: !s.band }))}
              />
              P10–P90
            </label>
            <label className="chip baseline">
              <input
                type="checkbox"
                checked={show.baseline}
                onChange={() => setShow((s) => ({ ...s, baseline: !s.baseline }))}
              />
              Persistence
            </label>
            <label className="chip actual">
              <input
                type="checkbox"
                checked={show.actual}
                onChange={() => setShow((s) => ({ ...s, actual: !s.actual }))}
              />
              Факт
            </label>
            {scenario && (
              <label className="chip scenario">
                <i /> Сценарий
              </label>
            )}
          </div>
        </div>
        <ForecastChart points={points} cursor={cursor} onCursor={setCursor} show={show} scenario={scenario} />
      </section>

      <section className="card bottom turb-card">
        <div className="card-head">
          <h2>
            По турбинам <span className="unit">0–24 ч</span>
          </h2>
        </div>
        <div className="bars">
          {perTurbine.map((t) => (
            <button
              key={t.id}
              className={`bar-row ${selected === t.id ? "on" : ""}`}
              onClick={() => setSelected(t.id)}
            >
              <span className="bar-id">{t.id}</span>
              <span className="bar-val">{t.hours.toFixed(1)} ч</span>
              <span className="bar-track">
                <i
                  className={t.hours / bestTurbine < 0.9 ? "low" : ""}
                  style={{ width: `${(t.hours / bestTurbine) * 100}%` }}
                />
              </span>
              <span className="bar-pct">{pct(t.hours / Math.max(1, day.length))}</span>
            </button>
          ))}
        </div>
        {perTurbine.length > 1 && (
          <div className="hint">
            Потери от следа T1 → T2 за 24 ч:{" "}
            <b>
              {(
                (1 - perTurbine[1].hours / Math.max(1e-6, perTurbine[0].hours)) *
                100
              ).toFixed(1)}
              %
            </b>
          </div>
        )}
      </section>

      <section className="card bottom whatif-card">
        <div className="card-head">
          <h2>Что если</h2>
        </div>
        <div className="seg wide">
          {SCENARIOS.map((s) => (
            <button key={s.key} className={windPct === s.wind ? "on" : ""} onClick={() => setWindPct(s.wind)}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="slider-head">
          <span>Изменение скорости ветра</span>
          <b>
            {windPct > 0 ? "+" : ""}
            {windPct}
            <small>%</small>
          </b>
        </div>
        <input
          type="range"
          min={-20}
          max={20}
          value={windPct}
          onChange={(e) => setWindPct(Number(e.target.value))}
        />
        <div className="slider-scale">
          <span>−20%</span>
          <span>+20%</span>
        </div>
        <div className="scenario-out">
          <div>
            <div className="kpi-label">Выработка 0–24 ч по сценарию</div>
            <div className="kpi-mid">
              {scenarioHours.toFixed(1)} <small>ч на номинале</small>
            </div>
          </div>
          <div className={`delta ${!windPct ? "flat" : scenarioHours >= fullLoadHours ? "up" : "down"}`}>
            {!windPct || !fullLoadHours ? (
              "—"
            ) : (
              <>
                {scenarioHours >= fullLoadHours ? "+" : "−"}
                {Math.abs(((scenarioHours - fullLoadHours) / fullLoadHours) * 100).toFixed(0)}
                <small>%</small>
              </>
            )}
          </div>
        </div>
        <div className="hint">
          Мощность растёт как куб скорости ветра, поэтому −15% ветра дают заметно больше −15%
          выработки.
        </div>
      </section>
    </div>
  );
}
