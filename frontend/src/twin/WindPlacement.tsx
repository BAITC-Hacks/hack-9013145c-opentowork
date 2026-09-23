import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { ReferenceTurbine, Station, WindSimulation, WindSimulationInput, WindTurbineModel } from "../api";
import type { Route } from "./data";
import { StepBar } from "./Flow";
import KzMap from "./KzMap";
import { loadDraftTurbines, MAX_DRAFT_TURBINES, saveDraftTurbines } from "./wind-drafts";
import type { DraftTurbine } from "./wind-drafts";
import "./wind-placement.css";

const number = (n: number, digits = 1) => n.toLocaleString("ru-RU", {
  maximumFractionDigits: digits,
});
const date = (iso: string) => new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Asia/Almaty", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
}).format(new Date(iso));

/** Паспорт модели без кривой мощности: где стоит в Казахстане и откуда факты. Выработку не считаем. */
function ReferenceCard({ turbine }: { turbine: ReferenceTurbine }) {
  return <div className="reference-card">
    <dl className="facts">
      <dt>Номинальная мощность</dt><dd>{number(turbine.rated_power_kw / 1000, 2)} МВт</dd>
      <dt>Диаметр ротора</dt><dd>{turbine.rotor_diameter_m} м</dd>
      {turbine.hub_height_m != null && <><dt>Высота башни</dt><dd>{turbine.hub_height_m} м</dd></>}
    </dl>
    {turbine.sites.map((s) => <p key={s.name} className="reference-site">
      <b>{s.name}</b>
      {s.units != null && ` · ${s.units} турбин`}{s.capacity_mw != null && ` · ${s.capacity_mw} МВт`}
      {s.owner && <><br /><span className="dim">{s.owner}</span></>}
    </p>)}
    <ul className="reference-specs">{turbine.specs.map((s) => <li key={s}>{s}</li>)}</ul>
    <p className="hint warn-text">Производитель не публикует кривую мощности этой модели, поэтому выработку не считаем:
      подставлять кривую другой турбины под это название нельзя.</p>
    <p className="hint">Источники: {turbine.sources.map((s, i) => <span key={s.url + i}>
      {i > 0 && "; "}<a href={s.url} target="_blank" rel="noreferrer">{s.title}</a></span>)}</p>
  </div>;
}

function Output({ run, save, canSave }: { run: WindSimulation; save: () => void; canSave: boolean }) {
  const [cursor, setCursor] = useState(0);
  const hour = run.hours[Math.min(cursor, run.hours.length - 1)];
  return <section className="card wind-output" aria-live="polite">
    <div className="card-head"><h2>Расчётная выработка</h2><span className="pill">Без местной калибровки</span></div>
    <p className="dim">{run.turbine.name} · {run.hub_height_m} м · {run.request.latitude.toFixed(4)}°, {run.request.longitude.toFixed(4)}°</p>
    <div className="wind-kpis">
      <div><span className="kpi-label">За {run.request.horizon_hours} часов</span>
        <strong>{number(run.net_energy_kwh / 1000, 2)} <small>МВт·ч</small></strong></div>
      <div><span className="kpi-label">Использование мощности</span>
        <strong>{number(run.capacity_factor * 100)} <small>%</small></strong></div>
      <div><span className="kpi-label">Ветер у ротора, средний</span>
        <strong>{number(run.mean_wind_hub_ms)} <small>м/с</small></strong></div>
    </div>
    <p className="hint">{date(run.forecast_start)} — {date(run.forecast_end)} · UTC+5</p>
    <div className="wind-power-bars" aria-label="Почасовая мощность">
      {run.hours.map((h, i) => <button key={h.time} type="button"
        className={`${i === cursor ? "active" : ""} ${h.high_wind_shutdown ? "shutdown" : ""}`}
        onMouseEnter={() => setCursor(i)} onFocus={() => setCursor(i)} onClick={() => setCursor(i)}
        aria-label={`${date(h.time)}, ${number(h.net_power_kw)} кВт`}
        title={`${date(h.time)}: ${number(h.net_power_kw)} кВт`}
        style={{ height: `${Math.max(2, h.net_power_kw / run.turbine.rated_power_kw * 100)}%` }} />)}
    </div>
    <div className="wind-hour"><b>{date(hour.time)}</b><span>{number(hour.net_power_kw)} кВт</span>
      <span>{number(hour.wind_hub_ms)} м/с</span>
      {hour.high_wind_shutdown && <span className="warn-text">Остановка по границе кривой</span>}</div>
    <dl className="facts">
      <dt>Выработка до заданных потерь</dt><dd>{number(run.gross_energy_kwh / 1000, 2)} МВт·ч</dd>
      <dt>Заданные потери</dt><dd>{run.request.loss_percent}%</dd>
      <dt>Выработка на 1 МВт номинала</dt><dd>{number(run.net_energy_kwh / run.turbine.rated_power_kw, 2)} МВт·ч/МВт</dd>
      <dt>Часы остановки при сильном ветре</dt><dd>{run.high_wind_shutdown_hours}</dd>
    </dl>
    <button type="button" className="primary" disabled={!canSave} onClick={save}>
      {canSave ? "Добавить вариант к сравнению" : "В сравнении уже три варианта"}
    </button>
    <details className="wind-method"><summary>Откуда данные и как рассчитано</summary>
      <p><a href={run.weather_source_url} target="_blank" rel="noreferrer">{run.weather_provider}</a>
        {" · получено "}{date(run.weather_retrieved_at)} (UTC+5).</p>
      <p>Ячейка погоды: {run.weather_grid.latitude.toFixed(3)}°, {run.weather_grid.longitude.toFixed(3)}°;
        высота местности {number(run.weather_grid.elevation_m, 0)} м.</p>
      <a href={run.turbine.source_url} target="_blank" rel="noreferrer">Исходная кривая мощности</a>
      <ul>{run.assumptions.map((note) => <li key={note}>{note}</li>)}</ul>
    </details>
  </section>;
}

