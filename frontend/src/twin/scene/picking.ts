export type ScreenPoint = { x: number; y: number };
export type WindPickRegion = {
  id: string;
  base: ScreenPoint;
  hub: ScreenPoint;
  rotor: ScreenPoint[];
  depth: number;
};

function segmentDistance(p: ScreenPoint, a: ScreenPoint, b: ScreenPoint): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** CSS-pixel tolerance stays usable at any zoom, independently of thin model geometry. */
export function pickWindUnit(point: ScreenPoint, regions: WindPickRegion[], padding: number): string | null {
  const candidates: { region: WindPickRegion; distance: number }[] = [];
  let best = Infinity;
  for (const region of regions) {
    let inside = false;
    let edge = Infinity;
    for (let i = 0, j = region.rotor.length - 1; i < region.rotor.length; j = i++) {
      const a = region.rotor[i], b = region.rotor[j];
      if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
      edge = Math.min(edge, segmentDistance(point, a, b));
    }
    const distance = Math.min(segmentDistance(point, region.base, region.hub), inside ? 0 : edge);
    if (distance > padding) continue;
    best = Math.min(best, distance);
    candidates.push({ region, distance });
  }
  // Compare every depth tie against the same minimum; otherwise a chain of nearby
  // candidates can drift away from the pointer depending on their array order.
  let picked: WindPickRegion | null = null;
  for (const { region, distance } of candidates) {
    if (distance <= best + 1 && (!picked || region.depth < picked.depth)) picked = region;
  }
  return picked?.id ?? null;
}
