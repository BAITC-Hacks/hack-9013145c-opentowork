import { useEffect, useRef, useState } from "react";
import type { ForecastPoint, Station, Turbine, UnitSample } from "../api";
import { fmtDayTime, mw, stationRated, unitRated, useUnitHistory } from "./data";
import { parseTs, RATED_ASSUMPTION_MW, SITE, sunPosition, toIso, wakeFactor } from "./demo";

interface Props {
  station: Station;
  unit: Turbine;
  points: ForecastPoint[];
  cursor: number;
  originIso: string;
  onClose: () => void;
}

const HOUR = 3_600_000;

function unitShare(p: ForecastPoint, id: string): number {
  return p.per_turbine?.[id] ?? p.p50;
}

function status(station: Station, p: ForecastPoint | undefined, power: number) {
  if (!p) return { text: "—", tone: "" };
  if (station.kind === "solar") {
    const sun = sunPosition(parseTs(p.forecast_for) - SITE.utcOffset * HOUR, station.lat ?? SITE.lat, station.lon ?? SITE.lon);
    if (sun.elevation <= 0) return { text: "Ночь", tone: "idle" };
    if ((p.cloud_cover ?? 0) > 0.7) return { text: "Сплошная облачность", tone: "warn" };
    return { text: "Работает", tone: "ok" };
  }
  if (p.wind_speed >= 25) return { text: "Остановлена: шторм", tone: "warn" };
  if (p.wind_speed < 3) return { text: "Штиль — ветра мало", tone: "idle" };
  if (power >= 0.97) return { text: "На полной мощности", tone: "ok" };
  return { text: "Работает", tone: "ok" };
}

export default function UnitPanel({ station, unit, points, cursor, originIso, onClose }: Props) {
  const rated = unitRated(station, unit, RATED_ASSUMPTION_MW);
  const stationMw = stationRated(station);
  const origin = parseTs(originIso);
  const localOrigin = new Date(origin + SITE.utcOffset * HOUR);
  const monthStart = Date.UTC(localOrigin.getUTCFullYear(), localOrigin.getUTCMonth(), 1) - SITE.utcOffset * HOUR;
  const facts = useUnitHistory(station, unit.id, toIso(Math.min(monthStart, origin - 24 * HOUR)), toIso(origin));
  const history = (facts ?? []).filter((s) => parseTs(s.ts) >= monthStart);
  const last24 = (facts ?? []).filter((s) => parseTs(s.ts) >= origin - 24 * HOUR);

  const p = points[Math.min(cursor, points.length - 1)];
  const share = p ? unitShare(p, unit.id) : 0;
  const st = status(station, p, share);
  const day = points.slice(0, 24);
  const forecast24 = day.reduce((a, q) => a + unitShare(q, unit.id), 0) * rated;
  const done24 = last24.reduce((a, s) => a + s.power, 0) * rated;
  const doneMonth = history.reduce((a, s) => a + s.power, 0) * rated;
  const workedHours = last24.filter((s) => s.power > 0.01).length;
  const wake = station.kind === "wind" && p && unit.id === "T2" ? wakeFactor(p.wind_dir) : 1;
  const hubWind = p ? p.wind_speed * wake ** (1 / 3) : 0;
  const rpm = share > 0.01 ? 5 + 11 * share : 0;
  const sun = p
    ? sunPosition(parseTs(p.forecast_for) - SITE.utcOffset * HOUR, station.lat ?? SITE.lat, station.lon ?? SITE.lon)
    : null;

  return (
    <div className="unit-panel">
      <button className="back-link" onClick={onClose}>
        ← Вся станция
      </button>
      <div className="unit-head">
        <div>
          <div className="unit-id">{unit.id}</div>
          <h2>{unit.name}</h2>
        </div>
        <span className={`status ${st.tone}`}>{st.text}</span>
      </div>

      <div className="unit-now">
        <div className="kpi-label">
          Мощность <em>{p ? fmtDayTime(p.forecast_for) : "—"}</em>
        </div>
        <div className="kpi-big">
          {mw(share * rated)}
          <small>МВт из {mw(rated)}</small>
        </div>
        <div className="meter">
          <i style={{ width: `${share * 100}%` }} />
        </div>
      </div>

      <dl className="facts">
        {station.kind === "wind" ? (
          <>
            <dt>Ветер у ротора</dt>
            <dd>{hubWind.toFixed(1)} м/с</dd>
            <dt>Обороты ротора</dt>
            <dd>{rpm ? `${rpm.toFixed(0)} об/мин` : "стоит"}</dd>
          </>
        ) : (
          <>
            <dt>Высота солнца</dt>
            <dd>{sun ? `${Math.max(0, sun.elevation).toFixed(0)}°` : "—"}</dd>
            <dt>Облачность</dt>
            <dd>{p?.cloud_cover != null ? `${Math.round(p.cloud_cover * 100)}%` : "—"}</dd>
          </>
        )}
        <dt>Температура воздуха</dt>
        <dd>{p ? `${p.temperature.toFixed(0)} °C` : "—"}</dd>
        {wake < 0.995 && (
          <>
            <dt>Тень от T1</dt>
            <dd className="warn-text">−{((1 - wake) * 100).toFixed(0)}% мощности</dd>
          </>
        )}
      </dl>

      <div className="energy">
        <div>
          <span className="kpi-label">Выработала за сутки</span>
          <b>{facts && last24.length ? <>{mw(done24)}<small>МВт·ч</small></> : "—"}</b>
          <span className="energy-sub">
            {last24.length === 24 ? `работала ${workedHours} из 24 ч` : `неполные данные: ${last24.length} из 24 ч`}
          </span>
        </div>
        <div>
          <span className="kpi-label">С начала месяца</span>
          <b>{facts && history.length ? <>{mw(doneMonth)}<small>МВт·ч</small></> : "—"}</b>
          <span className="energy-sub">{history.length} из {Math.round((origin - monthStart) / HOUR)} ч · сумма известных часов</span>
        </div>
        <div className="accent">
          <span className="kpi-label">Прогноз на сутки</span>
          <b>{mw(forecast24)}<small>МВт·ч</small></b>
          <span className="energy-sub">
            {last24.length === 24 && done24 > 0 ? `${forecast24 >= done24 ? "+" : "−"}${Math.abs(((forecast24 - done24) / done24) * 100).toFixed(0)}% к прошлым суткам` : "Нет полных суток для сравнения"}
          </span>
        </div>
      </div>

      <UnitChart history={last24} points={points} unitId={unit.id} cursor={cursor} />
      {!unit.rated_mw && <p className="hint">Номинал турбины не указан в данных — {stationMw && station.units.length
        ? `принят средний по станции: ${mw(stationMw)} МВт / ${station.units.length} турбин`
        : `принят ${RATED_ASSUMPTION_MW} МВт`}.</p>}
      {station.data !== "history" && (
        <p className="hint">Показатели этой станции — расчёт модели, фактических данных нет.</p>
      )}
    </div>
  );
}

