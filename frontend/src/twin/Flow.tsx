import { useId, useMemo } from "react";
import type { SourceKind, Station } from "../api";
import { mw, stationRated } from "./data";
import KzMap from "./KzMap";
import type { Mode, Route } from "./data";
import { demoRun, demoSolarRun, DEMO_STATIONS } from "./demo";
import "./flow-refresh.css";

const STEP_NAMES = ["Задача", "Источник", "Станция", "Обзор"];

export function StepBar({ step, mode }: { step: number; mode?: Mode }) {
  const names = mode === "place" ? ["Задача", "Источник", "Место"] : STEP_NAMES;
  return (
    <ol className="stepbar" aria-label="Шаги">
      {names.map((name, i) => (
        <li
          key={name}
          className={i < step ? "done" : i === step ? "current" : ""}
          aria-current={i === step ? "step" : undefined}
        >
          <span className="stepbar-n">{i < step ? "✓" : i + 1}</span>
          {name}
        </li>
      ))}
    </ol>
  );
}

function Arrow() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <path
        d="M4 10h11M10 5l5 5-5 5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SourceIcon({ kind }: { kind: "wind" | "solar" | "roofs" | "place" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "wind" ? (
        <>
          <path d="M12 11v10M12 9l-1-7c3 1 3 4 1 7ZM10 10l-7 3c0-3 3-4 7-3ZM13 10l5 5c-3 1-5-1-5-5Z" />
          <circle cx="12" cy="10" r="1.5" />
        </>
      ) : kind === "solar" ? (
        <>
          <circle cx="7" cy="6" r="3" />
          <path d="M7 1V0M1 6H0M12 2l1-1M3 2 2 1M6 12h14l2 9H3l3-9ZM5 16h16M11 12l-1 9M15 12l1 9" />
        </>
      ) : kind === "roofs" ? (
        <>
          <path d="m2 10 10-7 10 7M5 9v12h14V9M8 8h8l2 5H6l2-5ZM11 9v3M15 9v3M10 17h4v4" />
        </>
      ) : (
        <>
          <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z" />
          <circle cx="12" cy="10" r="2.5" />
        </>
      )}
    </svg>
  );
}

