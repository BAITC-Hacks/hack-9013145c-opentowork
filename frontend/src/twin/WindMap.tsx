import { lazy, Suspense, useState } from "react";
import type { ComponentProps } from "react";
import LegacyWindMap from "./LegacyWindMap";
import SceneBoundary from "./SceneBoundary";

export { LEGEND_GRADIENT, SPEED_MARKS, speedColor } from "./LegacyWindMap";
export type { Layers } from "./LegacyWindMap";
export type WindMapProps = ComponentProps<typeof LegacyWindMap>;

const Scene = lazy(() => import("./scene/Scene"));

export default function WindMap(props: WindMapProps) {
  const [available, setAvailable] = useState(true);
  if (!available) return <LegacyWindMap {...props} />;
  return (
    <SceneBoundary fallback={<LegacyWindMap {...props} />} onUnavailable={() => setAvailable(false)}>
    <Suspense fallback={<div className="scene-loading"><span className="spin" /> Подготавливаем ландшафт…</div>}>
      <Scene {...props} onUnavailable={() => setAvailable(false)} />
    </Suspense>
    </SceneBoundary>
  );
}
