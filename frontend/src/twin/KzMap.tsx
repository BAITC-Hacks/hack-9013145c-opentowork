import { useMemo, useState } from "react";
import type { Station } from "../api";
import { canOpen, mw } from "./data";
import outline from "./kz_outline.json";
import "./kzmap.css";

// Равнопромежуточная проекция с поправкой на широту 48° — для одной страны
// искажения меньше толщины линии, а тянуть картографическую библиотеку незачем.
const BOX = { lat0: 40.4, lat1: 55.6, lon0: 46.3, lon1: 87.5 };
const K = Math.cos((48 * Math.PI) / 180);
const W = 1000;
const H = Math.round((W * (BOX.lat1 - BOX.lat0)) / ((BOX.lon1 - BOX.lon0) * K));

function xy(lat: number, lon: number): [number, number] {
  return [((lon - BOX.lon0) / (BOX.lon1 - BOX.lon0)) * W, ((BOX.lat1 - lat) / (BOX.lat1 - BOX.lat0)) * H];
}

const PATH = (outline as number[][][])
  .map((ring) => ring.map(([lat, lon], i) => `${i ? "L" : "M"}${xy(lat, lon).map((v) => v.toFixed(1)).join(",")}`).join("") + "Z")
  .join("");

const CITIES = [
  { name: "Астана", lat: 51.17, lon: 71.45 },
  { name: "Алматы", lat: 43.24, lon: 76.89 },
  { name: "Шымкент", lat: 42.32, lon: 69.59 },
  { name: "Актобе", lat: 50.28, lon: 57.17 },
  { name: "Атырау", lat: 47.11, lon: 51.92 },
  { name: "Караганда", lat: 49.8, lon: 73.1 },
  { name: "Усть-Каменогорск", lat: 49.95, lon: 82.61 },
];

const LOCATION_LABEL = {
  turbines: "координаты каждой турбины",
  plant: "точка станции",
  district: "только район, точка на райцентре",
} as const;

function radius(s: Station): number {
  const cap = s.capacity_mw ?? s.units.reduce((a, u) => a + (u.rated_mw ?? 0), 0);
  return 5 + Math.sqrt(Math.max(cap, 1)) * 1.1;
}

interface PlacementMode {
  point: { lat: number; lon: number } | null;
  onPick: (lat: number, lon: number) => void;
  markers?: { id: string; lat: number; lon: number; label: string; onSelect: () => void }[];
}