/** Small original illustrations; overview cards never depend on remote image services. */
function EnergyArtwork({ kind }: { kind: "wind" | "solar" | "roofs" }) {
  const id = useId().replace(/:/g, "");
  const solar = kind !== "wind";
  const panel = (x: number, y: number, size = 1) => (
    <g transform={`translate(${x} ${y}) scale(${size})`}>
      <path
        d="m0 0 45-9 18 13-45 10Z"
        fill="#294861"
        stroke="#a2b8c9"
        strokeWidth=".8"
      />
      <path
        d="m9-2 18 14M18-4 18 14M27-5 18 14M36-7 18 14M7 5l45-10"
        stroke="#6c899d"
        strokeWidth=".65"
      />
      <path d="M18 14v5M56 6v6" stroke="#8599a8" strokeWidth="2" />
    </g>
  );
  const turbine = (x: number, y: number, size: number) => (
    <g transform={`translate(${x} ${y}) scale(${size})`}>
      <ellipse
        cx="25"
        cy="13"
        rx="34"
        ry="4"
        fill="#638a7b"
        opacity=".17"
        transform="rotate(24)"
      />
      <path
        d="m-3 0 2-94h3L5 0Z"
        fill={`url(#${id}tower)`}
        stroke="#c1cfd0"
        strokeWidth=".4"
      />
      <ellipse cx="1" cy="1" rx="8" ry="3" fill="#c2cfca" />
      <path
        d="M1-94 0-143c5 3 6 32 1 49ZM-1-92l-42 27c1-6 26-24 42-27ZM3-92l36 28c-7 1-30-16-36-28Z"
        fill="#fff"
        stroke="#c8d6d4"
        strokeWidth=".5"
      />
      <rect x="-3" y="-98" width="11" height="6" rx="2" fill="#e1e9e8" />
      <circle cx="1" cy="-94" r="3.5" fill="#fff" stroke="#bfceca" />
    </g>
  );
  const building = (
    x: number,
    y: number,
    w: number,
    h: number,
    tall: number,
  ) => (
    <g transform={`translate(${x} ${y})`}>
      <path d={`M0 0 ${w} 14 ${w + h} 1 ${h} -13Z`} fill="#f8f6ef" />
      <path d={`M0 0v${tall}l${w} 14V14Z`} fill="#c0c9c9" />
      <path d={`M${w} 14v${tall}l${h}-13V1Z`} fill="#98a9ae" />
      <path
        d={`M3 4v${tall - 6}M9 6v${tall - 6}M15 8v${tall - 6}M21 10v${tall - 6}`}
        stroke="#e9eeec"
        strokeWidth="2.2"
      />
      <path
        d={`M${w + 5} 15v${tall - 7}M${w + 11} 12v${tall - 7}M${w + 17} 9v${tall - 7}`}
        stroke="#c4d3d3"
        strokeWidth="2"
      />
    </g>
  );
  return (
    <svg
      viewBox="0 0 360 210"
      className={`energy-art energy-art-${kind}`}
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id={`${id}bg`}
          x1="20"
          y1="0"
          x2="330"
          y2="210"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor={solar ? "#fcf6e8" : "#edf6f2"} />
          <stop offset="1" stopColor={solar ? "#f4ebda" : "#dcebe4"} />
        </linearGradient>
        <linearGradient id={`${id}tower`}>
          <stop stopColor="#bacac6" />
          <stop offset=".55" stopColor="#fff" />
          <stop offset="1" stopColor="#e6eeeb" />
        </linearGradient>
      </defs>
      <path d="M0 0h360v210H0z" fill={`url(#${id}bg)`} />
      <circle
        cx="291"
        cy="49"
        r={solar ? 25 : 31}
        fill={solar ? "#e9bb56" : "#fff"}
        opacity={solar ? ".65" : ".7"}
      />
      <path
        d="M0 147c70-47 139-11 202-34s106-12 158 2v95H0Z"
        fill={solar ? "#d5d5bd" : "#abc4b0"}
        opacity=".45"
      />
      <path
        d="M0 168c71-39 123 15 200-10s114-14 160 7v45H0Z"
        fill={solar ? "#b9c5ad" : "#87ac96"}
        opacity=".24"
      />
      <path
        d="M21 210c68-23 87-73 149-61s85 6 155-41"
        stroke={solar ? "#f5f0e1" : "#e8e8d8"}
        strokeWidth="9"
      />
      {kind === "wind" ? (
        <>
          {turbine(266, 143, 0.55)}
          {turbine(163, 149, 0.76)}
          {turbine(83, 183, 1.03)}
          <path d="m189 179 31-7 23 14-31 8Z" fill="#98aea3" opacity=".35" />
          {panel(186, 161, 0.72)}
          {panel(224, 152, 0.72)}
        </>
      ) : kind === "solar" ? (
        <>
          {[0, 1, 2].map((r) => (
            <g key={r}>
              {[0, 1, 2, 3].map((c) => (
                <g key={c}>
                  {panel(42 + c * 59 + r * 8, 101 + r * 28 - c * 2, 0.9)}
                </g>
              ))}
            </g>
          ))}
          <path d="m274 167 32-7 13 9-32 8Z" fill="#f7f4e9" />
          <path d="m274 167 13 10v16l-13-10Z" fill="#c7cfc5" />
          <path d="m287 177 32-8v16l-32 8Z" fill="#99aba5" />
        </>
      ) : (
        <>
          <path d="m0 193 297-84 63 25-292 76Z" fill="#b3bcba" />
          <path
            d="m0 185 293-79M18 210l310-91"
            stroke="#f5f3e9"
            strokeWidth="2"
          />
          {building(218, 88, 36, 26, 47)}
          {building(125, 87, 53, 31, 64)}
          {panel(135, 83, 0.6)}
          {building(57, 142, 45, 26, 38)}
          {panel(66, 138, 0.56)}
          {building(230, 159, 35, 25, 34)}
          {panel(237, 153, 0.49)}
          <g fill="#7e9e7e">
            <ellipse cx="32" cy="151" rx="8" ry="13" />
            <ellipse cx="196" cy="163" rx="7" ry="11" />
            <ellipse cx="323" cy="153" rx="10" ry="14" />
          </g>
        </>
      )}
    </svg>
  );
}

