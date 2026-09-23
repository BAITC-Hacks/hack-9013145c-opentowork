import { useEffect, useState } from "react";
import { api } from "../api";
import type { Bid, BidFormat, BidSummary } from "../api";
import { fmtDay, mw } from "./data";

// Вкладка «Заявка РФЦ»: черновик заявки на продажу на операционные сутки D.
// Заявка на D строится из прогноза, выпущенного в 00 UTC суток D−1 (до 08:00 Астаны),
// поэтому выбор суток здесь и дата прогноза на других вкладках — одно и то же состояние.

const DAY = 86_400_000;
const FORMATS: [BidFormat, string][] = [["pdf", "PDF"], ["docx", "DOCX"], ["csv", "CSV"], ["json", "JSON"]];

function shiftDay(isoDay: string, days: number): string {
  return new Date(Date.parse(`${isoDay.slice(0, 10)}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

export default function Bids({
  originIso,
  onOrigin,
  onExplain,
}: {
  originIso: string;
  onOrigin: (iso: string) => void;
  onExplain: (origin: string) => void;
}) {
  const [index, setIndex] = useState<BidSummary[] | null>(null);
  const [bid, setBid] = useState<Bid | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wanted = shiftDay(originIso, 1);
  const day = index?.some((b) => b.day === wanted) ? wanted : index?.[0]?.day ?? null;

  useEffect(() => {
    api.bids().then(setIndex, (e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!day) return;
    let alive = true;
    setBid(null);
    api.bid(day).then(
      (b) => alive && setBid(b),
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [day]);

  const pick = (d: string) => onOrigin(`${shiftDay(d, -1)}T00:00:00`);
  const forecastOrigin = day ? `${shiftDay(day, -1)}T00:00:00Z` : null;
  const peak = bid ? Math.max(...bid.hours.map((h) => h.mw), 1e-6) : 1;

  return (
    <div className="bids">
      <div className="bids-head">
        <div>
          <span className="eyebrow">Черновик по форме приложения 7</span>
          <h1>Заявка на продажу в РФЦ</h1>
          <p>
            Почасовой объём на операционные сутки из прогноза агента, опубликованного до 08:00 предыдущих суток,
            и корректировки по его ревизиям. Проверьте реквизиты перед подачей — это черновик.
          </p>
        </div>
        {index && (
          <label className="bids-day">
            <span>Операционные сутки</span>
            <select value={day ?? ""} onChange={(e) => pick(e.target.value)}>
              {index.map((b) => (
                <option key={b.day} value={b.day}>
                  {fmtDay(b.day)} {b.day.slice(0, 4)} · {mw(b.total_mwh)} МВт·ч
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {error && <div className="error">Заявки недоступны: {error}</div>}
      {!bid && !error && (
        <div className="card pred-loading">
          <span className="spin" /> Загружаем черновик заявки…
        </div>
      )}

      {bid && (
        <>
          <div className="bids-kpis">
            <div className="card">
              <span className="kpi-label">Объём на сутки</span>
              <b>{mw(bid.total_mwh)}<small>МВт·ч</small></b>
              <span className="kpi-sub">установлено {mw(bid.installed_mw)} МВт</span>
            </div>
            <div className="card">
              <span className="kpi-label">Подать до</span>
              <b className="kpi-text">{bid.deadline_local}</b>
              <span className="kpi-sub">подготовлено {bid.prepared_at_local}</span>
            </div>
            <div className="card">
              <span className="kpi-label">Корректировки</span>
              <b>{bid.corrections.length}</b>
              <span className="kpi-sub">из ревизий агента в течение суток</span>
            </div>
            <div className="card bids-files">
              <span className="kpi-label">Скачать черновик</span>
              <div className="bids-file-links">
                {FORMATS.map(([f, label]) => (
                  <a key={f} className="button-link" href={api.bidFileUrl(bid.operational_day, f)} download>
                    {label}
                  </a>
                ))}
              </div>
              {forecastOrigin && (
                <button className="link" onClick={() => onExplain(forecastOrigin)}>
                  Почему такой объём →
                </button>
              )}
            </div>
          </div>

          <div className="card">
            <h2>Почасовой объём, МВт</h2>
            <p className="hint">
              {bid.operation} · {bid.counterparty}. Прогноз {bid.forecast_id}, погода от {bid.weather_run} UTC.
            </p>
            <div className="pred-table-wrap">
              <table className="pred-table bids-table">
                <thead>
                  <tr>
                    <th>Час</th>
                    <th>Интервал</th>
                    <th className="num">Заявка</th>
                    <th className="num">P10–P90</th>
                    <th className="num">Ветер</th>
                    <th>Горизонт</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {bid.hours.map((h) => (
                    <tr key={h.hour}>
                      <td>{h.hour}</td>
                      <td>{h.interval_local}</td>
                      <td className="num">
                        <span className="bids-bar" style={{ width: `${(h.mw / peak) * 56}px` }} />
                        {h.mw.toFixed(3)}
                      </td>
                      <td className="num dim">
                        {h.p10_mw.toFixed(2)}–{h.p90_mw.toFixed(2)}
                      </td>
                      <td className="num">
                        {h.wind_ms.toFixed(1)} <small>м/с</small>
                      </td>
                      <td className="dim">+{h.horizon_h} ч</td>
                      <td>{h.icing && <span className="method-badge curve">обледенение</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {bid.corrections.length > 0 && (
            <div className="card">
              <h2>Корректировки (п. 97–99)</h2>
              <div className="pred-table-wrap">
                <table className="pred-table">
                  <thead>
                    <tr>
                      <th>Решение</th>
                      <th>Час</th>
                      <th>Направление</th>
                      <th className="num">Было → стало</th>
                      <th>Подать до</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bid.corrections.map((c, i) => (
                      <tr key={i}>
                        <td>{c.decided_at_local}</td>
                        <td>
                          {c.hour} <span className="dim">{c.interval_local}</span>
                        </td>
                        <td>
                          {c.direction} на {c.volume_mw.toFixed(2)} МВт
                        </td>
                        <td className="num">
                          {c.was_mw.toFixed(3)} → <b>{c.new_mw.toFixed(3)}</b>
                        </td>
                        <td>{c.submit_before_local}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {(bid.risks.length > 0 || bid.assumptions.length > 0) && (
            <div className="card bids-notes">
              {bid.risks.length > 0 && (
                <>
                  <h2>Риски на сутки</h2>
                  <ul>{bid.risks.map((r) => <li key={r}>{r}</li>)}</ul>
                </>
              )}
              {bid.assumptions.length > 0 && (
                <>
                  <h2>Допущения черновика</h2>
                  <ul className="dim">{bid.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
