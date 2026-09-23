import { useEffect, useRef } from "react";
import type { ForecastPoint, SourceKind, Turbine } from "../api";
import { SITE } from "./demo";

// Визуализация — только отображение прогноза: поле, частицы и след
// турбины в ML-расчёте не участвуют (ТЗ §24). Модель следа — упрощённая
// Jensen, её хватает, чтобы показать, почему T2 даёт меньше T1.

export interface Layers {
  speed: boolean;
  direction: boolean;
  wake: boolean;
  terrain: boolean;
  solar: boolean;
}

interface Props {
  point: ForecastPoint | null;
  kind: SourceKind;
  units: Turbine[]; // турбины ВЭС или блоки панелей СЭС
  labels: Record<string, { main: string; sub: string }>;
  layers: Layers;
  tilt: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
  sun: { elevation: number; azimuth: number };
  solarOutput: number;
}

const WORLD_W = 3200; // метров по ширине плоскости
const GRID_W = 128;
const PERSPECTIVE = 900;
const PLANE_SCALE = 1.45;
const HUB_M = 100;
const ROTOR_M = 55;
const EXAGGERATE = 2.4;
const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const SOLAR = { x: 640, y: -160, w: 460, h: 260 };
const BLOCK = { w: 380, h: 210 };

function worldOf(t: Turbine) {
  const x = (t.lon - SITE.lon) * Math.cos((SITE.lat * Math.PI) / 180) * 111_320;
  const y = -(t.lat - SITE.lat) * 110_540;
  return { x, y };
}

// Шкала привязана к физике турбины, а не к радуге: ниже cut-in поле почти
// прозрачное (энергии нет), рабочий участок кривой — оттенки ледника,
// номинал — глубокий синий, а к cut-out — натриевый янтарь, как тревога.
type Stop = [number, [number, number, number], number];
const STOPS: Stop[] = [
  [0, [190, 214, 218], 0],
  [3, [150, 210, 214], 30],
  [7, [104, 196, 206], 120],
  [12.5, [34, 112, 138], 175],
  [18, [24, 58, 92], 195],
  [21, [240, 164, 58], 205],
  [25, [196, 64, 38], 225],
];

export const SPEED_MARKS: [number, string][] = [
  [3, "cut-in"],
  [12.5, "номинал"],
  [25, "cut-out"],
];

export function speedColor(v: number): [number, number, number, number] {
  for (let i = 1; i < STOPS.length; i += 1) {
    if (v <= STOPS[i][0]) {
      const [v0, c0, a0] = STOPS[i - 1];
      const [v1, c1, a1] = STOPS[i];
      const f = (v - v0) / (v1 - v0);
      const [r, g, b] = [0, 1, 2].map((k) => Math.round(c0[k] + (c1[k] - c0[k]) * f));
      return [r, g, b, Math.round(a0 + (a1 - a0) * f)];
    }
  }
  const [, c, alpha] = STOPS[STOPS.length - 1];
  return [...c, alpha] as [number, number, number, number];
}

export const LEGEND_GRADIENT = `linear-gradient(to top, ${STOPS.map(
  ([v, c]) => `rgb(${c.join(",")}) ${(v / 25) * 100}%`,
).join(", ")})`;

function fbm(x: number, y: number): number {
  let v = 0;
  let a = 0.5;
  let f = 1;
  for (let o = 0; o < 5; o += 1) {
    v += a * valueNoise(x * f, y * f);
    a *= 0.5;
    f *= 2.03;
  }
  return v;
}

function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const h = (i: number, j: number) => {
    const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const u = xf * xf * (3 - 2 * xf);
  const w = yf * yf * (3 - 2 * yf);
  return (
    h(xi, yi) * (1 - u) * (1 - w) +
    h(xi + 1, yi) * u * (1 - w) +
    h(xi, yi + 1) * (1 - u) * w +
    h(xi + 1, yi + 1) * u * w
  );
}

