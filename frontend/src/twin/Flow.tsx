import { useMemo } from "react";
import type { SourceKind, Station } from "../api";
import { mw, stationRated } from "./data";
import type { Mode, Route } from "./data";
import { demoRun, demoSolarRun } from "./demo";

// Экраны выбора: задача → источник → станция. Каждый шаг — один вопрос
// и крупные карточки-ответы, без терминов, которые нужно знать заранее.

const STEP_NAMES = ["Задача", "Источник", "Станция", "Карта"];

export function StepBar({ step, mode }: { step: number; mode?: Mode }) {
  const names = mode === "place" ? ["Задача", "Источник", "Место"] : STEP_NAMES;
  return (
    <ol className="stepbar" aria-label="Шаги">
      {names.map((name, i) => (
        <li key={name} className={i < step ? "done" : i === step ? "current" : ""} aria-current={i === step ? "step" : undefined}>
          <span className="stepbar-n">{i + 1}</span>
          {name}
        </li>
      ))}
    </ol>
  );
}

function Choice({
  title,
  text,
  meta,
  icon,
  onClick,
  disabled,
}: {
  title: string;
  text: string;
  meta?: string;
  icon: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button className="choice" onClick={onClick} disabled={disabled}>
      <span className="choice-icon" aria-hidden>
        {icon}
      </span>
      <span className="choice-title">{title}</span>
      <span className="choice-text">{text}</span>
      {meta && <span className="choice-meta">{meta}</span>}
      <span className="choice-go" aria-hidden>
        →
      </span>
    </button>
  );
}

const IconForecast = (
  <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M6 50h52" opacity=".4" />
    <path d="M8 42c8 0 10-20 18-20s8 12 14 12 8-18 16-18" />
    <path d="M40 34c6 0 8-18 16-18" strokeDasharray="3 4" />
    <circle cx="40" cy="34" r="3" fill="currentColor" />
  </svg>
);

const IconPlace = (
  <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M6 14h52M6 26h52M6 38h52M6 50h52M14 6v52M26 6v52M38 6v52M50 6v52" opacity=".22" />
    <path d="M38 12c-7 0-12 5-12 12 0 9 12 22 12 22s12-13 12-22c0-7-5-12-12-12z" />
    <circle cx="38" cy="24" r="4" />
  </svg>
);

const IconWind = (
  <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M32 26l1.5 32h-3z" fill="currentColor" stroke="none" opacity=".7" />
    <circle cx="32" cy="24" r="3" />
    <path d="M32 21c-1-7 0-13 2-18 2 7 1 12-2 18zM29.5 26c-6 3-12 5-18 5 5-5 11-6 18-5zM34.5 26c4 5 9 9 14 11-2-7-7-10-14-11z" fill="currentColor" stroke="none" />
    <path d="M4 14h14M8 20h10M50 44h10M46 50h14" opacity=".5" />
  </svg>
);

const IconSun = (
  <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="22" cy="20" r="7" />
    <path d="M22 5v4M22 31v4M7 20h4M33 20h4M11 9l3 3M30 28l3 3M11 31l3-3M30 12l3-3" />
    <path d="M18 58l8-18h32l-8 18z" />
    <path d="M22 49h32M34 40l-8 18M46 40l-8 18" opacity=".6" />
  </svg>
);

export function Home({ go, lastStation }: { go: (r: Route) => void; lastStation: Station | null }) {
  return (
    <div className="flow">
      <StepBar step={0} />
      <h1 className="flow-q">Что вы хотите сделать?</h1>
      <div className="choices two">
        <Choice
          title="Прогноз действующей станции"
          text="Сколько станция выработает за 24–48 часов, насколько прогноз надёжен и что даёт каждая турбина"
          icon={IconForecast}
          onClick={() => go({ page: "kind", mode: "forecast" })}
        />
        <Choice
          title="Место для новой станции"
          text="Где в регионе больше ветра или солнца и сколько энергии даст там новая станция"
          icon={IconPlace}
          onClick={() => go({ page: "kind", mode: "place" })}
        />
      </div>
      {lastStation && (
        <button
          className="resume"
          onClick={() =>
            go({ page: "station", kind: lastStation.kind, stationId: lastStation.id, tab: "map" })
          }
        >
          Вернуться к станции <b>{lastStation.name}</b> →
        </button>
      )}
      <button className="footer-link" onClick={() => go({ page: "platform" })}>
        Состояние платформы — для разработчиков
      </button>
    </div>
  );
}

