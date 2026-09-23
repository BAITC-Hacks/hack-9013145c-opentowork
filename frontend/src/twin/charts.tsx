import { useEffect, useRef, useState } from "react";
import type { ForecastPoint } from "../api";
import { fmtDayTime, pct } from "./data";

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(200, e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function path(xs: number[], ys: number[]): string {
  return xs.map((x, i) => `${i ? "L" : "M"}${x.toFixed(1)},${ys[i].toFixed(1)}`).join("");
}

export interface Series {
  show: { actual: boolean; baseline: boolean; band: boolean };
  scenario?: number[] | null;
}

interface ChartProps extends Series {
  points: ForecastPoint[];
  cursor: number;
  onCursor?: (i: number) => void;
  height?: number;
}

export function ForecastChart({ points, cursor, onCursor, height = 230, show, scenario }: ChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 38, r: 12, t: 12, b: 26 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const n = points.length;
  if (!n) return <div ref={ref} style={{ height }} />;

  const x = (i: number) => pad.l + (i / Math.max(1, n - 1)) * w;
  const y = (v: number) => pad.t + (1 - v) * h;
  const xs = points.map((_, i) => x(i));
  const band =
    path(xs, points.map((p) => y(p.p90))) +
    [...points].reverse().map((p, k) => `L${x(n - 1 - k).toFixed(1)},${y(p.p10).toFixed(1)}`).join("") +
    "Z";
  const hasActual = points.some((p) => p.actual != null);
  const active = hover ?? cursor;
  const ap = points[active];

  const pick = (evt: React.MouseEvent<SVGSVGElement>) => {
    const box = evt.currentTarget.getBoundingClientRect();
    const i = Math.round(((evt.clientX - box.left - pad.l) / w) * (n - 1));
    return Math.min(n - 1, Math.max(0, i));
  };

  return (
    <div ref={ref} className="chart">
      <svg
        width={width}
        height={height}
        onMouseMove={(e) => setHover(pick(e))}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => onCursor?.(pick(e))}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={pad.l + w} y1={y(v)} y2={y(v)} className="grid-line" />
            <text x={pad.l - 6} y={y(v) + 4} className="axis" textAnchor="end">
              {v * 100}
            </text>
          </g>
        ))}
        {points.map((p, i) =>
          (p.forecast_for.slice(11, 13) === "00" || i === 0) && x(i) < pad.l + w - 70 ? (
            <g key={p.forecast_for}>
              <line x1={x(i)} x2={x(i)} y1={pad.t} y2={pad.t + h} className="grid-line day" />
              <text x={x(i) + 4} y={height - 8} className="axis">
                {fmtDayTime(p.forecast_for)}
              </text>
            </g>
          ) : p.forecast_for.slice(11, 13) === "12" ? (
            <text key={p.forecast_for} x={x(i)} y={height - 8} className="axis" textAnchor="middle">
              12:00
            </text>
          ) : null,
        )}
        {show.band && <path d={band} className="band" />}
        {show.baseline && (
          <path d={path(xs, points.map((p) => y(p.baseline ?? 0)))} className="line baseline" />
        )}
        {show.actual && hasActual && (
          <path
            d={path(
              xs.filter((_, i) => points[i].actual != null),
              points.filter((p) => p.actual != null).map((p) => y(p.actual ?? 0)),
            )}
            className="line actual"
          />
        )}
        <path d={path(xs, points.map((p) => y(p.p50)))} className="line p50" />
        {scenario && <path d={path(xs, scenario.map(y))} className="line scenario" />}
        <line x1={x(active)} x2={x(active)} y1={pad.t} y2={pad.t + h} className="cursor" />
        <circle cx={x(active)} cy={y(ap.p50)} r={4} className="dot" />
      </svg>
      <div
        className="chart-tip"
        style={{ left: Math.min(width - 190, Math.max(0, x(active) + 12)), top: 8 }}
      >
        <b>{fmtDayTime(ap.forecast_for)}</b> <span className="dim">+{ap.horizon_h} ч</span>
        <div>
          P50 <b>{pct(ap.p50)}</b> <span className="dim">[{pct(ap.p10)}–{pct(ap.p90)}]</span>
        </div>
        {ap.actual != null && (
          <div>
            Факт <b>{pct(ap.actual)}</b>{" "}
            <span className={Math.abs(ap.actual - ap.p50) > 0.1 ? "bad" : "good"}>
              {ap.actual - ap.p50 >= 0 ? "+" : ""}
              {((ap.actual - ap.p50) * 100).toFixed(0)} п.п.
            </span>
          </div>
        )}
        {scenario && (
          <div>
            Сценарий <b>{pct(scenario[active])}</b>
          </div>
        )}
      </div>
    </div>
  );
}

export function Sparkline({ values, color = "var(--live)" }: { values: number[]; color?: string }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1e-6);
  const w = 120;
  const h = 34;
  const xs = values.map((_, i) => (i / (values.length - 1)) * w);
  const ys = values.map((v) => h - 2 - (v / max) * (h - 4));
  return (
    <svg width={w} height={h} className="spark">
      <path d={`${path(xs, ys)}L${w},${h}L0,${h}Z`} fill={color} opacity={0.15} />
      <path d={path(xs, ys)} fill="none" stroke={color} strokeWidth={1.6} />
    </svg>
  );
}

interface LinesProps {
  series: { name: string; color: string; values: number[]; dashed?: boolean }[];
  labels: string[];
  height?: number;
  unit?: (v: number) => string;
}

export function LineChart({ series, labels, height = 220, unit = (v) => v.toFixed(2) }: LinesProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const pad = { l: 44, r: 12, t: 12, b: 26 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const n = labels.length;
  const max = Math.max(...series.flatMap((s) => s.values), 1e-6) * 1.1;
  const x = (i: number) => pad.l + (i / Math.max(1, n - 1)) * w;
  const y = (v: number) => pad.t + (1 - v / max) * h;
  const step = Math.max(1, Math.ceil(n / 7));
  return (
    <div ref={ref} className="chart">
      <svg width={width} height={height}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={pad.l} x2={pad.l + w} y1={y(max * f)} y2={y(max * f)} className="grid-line" />
            <text x={pad.l - 6} y={y(max * f) + 4} className="axis" textAnchor="end">
              {unit(max * f)}
            </text>
          </g>
        ))}
        {labels.map((l, i) =>
          i % step === 0 ? (
            <text key={l} x={x(i)} y={height - 8} className="axis" textAnchor="middle">
              {l}
            </text>
          ) : null,
        )}
        {series.map((s) => (
          <path
            key={s.name}
            d={path(labels.map((_, i) => x(i)), s.values.map(y))}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeDasharray={s.dashed ? "5 4" : undefined}
          />
        ))}
      </svg>
      <div className="legend-row">
        {series.map((s) => (
          <span key={s.name}>
            <i style={{ background: s.color }} /> {s.name}
          </span>
        ))}
      </div>
    </div>
  );
}
