import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { Rooftop, RooftopsResponse } from "../api";
import type { Route } from "./data";
import SceneBoundary from "./SceneBoundary";
import "./rooftops.css";

const RooftopScene = lazy(() => import("./scene/RooftopScene"));
type Metric = "materials" | "energy" | "quality";

const MONTHS = ["Я", "Ф", "М", "А", "М", "И", "И", "А", "С", "О", "Н", "Д"];
const TYPE_LABEL: Record<string, string> = {
  apartments: "жилой дом",
  residential: "жилой дом",
  office: "офис",
  commercial: "коммерческое",
  retail: "торговое",
  school: "школа",
  kindergarten: "детский сад",
  hospital: "больница",
  parking: "паркинг",
  university: "вуз",
  hotel: "гостиница",
  detached: "частный дом",
  house: "частный дом",
  yes: "тип не указан",
};
const HEIGHT_LABEL: Record<Rooftop["height_source"], string> = {
  osm_height: "высота из OpenStreetMap",
  osm_levels: "по этажности из OpenStreetMap",
  assumed: "допущение по типу здания",
};

const fmt = (n: number) => Math.round(n).toLocaleString("ru-RU");
const mwh = (kwh: number) => (kwh >= 10_000 ? fmt(kwh / 1000) : (kwh / 1000).toFixed(1));

// Та же охристая шкала, что у солнечной карты региона: ярче — больше солнца.
function rampRgb(f: number, quality = false): string {
  const lo = [226, 232, 235];
  const hi = quality ? [21, 149, 129] : [217, 146, 34];
  const t = Math.max(0, Math.min(1, f)) ** 1.1;
  return `rgb(${lo.map((c, i) => Math.round(c + (hi[i] - c) * t)).join(",")})`;
}

function useRooftops() {
  const [data, setData] = useState<RooftopsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .rooftops()
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  }, []);
  return { data, error };
}

interface View {
  x: number;
  y: number;
  w: number;
}

