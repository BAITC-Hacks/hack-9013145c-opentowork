import type { StationWind, WindHour } from "../api";
import { fmtDayTime } from "./data";
import "./windpanel.css";

const RUMBS = ["С", "ССВ", "СВ", "ВСВ", "В", "ВЮВ", "ЮВ", "ЮЮВ", "Ю", "ЮЮЗ", "ЮЗ", "ЗЮЗ", "З", "ЗСЗ", "СЗ", "ССЗ"];
const BEAUFORT = [
  "штиль", "тихий", "лёгкий", "слабый", "умеренный", "свежий", "сильный",
  "крепкий", "очень крепкий", "шторм", "сильный шторм", "жестокий шторм", "ураган",
];
const SOURCE = {
  snapshot: "архив прогнозов Open-Meteo (снимок в репозитории)",
  archive: "архив прогнозов Open-Meteo",
  forecast: "прогноз Open-Meteo",
} as const;

function rumb(deg: number): string {
  return RUMBS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/** Стрелка показывает, куда дует ветер; подпись — откуда, как принято у метеорологов. */
function Arrow({ from, size = 14 }: { from: number; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="-10 -10 20 20" aria-hidden="true" style={{ transform: `rotate(${from + 180}deg)` }}>
      <path d="M0 -8 L5 3 L0 0.5 L-5 3 Z" fill="currentColor" />
    </svg>
  );
}

function shearText(alpha: number | null): string {
  if (alpha == null) return "—";
  const ratio = 10 ** alpha;
  if (alpha < 0.08) return `α ${alpha.toFixed(2)} · ветер перемешан, у земли почти как у ротора`;
  return `α ${alpha.toFixed(2)} · у ротора в ${ratio.toFixed(1)}× сильнее, чем у земли`;
}

function Chart({ hours, cursor }: { hours: WindHour[]; cursor: number }) {
  const W = 640;
  const H = 150;
  const pad = { l: 28, r: 8, t: 10, b: 34 };
  const max = Math.max(12, ...hours.map((h) => Math.max(h.speed_100m, h.gust_10m ?? 0))) * 1.08;
  const x = (i: number) => pad.l + (i / Math.max(1, hours.length - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const line = (get: (h: WindHour) => number | null) =>
    hours
      .map((h, i) => [i, get(h)] as const)
      .filter(([, v]) => v != null)
      .map(([i, v], k) => `${k ? "L" : "M"}${x(i).toFixed(1)},${y(v!).toFixed(1)}`)
      .join("");
  const step = Math.max(1, Math.round(hours.length / 16));
  const ticks = [3, 12.5, 25].filter((v) => v < max);
  return (
    <svg className="wp-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Скорость ветра и порывы по часам">
      {ticks.map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="wp-grid" />
          <text x={pad.l - 4} y={y(v) + 3} className="wp-tick" textAnchor="end">{v}</text>
        </g>
      ))}
      <path d={line((h) => h.gust_10m)} className="wp-gust" />
      <path d={line((h) => h.speed_10m)} className="wp-v10" />
      <path d={line((h) => h.speed_100m)} className="wp-v100" />
      {hours[cursor] && <line x1={x(cursor)} x2={x(cursor)} y1={pad.t} y2={H - pad.b} className="wp-cursor" />}
      {hours.map((h, i) =>
        i % step === 0 && h.dir_100m != null ? (
          <g key={h.time} transform={`translate(${x(i)},${H - 18}) rotate(${h.dir_100m + 180})`} className="wp-dir">
            <path d="M0 -7 L4 3 L0 1 L-4 3 Z" />
          </g>
        ) : null,
      )}
    </svg>
  );
}

export default function WindPanel({ wind, atIso }: { wind: StationWind | null; atIso: string | null }) {
  if (!wind || wind.hours.length === 0) return null;
  const at = atIso ? Date.parse(atIso.endsWith("Z") ? atIso : `${atIso}Z`) : NaN;
  const idx = Math.max(0, wind.hours.findIndex((h) => Date.parse(h.time) === at));
  const h = wind.hours[idx];
  const peakGust = wind.hours.reduce((a, b) => ((b.gust_10m ?? 0) > (a.gust_10m ?? 0) ? b : a));
  return (
    <section className="card bottom wind-card" aria-label="Ветер у станции">
      <div className="card-head">
        <h2>
          Ветер у станции <span className="unit">м/с</span>
        </h2>
        <span className="wp-at">{fmtDayTime(h.time.slice(0, 19))} UTC</span>
      </div>
      <div className="wp-grid-layout">
        <div className="wp-now">
          <div className="wp-dial" aria-hidden="true">
            {["С", "В", "Ю", "З"].map((c, i) => (
              <span key={c} className={`wp-c c${i}`}>{c}</span>
            ))}
            {h.dir_100m != null && (
              <div className="wp-needle" style={{ transform: `rotate(${h.dir_100m + 180}deg)` }} />
            )}
          </div>
          <dl className="wp-facts">
            <div>
              <dt>Сила · 100 м</dt>
              <dd>
                <b>{h.speed_100m.toFixed(1)}</b> м/с <small>{h.beaufort} б. · {BEAUFORT[h.beaufort]}</small>
              </dd>
            </div>
            <div>
              <dt>Направление</dt>
              <dd>
                {h.dir_100m != null ? (
                  <>
                    <b>{rumb(h.dir_100m)}</b> {Math.round(h.dir_100m)}°{" "}
                    <small>у земли {h.dir_10m != null ? `${rumb(h.dir_10m)} ${Math.round(h.dir_10m)}°` : "—"}</small>
                  </>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div>
              <dt>Порывы · 10 м</dt>
              <dd>
                <b>{h.gust_10m != null ? h.gust_10m.toFixed(1) : "—"}</b> м/с{" "}
                <small>средний у земли {h.speed_10m != null ? h.speed_10m.toFixed(1) : "—"}</small>
              </dd>
            </div>
            <div>
              <dt>Сдвиг ветра</dt>
              <dd><small>{shearText(h.shear_alpha)}</small></dd>
            </div>
            {h.temperature != null && (
              <div>
                <dt>Температура</dt>
                <dd>
                  {h.temperature.toFixed(0)} °C
                  {h.temperature <= 1 && h.temperature >= -10 && <small> · риск обледенения лопастей</small>}
                </dd>
              </div>
            )}
          </dl>
        </div>
        <div className="wp-series">
          <Chart hours={wind.hours} cursor={idx} />
          <div className="wp-legend">
            <span><i className="v100" />на высоте ротора, 100 м</span>
            <span><i className="v10" />у земли, 10 м</span>
            <span><i className="gust" />порывы</span>
            <span><Arrow from={h.dir_100m ?? 0} size={11} />куда дует</span>
          </div>
          <p className="wp-note">
            Максимальный порыв за {wind.hours.length} ч — {peakGust.gust_10m?.toFixed(0) ?? "—"} м/с,{" "}
            {fmtDayTime(peakGust.time.slice(0, 19))}. Источник: {SOURCE[wind.source]},{" "}
            {wind.lat.toFixed(3)}° N, {wind.lon.toFixed(3)}° E.
          </p>
        </div>
      </div>
    </section>
  );
}
