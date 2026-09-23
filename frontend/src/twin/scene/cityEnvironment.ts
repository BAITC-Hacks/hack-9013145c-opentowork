import * as THREE from "three";

export type GeoPoint = [number, number];
export type CityEnvironmentData = {
  roads: { id: string; name?: string; kind: string; width_m: number; lanes?: number; bridge?: boolean; tunnel?: boolean; coordinates: GeoPoint[] }[];
  areas: { id: string; kind: string; polygon: GeoPoint[] }[];
};
type Point = [number, number];
type Surface = { positions: number[]; uvs: number[] };
type Road = CityEnvironmentData["roads"][number] & { points: Point[]; width: number; walk: boolean; distance: number[]; total: number };
type Area = { id: string; kind: string; points: Point[]; x0: number; x1: number; z0: number; z1: number };
type Segment = { id: string; a: Point; b: Point; width: number; x0: number; x1: number; z0: number; z1: number };
const surface = (): Surface => ({ positions: [], uvs: [] });
function triangle(s: Surface, a: number[], b: number[], c: number[], scale = 12) {
  s.positions.push(...a, ...b, ...c);
  for (const p of [a, b, c]) s.uvs.push(p[0] / scale, -p[2] / scale);
}
function quad(s: Surface, a: number[], b: number[], c: number[], d: number[], scale = 12) {
  triangle(s, a, b, c, scale); triangle(s, a, c, d, scale);
}
function makeMesh(s: Surface, material: THREE.Material, name: string) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(s.positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(s.uvs, 2));
  geometry.computeVertexNormals(); geometry.computeBoundingSphere();
  const result = new THREE.Mesh(geometry, material); result.receiveShadow = true; result.name = name;
  return result;
}
function grainTexture(base: string, kind: "grass" | "paving" | "asphalt" | "ground") {
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 512;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = base; ctx.fillRect(0, 0, 512, 512);
  let seed = 91;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  if (kind === "paving") {
    ctx.strokeStyle = "rgba(76,81,79,.16)"; ctx.lineWidth = 1;
    for (let y = 0; y <= 512; y += 64) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(512, y); ctx.stroke();
      for (let x = (y / 64) % 2 ? 64 : 0; x < 512; x += 128) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 64); ctx.stroke(); } }
  }
  for (let i = 0; i < 30000; i++) {
    ctx.fillStyle = i % 2 ? "rgba(234,234,213,.08)" : "rgba(37,45,35,.075)";
    ctx.fillRect(rand() * 512, rand() * 512, .5 + rand(), kind === "grass" ? 1 + rand() * 3 : .5 + rand());
  }
  const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping; map.anisotropy = 8;
  return map;
}
const within = (x: number, z: number, poly: Point[]) => {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
};
function segmentDistance(x: number, z: number, a: Point, b: Point) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz);
}
function cleanPoints(points: Point[]) {
  return points.filter((p, i) => p.every(Number.isFinite) && (!i || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > .025));
}
function offsets(points: Point[], halfWidth: number) {
  return points.map((p, i) => {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
    const before = new THREE.Vector2(p[0] - a[0], p[1] - a[1]);
    const after = new THREE.Vector2(b[0] - p[0], b[1] - p[1]);
    if (before.lengthSq() < 1e-8) before.copy(after); if (after.lengthSq() < 1e-8) after.copy(before);
    before.normalize(); after.normalize();
    const normal = new THREE.Vector2(-after.y, after.x);
    const miter = new THREE.Vector2(-before.y - after.y, before.x + after.x);
    if (miter.lengthSq() < .0001) miter.copy(normal); else miter.normalize();
    const scale = Math.min(halfWidth * 2.4, halfWidth / Math.max(.1, miter.dot(normal)));
    return [miter.x * scale, miter.y * scale] as Point;
  });
}
function cap(s: Surface, p: Point, radius: number, y: number) {
  for (let i = 0; i < 16; i++) {
    const a = i * Math.PI / 8, b = (i + 1) * Math.PI / 8;
    triangle(s, [p[0], y, p[1]], [p[0] + Math.cos(a) * radius, y, p[1] + Math.sin(a) * radius], [p[0] + Math.cos(b) * radius, y, p[1] + Math.sin(b) * radius]);
  }
}
function roadY(road: Road, distance: number) {
  if (!road.bridge) return .24;
  // Bridge tags specify topology, not surveyed elevation. Keep modest ramps continuous at both ends.
  const ramp = Math.min(35, road.total * .3);
  return .24 + Math.max(0, Math.min(1, distance / ramp, (road.total - distance) / ramp)) * 3.2;
}
function ribbon(s: Surface, road: Road, width: number, lift: number, scale = 12) {
  const offset = offsets(road.points, width / 2);
  for (let i = 0; i < road.points.length - 1; i++) {
    const a = road.points[i], b = road.points[i + 1], oa = offset[i], ob = offset[i + 1];
    const ya = roadY(road, road.distance[i]) + lift, yb = roadY(road, road.distance[i + 1]) + lift;
    quad(s, [a[0] - oa[0], ya, a[1] - oa[1]], [a[0] + oa[0], ya, a[1] + oa[1]], [b[0] + ob[0], yb, b[1] + ob[1]], [b[0] - ob[0], yb, b[1] - ob[1]], scale);
  }
  cap(s, road.points[0], width / 2, roadY(road, 0) + lift);
  cap(s, road.points[road.points.length - 1], width / 2, roadY(road, road.total) + lift);
}
function areaGeometry(s: Surface, area: Area, y: number, scale: number) {
  const shape = new THREE.Shape(area.points.map(([x, z]) => new THREE.Vector2(x, -z)));
  const indexed = new THREE.ShapeGeometry(shape), geometry = indexed.toNonIndexed();
  const positions = geometry.getAttribute("position");
  for (let i = 0; i < positions.count; i += 3) {
    const p = [i, i + 1, i + 2].map(j => [positions.getX(j), y, -positions.getY(j)]);
    triangle(s, p[0], p[1], p[2], scale);
  }
  geometry.dispose(); indexed.dispose();
}

