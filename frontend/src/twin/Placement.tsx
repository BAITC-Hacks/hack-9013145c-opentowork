import { useEffect, useMemo, useRef, useState } from "react";
import type { SourceKind, Station } from "../api";
import { StepBar } from "./Flow";
import type { Route } from "./data";
import { ghiAt, meanWindAt, REGION, solarCapacityFactor, windCapacityFactor } from "./demo";

const COLS = 96;
const ROWS = 60;
const CITIES = [
  { name: "Астана", lat: 51.17, lon: 71.45 },
  { name: "Ерейментау", lat: 51.62, lon: 73.1 },
];

interface Spot {
  lat: number;
  lon: number;
  resource: number; // м/с или кВт·ч/м² в год
  cf: number;
}

function spotAt(kind: SourceKind, lat: number, lon: number): Spot {
  const resource = kind === "wind" ? meanWindAt(lat, lon) : ghiAt(lat, lon);
  const cf = kind === "wind" ? windCapacityFactor(resource) : solarCapacityFactor(resource);
  return { lat, lon, resource, cf };
}

function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const k = Math.PI / 180;
  const dLat = (b.lat - a.lat) * k;
  const dLon = (b.lon - a.lon) * k * Math.cos(((a.lat + b.lat) / 2) * k);
  return Math.hypot(dLat, dLon) * 6371;
}

// Ramp от сланца к леднику (ветер) или к степной охре (солнце): чем ярче,
// тем больше ресурса. Натрий здесь не используется — он только для тревог.
function rampRgb(kind: SourceKind, f: number): number[] {
  const lo = [22, 38, 45];
  const hi = kind === "wind" ? [127, 212, 217] : [226, 200, 128];
  const t = Math.max(0, Math.min(1, f)) ** 1.2;
  return lo.map((c, i) => Math.round(c + (hi[i] - c) * t));
}

function ramp(kind: SourceKind, f: number): string {
  return `rgb(${rampRgb(kind, f).join(",")})`;
}