function Choice({
  title,
  text,
  meta,
  kind,
  onClick,
}: {
  title: string;
  text: string;
  meta?: string;
  kind: "wind" | "solar" | "roofs";
  onClick: () => void;
}) {
  return (
    <button className={`choice refresh-choice ${kind}`} onClick={onClick}>
      <span className="choice-icon">
        <SourceIcon kind={kind} />
      </span>
      <span className="choice-title">{title}</span>
      <span className="choice-text">{text}</span>
      {meta && <span className="choice-meta">{meta}</span>}
      <span className="choice-go">
        <Arrow />
      </span>
    </button>
  );
}

export function Home({
  go,
  lastStation,
  stations = DEMO_STATIONS,
}: {
  go: (r: Route) => void;
  lastStation: Station | null;
  stations?: Station[];
}) {
  const openSource = (kind: SourceKind) => {
    const station = stations.find((s) => s.kind === kind && s.data !== "none");
    go(
      station
        ? { page: "station", kind, stationId: station.id, tab: "map" }
        : { page: "stations", kind },
    );
  };
  return (
    <div className="flow flow-refresh overview">
      <div className="overview-heading">
        <div>
          <div className="flow-eyebrow">РАБОЧЕЕ ПРОСТРАНСТВО</div>
          <h1>Энергия под вашим контролем.</h1>
          <p>
            От прогноза выработки до выбора крыши для солнечных панелей — в
            одном пространстве.
          </p>
        </div>
        <span className="overview-badge">
          <span />
          Демонстрационная среда
        </span>
      </div>
      {lastStation && (
        <button
          className="overview-resume"
          onClick={() =>
            go({
              page: "station",
              kind: lastStation.kind,
              stationId: lastStation.id,
              tab: "map",
            })
          }
        >
          <span className={`overview-resume-icon ${lastStation.kind}`}>
            <SourceIcon kind={lastStation.kind} />
          </span>
          <span>
            Продолжить работу <b>{lastStation.name}</b>
          </span>
          <Arrow />
        </button>
      )}
      <div className="overview-section-heading">
        <h2>С чего начнём?</h2>
        <span>Выберите свой сценарий</span>
      </div>
      <div className="energy-projects">
        <button
          className="energy-project wind"
          onClick={() => openSource("wind")}
        >
          <div className="energy-project-art">
            <EnergyArtwork kind="wind" />
            <span className="energy-project-tag">ВЕТРОВАЯ ЭНЕРГИЯ</span>
          </div>
          <div className="energy-project-body">
            <div className="energy-project-title">
              <h3>Ветровые станции</h3>
              <Arrow />
            </div>
            <p>
              Прогноз выработки, состояние турбин и детальная 3D-сцена станции.
            </p>
            <span className="energy-project-foot">
              <SourceIcon kind="wind" />
              Прогноз на 24–48 часов
            </span>
          </div>
        </button>
        <button
          className="energy-project solar"
          onClick={() => openSource("solar")}
        >
          <div className="energy-project-art">
            <EnergyArtwork kind="solar" />
            <span className="energy-project-tag">СОЛНЕЧНАЯ ЭНЕРГИЯ</span>
          </div>
          <div className="energy-project-body">
            <div className="energy-project-title">
              <h3>Солнечные станции</h3>
              <Arrow />
            </div>
            <p>
              Выработка панелей с учётом солнечной радиации и погодных условий.
            </p>
            <span className="energy-project-foot">
              <SourceIcon kind="solar" />
              Прогноз по блокам СЭС
            </span>
          </div>
        </button>
        <button
          className="energy-project roofs"
          onClick={() => go({ page: "roofs" })}
        >
          <div className="energy-project-art">
            <EnergyArtwork kind="roofs" />
            <span className="energy-project-tag">ГОРОДСКАЯ ЭНЕРГИЯ</span>
          </div>
          <div className="energy-project-body">
            <div className="energy-project-title">
              <h3>Панели на крышах</h3>
              <Arrow />
            </div>
            <p>
              Найдите подходящие здания и оцените солнечный потенциал их крыш.
            </p>
            <span className="energy-project-foot">
              <SourceIcon kind="roofs" />
              3D-модель зданий Астаны
            </span>
          </div>
        </button>
      </div>
      <div className="overview-tools">
        <button onClick={() => go({ page: "kind", mode: "forecast" })}>
          <span className="overview-tool-icon">
            <SourceIcon kind="wind" />
          </span>
          <span>
            <b>Все станции</b>
            <small>Выбрать объект для прогноза</small>
          </span>
          <Arrow />
        </button>
        <button onClick={() => go({ page: "kind", mode: "place" })}>
          <span className="overview-tool-icon">
            <SourceIcon kind="place" />
          </span>
          <span>
            <b>Новая площадка</b>
            <small>Сравнить потенциал ветра и солнца</small>
          </span>
          <Arrow />
        </button>
      </div>
      <div className="overview-footer">
        <p>Расчёты в демо показывают возможности платформы.</p>
        <button onClick={() => go({ page: "platform" })}>
          Состояние платформы <Arrow />
        </button>
      </div>
    </div>
  );
}