export default function WindPlacement({ go, stations }: {
  go: (route: Route) => void; stations: Station[];
}) {
  const [catalog, setCatalog] = useState<WindTurbineModel[]>([]);
  // Модели казахстанских ВЭС без кривой мощности: только паспорт, расчёта нет.
  const [reference, setReference] = useState<ReferenceTurbine[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [reload, setReload] = useState(0);
  const [modelId, setModelId] = useState("");
  const [height, setHeight] = useState(0);
  const [latitude, setLatitude] = useState(String(stations.find((s) => s.data === "history")?.lat ?? 51.17));
  const [longitude, setLongitude] = useState(String(stations.find((s) => s.data === "history")?.lon ?? 71.45));
  const [horizon, setHorizon] = useState<24 | 48>(48);
  const [losses, setLosses] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [run, setRun] = useState<WindSimulation | null>(null);
  const [saved, setSaved] = useState<WindSimulation[]>([]);
  const [drafts, setDrafts] = useState<DraftTurbine[]>(loadDraftTurbines);
  const [storageMessage, setStorageMessage] = useState("");
  const controller = useRef<AbortController | null>(null);
  const key = [latitude, longitude, modelId, height, horizon, losses].join("|");
  const activeKey = useRef(key);
  activeKey.current = key;
  const model = catalog.find((t) => t.id === modelId);
  const referenceModel = model ? undefined : reference.find((t) => t.id === modelId);
  const lat = Number(latitude), lon = Number(longitude), loss = Number(losses);
  const valid = !!model && model.hub_heights_m.includes(height)
    && latitude.trim() !== "" && longitude.trim() !== "" && losses.trim() !== ""
    && Number.isFinite(lat) && lat >= -90 && lat <= 90
    && Number.isFinite(lon) && lon >= -180 && lon <= 180
    && Number.isFinite(loss) && loss >= 0 && loss <= 30;

  useEffect(() => {
    let alive = true;
    setCatalogError("");
    api.windTurbineModels().then((items) => {
      if (!alive) return;
      if (!items.length) { setCatalogError("Каталог турбин пуст"); return; }
      setCatalog(items); setModelId(items[0].id); setHeight(items[0].hub_heights_m[0]);
    }).catch((e: unknown) => {
      if (alive) setCatalogError(e instanceof Error ? e.message : "Не удалось загрузить каталог");
    });
    // Справочник необязателен: без него расчётный каталог работает как раньше.
    api.windReferenceTurbines().then((items) => { if (alive) setReference(items); }, () => undefined);
    return () => { alive = false; };
  }, [reload]);

  useEffect(() => {
    controller.current?.abort();
    setRun(null); setError(""); setBusy(false);
    return () => controller.current?.abort();
  }, [key]);

  const pick = (newLat: number, newLon: number) => {
    setLatitude(newLat.toFixed(4)); setLongitude(newLon.toFixed(4));
  };
  const selectDraft = (draft: DraftTurbine) => {
    const turbine = catalog.find((item) => item.id === draft.input.turbine_id);
    if (!turbine || !turbine.hub_heights_m.includes(draft.input.hub_height_m)) {
      setStorageMessage("Эта модель или высота больше не доступны в каталоге.");
      return;
    }
    setLatitude(String(draft.input.latitude)); setLongitude(String(draft.input.longitude));
    setModelId(draft.input.turbine_id); setHeight(draft.input.hub_height_m);
    setHorizon(draft.input.horizon_hours); setLosses(String(draft.input.loss_percent));
    setStorageMessage("Турбина выбрана. Нажмите «Рассчитать выработку» для текущей погоды.");
  };
  const updateDrafts = (items: DraftTurbine[]) => {
    setDrafts(items);
    const persisted = saveDraftTurbines(items);
    setStorageMessage(persisted ? "Сохранено в этом браузере."
      : "Хранилище браузера недоступно. Турбины сохранятся только до ухода с экрана.");
  };
  const addTurbine = () => {
    if (!run || drafts.length >= MAX_DRAFT_TURBINES) return;
    const duplicate = drafts.find((d) => JSON.stringify(d.input) === JSON.stringify(run.request));
    if (duplicate) { setStorageMessage("Такая турбина уже сохранена."); return; }
    updateDrafts([...drafts, {
      id: crypto.randomUUID(), name: run.turbine.name, input: run.request,
    }]);
  };
  const calculate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid || busy) return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const submittedKey = key;
    setBusy(true); setError(""); setRun(null);
    const input: WindSimulationInput = {
      latitude: lat, longitude: lon, turbine_id: modelId, hub_height_m: height,
      horizon_hours: horizon, loss_percent: loss,
    };
    try {
      const result = await api.simulateWind(input, abort.signal);
      if (!abort.signal.aborted && submittedKey === activeKey.current) setRun(result);
    } catch (e: unknown) {
      if (!abort.signal.aborted && submittedKey === activeKey.current)
        setError(e instanceof Error ? e.message : "Не удалось выполнить расчёт");
    } finally {
      if (!abort.signal.aborted && submittedKey === activeKey.current) setBusy(false);
    }
  };

  return <div className="flow flow-refresh wide wind-placement">
    <StepBar step={2} mode="place" />
    <div className="place-head"><h1 className="flow-q">Новая ветровая турбина</h1>
      <span className="pill">Погода + кривая мощности</span></div>
    <p className="flow-sub">Выберите место, модель и высоту башни. Получите расчёт выработки на ближайшие двое суток.</p>
    <div className="place">
      <div><KzMap stations={stations.filter((s) => s.kind === "wind")}
          onOpen={(s) => go({ page: "station", kind: "wind", stationId: s.id, tab: "map" })}
          placement={{ point: valid ? {lat, lon} : null, onPick: pick,
            markers: drafts.map((d) => ({id: d.id, lat: d.input.latitude,
              lon: d.input.longitude, label: d.name, onSelect: () => selectDraft(d)})) }} />
        <p className="hint">Нажмите на карту Казахстана или задайте точные координаты. На карте также показаны существующие ВЭС.</p>
        {run && <Output key={run.generated_at} run={run} canSave={saved.length < 3}
          save={() => setSaved((items) => items.length < 3 ? [...items, run] : items)} />}
        {run && <button className="primary" type="button" onClick={addTurbine}
          disabled={drafts.length >= MAX_DRAFT_TURBINES}>Добавить турбину на карту</button>}
        {!run && <section className="card wind-placeholder"><h2>{busy ? "Получаем прогноз погоды…" : "Что покажет расчёт"}</h2>
          <p>Почасовую мощность, суммарную выработку и влияние выбранной модели турбины.</p>
          <p className="hint">Результат относится к выбранным 24–48 часам. Для оценки за год нужен отдельный климатический расчёт.</p>
        </section>}
      </div>
      <form className="card wind-form" onSubmit={calculate}>
        <h2>Параметры турбины</h2>
        <div className="wind-coordinates">
          <label>Широта, °<input type="number" step="any" min="-90" max="90" required
            value={latitude} onChange={(e) => setLatitude(e.target.value)} /></label>
          <label>Долгота, °<input type="number" step="any" min="-180" max="180" required
            value={longitude} onChange={(e) => setLongitude(e.target.value)} /></label>
        </div>
        {catalogError && <div className="error" role="alert">{catalogError}
          <button type="button" onClick={() => setReload((n) => n + 1)}>Загрузить каталог повторно</button></div>}
        <label>Модель оборудования<select value={modelId} disabled={!catalog.length}
          onChange={(e) => {
            const chosen = catalog.find((t) => t.id === e.target.value);
            setModelId(e.target.value); setHeight(chosen ? chosen.hub_heights_m[0] : 0);
          }}>
          {!catalog.length && <option value="">Загрузка каталога…</option>}
          {reference.length > 0 ? <>
            <optgroup label="С расчётом выработки">
              {catalog.map((t) => <option value={t.id} key={t.id}>{t.name}</option>)}
            </optgroup>
            <optgroup label="Стоят на ВЭС Казахстана — без расчёта">
              {reference.map((t) => <option value={t.id} key={t.id}>{t.name}</option>)}
            </optgroup>
          </> : catalog.map((t) => <option value={t.id} key={t.id}>{t.name}</option>)}
        </select></label>
        {model && <dl className="facts"><dt>Номинальная мощность</dt><dd>{number(model.rated_power_kw / 1000, 2)} МВт</dd>
          <dt>Диаметр ротора</dt><dd>{model.rotor_diameter_m} м</dd></dl>}
        {referenceModel && <ReferenceCard turbine={referenceModel} />}
        {!referenceModel && <label>Высота башни<select value={height} disabled={!model} onChange={(e) => setHeight(Number(e.target.value))}>
          {model?.hub_heights_m.map((h) => <option key={h} value={h}>{h} м</option>)}
        </select></label>}
        <label>Горизонт<select value={horizon} onChange={(e) => setHorizon(Number(e.target.value) as 24 | 48)}>
          <option value={24}>24 часа</option><option value={48}>48 часов</option>
        </select></label>
        <label>Предполагаемые потери, %<input type="number" min="0" max="30" step="0.5" required
          value={losses} onChange={(e) => setLosses(e.target.value)} /></label>
        <p className="hint">0% — идеальная работа. Можно задать суммарные потери на доступность и передачу энергии.</p>
        <button className="primary" type="submit" disabled={!valid || busy}>
          {busy ? "Считаем…" : referenceModel ? "Расчёт недоступен для этой модели" : "Рассчитать выработку"}</button>
        {error && <div className="error" role="alert">{error}</div>}
        <p className="hint">Расчёт использует текущую погоду для выбранных координат. Новое обучение не требуется.</p>
      </form>
    </div>
    {storageMessage && <p role="status" className="hint">{storageMessage}</p>}
    {drafts.length > 0 && <section className="card wind-drafts">
      <h2>Мои новые турбины</h2>
      <p className="hint">Конфигурации хранятся в этом браузере. Выберите турбину, чтобы обновить расчёт по текущей погоде.
        {" "}<button type="button" className="link" onClick={() => go({ page: "predictions" })}>Прогноз всех моих турбин на 48 ч →</button></p>
      <div className="wind-draft-list">{drafts.map((draft) => <article key={draft.id}>
        <b>{draft.name}</b><span>{draft.input.hub_height_m} м · {draft.input.latitude.toFixed(4)}°, {draft.input.longitude.toFixed(4)}°</span>
        <div><button type="button" onClick={() => selectDraft(draft)}>Выбрать турбину</button>
          <button type="button" className="ghost" aria-label={`Удалить ${draft.name}`}
            onClick={() => updateDrafts(drafts.filter((d) => d.id !== draft.id))}>Удалить</button></div>
      </article>)}</div>
    </section>}
    {saved.length > 0 && <section className="card compare">
      <div className="card-head"><h2>Сравнение вариантов</h2>
        <button className="ghost" onClick={() => setSaved([])}>Очистить</button></div>
      <p className="hint">Варианты хранятся на этом экране. Для сравнения оборудования выберите одинаковые координаты,
        период и потери. Выработка на 1 МВт учитывает разницу номиналов.</p>
      <div className="wind-table-wrap"><table className="table"><thead><tr>
        <th>Турбина / место</th><th>Период, UTC+5</th><th>Потери</th><th>Выработка</th><th>На 1 МВт</th><th>Использование</th>
      </tr></thead><tbody>{saved.map((s, i) => <tr key={`${s.generated_at}-${i}`}>
        <td><b>{s.turbine.name} · {s.hub_height_m} м</b><br />{s.request.latitude.toFixed(4)}°, {s.request.longitude.toFixed(4)}°</td>
        <td>{date(s.forecast_start)}<br />{date(s.forecast_end)}</td><td>{s.request.loss_percent}%</td>
        <td>{number(s.net_energy_kwh / 1000, 2)} МВт·ч</td>
        <td>{number(s.net_energy_kwh / s.turbine.rated_power_kw, 2)} МВт·ч/МВт</td>
        <td>{number(s.capacity_factor * 100)}%</td>
      </tr>)}</tbody></table></div>
    </section>}
    <button className="back" onClick={() => go({ page: "kind", mode: "place" })}>← Назад</button>
  </div>;
}
