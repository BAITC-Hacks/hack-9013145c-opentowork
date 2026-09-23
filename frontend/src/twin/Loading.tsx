import "./loading.css";

/**
 * Оверлей поверх блока, пока идёт запрос. Появляется с задержкой (CSS), чтобы
 * быстрые ответы не мигали; старые цифры под ним приглушены — их не спутать с новыми.
 */
export function LoadingOverlay({ show, label, sub }: { show: boolean; label: string; sub?: string }) {
  if (!show) return null;
  return (
    <div className="loading-overlay" role="status" aria-live="polite">
      <div className="loading-box">
        <span className="loading-spinner" aria-hidden="true" />
        <span className="loading-text">
          <b>{label}</b>
          {sub && <small>{sub}</small>}
        </span>
      </div>
    </div>
  );
}

/** Загрузка целого экрана — вместо пустой страницы или преждевременного «не найдено». */
export function PageLoader({ label, sub }: { label: string; sub?: string }) {
  return (
    <div className="page-loader" role="status" aria-live="polite">
      <span className="loading-spinner" aria-hidden="true" />
      <b>{label}</b>
      {sub && <small>{sub}</small>}
    </div>
  );
}