export function KindPick({
  mode,
  stations,
  go,
}: {
  mode: Mode;
  stations: Station[];
  go: (r: Route) => void;
}) {
  const meta = (kind: SourceKind) => {
    if (mode === "place")
      return kind === "wind"
        ? "Новая турбина · расчёт на 24–48 часов"
        : "Карта солнечной радиации";
    const ready = stations.filter(
      (s) => s.kind === kind && s.data !== "none",
    ).length;
    return `${ready} ${plural(ready, "станция доступна", "станции доступны", "станций доступны")}`;
  };
  const next = (kind: SourceKind): Route =>
    mode === "place" ? { page: "place", kind } : { page: "stations", kind };
  return (
    <div className="flow flow-refresh">
      <StepBar step={1} mode={mode} />
      <h1 className="flow-q">
        {mode === "place"
          ? "У каждой площадки свой потенциал."
          : "Какую энергию прогнозируем?"}
      </h1>
      <p className="flow-sub">
        {mode === "place"
          ? "Выберите источник энергии, чтобы изучить подходящие места на карте."
          : "Откройте станцию, чтобы увидеть почасовой прогноз и её объекты в 3D."}
      </p>
      <div className="choices two">
        <Choice
          title="Ветровые станции"
          text={
            mode === "place"
              ? "Поставьте турбину на карту, выберите модель и рассчитайте выработку."
              : "Ветер, работа турбин и ожидаемая выработка."
          }
          meta={meta("wind")}
          kind="wind"
          onClick={() => go(next("wind"))}
        />
        <Choice
          title="Солнечные станции"
          text={
            mode === "place"
              ? "Сравните площадки по солнечному потенциалу."
              : "Солнечная радиация, панели и прогноз по блокам."
          }
          meta={meta("solar")}
          kind="solar"
          onClick={() => go(next("solar"))}
        />
      </div>
      {mode === "place" && (
        <button className="roof-shortcut" onClick={() => go({ page: "roofs" })}>
          <span className="overview-tool-icon">
            <SourceIcon kind="roofs" />
          </span>
          <span>
            <b>Или разместите панели на крыше</b>
            <small>3D-модель Астаны · оценка площади и затенения</small>
          </span>
          <Arrow />
        </button>
      )}
      <button className="back" onClick={() => go({ page: "home" })}>
        ← В рабочее пространство
      </button>
    </div>
  );
}

const DATA_LABEL: Record<Station["data"], string> = {
  history: "Данные истории",
  model: "Расчётная модель",
  none: "Ожидает данные",
};