export function KindPick({ mode, stations, go }: { mode: Mode; stations: Station[]; go: (r: Route) => void }) {
  const meta = (kind: SourceKind) => {
    if (mode === "place") return kind === "wind" ? "Карта средней скорости ветра" : "Карта солнечной радиации";
    const list = stations.filter((s) => s.kind === kind);
    const ready = list.filter((s) => s.data !== "none").length;
    return `${list.length} ${plural(list.length, "станция", "станции", "станций")} · доступна ${ready}`;
  };
  const next = (kind: SourceKind): Route =>
    mode === "place" ? { page: "place", kind } : { page: "stations", kind };
  return (
    <div className="flow">
      <StepBar step={1} mode={mode} />
      <h1 className="flow-q">{mode === "place" ? "Что хотите построить?" : "Какой источник?"}</h1>
      <div className="choices two">
        <Choice
          title={mode === "place" ? "Ветровую станцию" : "Ветер"}
          text={mode === "place" ? "Ищем места с сильным и ровным ветром" : "Ветровые электростанции"}
          meta={meta("wind")}
          icon={IconWind}
          onClick={() => go(next("wind"))}
        />
        <Choice
          title={mode === "place" ? "Солнечную станцию" : "Солнце"}
          text={mode === "place" ? "Ищем места, где больше солнца за год" : "Солнечные электростанции"}
          meta={meta("solar")}
          icon={IconSun}
          onClick={() => go(next("solar"))}
        />
      </div>
      {mode === "place" && (
        <div className="choices">
          <Choice
            title="Панели на крышах города"
            text="Какие здания Астаны дадут больше всего энергии с учётом теней от соседних домов"
            meta="Левый берег · данные OpenStreetMap и PVGIS"
            icon={IconSun}
            onClick={() => go({ page: "roofs" })}
          />
        </div>
      )}
      <button className="back" onClick={() => go({ page: "home" })}>
        ← Назад
      </button>
    </div>
  );
}

const DATA_LABEL: Record<Station["data"], string> = {
  history: "Есть данные",
  model: "Расчётная модель",
  none: "Нет данных",
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
  const list = stations.filter((s) => s.kind === kind);
  // Сводка на карточке — чтобы выбирать по делу, а не по названию.
  const summary = useMemo(() => {
    const out: Record<string, number> = {};
    for (const s of list) {
      if (s.data === "none") continue;
      const run = s.kind === "solar" ? demoSolarRun(s, originIso, 24) : demoRun(originIso, 24);
      const rated = stationRated(s);
      out[s.id] = run.predictions.reduce((a, p) => a + p.p50, 0) * rated;
    }
    return out;
  }, [list, originIso]);

  return (
    <div className="flow">
      <StepBar step={2} />
      <h1 className="flow-q">Выберите станцию</h1>
      <div className="stations">
        {list.map((s) => {
          const disabled = s.data === "none";
          return (
            <button
              key={s.id}
              className="station-card"
              disabled={disabled}
              onClick={() => go({ page: "station", kind, stationId: s.id, tab: "map" })}
            >
              <span className="sc-top">
                <span className={`sc-status ${s.data}`}>{DATA_LABEL[s.data]}</span>
                <span className="sc-coord">
                  {s.lat.toFixed(2)}° N · {s.lon.toFixed(2)}° E
                </span>
              </span>
              <span className="sc-name">{s.name}</span>
              <span className="sc-region">{s.region}</span>
              {disabled ? (
                <span className="sc-note">Подключите данные SCADA, чтобы строить прогноз</span>
              ) : (
                <span className="sc-stats">
                  <span>
                    <b>{s.units.length}</b> {kind === "wind" ? plural(s.units.length, "турбина", "турбины", "турбин") : plural(s.units.length, "блок", "блока", "блоков")}
                  </span>
                  <span>
                    <b>{mw(stationRated(s))}</b> МВт
                  </span>
                  <span>
                    <b>{mw(summary[s.id] ?? 0)}</b> МВт·ч за сутки
                  </span>
                </span>
              )}
              {s.note && !disabled && <span className="sc-note">{s.note}</span>}
            </button>
          );
        })}
      </div>
      <p className="flow-foot">
        Мощность турбин в данных кейса не указана — принято {mw(2.5)} МВт на турбину. Прогноз выработки — демо.
      </p>
      <button className="back" onClick={() => go({ page: "kind", mode: "forecast" })}>
        ← Назад
      </button>
    </div>
  );
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