export default function Rooftops({ go }: { go: (r: Route) => void }) {
  const { data, error } = useRooftops();
  const [sceneMetric, setSceneMetric] = useState<Metric>("materials");
  const metric = sceneMetric === "quality" ? "quality" : "energy";
  const [sceneAvailable, setSceneAvailable] = useState(true);
  const [show3D, setShow3D] = useState(true);
  const [picked, setPicked] = useState<Rooftop | null>(null);
  const [hover, setHover] = useState<{ b: Rooftop; x: number; y: number } | null>(null);
  const [tariff, setTariff] = useState(35);
  const [costPerKw, setCostPerKw] = useState(350_000);

  // Проекция района в координаты SVG: 1000 единиц по ширине, высота по
  // пропорциям участка с поправкой на широту.
  const geo = useMemo(() => {
    if (!data) return null;
    const [s, w, n, e] = data.bbox;
    const k = Math.cos((((s + n) / 2) * Math.PI) / 180);
    const W = 1000;
    const H = (W * (n - s)) / ((e - w) * k);
    const xy = ([lat, lon]: [number, number]) => [((lon - w) / (e - w)) * W, ((n - lat) / (n - s)) * H];
    const paths = new Map(
      data.buildings.map((b) => [b.id, "M" + b.polygon.map((p) => xy(p).map((v) => v.toFixed(1)).join(",")).join("L") + "Z"]),
    );
    return { W, H, paths };
  }, [data]);

  const [view, setView] = useState<View | null>(null);
  useEffect(() => {
    if (geo) setView({ x: 0, y: 0, w: geo.W });
  }, [geo]);

  const value = (b: Rooftop) => (metric === "energy" ? b.kwh_year : b.kwh_per_kwp);
  const scale = useMemo(() => {
    if (!data) return (_: Rooftop) => 0;
    const vals = data.buildings.map(value);
    if (metric === "energy") {
      // Выработка распределена с длинным хвостом (частный дом против ТРЦ) —
      // в логарифме различимы и маленькие крыши.
      const lo = Math.log10(Math.min(...vals));
      const hi = Math.log10(Math.max(...vals));
      return (b: Rooftop) => (Math.log10(value(b)) - lo) / (hi - lo);
    }
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    return (b: Rooftop) => (value(b) - lo) / (hi - lo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, metric]);

  const top = useMemo(() => {
    if (!data) return [];
    const minKw = 20; // на «качестве» иначе наверху окажутся гаражи без единой тени
    return [...data.buildings]
      .filter((b) => metric === "energy" || b.kwp >= minKw)
      .sort((a, b) => value(b) - value(a))
      .slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, metric]);

  // ─── масштаб и перетаскивание ───────────────────────────────────────────
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ px: number; py: number; view: View; moved: boolean } | null>(null);
  const aspect = geo ? geo.H / geo.W : 1;

  const toSvg = (clientX: number, clientY: number, v: View) => {
    const box = svgRef.current!.getBoundingClientRect();
    return {
      x: v.x + ((clientX - box.left) / box.width) * v.w,
      y: v.y + ((clientY - box.top) / box.height) * v.w * aspect,
    };
  };

  const zoom = (factor: number, cx?: number, cy?: number) => {
    if (!geo || !view) return;
    const w = Math.max(80, Math.min(geo.W, view.w * factor));
    const fx = cx ?? view.x + view.w / 2;
    const fy = cy ?? view.y + (view.w * aspect) / 2;
    const x = fx - ((fx - view.x) * w) / view.w;
    const y = fy - ((fy - view.y) * w) / view.w;
    setView(clamp({ x, y, w }));
  };

  const clamp = (v: View): View => {
    if (!geo) return v;
    return {
      w: v.w,
      x: Math.max(0, Math.min(geo.W - v.w, v.x)),
      y: Math.max(0, Math.min(geo.H - v.w * aspect, v.y)),
    };
  };

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    // Нативный слушатель: React вешает wheel как passive, и preventDefault
    // из обработчика не остановил бы прокрутку страницы.
    const onWheel = (e: WheelEvent) => {
      if (!view) return;
      e.preventDefault();
      const p = toSvg(e.clientX, e.clientY, view);
      zoom(e.deltaY > 0 ? 1.2 : 1 / 1.2, p.x, p.y);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const focus = (b: Rooftop) => {
    setPicked(b);
    if (!geo || !data) return;
    const [s, w, n, e] = data.bbox;
    const lat = b.polygon.reduce((a, p) => a + p[0], 0) / b.polygon.length;
    const lon = b.polygon.reduce((a, p) => a + p[1], 0) / b.polygon.length;
    const cx = ((lon - w) / (e - w)) * geo.W;
    const cy = ((n - lat) / (n - s)) * geo.H;
    const vw = 300;
    setView(clamp({ x: cx - vw / 2, y: cy - (vw * aspect) / 2, w: vw }));
  };

  if (error) {
    return (
      <div className="flow">
        <h1 className="flow-q">Не удалось загрузить расчёт</h1>
        <div className="error">{error}</div>
      </div>
    );
  }
  if (!data || !geo || !view) {
    return (
      <div className="flow">
        <p className="flow-sub">
          <span className="spin" /> Считаем тени от зданий района…
        </p>
      </div>
    );
  }

  const legend =
    metric === "energy"
      ? ["меньше", "больше энергии за год"]
      : [`${fmt(Math.min(...data.buildings.map((b) => b.kwh_per_kwp)))}`, `${fmt(data.irradiance.kwh_per_kwp_year)} кВт·ч с 1 кВт панелей`];

  return (
    <div className="flow wide rooftops-page">
      <div className="place-head">
        <div><span className="roof-eyebrow">СОЛНЕЧНАЯ ЭНЕРГИЯ</span><h1 className="flow-q">Найдите потенциал каждой крыши</h1></div>
        <span className="roof-district-badge">{data.district}</span>
      </div>
      <p className="flow-sub">
        Исследуйте здания в 3D, сравните выработку и оцените окупаемость солнечных панелей.
        Расчёт учитывает площадь крыши и тени от соседних домов.
      </p>

      <div className="roof-kpis">
        <div>
          <span className="kpi-label">Потенциал района</span>
          <b>{fmt(data.summary.total_mwh_year)}</b> <small>МВт·ч/год</small>
        </div>
        <div>
          <span className="kpi-label">Мощность панелей</span>
          <b>{(data.summary.total_kwp / 1000).toFixed(1)}</b> <small>МВт</small>
        </div>
        <div>
          <span className="kpi-label">10 лучших крыш дают</span>
          <b>{Math.round((data.summary.top10_mwh_year / data.summary.total_mwh_year) * 100)}%</b>{" "}
          <small>потенциала</small>
        </div>
        <div>
          <span className="kpi-label">Высота известна</span>
          <b>{Math.round(data.summary.height_known_share * 100)}%</b> <small>зданий</small>
        </div>
      </div>

      <div className="place">
        <div className="place-map card">
          <div className="roof-toolbar">
            <div className="roof-map-heading"><strong>Крыши района</strong><span>{fmt(data.summary.buildings)} зданий · выберите объект</span></div>
            <div className="roof-view-switch" aria-label="Режим отображения">
              <button className={show3D && sceneAvailable ? "on" : ""} disabled={!sceneAvailable} onClick={() => setShow3D(true)}>3D</button>
              <button className={!show3D || !sceneAvailable ? "on" : ""} onClick={() => setShow3D(false)}>2D</button>
            </div>
          </div>
          <div className="roof-layers" role="group" aria-label="Слой на крышах">
            <button aria-pressed={sceneMetric === "materials"} onClick={() => setSceneMetric("materials")}>Здания и панели</button>
            <button aria-pressed={sceneMetric === "energy"} onClick={() => setSceneMetric("energy")}>Выработка за год</button>
            <button aria-pressed={sceneMetric === "quality"} onClick={() => setSceneMetric("quality")}>Влияние теней</button>
          </div>
          {show3D && sceneAvailable ? <SceneBoundary onUnavailable={() => setSceneAvailable(false)}><Suspense fallback={<div className="roof-scene roof-scene-loading"><span className="spin" /> Загружаем 3D-сцену…</div>}>
            <RooftopScene data={data} selected={picked} metric={sceneMetric} onSelect={setPicked} onUnavailable={() => setSceneAvailable(false)} />
          </Suspense></SceneBoundary> : <>
          <div className="roof-zoom">
            <button className="ghost" onClick={() => zoom(1 / 1.5)} aria-label="Приблизить">+</button>
            <button className="ghost" onClick={() => zoom(1.5)} aria-label="Отдалить">−</button>
            <button className="ghost" onClick={() => setView({ x: 0, y: 0, w: geo.W })}>Весь район</button>
          </div>
          <svg
            ref={svgRef}
            className="roof-map"
            viewBox={`${view.x} ${view.y} ${view.w} ${view.w * aspect}`}
            style={{ aspectRatio: `${geo.W} / ${geo.H}` }}
            onPointerDown={(e) => {
              drag.current = { px: e.clientX, py: e.clientY, view, moved: false };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d || !svgRef.current) return;
              const box = svgRef.current.getBoundingClientRect();
              const dx = ((e.clientX - d.px) / box.width) * d.view.w;
              const dy = ((e.clientY - d.py) / box.height) * d.view.w * aspect;
              if (Math.abs(e.clientX - d.px) + Math.abs(e.clientY - d.py) > 4) d.moved = true;
              if (d.moved) setView(clamp({ ...d.view, x: d.view.x - dx, y: d.view.y - dy }));
            }}
            onPointerUp={() => {
              // Клик по зданию срабатывает, только если карту не тащили.
              setTimeout(() => (drag.current = null), 0);
            }}
            onPointerLeave={() => {
              drag.current = null;
              setHover(null);
            }}
          >
            <rect x={0} y={0} width={geo.W} height={geo.H} className="roof-ground" />
            {data.buildings.map((b) => (
              <path
                key={b.id}
                d={geo.paths.get(b.id)}
                fill={sceneMetric === "materials" ? "#bdc9cc" : rampRgb(scale(b), sceneMetric === "quality")}
                className={picked?.id === b.id ? "roof picked" : "roof"}
                strokeWidth={(picked?.id === b.id ? 2.2 : 0.6) * (view.w / geo.W)}
                onClick={() => {
                  if (!drag.current?.moved) setPicked(b);
                }}
                onPointerEnter={(e) => setHover({ b, x: e.clientX, y: e.clientY })}
                onPointerLeave={() => setHover(null)}
              />
            ))}
          </svg>
          </>}
          {hover && (
            <span className="roof-tip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
              <b>{hover.b.name ?? TYPE_LABEL[hover.b.type ?? ""] ?? "Здание"}</b>
              {mwh(hover.b.kwh_year)} МВт·ч/год · тень −{Math.round(hover.b.shading_loss * 100)}%
            </span>
          )}
          <div className="region-legend">
            {sceneMetric !== "materials" ? <>
              <span>{legend[0]}</span>
              <i style={{ background: `linear-gradient(90deg, ${rampRgb(0, sceneMetric === "quality")}, ${rampRgb(0.5, sceneMetric === "quality")}, ${rampRgb(1, sceneMetric === "quality")})` }} />
              <span>{legend[1]}</span>
            </> : <span>Контуры — OSM · часть высот принята по типу здания</span>}
            <span className="dim">{show3D && sceneAvailable ? "Вращайте мышью · Колесо — масштаб" : "Колесо — масштаб · Потяните для сдвига"}</span>
          </div>
        </div>

        <aside className="place-side">
          <section className="card spot">
            {picked ? (
              <RoofCard b={picked} data={data} tariff={tariff} costPerKw={costPerKw} />
            ) : (
              <div className="spot-empty">
                <span className="roof-selection-icon" aria-hidden="true">⌂</span>
                <h2>Начните с одного здания</h2>
                <p>Выберите крышу в 3D или в списке. Здесь появятся выработка, площадь панелей и срок окупаемости.</p>
                {top[0] && <button className="roof-start-button" onClick={() => focus(top[0])}>Показать лучшую крышу →</button>}
              </div>
            )}
          </section>

          <section className="card">
            <h2>{metric === "energy" ? "Больше всего энергии" : "Меньше всего теней"}</h2>
            <ol className="best">
              {top.map((b) => (
                <li key={b.id}>
                  <button aria-pressed={picked?.id === b.id} onClick={() => focus(b)}>
                    <span>{b.name ?? TYPE_LABEL[b.type ?? ""] ?? "Здание"}</span>
                    <span className="dim">
                      {fmt(b.usable_m2)} м² под панели · тень −{Math.round(b.shading_loss * 100)}%
                    </span>
                    <b>
                      {metric === "energy" ? `${mwh(b.kwh_year)} МВт·ч` : `${fmt(b.kwh_per_kwp)} кВт·ч/кВт`}
                    </b>
                  </button>
                </li>
              ))}
            </ol>
          </section>

          <section className="card">
            <h2>Экономика</h2>
            <p className="roof-assume">Допущения — поменяйте под свой объект.</p>
            <div className="slider-head">
              <span>Тариф на электроэнергию</span>
              <b>
                {tariff}
                <small>₸/кВт·ч</small>
              </b>
            </div>
            <input type="range" min={10} max={80} step={1} value={tariff} aria-label="Тариф, тенге за кВт·ч" onChange={(e) => setTariff(Number(e.target.value))} />
            <div className="slider-head">
              <span>Стоимость установки</span>
              <b>
                {fmt(costPerKw / 1000)}
                <small>тыс. ₸/кВт</small>
              </b>
            </div>
            <input type="range" min={150_000} max={700_000} step={10_000} value={costPerKw} aria-label="Стоимость установки, тенге за кВт" onChange={(e) => setCostPerKw(Number(e.target.value))} />
          </section>
        </aside>
      </div>

      <p className="flow-foot">
        3D — реконструкция по контурам и высотам, фасады и размещение панелей иллюстративные. Радиация — {data.sources.irradiance} (среднее за многолетний период), панели на юг под {data.irradiance.tilt_deg}°,
        потери системы 14%. Контуры и этажность — {data.sources.buildings}, выгрузка {data.sources.fetched}. Тени считаются
        по высотам соседних зданий для прямого света; рассеянный свет и снег на панелях не учитываются. Купола и шатры
        (Хан Шатыр) исключены. Где высоты нет в OSM, она принята по типу здания — такие здания помечены.
      </p>
      <button className="back" onClick={() => go({ page: "kind", mode: "place" })}>
        ← Назад
      </button>
    </div>
  );
}