/** Сутки факта слева от «сейчас» и прогноз с разбросом справа. */
function UnitChart({
  history,
  points,
  unitId,
  cursor,
}: {
  history: UnitSample[];
  points: ForecastPoint[];
  unitId: string;
  cursor: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(280);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  const h = 110;
  const n = history.length + points.length;
  if (n < 2) return <div ref={ref} className="unit-chart" style={{ height: h }} />;
  const x = (i: number) => (i / (n - 1)) * w;
  const y = (v: number) => 8 + (1 - v) * (h - 16);
  const off = history.length;
  const share = (p: ForecastPoint) => unitShare(p, unitId);
  const ratio = (p: ForecastPoint) => (p.p50 > 0.001 ? share(p) / p.p50 : 1);
  const hist = history.map((s, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(s.power).toFixed(1)}`).join("");
  const fc = points.map((p, i) => `${i ? "L" : "M"}${x(off + i).toFixed(1)},${y(share(p)).toFixed(1)}`).join("");
  const band =
    points.map((p, i) => `${i ? "L" : "M"}${x(off + i).toFixed(1)},${y(Math.min(1, p.p90 * ratio(p))).toFixed(1)}`).join("") +
    [...points].reverse().map((p, k) => `L${x(off + points.length - 1 - k).toFixed(1)},${y(p.p10 * ratio(p)).toFixed(1)}`).join("") +
    "Z";
  return (
    <div ref={ref} className="unit-chart">
      <svg width={w} height={h} aria-label="Мощность: сутки факта и прогноз">
        <rect x={0} y={0} width={x(off)} height={h} className="uc-past" />
        <path d={band} className="band" />
        <path d={hist} className="line actual" />
        <path d={fc} className="line p50" />
        <line x1={x(off)} x2={x(off)} y1={0} y2={h} className="uc-now" />
        <line x1={x(off + cursor)} x2={x(off + cursor)} y1={0} y2={h} className="cursor" />
      </svg>
      <div className="uc-legend">
        <span>
          <i className="a" /> было
        </span>
        <span className="dim">сейчас</span>
        <span>
          <i className="p" /> будет
        </span>
      </div>
    </div>
  );
}