export function StationPick({
  kind,
  stations,
  originIso,
  go,
}: {
  kind: SourceKind;
  stations: Station[];
  originIso: string;
  go: (r: Route) => void;
}) {
  const list = useMemo(
    () => stations.filter((s) => s.kind === kind),
    [stations, kind],
  );
  const summary = useMemo(() => {
    const out: Record<string, number> = {};
    for (const s of list) {
      if (s.data === "none") continue;
      const run =
        s.kind === "solar"
          ? demoSolarRun(s, originIso, 24)
          : demoRun(originIso, 24);
      out[s.id] =
        run.predictions.reduce((a, p) => a + p.p50, 0) * stationRated(s);
    }
    return out;
  }, [list, originIso]);
  return (
    <div className={`flow flow-refresh station-picker ${kind}`}>
      <StepBar step={2} />
      <div className="station-picker-heading">
        <div>
          <h1 className="flow-q">
            {kind === "wind" ? "Ветровые станции" : "Солнечные станции"}
          </h1>
          <p className="flow-sub">
            Выберите объект, чтобы открыть прогноз и 3D-обзор.
          </p>
        </div>
        <span className="overview-badge">
          {list.length} {plural(list.length, "объект", "объекта", "объектов")}
        </span>
      </div>
      {kind === "wind" && (
        <KzMap
          stations={list}
          onOpen={(s) => go({ page: "station", kind, stationId: s.id, tab: "map" })}
        />
      )}
      <div className="stations">
        {(kind === "wind" ? list.filter((s) => s.data !== "none") : list).map((s) => {
          const disabled = s.data === "none";
          return (
            <button
              key={s.id}
              className="station-card"
              disabled={disabled}
              onClick={() =>
                go({ page: "station", kind, stationId: s.id, tab: "map" })
              }
            >
              <span className="sc-top">
                <span className={`sc-status ${s.data}`}>
                  {DATA_LABEL[s.data]}
                </span>
                <span className="sc-source">
                  <SourceIcon kind={kind} />
                </span>
              </span>
              <span className="sc-name">{s.name}</span>
              <span className="sc-region">{s.region}</span>
              {disabled ? (
                <span className="sc-note">
                  Прогноз появится после подключения данных станции.
                </span>
              ) : (
                <>
                  <span className="sc-stats">
                    <span>
                      <b>
                        {mw(stationRated(s))} <small>МВт</small>
                      </b>
                      Мощность станции
                    </span>
                    <span>
                      <b>
                        {mw(summary[s.id] ?? 0)} <small>МВт·ч</small>
                      </b>
                      За 24 часа · демо
                    </span>
                  </span>
                  <span className="sc-bottom">
                    <span>
                      {s.units.length}{" "}
                      {kind === "wind"
                        ? plural(s.units.length, "турбина", "турбины", "турбин")
                        : plural(s.units.length, "блок", "блока", "блоков")}
                    </span>
                    <span>
                      Открыть станцию <Arrow />
                    </span>
                  </span>
                </>
              )}
              {s.note && !disabled && <span className="sc-note">{s.note}</span>}
            </button>
          );
        })}
      </div>
      {kind === "wind" && <RegistryTable stations={list} />}
      <p className="flow-foot">
        {kind === "wind"
          ? `Прогноз выработки — демонстрационный. Турбины Нурлы — Goldwind GW109/2500, номинал ${mw(2.5)} МВт (модель по OSM; в данных кейса мощность нормализована).`
          : "Выработка показана по демонстрационной модели солнечной станции. Оценки не заменяют проектный расчёт."}
      </p>
      <button
        className="back"
        onClick={() => go({ page: "kind", mode: "forecast" })}
      >
        ← Выбрать другой источник
      </button>
    </div>
  );
}

function RegistryTable({ stations }: { stations: Station[] }) {
  const total = stations.reduce((a, s) => a + (s.in_registry ? s.capacity_mw ?? 0 : 0), 0);
  const noCoords = stations.filter((s) => s.lat === null).length;
  return (
    <details className="kzmap-registry">
      <summary>
        Все ВЭС в справочнике: {stations.length} · в реестре {mw(total)} МВт · без координат {noCoords}
      </summary>
      <table>
        <thead>
          <tr>
            <th>Станция</th>
            <th>Область</th>
            <th>Турбин</th>
            <th>МВт</th>
          </tr>
        </thead>
        <tbody>
          {stations.map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td>
              <td>{s.region}</td>
              <td>{s.units.length || (s.lat === null ? "нет координат" : "—")}</td>
              <td>{s.capacity_mw != null ? mw(s.capacity_mw) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="kzmap-source">
        Источники: реестр объектов ВИЭ QazaqGreen по данным Минэнерго РК (январь 2026); координаты турбин —
        © участники OpenStreetMap (ODbL); контур страны — Natural Earth.
      </p>
    </details>
  );
}

export function plural(
  n: number,
  one: string,
  few: string,
  many: string,
): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