function RoofCard({ b, data, tariff, costPerKw }: { b: Rooftop; data: RooftopsResponse; tariff: number; costPerKw: number }) {
  const unshaded = data.irradiance.months.map((m) => b.kwp * m.kwh_per_kwp);
  const peak = Math.max(...unshaded);
  const cost = b.kwp * costPerKw;
  const income = b.kwh_year * tariff;
  const payback = income > 0 ? cost / income : Infinity;
  return (
    <>
      <div className="roof-card-head">
        <h2>{b.name ?? "Здание без названия"}</h2>
        <span className="pill">№ {b.rank} в районе</span>
      </div>
      <div className="kpi-label">Выработка за год</div>
      <div className="kpi-big">
        {mwh(b.kwh_year)}
        <small>МВт·ч</small>
      </div>

      <svg className="roof-months" viewBox="0 0 240 90" role="img" aria-label="Выработка по месяцам">
        {b.monthly_kwh.map((v, i) => {
          const x = i * 20 + 3;
          const hFull = (unshaded[i] / peak) * 72;
          const h = (v / peak) * 72;
          return (
            <g key={i}>
              <rect x={x} y={76 - hFull} width={14} height={hFull} className="lost" />
              <rect x={x} y={76 - h} width={14} height={h} className="got" />
              <text x={x + 7} y={88} textAnchor="middle">
                {MONTHS[i]}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="roof-months-legend">
        <span><i className="got" /> выработка</span>
        <span><i className="lost" /> съели тени</span>
      </div>

      <dl className="facts">
        <dt>Панелей поместится</dt>
        <dd>{fmt(b.kwp)} кВт</dd>
        <dt>Площадь под панели</dt>
        <dd>
          {fmt(b.usable_m2)} из {fmt(b.roof_m2)} м²
        </dd>
        <dt>Потери от теней</dt>
        <dd>−{Math.round(b.shading_loss * 100)}% за год</dd>
        <dt>Высота здания</dt>
        <dd title={HEIGHT_LABEL[b.height_source]}>
          {fmt(b.height_m)} м{b.height_source === "assumed" && <span className="roof-flag"> допущение</span>}
        </dd>
        <dt>Тип</dt>
        <dd>{TYPE_LABEL[b.type ?? ""] ?? b.type ?? "—"}</dd>
        <dt>Установка обойдётся</dt>
        <dd>{fmt(cost / 1_000_000)} млн ₸</dd>
        <dt>Окупаемость</dt>
        <dd>{Number.isFinite(payback) ? `${payback.toFixed(1)} лет` : "—"}</dd>
      </dl>

      <ul className="roof-notes">
        {b.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
      <a className="roof-osm" href={`https://www.openstreetmap.org/${b.id}`} target="_blank" rel="noreferrer">
        Здание в OpenStreetMap ↗
      </a>
    </>
  );
}