export default function Placement({
  kind,
  stations,
  go,
}: {
  kind: SourceKind;
  stations: Station[];
  go: (r: Route) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 500 });
  const [picked, setPicked] = useState<Spot | null>(null);
  const [hover, setHover] = useState<Spot | null>(null);
  const [saved, setSaved] = useState<Spot[]>([]);
  const [capacity, setCapacity] = useState(kind === "wind" ? 50 : 20);

  const grid = useMemo(() => {
    const cells: Spot[] = [];
    for (let j = 0; j < ROWS; j += 1) {
      for (let i = 0; i < COLS; i += 1) {
        const lat = REGION.lat1 - ((j + 0.5) / ROWS) * (REGION.lat1 - REGION.lat0);
        const lon = REGION.lon0 + ((i + 0.5) / COLS) * (REGION.lon1 - REGION.lon0);
        cells.push(spotAt(kind, lat, lon));
      }
    }
    return cells;
  }, [kind]);

  const [min, max] = useMemo(() => {
    const r = grid.map((c) => c.resource);
    return [Math.min(...r), Math.max(...r)];
  }, [grid]);

  const best = useMemo(() => {
    // Лучшие места, разнесённые хотя бы на 25 км — иначе топ-5 окажется
    // пятью соседними клетками.
    const sorted = [...grid].sort((a, b) => b.cf - a.cf);
    const out: Spot[] = [];
    for (const c of sorted) {
      if (out.every((o) => distanceKm(o, c) > 25)) out.push(c);
      if (out.length === 5) break;
    }
    return out;
  }, [grid]);

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => {
      const w = e.contentRect.width;
      setSize({ w, h: Math.round(w * 0.62) });
    });
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  const toXY = (lat: number, lon: number) => ({
    x: ((lon - REGION.lon0) / (REGION.lon1 - REGION.lon0)) * size.w,
    y: ((REGION.lat1 - lat) / (REGION.lat1 - REGION.lat0)) * size.h,
  });
  const fromXY = (x: number, y: number) => ({
    lon: REGION.lon0 + (x / size.w) * (REGION.lon1 - REGION.lon0),
    lat: REGION.lat1 - (y / size.h) * (REGION.lat1 - REGION.lat0),
  });

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = size.w * dpr;
    c.height = size.h * dpr;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Клетки рисуются маленьким изображением и растягиваются со
    // сглаживанием — поле читается как непрерывное, а не как мозаика.
    const img = new ImageData(COLS, ROWS);
    grid.forEach((cell, k) => {
      const [r, g, b] = rampRgb(kind, (cell.resource - min) / (max - min));
      img.data.set([r, g, b, 255], k * 4);
    });
    const tmp = document.createElement("canvas");
    tmp.width = COLS;
    tmp.height = ROWS;
    tmp.getContext("2d")!.putImageData(img, 0, 0);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(tmp, 0, 0, size.w, size.h);
  }, [grid, size, kind, min, max]);

  const onMap = (e: React.MouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const { lat, lon } = fromXY(e.clientX - box.left, e.clientY - box.top);
    return spotAt(kind, lat, lon);
  };

  const existing = stations.filter(
    (s): s is Station & { lat: number; lon: number } =>
      s.lat != null && s.lon != null &&
      s.lat >= REGION.lat0 && s.lat <= REGION.lat1 && s.lon >= REGION.lon0 && s.lon <= REGION.lon1,
  );
  const fmtRes = (s: Spot) =>
    kind === "wind" ? `${s.resource.toFixed(1)} м/с` : `${Math.round(s.resource)} кВт·ч/м²`;
  const energy = (s: Spot) => s.cf * capacity * 8760;
  const astana = CITIES[0];

  return (
    <div className="flow wide">
      <StepBar step={2} mode="place" />
      <div className="place-head">
        <h1 className="flow-q">Где построить {kind === "wind" ? "ветровую" : "солнечную"} станцию?</h1>
        <span className="demo-flag">Демо: синтетическая карта ресурса</span>
      </div>
      <p className="flow-sub">
        Нажмите на точку карты — покажем, сколько энергии даст там станция. Чем ярче цвет, тем
        больше {kind === "wind" ? "ветра" : "солнца"} за год.
      </p>

      <div className="place">
        <div className="place-map card">
          <div
            ref={wrapRef}
            className="region"
            style={{ height: size.h }}
            onClick={(e) => setPicked(onMap(e))}
            onMouseMove={(e) => setHover(onMap(e))}
            onMouseLeave={() => setHover(null)}
          >
            <canvas ref={canvasRef} style={{ width: size.w, height: size.h }} />
            {CITIES.map((c) => {
              const p = toXY(c.lat, c.lon);
              return (
                <span key={c.name} className="city" style={{ left: p.x, top: p.y }}>
                  {c.name}
                </span>
              );
            })}
            {existing.map((s, i) => {
              const p = toXY(s.lat, s.lon);
              return (
                <span key={s.id} className="existing" style={{ left: p.x, top: p.y + i * 18 }} title={s.name}>
                  {s.kind === "wind" ? "ВЭС" : "СЭС"}
                </span>
              );
            })}
            {saved.map((s, i) => {
              const p = toXY(s.lat, s.lon);
              return (
                <span key={i} className="pin saved" style={{ left: p.x, top: p.y }}>
                  {String.fromCharCode(65 + i)}
                </span>
              );
            })}
            {picked && (
              <span
                className="pin current"
                style={{ left: toXY(picked.lat, picked.lon).x, top: toXY(picked.lat, picked.lon).y }}
              />
            )}
            {hover && (
              <span className="hover-tip" style={{ left: toXY(hover.lat, hover.lon).x + 12, top: toXY(hover.lat, hover.lon).y + 12 }}>
                {fmtRes(hover)} · КИУМ {Math.round(hover.cf * 100)}%
              </span>
            )}
          </div>
          <div className="region-legend">
            <span>{kind === "wind" ? `${min.toFixed(1)} м/с` : `${Math.round(min)} кВт·ч/м²`}</span>
            <i style={{ background: `linear-gradient(90deg, ${ramp(kind, 0)}, ${ramp(kind, 0.5)}, ${ramp(kind, 1)})` }} />
            <span>{kind === "wind" ? `${max.toFixed(1)} м/с` : `${Math.round(max)} кВт·ч/м²`}</span>
            <span className="dim">
              {kind === "wind" ? "средний ветер на высоте ступицы" : "солнечная радиация за год"}
            </span>
          </div>
        </div>

        <aside className="place-side">
          <section className="card">
            <h2>Мощность новой станции</h2>
            <div className="slider-head">
              <span>Установленная мощность</span>
              <b>
                {capacity}
                <small>МВт</small>
              </b>
            </div>
            <input
              type="range"
              min={kind === "wind" ? 10 : 5}
              max={kind === "wind" ? 200 : 100}
              step={5}
              value={capacity}
              aria-label="Установленная мощность, МВт"
              onChange={(e) => setCapacity(Number(e.target.value))}
            />
          </section>

          <section className="card spot">
            {picked ? (
              <>
                <h2>Выбранная точка</h2>
                <div className="kpi-label">Выработка за год</div>
                <div className="kpi-big">
                  {Math.round(energy(picked)).toLocaleString("ru-RU")}
                  <small>МВт·ч</small>
                </div>
                <dl className="facts">
                  <dt>{kind === "wind" ? "Средний ветер" : "Радиация"}</dt>
                  <dd>{fmtRes(picked)}</dd>
                  <dt>Коэффициент использования</dt>
                  <dd>{Math.round(picked.cf * 100)}%</dd>
                  <dt>До Астаны</dt>
                  <dd>{Math.round(distanceKm(picked, astana))} км</dd>
                  <dt>Координаты</dt>
                  <dd className="mono">
                    {picked.lat.toFixed(3)}, {picked.lon.toFixed(3)}
                  </dd>
                </dl>
                <button
                  className="primary"
                  disabled={saved.length >= 3}
                  onClick={() => setSaved((s) => [...s, picked])}
                >
                  {saved.length >= 3 ? "Можно сравнить до трёх мест" : "Добавить к сравнению"}
                </button>
              </>
            ) : (
              <div className="spot-empty">
                <h2>Точка не выбрана</h2>
                <p>Нажмите на карту или выберите одно из лучших мест ниже.</p>
              </div>
            )}
          </section>

          <section className="card">
            <h2>Лучшие места в регионе</h2>
            <ol className="best">
              {best.map((b) => (
                <li key={`${b.lat}-${b.lon}`}>
                  <button onClick={() => setPicked(b)}>
                    <span>{fmtRes(b)}</span>
                    <span className="dim">{Math.round(distanceKm(b, astana))} км от Астаны</span>
                    <b>{Math.round(energy(b)).toLocaleString("ru-RU")} МВт·ч/год</b>
                  </button>
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>

      {saved.length > 0 && (
        <section className="card compare">
          <div className="card-head">
            <h2>Сравнение мест</h2>
            <button className="ghost" onClick={() => setSaved([])}>
              Очистить
            </button>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Место</th>
                <th>{kind === "wind" ? "Ветер" : "Радиация"}</th>
                <th>КИУМ</th>
                <th>Выработка за год</th>
                <th>До Астаны</th>
              </tr>
            </thead>
            <tbody>
              {saved.map((s, i) => {
                const top = saved.every((o) => o.cf <= s.cf);
                return (
                  <tr key={i} className={top ? "selected" : ""}>
                    <td>
                      <b>{String.fromCharCode(65 + i)}</b> <span className="mono dim">{s.lat.toFixed(2)}, {s.lon.toFixed(2)}</span>
                      {top && saved.length > 1 && <span className="pill ok">лучшее</span>}
                    </td>
                    <td className="mono">{fmtRes(s)}</td>
                    <td className="mono">{Math.round(s.cf * 100)}%</td>
                    <td className="mono">{Math.round(energy(s)).toLocaleString("ru-RU")} МВт·ч</td>
                    <td className="mono">{Math.round(distanceKm(s, astana))} км</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      <p className="flow-foot">
        {kind === "wind"
          ? "КИУМ считается по кривой мощности турбины и распределению скоростей Рэлея. Карта ветра — синтетическая; в работе её заменят данные Global Wind Atlas."
          : "КИУМ = радиация × коэффициент производительности 0.8 / 8760 ч. Карта радиации — синтетическая; в работе её заменят данные PVGIS или NASA POWER."}
      </p>
      <button className="back" onClick={() => go({ page: "kind", mode: "place" })}>
        ← Назад
      </button>
    </div>
  );
}