export default function WindMap(props: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const planeRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const fieldRef = useRef<HTMLCanvasElement>(null);
  const flowRef = useRef<HTMLCanvasElement>(null);
  const overRef = useRef<HTMLCanvasElement>(null);
  const labelRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const propsRef = useRef(props);
  propsRef.current = props;

  // Всё, что меняется каждый кадр, живёт в ref, а не в state: перерисовка
  // React на 60 fps не нужна и заметно грузит слабые ноутбуки на демо.
  const sim = useRef({
    w: 0,
    h: 0,
    dpr: 1,
    angle: 0,
    grid: new Float32Array(0),
    gw: 0,
    gh: 0,
    particles: [] as { x: number; y: number; age: number }[],
    rotor: {} as Record<string, number>,
    hit: {} as Record<string, { x: number; y: number }>,
    last: 0,
  });

  // Размер и статичный рельеф.
  useEffect(() => {
    const wrap = wrapRef.current!;
    const resize = () => {
      const s = sim.current;
      s.w = wrap.clientWidth;
      s.h = wrap.clientHeight;
      s.dpr = Math.min(2, window.devicePixelRatio || 1);
      for (const c of [baseRef.current, fieldRef.current, flowRef.current, overRef.current]) {
        if (!c) continue;
        c.width = Math.round(s.w * s.dpr);
        c.height = Math.round(s.h * s.dpr);
        c.style.width = `${s.w}px`;
        c.style.height = `${s.h}px`;
      }
      s.particles = Array.from({ length: Math.round((s.w * s.h) / 520) }, () => ({
        x: Math.random() * s.w,
        y: Math.random() * s.h,
        age: Math.random() * 120,
      }));
      drawTerrain();
      rebuildField();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    drawTerrain();
  }, [props.layers.terrain]);

  useEffect(() => {
    rebuildField();
  }, [props.point, props.layers.wake, props.layers.speed, props.units, props.kind]);

  const ppm = () => sim.current.w / WORLD_W;
  const toPlane = (x: number, y: number) => ({
    px: sim.current.w / 2 + x * ppm(),
    py: sim.current.h / 2 + y * ppm(),
  });

  function elevationAt(px: number, py: number): number {
    const s = sim.current;
    return fbm((px / s.w) * 3.2 + 4.1, (py / s.w) * 3.2 + 1.7);
  }

  function drawTerrain() {
    const s = sim.current;
    const c = baseRef.current;
    if (!c || !s.w) return;
    const ctx = c.getContext("2d")!;
    const cols = 220;
    const rows = Math.round((cols * s.h) / s.w);
    const img = ctx.createImageData(cols, rows);
    const relief = propsRef.current.layers.terrain;
    for (let j = 0; j < rows; j += 1) {
      for (let i = 0; i < cols; i += 1) {
        const px = (i / cols) * s.w;
        const py = (j / rows) * s.h;
        const e = elevationAt(px, py);
        const ex = elevationAt(px + 6, py) - e;
        // Февраль в степи: снег. Склоны темнеют от бокового света, горизонтали
        // — тонкие сине-серые линии, как на топокарте.
        const shade = relief ? 0.93 + ex * 9 : 0.97;
        const contour = relief && Math.abs(((e * 16) % 1) - 0.5) < 0.035 ? 0.84 : 1;
        const k = (j * cols + i) * 4;
        img.data[k] = (178 + e * 44) * shade * contour;
        img.data[k + 1] = (192 + e * 40) * shade * contour;
        img.data[k + 2] = (198 + e * 36) * shade * contour;
        img.data[k + 3] = 255;
      }
    }
    const tmp = document.createElement("canvas");
    tmp.width = cols;
    tmp.height = rows;
    tmp.getContext("2d")!.putImageData(img, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(tmp, 0, 0, c.width, c.height);
  }

  /** Скорость ветра в точке плоскости: фон + рельеф − следы турбин. */
  function speedAt(px: number, py: number, withWake: boolean): number {
    const p = propsRef.current.point;
    if (!p) return 0;
    let v = p.wind_speed * (0.88 + 0.26 * elevationAt(px, py));
    if (withWake && propsRef.current.kind === "wind") {
      const theta = (((p.wind_dir + 180) % 360) * Math.PI) / 180;
      const dx = Math.sin(theta);
      const dy = -Math.cos(theta);
      const r0 = ROTOR_M * ppm();
      for (const t of propsRef.current.units) {
        const w = worldOf(t);
        const { px: tx, py: ty } = toPlane(w.x, w.y);
        const along = (px - tx) * dx + (py - ty) * dy;
        if (along <= 0) continue;
        const lateral = Math.abs(-(px - tx) * dy + (py - ty) * dx);
        const r = r0 + 0.075 * along;
        if (lateral > r) continue;
        const edge = 1 - (lateral / r) ** 2;
        v *= Math.max(0.35, 1 - 0.55 * (r0 / r) ** 2 * edge * 3.2);
      }
    }
    return Math.max(0, v);
  }

  function rebuildField() {
    const s = sim.current;
    const c = fieldRef.current;
    if (!c || !s.w) return;
    const { layers } = propsRef.current;
    s.gw = GRID_W;
    s.gh = Math.round((GRID_W * s.h) / s.w);
    s.grid = new Float32Array(s.gw * s.gh);
    const img = new ImageData(s.gw, s.gh);
    for (let j = 0; j < s.gh; j += 1) {
      for (let i = 0; i < s.gw; i += 1) {
        const v = speedAt(((i + 0.5) / s.gw) * s.w, ((j + 0.5) / s.gh) * s.h, layers.wake);
        s.grid[j * s.gw + i] = v;
        const [r, g, b, alpha] = speedColor(v);
        const k = (j * s.gw + i) * 4;
        img.data[k] = r;
        img.data[k + 1] = g;
        img.data[k + 2] = b;
        img.data[k + 3] = alpha;
      }
    }
    const ctx = c.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    if (!layers.speed) return;
    const tmp = document.createElement("canvas");
    tmp.width = s.gw;
    tmp.height = s.gh;
    tmp.getContext("2d")!.putImageData(img, 0, 0);
    ctx.imageSmoothingQuality = "high";
    ctx.filter = "blur(6px)";
    ctx.drawImage(tmp, 0, 0, c.width, c.height);
    ctx.filter = "none";
  }

  function gridSpeed(px: number, py: number): number {
    const s = sim.current;
    const i = Math.min(s.gw - 1, Math.max(0, Math.floor((px / s.w) * s.gw)));
    const j = Math.min(s.gh - 1, Math.max(0, Math.floor((py / s.h) * s.gh)));
    return s.grid[j * s.gw + i] ?? 0;
  }

  /** Та же матрица, что у CSS: perspective · rotateX · scale, вокруг центра. */
  function project(px: number, py: number) {
    const s = sim.current;
    const x = (px - s.w / 2) * PLANE_SCALE;
    const y = (py - s.h / 2) * PLANE_SCALE;
    const a = s.angle;
    const z = y * Math.sin(a);
    const k = PERSPECTIVE / (PERSPECTIVE - z);
    return { sx: s.w / 2 + x * k, sy: s.h / 2 + y * Math.cos(a) * k, k };
  }

  // Главный цикл отрисовки.
  useEffect(() => {
    let raf = 0;
    const frame = (now: number) => {
      const s = sim.current;
      const P = propsRef.current;
      const dt = Math.min(0.05, (now - (s.last || now)) / 1000);
      s.last = now;
      const target = P.tilt ? (52 * Math.PI) / 180 : 0;
      s.angle = reducedMotion() ? target : s.angle + (target - s.angle) * Math.min(1, dt * 5);
      if (planeRef.current) {
        planeRef.current.style.transform = `perspective(${PERSPECTIVE}px) rotateX(${s.angle}rad) scale(${PLANE_SCALE})`;
      }
      drawFlow(dt);
      drawOverlay(dt);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  function drawFlow(dt: number) {
    const s = sim.current;
    const c = flowRef.current;
    const P = propsRef.current;
    if (!c || !s.w) return;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "rgba(0,0,0,0.09)";
    ctx.fillRect(0, 0, s.w, s.h);
    ctx.globalCompositeOperation = "source-over";
    if (!P.layers.direction || !P.point) return;
    const theta = (((P.point.wind_dir + 180) % 360) * Math.PI) / 180;
    const dx = Math.sin(theta);
    const dy = -Math.cos(theta);
    ctx.lineWidth = 1.1;
    ctx.strokeStyle = "rgba(11,20,24,0.42)";
    ctx.beginPath();
    for (const p of s.particles) {
      const v = gridSpeed(p.x, p.y);
      const wobble = Math.sin(p.y * 0.02 + p.x * 0.013) * 0.25;
      // При reduced motion штрихи стоят на месте и показывают только направление.
      const still = reducedMotion();
      const step = still ? 3 + v * 0.6 : (4 + v * 3.2) * dt * 10;
      const nx = p.x + (dx - dy * wobble) * step;
      const ny = p.y + (dy + dx * wobble) * step;
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(nx, ny);
      if (still) continue;
      p.x = nx;
      p.y = ny;
      p.age += 1;
      if (p.age > 140 || p.x < -5 || p.y < -5 || p.x > s.w + 5 || p.y > s.h + 5) {
        p.x = Math.random() * s.w;
        p.y = Math.random() * s.h;
        p.age = 0;
      }
    }
    ctx.stroke();
  }

  function drawOverlay(dt: number) {
    const s = sim.current;
    const c = overRef.current;
    const P = propsRef.current;
    if (!c || !s.w) return;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
    ctx.clearRect(0, 0, s.w, s.h);

    if (P.kind === "wind" && P.layers.solar) drawPanels(ctx, SOLAR, P.solarOutput, false);

    if (P.kind === "solar") {
      for (const u of P.units) {
        const w = worldOf(u);
        const rect = { x: w.x - BLOCK.w / 2, y: w.y - BLOCK.h / 2, w: BLOCK.w, h: BLOCK.h };
        const power = P.point?.per_turbine?.[u.id] ?? P.point?.p50 ?? 0;
        drawPanels(ctx, rect, power, P.selected === u.id);
        const top = project(...xy(toPlane(w.x, rect.y)));
        const mid = project(...xy(toPlane(w.x, w.y)));
        s.hit[u.id] = { x: mid.sx, y: mid.sy };
        const label = labelRefs.current[u.id];
        if (label) label.style.transform = `translate(${top.sx - 30}px, ${top.sy - 52}px)`;
      }
      return;
    }

    const yawDeg = P.point ? P.point.wind_dir : 270;
    const face = Math.max(0.45, Math.abs(Math.cos((yawDeg * Math.PI) / 180)));
    const sorted = [...P.units]
      .map((t) => ({ t, w: worldOf(t) }))
      .sort((a, b) => a.w.y - b.w.y);
    for (const { t, w } of sorted) {
      const { px, py } = toPlane(w.x, w.y);
      const { sx, sy, k } = project(px, py);
      const scale = ppm() * PLANE_SCALE * k * EXAGGERATE;
      const power = P.point?.per_turbine?.[t.id] ?? P.point?.p50 ?? 0;
      const rpm = power > 0.01 && !reducedMotion() ? 5 + 11 * power : 0;
      s.rotor[t.id] = ((s.rotor[t.id] ?? Math.random() * 6) + (rpm / 60) * 2 * Math.PI * dt) % (2 * Math.PI);
      if (P.sun.elevation > 2) drawShadow(ctx, px, py, scale);
      drawTurbine(ctx, sx, sy, scale, s.rotor[t.id], face, P.selected === t.id);
      s.hit[t.id] = { x: sx, y: sy - (HUB_M * scale) / 2 };
      const label = labelRefs.current[t.id];
      if (label) label.style.transform = `translate(${sx + 16 * Math.max(0.7, k)}px, ${sy - HUB_M * scale - 12}px)`;
    }
  }

  const xy = (p: { px: number; py: number }): [number, number] => [p.px, p.py];

  /** Клик по самому объекту на карте, а не только по подписи. */
  function unitAt(evt: React.MouseEvent): string | null {
    const box = wrapRef.current!.getBoundingClientRect();
    const x = evt.clientX - box.left;
    const y = evt.clientY - box.top;
    let best: string | null = null;
    let bestD = 70;
    for (const [id, p] of Object.entries(sim.current.hit)) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }

  function drawTurbine(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    scale: number,
    angle: number,
    face: number,
    selected: boolean,
  ) {
    const hub = HUB_M * scale;
    const rotor = ROTOR_M * scale;
    ctx.save();
    // Тень и основание.
    ctx.fillStyle = "rgba(11,20,24,0.28)";
    ctx.beginPath();
    ctx.ellipse(x, y, 9 * scale * 3, 3.2 * scale * 3, 0, 0, Math.PI * 2);
    ctx.fill();
    if (selected) {
      ctx.strokeStyle = "#f0a43a";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(x, y, 14 * scale * 3, 5 * scale * 3, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    const grad = ctx.createLinearGradient(x - 3, 0, x + 3, 0);
    grad.addColorStop(0, "#9aa9ad");
    grad.addColorStop(0.5, "#f4f7f7");
    grad.addColorStop(1, "#7d8c90");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(x - 2.4 * scale * 1.4, y);
    ctx.lineTo(x + 2.4 * scale * 1.4, y);
    ctx.lineTo(x + 1.1 * scale * 1.4, y - hub);
    ctx.lineTo(x - 1.1 * scale * 1.4, y - hub);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(11,20,24,0.35)";
    ctx.lineWidth = 0.8;
    ctx.stroke();
    // Гондола.
    ctx.fillStyle = "#e8edf2";
    ctx.beginPath();
    ctx.ellipse(x, y - hub, 4.5 * scale * (0.4 + (1 - face)), 2.6 * scale, 0, 0, Math.PI * 2);
    ctx.fill();
    // Лопасти: сплющены по x, если ротор развёрнут боком к зрителю.
    ctx.fillStyle = "#f5f8fb";
    ctx.strokeStyle = "rgba(11,20,24,0.55)";
    ctx.lineWidth = 0.8;
    for (let b = 0; b < 3; b += 1) {
      const a = angle + (b * 2 * Math.PI) / 3;
      const tipX = x + Math.cos(a) * rotor * face;
      const tipY = y - hub + Math.sin(a) * rotor;
      const nx = -Math.sin(a) * 3.6 * scale * face;
      const ny = Math.cos(a) * 3.6 * scale;
      ctx.beginPath();
      ctx.moveTo(x + nx, y - hub + ny);
      ctx.quadraticCurveTo(
        x + Math.cos(a) * rotor * 0.35 * face + nx * 1.6,
        y - hub + Math.sin(a) * rotor * 0.35 + ny * 1.6,
        tipX,
        tipY,
      );
      ctx.lineTo(x - nx * 0.4, y - hub - ny * 0.4);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(x, y - hub, 2.2 * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawPanels(
    ctx: CanvasRenderingContext2D,
    rect: { x: number; y: number; w: number; h: number },
    glow: number,
    selected: boolean,
  ) {
    const rows = 6;
    const cols = 10;
    for (let r = 0; r < rows; r += 1) {
      for (let q = 0; q < cols; q += 1) {
        const x0 = rect.x + (q / cols) * rect.w;
        const y0 = rect.y + (r / rows) * rect.h;
        const cw = (rect.w / cols) * 0.86;
        const ch = (rect.h / rows) * 0.62;
        const corners = [
          [x0, y0],
          [x0 + cw, y0],
          [x0 + cw, y0 + ch],
          [x0, y0 + ch],
        ].map(([wx, wy]) => project(...xy(toPlane(wx, wy))));
        ctx.beginPath();
        corners.forEach((p, i) => (i ? ctx.lineTo(p.sx, p.sy) : ctx.moveTo(p.sx, p.sy)));
        ctx.closePath();
        ctx.fillStyle = `rgb(${18 + glow * 30}, ${32 + glow * 44}, ${46 + glow * 70})`;
        ctx.fill();
        ctx.strokeStyle = "rgba(230,238,236,0.4)";
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }
    }
    if (selected) {
      const pad = 24;
      const frame = [
        [rect.x - pad, rect.y - pad],
        [rect.x + rect.w + pad, rect.y - pad],
        [rect.x + rect.w + pad, rect.y + rect.h + pad],
        [rect.x - pad, rect.y + rect.h + pad],
      ].map(([wx, wy]) => project(...xy(toPlane(wx, wy))));
      ctx.beginPath();
      frame.forEach((p, i) => (i ? ctx.lineTo(p.sx, p.sy) : ctx.moveTo(p.sx, p.sy)));
      ctx.closePath();
      ctx.strokeStyle = "#f0a43a";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  /** Тень от реального положения солнца: так видно, как оно движется. */
  function drawShadow(ctx: CanvasRenderingContext2D, px: number, py: number, scale: number) {
    const { elevation, azimuth } = propsRef.current.sun;
    const len = Math.min(4, 1 / Math.tan((elevation * Math.PI) / 180)) * HUB_M * ppm() * EXAGGERATE;
    const a = ((azimuth + 180) * Math.PI) / 180;
    const base = project(px, py);
    const tip = project(px + Math.sin(a) * len, py - Math.cos(a) * len);
    ctx.save();
    ctx.strokeStyle = "rgba(24,44,58,0.3)";
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(1.5, 2.2 * scale);
    ctx.beginPath();
    ctx.moveTo(base.sx, base.sy);
    ctx.lineTo(tip.sx, tip.sy);
    ctx.stroke();
    ctx.restore();
  }

  const P = props;
  return (
    <div
      className="map"
      ref={wrapRef}
      onClick={(e) => {
        const id = unitAt(e);
        if (id) P.onSelect(id);
      }}
      onMouseMove={(e) => {
        e.currentTarget.style.cursor = unitAt(e) ? "pointer" : "default";
      }}
    >
      <div className="map-sky" />
      <div className="map-plane" ref={planeRef}>
        <canvas ref={baseRef} />
        <canvas ref={fieldRef} />
        <canvas ref={flowRef} />
      </div>
      <canvas ref={overRef} className="map-over" />
      {P.units.map((t) => {
        const label = P.labels[t.id];
        return (
          <button
            key={t.id}
            ref={(el) => {
              labelRefs.current[t.id] = el;
            }}
            className={`turbine-label ${P.selected === t.id ? "active" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              P.onSelect(t.id);
            }}
            aria-pressed={P.selected === t.id}
            aria-label={`${t.name}: ${label?.main ?? ""}. Открыть показатели`}
          >
            <div className="tl-head">
              <b>{t.id}</b> <span>{label?.sub}</span>
            </div>
            <div className="tl-wind">{label?.main ?? "—"}</div>
          </button>
        );
      })}
    </div>
  );
}