export function createCityEnvironment(data: CityEnvironmentData | undefined, project: (p: GeoPoint) => Point, width: number, depth: number) {
  const group = new THREE.Group(); group.name = "osm-city-environment";
  const roads: Road[] = (data?.roads ?? []).filter(r => !r.tunnel).map((r) => {
    const points = cleanPoints(r.coordinates.map(project)); const distance = [0];
    for (let i = 1; i < points.length; i++) distance.push(distance[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
    return { ...r, points, width: Math.max(1.2, Math.min(80, r.width_m || 5)), walk: /^(pedestrian|footway|cycleway|path|steps|track)$/.test(r.kind), distance, total: distance[distance.length - 1] };
  }).filter(r => r.points.length >= 2 && r.total > .1);
  const areas: Area[] = (data?.areas ?? []).map(a => {
    const points = cleanPoints(a.polygon.map(project));
    return { ...a, points, x0: Math.min(...points.map(p => p[0])), x1: Math.max(...points.map(p => p[0])), z0: Math.min(...points.map(p => p[1])), z1: Math.max(...points.map(p => p[1])) };
  }).filter(a => a.points.length >= 3);
  const roadGrid = new Map<string, Segment[]>(); const cell = 80;
  for (const r of roads) for (let i = 0; i < r.points.length - 1; i++) {
    const a = r.points[i], b = r.points[i + 1], margin = r.width / 2 + 12;
    const item: Segment = { id: r.id, a, b, width: r.width, x0: Math.min(a[0], b[0]) - margin, x1: Math.max(a[0], b[0]) + margin, z0: Math.min(a[1], b[1]) - margin, z1: Math.max(a[1], b[1]) + margin };
    for (let x = Math.floor(item.x0 / cell); x <= Math.floor(item.x1 / cell); x++) for (let z = Math.floor(item.z0 / cell); z <= Math.floor(item.z1 / cell); z++) {
      const key = `${x}:${z}`, list = roadGrid.get(key) ?? []; list.push(item); roadGrid.set(key, list);
    }
  }
  const nearRoad = (x: number, z: number, margin: number, exclude?: string) => (roadGrid.get(`${Math.floor(x / cell)}:${Math.floor(z / cell)}`) ?? []).some(s => s.id !== exclude && x >= s.x0 && x <= s.x1 && z >= s.z0 && z <= s.z1 && segmentDistance(x, z, s.a, s.b) < s.width / 2 + margin);
  const contains = (a: Area, x: number, z: number) => x >= a.x0 && x <= a.x1 && z >= a.z0 && z <= a.z1 && within(x, z, a.points);
  const green = areas.filter(a => /^(park|wood|grass)$/.test(a.kind));
  const water = areas.filter(a => a.kind === "water");
  const allowsTree = (x: number, z: number) => !nearRoad(x, z, 5.5) && !water.some(a => contains(a, x, z)) && green.some(a => contains(a, x, z));
  const batches = { residential: surface(), industrial: surface(), commercial: surface(), grass: surface(), wood: surface(), water: surface(), parking: surface(), paving: surface(), asphalt: surface(), curb: surface(), marking: surface() };
  for (const area of areas) {
    if (area.kind === "water") areaGeometry(batches.water, area, .015, 20);
    else if (area.kind === "wood") areaGeometry(batches.wood, area, -.015, 32);
    else if (/^(park|grass)$/.test(area.kind)) areaGeometry(batches.grass, area, -.018, 28);
    else if (area.kind === "parking") areaGeometry(batches.parking, area, .035, 15);
    else if (area.kind === "pedestrian") areaGeometry(batches.paving, area, .07, 6);
    else if (area.kind === "industrial") areaGeometry(batches.industrial, area, -.045, 24);
    else if (area.kind === "commercial") areaGeometry(batches.commercial, area, -.046, 24);
    else if (area.kind === "residential") areaGeometry(batches.residential, area, -.047, 24);
  }
  for (const road of roads) {
    if (road.walk) { ribbon(batches.paving, road, road.width, -.06, 6); continue; }
    ribbon(batches.paving, road, road.width + 3.8, -.08, 6);
    ribbon(batches.asphalt, road, road.width, 0, 12);
    const offset = offsets(road.points, road.width / 2);
    for (let i = 0; i < road.points.length - 1; i++) {
      const a = road.points[i], b = road.points[i + 1], span = road.distance[i + 1] - road.distance[i];
      const count = Math.max(1, Math.ceil(span / 4));
      for (let j = 0; j < count; j++) for (const sign of [-1, 1]) {
        const at = (t: number) => [a[0] + (b[0] - a[0]) * t + sign * (offset[i][0] + (offset[i + 1][0] - offset[i][0]) * t), a[1] + (b[1] - a[1]) * t + sign * (offset[i][1] + (offset[i + 1][1] - offset[i][1]) * t)] as Point;
        const p = at(j / count), q = at((j + 1) / count);
        if (nearRoad((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, 1.5, road.id)) continue;
        const nx = -(q[1] - p[1]), nz = q[0] - p[0], n = Math.hypot(nx, nz) || 1;
        const yp = roadY(road, road.distance[i] + span * j / count) + .035, yq = roadY(road, road.distance[i] + span * (j + 1) / count) + .035;
        quad(batches.curb, [p[0], yp, p[1]], [q[0], yq, q[1]], [q[0] + nx / n * .17, yq, q[1] + nz / n * .17], [p[0] + nx / n * .17, yp, p[1] + nz / n * .17]);
      }
      if (!/^(motorway|trunk|primary|secondary|tertiary)/.test(road.kind) || road.width < 6 || road.lanes === 1) continue;
      for (let d = Math.ceil(road.distance[i] / 10) * 10; d < road.distance[i + 1]; d += 10) {
        if (d < 9 || d + 4 > road.total - 9 || d + 4 > road.distance[i + 1]) continue;
        const t = (d - road.distance[i]) / span, u = (d + 4 - road.distance[i]) / span;
        const p: Point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        if (nearRoad(p[0], p[1], 3, road.id)) continue;
        const q: Point = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
        const nx = -(b[1] - a[1]) / span * .06, nz = (b[0] - a[0]) / span * .06;
        quad(batches.marking, [p[0] - nx, roadY(road, d) + .014, p[1] - nz], [p[0] + nx, roadY(road, d) + .014, p[1] + nz], [q[0] + nx, roadY(road, d + 4) + .014, q[1] + nz], [q[0] - nx, roadY(road, d + 4) + .014, q[1] - nz]);
      }
    }
  }
  const materials: Record<keyof typeof batches, THREE.Material> = {
    residential: new THREE.MeshStandardMaterial({ color: "#d1cfc3", roughness: 1 }),
    industrial: new THREE.MeshStandardMaterial({ color: "#bcb9af", roughness: 1 }),
    commercial: new THREE.MeshStandardMaterial({ color: "#c6c6bc", roughness: 1 }),
    grass: new THREE.MeshStandardMaterial({ map: grainTexture("#879370", "grass"), roughness: 1 }),
    wood: new THREE.MeshStandardMaterial({ map: grainTexture("#6b815f", "grass"), roughness: 1 }),
    water: new THREE.MeshStandardMaterial({ color: "#5d8888", metalness: .14, roughness: .28 }),
    parking: new THREE.MeshStandardMaterial({ map: grainTexture("#8c8f89", "asphalt"), roughness: .92 }),
    paving: new THREE.MeshStandardMaterial({ map: grainTexture("#cccbc0", "paving"), roughness: .88 }),
    asphalt: new THREE.MeshStandardMaterial({ map: grainTexture("#666d6b", "asphalt"), roughness: .95 }),
    curb: new THREE.MeshStandardMaterial({ color: "#c0c4b9", roughness: .9 }),
    marking: new THREE.MeshStandardMaterial({ color: "#d9d8c3", roughness: 1 }),
  };
  for (const key of Object.keys(batches) as (keyof typeof batches)[]) {
    materials[key].side = THREE.DoubleSide;
    // Keep even an empty batch attached so disposal owns its material and texture.
    group.add(makeMesh(batches[key], materials[key], `osm-${key}`));
  }
  const groundMap = grainTexture("#b9b9aa", "ground"); groundMap.repeat.set((width + 12000) / 50, (depth + 12000) / 50);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(width + 12000, depth + 12000), new THREE.MeshStandardMaterial({ map: groundMap, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -.08; ground.receiveShadow = true; ground.name = "urban-base-ground"; group.add(ground);
  const treeCandidates: { x: number; z: number; scale: number }[] = [];
  for (const area of green) {
    const step = area.kind === "wood" ? 17 : area.kind === "park" ? 25 : 48;
    for (let x = Math.max(area.x0, -width * .55) + step / 2; x < Math.min(area.x1, width * .55); x += step) for (let z = Math.max(area.z0, -depth * .55) + step / 2; z < Math.min(area.z1, depth * .55); z += step) {
      if (treeCandidates.length > 4000) break;
      const jitter = Math.sin(x * .241 + z * .132);
      const px = x + jitter * step * .28, pz = z + Math.cos(x * .135 - z * .272) * step * .28;
      if (contains(area, px, pz) && allowsTree(px, pz)) treeCandidates.push({ x: px, z: pz, scale: .84 + Math.abs(jitter) * .35 });
    }
  }
  return { group, allowsTree, treeCandidates, nearRoad, roads, areas, hasData: Boolean(data) };
}
