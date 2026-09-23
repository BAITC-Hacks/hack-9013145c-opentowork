import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { ForecastPoint, ForecastRun, Station } from "../api";
import { ForecastChart, Sparkline } from "./charts";
import { fmtDayTime, LIVE_ORIGIN, mw, originLabel, stationRated, STATION_ORIGINS, useStationWind } from "./data";
import type { Origin } from "./data";
import { parseTs, powerCurve, RATED_ASSUMPTION_MW, SITE, solarPower, sunPosition } from "./demo";
import UnitPanel from "./UnitPanel";
import { LoadingOverlay } from "./Loading";
import WindPanel from "./WindPanel";
import WindMap, { LEGEND_GRADIENT, SPEED_MARKS } from "./WindMap";
import type { Layers } from "./WindMap";

const METHOD_LABEL: Record<string, string> = {
  ml: "ML-модель windcast, погода Open-Meteo",
  curve: "Ветер Open-Meteo → кривая мощности",
  solar: "Радиация Open-Meteo → модель панелей",
  saved: "Сохранённый прогон агента",
};

const WIND_LAYERS: [keyof Layers, string][] = [
  ["speed", "Сила ветра"],
  ["direction", "Направление ветра"],
  ["wake", "Тень от турбин"],
  ["terrain", "Детали поверхности"],
  ["solar", "Солнечная станция рядом"],
];
const SOLAR_LAYERS: [keyof Layers, string][] = [["terrain", "Детали поверхности"]];

const RUMBS = ["С", "ССВ", "СВ", "ВСВ", "В", "ВЮВ", "ЮВ", "ЮЮВ", "Ю", "ЮЮЗ", "ЮЗ", "ЗЮЗ", "З", "ЗСЗ", "СЗ", "ССЗ"];