export default function KzMap({ stations, onOpen, placement }: {
  stations: Station[];
  onOpen: (s: Station) => void;
  placement?: PlacementMode;
}) {
  const mapped = useMemo(
    () =>
      stations
        .filter((s): s is Station & { lat: number; lon: number } => s.lat !== null && s.lon !== null)
        // Крупные рисуем первыми, чтобы мелкие соседи оставались кликабельными.
        .sort((a, b) => radius(b) - radius(a)),
    [stations],
  );
  const [focusId, setFocusId] = useState<string | null>(() => stations.find((s) => s.data === "history")?.id ?? null);
  const focus = stations.find((s) => s.id === focusId) ?? null;

  return (
    <div className={`kzmap${placement ? " kzmap-placement" : ""}`}>
      <div className="kzmap-canvas">
        <svg viewBox={`0 0 ${W} ${H}`} role="img"
          aria-label={placement ? "Карта Казахстана: выберите место новой турбины" : `Карта станций Казахстана: ${mapped.length}`}
          onClick={placement ? (event) => {
            const svg = event.currentTarget;
            const matrix = svg.getScreenCTM();
            if (!matrix) return;
            const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
            if (point.x < 0 || point.x > W || point.y < 0 || point.y > H) return;
            placement.onPick(BOX.lat1 - point.y / H * (BOX.lat1 - BOX.lat0),
              BOX.lon0 + point.x / W * (BOX.lon1 - BOX.lon0));
          } : undefined}>
          <path className="kzmap-land" d={PATH} />
          {CITIES.map((c) => {
            const [x, y] = xy(c.lat, c.lon);
            return (
              <g key={c.name} className="kzmap-city">
                <circle cx={x} cy={y} r={2.5} />
                <text x={x + 6} y={y + 4}>{c.name}</text>
              </g>
            );
          })}
          {mapped.map((s) => {
            const [x, y] = xy(s.lat, s.lon);
            const cls = [
              "kzmap-pin",
              s.location === "district" ? "approx" : "",
              s.data === "history" ? "history" : "",
              s.id === focusId ? "focus" : "",
            ].join(" ");
            return (
              <g
                key={s.id}
                className={cls}
                tabIndex={0}
                role="button"
                aria-label={`${s.name}, ${s.region}`}
                onClick={(event) => {
                  event.stopPropagation();
                  if (placement) placement.onPick(s.lat, s.lon);
                  else setFocusId(s.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    if (placement) placement.onPick(s.lat, s.lon);
                    else setFocusId(s.id);
                  }
                }}
              >
                <title>{s.name}</title>
                {s.data === "history" && <circle className="kzmap-halo" cx={x} cy={y} r={radius(s) + 7} />}
                <circle cx={x} cy={y} r={radius(s)} />
              </g>
            );
          })}
          {placement?.markers?.map((m) => {
            const [x, y] = xy(m.lat, m.lon);
            return <g key={m.id} className="kzmap-draft" role="button" tabIndex={0}
              aria-label={`Новая турбина: ${m.label}`} transform={`translate(${x},${y})`}
              onClick={(event) => { event.stopPropagation(); m.onSelect(); }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") { event.preventDefault(); m.onSelect(); }
              }}>
              <title>{m.label}</title><circle r="10" /><path d="M0 5V-6M0-6V-15M0-6L-8-1M0-6L8-1" />
            </g>;
          })}
          {placement?.point && Number.isFinite(placement.point.lat) && Number.isFinite(placement.point.lon) &&
            <g className="kzmap-new-point" transform={`translate(${xy(placement.point.lat, placement.point.lon).join(",")})`}>
              <circle r="19" /><path d="M0 10V-10M0-10V-24M0-10L-12-3M0-10L12-3" />
            </g>}
        </svg>
        <ul className="kzmap-legend">
          <li><i className="lg history" />есть данные SCADA</li>
          <li><i className="lg" />координаты из OSM</li>
          <li><i className="lg approx" />известен только район</li>
          <li className="dim">размер — мощность</li>
          {placement && <li>Зелёный ветряк — новая турбина</li>}
        </ul>
      </div>

      {!placement && <aside className="kzmap-card" aria-live="polite">
        {focus ? (
          <>
            <span className="kzmap-region">{focus.region}</span>
            <h2>{focus.name}</h2>
            <dl>
              <dt>Мощность</dt>
              <dd>
                {focus.capacity_mw != null ? `${mw(focus.capacity_mw)} МВт` : "не опубликована"}
                {focus.capacity_source && <small> · {focus.capacity_source === "registry" ? "реестр Минэнерго" : "OSM"}</small>}
              </dd>
              <dt>{focus.kind === "solar" ? "Блоки" : "Турбины"}</dt>
              <dd>
                {focus.units.length > 0 ? focus.units.length : "не нанесены"}
                {(() => {
                  const models = [...new Set(focus.units.map((u) => u.model).filter(Boolean))];
                  return models.length > 0 && <small> · {models.join(", ")}</small>;
                })()}
              </dd>
              <dt>Оператор</dt>
              <dd>{focus.operators?.length ? focus.operators.join(", ") : "не установлен"}</dd>
              {focus.commissioned && (
                <>
                  <dt>Ввод</dt>
                  <dd>{focus.commissioned}</dd>
                </>
              )}
              <dt>Координаты</dt>
              <dd>
                {focus.lat?.toFixed(4)}° N, {focus.lon?.toFixed(4)}° E
                {focus.location && <small> · {LOCATION_LABEL[focus.location]}</small>}
              </dd>
            </dl>
            {focus.note && <p className="kzmap-note">{focus.note}</p>}
            {canOpen(focus) ? (
              <button className="kzmap-open" onClick={() => onOpen(focus)}>
                {focus.data === "history" || focus.kind === "solar" ? "Открыть прогноз" : "Открыть станцию · прогноз демо"}
              </button>
            ) : (
              <p className="kzmap-note">Расположение турбин неизвестно — 3D-обзор недоступен.</p>
            )}
          </>
        ) : (
          <p className="kzmap-note">Нажмите на станцию на карте.</p>
        )}
      </aside>}
    </div>
  );
}