/** Румб, как говорят метеорологи: «ветер ЗСЗ» — откуда дует. */
function rumb(deg: number): string {
  return RUMBS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/**
 * Лента барографа под ползунком: сам прогноз, коридор P10–P90 и штормовые
 * часы. Двигая время, видишь, куда идёшь.
 */
function Barograph({ points, storms }: { points: ForecastPoint[]; storms: boolean }) {
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
      {storms &&
        points.map((p, i) =>
          p.wind_speed >= 18 ? (
            <rect key={`s${i}`} x={x(i) - 50 / n} width={100 / n} y={0} height={100} className="baro-storm" />
          ) : null,
        )}
      <polygon points={`${upper} ${lower}`} className="baro-band" />
      <polyline points={points.map((p, i) => `${x(i)},${y(p.p50)}`).join(" ")} className="baro-line" />
    </svg>
  );
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

interface Props {
  station: Station;
  run: ForecastRun | null;
  dataOrigin: Origin;
  loading: boolean;
  originIso: string;
  onOrigin: (iso: string) => void;
  horizon: number;
  onHorizon: (h: number) => void;
  onRerun: () => void;
  /** Есть только у станции с обученной моделью: открывает страницу «Почему такой прогноз». */
  onExplain?: () => void;
}

export default function StationView({
  station,
  run,
  dataOrigin,
  loading,
  originIso,
  onOrigin,
  horizon,
  onHorizon,
  onRerun,
  onExplain,
}: Props) {
  const wind = station.kind === "wind";
  const units = station.units;
  const rated = stationRated(station) || units.length * RATED_ASSUMPTION_MW;
  const points = run?.predictions ?? [];
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [tilt, setTilt] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [layers, setLayers] = useState<Layers>({
    speed: wind,
    direction: wind,
    wake: wind,
    terrain: true,
    solar: false,
  });
  const [show, setShow] = useState({ actual: true, baseline: false, band: true });
  const [change, setChange] = useState(0);
  const [remoteScenario, setRemoteScenario] = useState<{ key: string; values: number[] | null; error: boolean }>({ key: "", values: null, error: false });
  const scenarioKey = `${run?.forecast_id}:${horizon}:${change}`;
  const serverScenario = wind && dataOrigin === "api";
  useEffect(() => {
    if (!serverScenario || !change || !run) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      api.simulate(run.forecast_id, change, horizon).then((result) => {
        if (alive) setRemoteScenario({ key: scenarioKey, values: result.points.map((p) => p.p50), error: false });
      }).catch(() => {
        if (alive) setRemoteScenario({ key: scenarioKey, values: null, error: true });
      });
    }, 180);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [run, change, horizon, serverScenario, scenarioKey]);
  const scenarioPending = serverScenario && change !== 0 && remoteScenario.key !== scenarioKey;
  const scenarioFailed = serverScenario && change !== 0 && remoteScenario.key === scenarioKey && remoteScenario.error;
  // На телефоне панель слоёв закрывала бы карту — там она свёрнута.
  const [compact] = useState(() => window.matchMedia("(max-width: 720px)").matches);

  const sideRef = useRef<HTMLElement>(null);

  useEffect(() => setCursor(0), [run?.forecast_id]);

  // На телефоне панель агрегата — под картой; при выборе из списка внизу
  // её не видно, поэтому прокручиваем к ней.
  useEffect(() => {
    if (selected && compact) sideRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selected, compact]);

  useEffect(() => {
    if (!playing || !points.length) return;
    const id = window.setInterval(() => setCursor((c) => (c + 1) % points.length), 450);
    return () => window.clearInterval(id);
  }, [playing, points.length]);

  const point = points[Math.min(cursor, points.length - 1)] ?? null;
  const stationWind = useStationWind(station, originIso, horizon);
  const tMs = point ? parseTs(point.forecast_for) : parseTs(originIso);
  const sun = sunPosition(tMs - SITE.utcOffset * 3_600_000, station.lat ?? SITE.lat, station.lon ?? SITE.lon);
  // У СЭС освещённость панелей в сцене — её же прогноз; у ВЭС соседняя СЭС условная.
  const solarNow = wind ? solarPower(tMs) : (point?.p50 ?? 0);

  // Для ВЭС API и Copilot используют один серверный расчёт сценария.
  const scenario = useMemo(() => {
    if (!change || !run) return null;
    if (serverScenario) return remoteScenario.key === scenarioKey ? remoteScenario.values : null;
    const k = 1 + change / 100;
    return run.predictions.map((p) => {
      if (wind) {
        const base = powerCurve(p.wind_speed);
        const next = powerCurve(p.wind_speed * k);
        return base > 0.005 ? Math.min(1, (p.p50 * next) / base) : next * 0.9;
      }
      // Прогноз уже учитывает радиацию; сценарий меняет только облачность.
      const cloud = p.cloud_cover ?? 0.5;
      const clearSky = (c: number) => 1 - 0.72 * c ** 2.2;
      return Math.min(1, (p.p50 * clearSky(Math.min(1, cloud * k))) / clearSky(cloud));
    });
  }, [change, run, wind, serverScenario, remoteScenario, scenarioKey]);

  const day = points.slice(0, 24);
  const energy24 = sum(day.map((p) => p.p50)) * rated;
  const scenario24 = scenario ? sum(scenario.slice(0, 24)) * rated : energy24;
  const load = day.length ? sum(day.map((p) => p.p50)) / day.length : 0;
  const avgWind = day.length ? sum(day.map((p) => p.wind_speed)) / day.length : 0;
  const avgCloud = day.length ? sum(day.map((p) => p.cloud_cover ?? 0)) / day.length : 0;
  // Наибольший разброс за последние сутки горизонта: у СЭС последний час
  // может прийтись на ночь, где разброс нулевой и ничего не говорит.
  const spreadMw = Math.max(0, ...points.map((p) => p.p90 - p.p10)) * rated;
  const storm = wind ? points.find((p) => p.wind_speed >= 18) : undefined;
  const perUnit = units.map((u) => ({
    unit: u,
    now: (point?.per_turbine?.[u.id] ?? point?.p50 ?? 0) * (u.rated_mw ?? RATED_ASSUMPTION_MW),
    day: sum(day.map((p) => p.per_turbine?.[u.id] ?? p.p50)) * (u.rated_mw ?? RATED_ASSUMPTION_MW),
  }));
  const bestUnit = Math.max(...perUnit.map((u) => u.day), 1e-6);
  const labels = Object.fromEntries(
    perUnit.map(({ unit, now }) => [
      unit.id,
      {
        main: `${mw(now)} МВт`,
        sub: wind && point ? `${point.wind_speed.toFixed(1)} м/с` : unit.name,
      },
    ]),
  );
  const selectedUnit = units.find((u) => u.id === selected) ?? null;

  return (
    <div className={`dash loading-host ${wind ? "wind-dashboard" : "solar-dashboard"}`} aria-busy={loading}>
      <LoadingOverlay
        tall
        show={loading}
        label={run ? "Пересчитываем прогноз…" : "Загружаем прогноз станции…"}
        sub={
          originIso === LIVE_ORIGIN || station.data !== "history"
            ? "Запрашиваем погоду Open-Meteo и считаем мощность по часам"
            : "Берём сохранённый прогон агента за выбранную дату"
        }
      />
      <div className="dashboard-toolbar">
        <div className="scene-section-title"><span className={`source-indicator ${wind ? "wind" : "solar"}`} /><b>Цифровой двойник</b><span>3D-обзор территории</span></div>
        <div className="forecast-controls">
          <label htmlFor="forecast-date">Дата прогноза</label>
          <select id="forecast-date" value={originIso} onChange={(e) => onOrigin(e.target.value)}>
            {STATION_ORIGINS.map((o) => <option key={o} value={o}>{originLabel(o)}</option>)}
          </select>
          <div className="seg" aria-label="Горизонт прогноза">
            {[24, 48].map((h) => <button key={h} className={horizon === h ? "on" : ""} aria-pressed={horizon === h} onClick={() => onHorizon(h)}>{h} ч</button>)}
          </div>
          <button className="refresh-forecast" onClick={onRerun} disabled={loading}>{loading ? "Обновляем…" : "↻ Обновить"}</button>
        </div>
      </div>
      <section className="map-area">
        <WindMap
          point={point}
          kind={station.kind}
          units={units}
          labels={labels}
          layers={layers}
          tilt={tilt}
          selected={selected}
          onSelect={setSelected}
          sun={sun}
          solarOutput={solarNow}
        />

        <details className="float left-top panel">
          <summary>Слои сцены</summary>
          <div className="panel-title">Отображение</div>
          {(wind ? WIND_LAYERS : SOLAR_LAYERS).map(([key, label]) => (
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

        {wind && layers.speed && (
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
        )}

        <div className="float right-top compass-wrap">
          <button className="view-toggle" onClick={() => setTilt((t) => !t)} aria-pressed={!tilt}>
            {tilt ? "Вид сверху" : "Перспектива"}
          </button>
          <div
            className="compass"
            role="img"
            aria-label={wind && point ? `Ветер ${rumb(point.wind_dir)}` : `Солнце: азимут ${Math.round(sun.azimuth)}°`}
          >
            {["С", "В", "Ю", "З"].map((c, i) => (
              <span key={c} className={`cardinal c${i}`}>
                {c}
              </span>
            ))}
            {wind && point && (
              <div className="needle" style={{ transform: `rotate(${point.wind_dir + 180}deg)` }} />
            )}
            {sun.elevation > 0 && (
              <div className="sun-dot" style={{ transform: `rotate(${sun.azimuth}deg)` }}>
                <i />
              </div>
            )}
          </div>
          <div className="compass-cap">
            {wind && point
              ? `${rumb(point.wind_dir)} · ${Math.round(point.wind_dir)}°`
              : sun.elevation > 0
                ? `солнце ${Math.round(sun.elevation)}°`
                : "ночь"}
          </div>
        </div>

        {dataOrigin === "demo" && (
          <div className="float top-center demo-flag">Демонстрационный прогноз</div>
        )}
        {dataOrigin === "api" && run?.method === "curve" && (
          <div className="float top-center demo-flag curve-flag">Реальная погода · кривая мощности, без ML</div>
        )}

        {!selected && (
          <div className="float map-hint">
            Вращайте сцену мышью · Колесо — масштаб · Нажмите на {wind ? "турбину" : "блок панелей"}
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
            <Barograph points={points} storms={wind} />
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
          <div className="tl-now">
            <span className="now-time">{point ? fmtDayTime(point.forecast_for) : "—"}</span>
            <span className="now-h">+{point?.horizon_h ?? 0} ч</span>
          </div>
        </div>
      </section>

      <aside className="side" ref={sideRef}>
        {selectedUnit ? (
          <div className="card">
            <UnitPanel
              station={station}
              unit={selectedUnit}
              points={points}
              cursor={cursor}
              originIso={originIso}
              onClose={() => setSelected(null)}
            />
          </div>
        ) : (
          <>
            <div className="card kpi">
              <div className="kpi-label">
                Мощность станции <em>{point ? fmtDayTime(point.forecast_for) : "—"}</em>
              </div>
              <div className="kpi-big">
                {point ? mw(point.p50 * rated) : "—"}
                <small>МВт из {mw(rated)}</small>
              </div>
              {point && (
                <div className="kpi-sub">
                  вероятно от <b>{mw(point.p10 * rated)}</b> до <b>{mw(point.p90 * rated)}</b> МВт
                </div>
              )}
            </div>
            <div className="card kpi row-kpi">
              <div>
                <div className="kpi-label">
                  Выработает <em>за сутки</em>
                </div>
                <div className="kpi-mid">
                  {mw(energy24)}
                  <small>МВт·ч</small>
                </div>
              </div>
              <Sparkline values={day.map((p) => p.p50)} />
            </div>
            <div className="card kpi">
              <div className="kpi-label">
                Загрузка станции <em>за сутки</em>
              </div>
              <div className="kpi-mid">
                {Math.round(load * 100)}
                <small>%</small>
              </div>
              <div className="meter">
                <i style={{ width: `${load * 100}%` }} />
              </div>
            </div>
            <div className="card kpi two">
              <div>
                <div className="kpi-label">{wind ? "Средний ветер" : "Облачность"}</div>
                <div className="kpi-mid">
                  {wind ? avgWind.toFixed(1) : Math.round(avgCloud * 100)}
                  <small>{wind ? "м/с" : "%"}</small>
                </div>
              </div>
              <div>
                <div className="kpi-label">Макс. ширина P10–P90</div>
                <div className="kpi-mid">
                  {mw(spreadMw)}
                  <small>МВт</small>
                </div>
              </div>
            </div>
            {storm ? (
              <div className="card alert">
                <div className="alert-title">Штормовой ветер</div>
                <div>
                  {fmtDayTime(storm.forecast_for)}: ветер до {storm.wind_speed.toFixed(0)} м/с. При 25 м/с
                  турбины остановятся ради безопасности.
                </div>
                <button className="link" onClick={() => setCursor(points.indexOf(storm))}>
                  Перейти к этому часу
                </button>
              </div>
            ) : (
              <div className="card agent-mini">
                <div className="kpi-label">Прогноз обновлён</div>
                <div className="kpi-sub" style={{ marginTop: 0 }}>
                  по погоде от {run ? fmtDayTime(run.weather_run) : "—"}
                </div>
                {run && <div className="kpi-sub method-line">{METHOD_LABEL[run.method ?? "saved"]}</div>}
                <button className="link" onClick={onRerun} disabled={loading}>
                  {loading ? "Пересчитываем…" : "Пересчитать прогноз"}
                </button>
              </div>
            )}
          </>
        )}
      </aside>

      <section className="card bottom chart-card">
        <div className="card-head">
          <h2>
            Прогноз мощности <span className="unit">МВт</span>
          </h2>
          <div className="toggles">
            <label className="chip p50">
              <i /> Прогноз
            </label>
            <label className="chip band">
              <input
                type="checkbox"
                checked={show.band}
                onChange={() => setShow((s) => ({ ...s, band: !s.band }))}
              />
              Вероятный диапазон
            </label>
            <label className="chip actual">
              <input
                type="checkbox"
                checked={show.actual}
                onChange={() => setShow((s) => ({ ...s, actual: !s.actual }))}
              />
              Факт
            </label>
            <label className="chip baseline">
              <input
                type="checkbox"
                checked={show.baseline}
                onChange={() => setShow((s) => ({ ...s, baseline: !s.baseline }))}
              />
              Погода + кривая
            </label>
            {scenario && (
              <label className="chip scenario">
                <i /> Сценарий
              </label>
            )}
          </div>
        </div>
        <ForecastChart
          points={points}
          cursor={cursor}
          onCursor={setCursor}
          show={show}
          scenario={scenario}
          rated={rated}
        />
        {onExplain && (
          <div className="explain-cta">
            <button className="primary" onClick={onExplain}>
              Объяснить прогноз →
            </button>
            <span>разбор по шагам модели, вклад факторов и причины ревизий</span>
          </div>
        )}
      </section>

      <section className="card bottom turb-card">
        <div className="card-head">
          <h2>
            {wind ? "Турбины" : "Блоки панелей"} <span className="unit">за сутки</span>
          </h2>
        </div>
        <div className="bars">
          {perUnit.map((u) => (
            <button
              key={u.unit.id}
              className={`bar-row ${selected === u.unit.id ? "on" : ""}`}
              onClick={() => setSelected(u.unit.id)}
            >
              <span className="bar-id">{u.unit.id}</span>
              <span className="bar-val">{mw(u.day)} МВт·ч</span>
              <span className="bar-track">
                <i
                  className={u.day / bestUnit < 0.9 ? "low" : ""}
                  style={{ width: `${(u.day / bestUnit) * 100}%` }}
                />
              </span>
              <span className="bar-pct">→</span>
            </button>
          ))}
        </div>
        {wind && perUnit.length > 1 && perUnit[0].day > 1e-6 && (
          <div className="hint">
            Прогноз {perUnit[1].unit.id} относительно {perUnit[0].unit.id}:{" "}
            <b>{((perUnit[1].day / Math.max(1e-6, perUnit[0].day) - 1) * 100).toFixed(1)}%</b>.
            Разница прогнозов не является измерением аэродинамического следа.
          </div>
        )}
      </section>

      <section className="card bottom whatif-card">
        <div className="card-head">
          <h2>Что если</h2>
        </div>
        <div className="seg wide">
          {(wind
            ? [
                [0, "Как в прогнозе"],
                [-15, "Ветер слабее"],
                [15, "Ветер сильнее"],
              ]
            : [
                [0, "Как в прогнозе"],
                [20, "Облачнее"],
                [-20, "Яснее"],
              ]
          ).map(([v, label]) => (
            <button key={label} className={change === v ? "on" : ""} onClick={() => setChange(v as number)}>
              {label}
            </button>
          ))}
        </div>
        <div className="slider-head">
          <span>{wind ? "Скорость ветра" : "Облачность"}</span>
          <b>
            {change > 0 ? "+" : ""}
            {change}
            <small>%</small>
          </b>
        </div>
        <input
          type="range"
          min={-20}
          max={20}
          value={change}
          aria-label={wind ? "Изменение скорости ветра, %" : "Изменение облачности, %"}
          onChange={(e) => setChange(Number(e.target.value))}
        />
        <div className="slider-scale">
          <span>−20%</span>
          <span>+20%</span>
        </div>
        <div className="scenario-out">
          <div>
            <div className="kpi-label">Выработка за сутки</div>
            <div className="kpi-mid">
              {scenarioPending ? "…" : scenarioFailed ? "—" : mw(scenario24)}
              <small>МВт·ч</small>
            </div>
          </div>
          <div className={`delta ${!change ? "flat" : scenario24 >= energy24 ? "up" : "down"}`}>
            {!change || !energy24 || scenarioPending || scenarioFailed ? (
              "—"
            ) : (
              <>
                {scenario24 >= energy24 ? "+" : "−"}
                {Math.abs(((scenario24 - energy24) / energy24) * 100).toFixed(0)}
                <small>%</small>
              </>
            )}
          </div>
        </div>
        <div className="hint">
          {wind
            ? scenarioFailed ? "Не удалось рассчитать сценарий. Обновите прогноз и повторите." : "Сценарий по кривой мощности: сохраняем поправку ML-модели и меняем скорость ветра."
            : "Облака сильнее всего режут выработку в полдень, когда солнце выше всего."}
        </div>
      </section>

      {wind && <WindPanel wind={stationWind.wind} loading={stationWind.loading} atIso={point?.forecast_for ?? null} />}
    </div>
  );
}
