import * as THREE from "three";
import type { Rooftop, RooftopsResponse } from "../../api";
import { createCityEnvironment } from "./cityEnvironment";
import type { CityEnvironmentData } from "./cityEnvironment";

const DEG = Math.PI / 180;
type Point = [number, number];
export type CityContextBuilding = { id: string; polygon: [number, number][]; height_m: number; min_height_m: number; roof_shape?: string | null; roof_height_m?: number | null };
export type CityBuilding = { data: Rooftop; polygon: Point[]; center: THREE.Vector3; radius: number; roofStart: number; roofEnd: number; detailRoofRanges?: [number, number][]; parts?: { polygon: Point[]; height: number }[] };

type Surface = { positions: number[]; uvs: number[]; colors: number[]; owners: string[] };
const surface = (): Surface => ({ positions: [], uvs: [], colors: [], owners: [] });
function triangle(s: Surface, a: number[], b: number[], c: number[], uv: number[][], color: THREE.Color, owner: string) {
  s.positions.push(...a, ...b, ...c);
  s.uvs.push(...uv.flat());
  for (let i = 0; i < 3; i++) s.colors.push(color.r, color.g, color.b);
  s.owners.push(owner);
}
function quad(s: Surface, p: number[][], uv: number[][], color: THREE.Color, owner: string) {
  triangle(s, p[0], p[1], p[2], [uv[0], uv[1], uv[2]], color, owner);
  triangle(s, p[0], p[2], p[3], [uv[0], uv[2], uv[3]], color, owner);
}
function mesh(s: Surface, material: THREE.Material) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(s.positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(s.uvs, 2));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(s.colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const result = new THREE.Mesh(geometry, material);
  result.userData.owners = s.owners;
  result.castShadow = true;
  result.receiveShadow = true;
  return result;
}
function texture(width: number, height: number, paint: (ctx: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  paint(canvas.getContext("2d")!);
  const result = new THREE.CanvasTexture(canvas);
  result.wrapS = result.wrapT = THREE.RepeatWrapping;
  result.colorSpace = THREE.SRGBColorSpace;
  result.anisotropy = 8;
  return result;
}
function facadeTexture() {
  return texture(256, 256, (ctx) => {
    ctx.fillStyle = "#dedcd6"; ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = "#d1cfca"; ctx.fillRect(0, 247, 256, 9);
    ctx.fillStyle = "#f1eee7"; ctx.fillRect(0, 0, 9, 256);
    ctx.fillStyle = "#a9a9a4"; ctx.fillRect(48, 33, 164, 178);
    ctx.fillStyle = "#303d45"; ctx.fillRect(53, 36, 154, 166);
    const glass = ctx.createLinearGradient(55, 35, 202, 195);
    glass.addColorStop(0, "#afc2c7"); glass.addColorStop(.5, "#617c86"); glass.addColorStop(1, "#334958");
    ctx.fillStyle = glass; ctx.fillRect(61, 44, 138, 149);
    ctx.fillStyle = "rgba(234,244,245,.30)"; ctx.fillRect(64, 46, 12, 146);
    ctx.fillStyle = "#bcc1bc"; ctx.fillRect(126, 41, 5, 158); ctx.fillRect(58, 143, 144, 4);
    ctx.fillStyle = "#ebe8df"; ctx.fillRect(45, 202, 170, 8);
    ctx.fillStyle = "rgba(0,0,0,.12)"; ctx.fillRect(45, 210, 170, 6);
  });
}
function roofTexture() {
  let seed = 42;
  return texture(512, 512, (ctx) => {
    ctx.fillStyle = "#bdbcb8"; ctx.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 15000; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const x = (seed & 511); seed = (seed * 1664525 + 1013904223) >>> 0;
      const y = (seed & 511);
      ctx.fillStyle = i % 2 ? "rgba(255,255,255,.11)" : "rgba(40,45,45,.09)";
      ctx.fillRect(x, y, 2, 2);
    }
    ctx.strokeStyle = "rgba(69,73,74,.18)"; ctx.lineWidth = 1;
    for (let i = 0; i <= 512; i += 128) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 512); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(512, i); ctx.stroke(); }
  });
}
function panelTexture() {
  return texture(256, 384, (ctx) => {
    ctx.fillStyle = "#acb8bd"; ctx.fillRect(0, 0, 256, 384);
    ctx.fillStyle = "#182f44"; ctx.fillRect(5, 5, 246, 374);
    for (let y = 9; y < 375; y += 31) for (let x = 9; x < 246; x += 40) {
      ctx.fillStyle = (x + y) % 3 ? "#234b67" : "#1b3e5d";
      ctx.fillRect(x, y, 37, 28);
      ctx.fillStyle = "rgba(180,214,231,.24)"; ctx.fillRect(x + 12, y, 1, 28); ctx.fillRect(x + 25, y, 1, 28);
    }
  });
}
function pavingTexture() {
  let seed = 816;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  return texture(512, 512, (ctx) => {
    ctx.fillStyle = "#aeb5b0"; ctx.fillRect(0, 0, 512, 512);
    const slabs = ["#d0d2c8", "#c8cdc4", "#d7d8d0", "#c9cec8"];
    for (let row = -1; row < 8; row++) for (let col = -1; col < 8; col++) {
      const x = col * 128 + (row % 2 ? 64 : 0), y = row * 64;
      ctx.fillStyle = slabs[(col + row + 16) % slabs.length]; ctx.fillRect(x + 1, y + 1, 126, 62);
      ctx.fillStyle = "rgba(255,255,255,.16)"; ctx.fillRect(x + 1, y + 1, 126, 1);
    }
    for (let i = 0; i < 18000; i++) {
      ctx.fillStyle = i % 2 ? "rgba(255,255,255,.10)" : "rgba(69,80,66,.08)";
      ctx.fillRect(rand() * 512, rand() * 512, 1, 1);
    }
  });
}
function outsideNormal(poly: Point[], index: number): Point {
  let area = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; area += p[0] * q[1] - q[0] * p[1]; }
  const p = poly[index], q = poly[(index + 1) % poly.length];
  const length = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
  const sign = area >= 0 ? 1 : -1;
  return [sign * (q[1] - p[1]) / length, -sign * (q[0] - p[0]) / length];
}
const inside = (x: number, z: number, poly: Point[]) => {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
};
function edgeDistance(x: number, z: number, poly: Point[]) {
  let distance = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const vx = b[0] - a[0], vz = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * vx + (z - a[1]) * vz) / (vx * vx + vz * vz || 1)));
    distance = Math.min(distance, Math.hypot(x - a[0] - vx * t, z - a[1] - vz * t));
  }
  return distance;
}

export function createCity(data: RooftopsResponse) {
  const [south, west, north, east] = data.bbox;
  const lat = (south + north) / 2, lon = (west + east) / 2;
  const width = (east - west) * Math.cos(lat * DEG) * 111320;
  const depth = (north - south) * 110540;
  const project = ([la, lo]: [number, number]): Point => [(lo - lon) * Math.cos(lat * DEG) * 111320, -(la - lat) * 110540];
  const environment = createCityEnvironment((data as RooftopsResponse & { environment?: CityEnvironmentData }).environment, project, width, depth);
  const contextBuildings = (data as RooftopsResponse & { context_buildings?: CityContextBuilding[] }).context_buildings ?? [];
  const projectedContexts = contextBuildings.map(data => ({ data, polygon: data.polygon.map(project) }));
  const walls = surface(), roofs = surface(), trim = surface(), paths = surface(), curbs = surface();
  const buildings: CityBuilding[] = [];
  const partOwners = new Map<string, string>();
  const panelPositions: THREE.Vector3[] = [];
  const fixtures: { x: number; y: number; z: number; scale: number }[] = [];
  const palette = ["#f2f0e9", "#e7e1d4", "#d1d5d4", "#d9c7b0", "#e2e7e6", "#e9ded5"];
  const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
  data.buildings.forEach((b, index) => {
    const poly: Point[] = b.polygon.map(([la, lo]) => [(lo - lon) * Math.cos(lat * DEG) * 111320, -(la - lat) * 110540]);
    if (poly.length > 2 && Math.hypot(poly[0][0] - poly[poly.length - 1][0], poly[0][1] - poly[poly.length - 1][1]) < .01) poly.pop();
    if (poly.length < 3) return;
    const h = Math.max(2.8, b.height_m);
    const cx = poly.reduce((sum, p) => sum + p[0], 0) / poly.length;
    const cz = poly.reduce((sum, p) => sum + p[1], 0) / poly.length;
    const contained = projectedContexts.filter(c => c.polygon.every(p => inside(p[0], p[1], poly) || edgeDistance(p[0], p[1], poly) < .85));
    const minX = Math.min(...poly.map((p) => p[0])), maxX = Math.max(...poly.map((p) => p[0]));
    const minZ = Math.min(...poly.map((p) => p[1])), maxZ = Math.max(...poly.map((p) => p[1]));
    let samples = 0, covered = 0;
    if (contained.length >= 2) for (let ix = 0; ix < 16; ix++) for (let iz = 0; iz < 16; iz++) {
      const x = minX + (ix + .5) / 16 * (maxX - minX), z = minZ + (iz + .5) / 16 * (maxZ - minZ);
      if (!inside(x, z, poly)) continue;
      samples++;
      if (contained.some(c => inside(x, z, c.polygon))) covered++;
    }
    // OSM's parent height is often the maximum of its parts. Extruding that whole
    // outline would turn a 382/63/138 m composition into one false 382 m slab.
    const composite = samples >= 8 && covered / samples >= .98;
    if (composite) contained.forEach(c => partOwners.set(c.data.id, b.id));
    const roofStart = roofs.positions.length / 3;
    const wallColor = new THREE.Color(palette[index % palette.length]);
    const roofColor = new THREE.Color(b.pitched ? "#8f9290" : "#d1d1c9");
    const trimColor = new THREE.Color("#d8d9d5");
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], c = poly[(i + 1) % poly.length];
      const length = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (length < .01) continue;
      if (!composite) {
      quad(walls, [[a[0], 0, a[1]], [c[0], 0, c[1]], [c[0], h, c[1]], [a[0], h, a[1]]], [[0, 0], [length / 3.5, 0], [length / 3.5, h / 3.2], [0, h / 3.2]], wallColor, b.id);
      // A roof parapet has inner and outer faces and a cap, rather than a line.
      const nx = (a[1] - c[1]) / length * .25, nz = (c[0] - a[0]) / length * .25;
      const rim = .7;
      quad(trim, [[a[0], h, a[1]], [c[0], h, c[1]], [c[0], h + rim, c[1]], [a[0], h + rim, a[1]]], uv, trimColor, b.id);
      quad(trim, [[a[0] + nx, h, a[1] + nz], [c[0] + nx, h, c[1] + nz], [c[0] + nx, h + rim, c[1] + nz], [a[0] + nx, h + rim, a[1] + nz]], uv, trimColor, b.id);
      quad(trim, [[a[0], h + rim, a[1]], [c[0], h + rim, c[1]], [c[0] + nx, h + rim, c[1] + nz], [a[0] + nx, h + rim, a[1] + nz]], uv, trimColor, b.id);
      }
      // Modest paved aprons follow real building edges; they do not imply mapped streets.
      const [ox, oz] = outsideNormal(poly, i);
      const apron = b.roof_m2 > 1000 ? 6 : 4.5;
      const edgeA = [a[0] + ox * apron, .12, a[1] + oz * apron];
      const edgeB = [c[0] + ox * apron, .12, c[1] + oz * apron];
      const paving = [[a[0], .12, a[1]], [c[0], .12, c[1]], edgeB, edgeA];
      quad(paths, paving, paving.map(([x, , z]) => [x / 5, z / 5]), new THREE.Color("#ffffff"), "");
      const curbA = [edgeA[0] + ox * .2, .16, edgeA[2] + oz * .2];
      const curbB = [edgeB[0] + ox * .2, .16, edgeB[2] + oz * .2];
      quad(curbs, [[edgeA[0], .16, edgeA[2]], [edgeB[0], .16, edgeB[2]], curbB, curbA], uv, new THREE.Color("#bac2b8"), "");
      quad(curbs, [curbA, curbB, [curbB[0], -.02, curbB[2]], [curbA[0], -.02, curbA[2]]], uv, new THREE.Color("#a5aea0"), "");
      // Close the small outside corner between consecutive perpendicular offsets.
      const [px, pz] = outsideNormal(poly, (i + poly.length - 1) % poly.length);
      const corner = [[a[0], .12, a[1]], edgeA, [a[0] + px * apron, .12, a[1] + pz * apron]];
      triangle(paths, corner[0], corner[1], corner[2], corner.map(([x, , z]) => [x / 5, z / 5]), new THREE.Color("#ffffff"), "");
    }
    if (!composite) {
    const shape = new THREE.Shape(poly.map(([x, z]) => new THREE.Vector2(x, -z)));
    const roofGeometry = new THREE.ShapeGeometry(shape).toNonIndexed();
    const p = roofGeometry.getAttribute("position");
    for (let i = 0; i < p.count; i += 3) {
      const points = [i, i + 1, i + 2].map((j) => [p.getX(j), h, -p.getY(j)]);
      triangle(roofs, points[0], points[1], points[2], points.map(([x, , z]) => [x / 14, z / 14]), roofColor, b.id);
    }
    roofGeometry.dispose();
    }
    buildings.push({ data: b, polygon: poly, center: new THREE.Vector3((minX + maxX) / 2, h, (minZ + maxZ) / 2), radius: Math.max(maxX - minX, maxZ - minZ) / 2, roofStart, roofEnd: roofs.positions.length / 3, parts: composite ? contained.map(c => ({ polygon: c.polygon, height: c.data.height_m })) : undefined });
    let count = 0;
    const limit = composite ? 0 : Math.min(220, Math.floor(b.kwp / 1.1));
    for (let z = minZ + 4; z < maxZ - 4 && count < limit; z += 7) for (let x = minX + 4; x < maxX - 4 && count < limit; x += 4.2) {
      if (inside(x, z, poly) && edgeDistance(x, z, poly) > 3) {
        panelPositions.push(new THREE.Vector3(x, h + 1.1, z)); count++;
      }
    }
    if (!composite && b.roof_m2 > 150 && inside(cx, cz, poly) && edgeDistance(cx, cz, poly) > 4) fixtures.push({ x: cx, y: h + .9, z: cz, scale: Math.min(3, Math.sqrt(b.roof_m2) / 20) });
  });

  // OSM building parts and unsuitable roofs remain physical neighbours, without
  // becoming solar candidates. In particular, real tower parts retain their height.
  for (const context of contextBuildings) {
    const poly = context.polygon.map(project);
    if (poly.length > 2 && Math.hypot(poly[0][0] - poly[poly.length - 1][0], poly[0][1] - poly[poly.length - 1][1]) < .01) poly.pop();
    if (poly.length < 3 || !poly.every(p => p.every(Number.isFinite))) continue;
    const bottom = Math.max(0, context.min_height_m || 0);
    const top = Math.max(bottom + 1, context.height_m || 3);
    const cx = poly.reduce((sum, p) => sum + p[0], 0) / poly.length;
    const cz = poly.reduce((sum, p) => sum + p[1], 0) / poly.length;
    const parent = buildings.find(b => b.data.id === partOwners.get(context.id)) ?? buildings.find(b => inside(cx, cz, b.polygon));
    const owner = parent?.data.id ?? context.id;
    if (parent) parent.center.y = Math.max(parent.center.y, top);
    const roofShape = context.roof_shape ?? "flat";
    const shaped = /^(dome|cone|round|orb|onion|spherical|pyramidal)$/.test(roofShape);
    const span = Math.min(Math.max(...poly.map(p => p[0])) - Math.min(...poly.map(p => p[0])), Math.max(...poly.map(p => p[1])) - Math.min(...poly.map(p => p[1])));
    const estimatedRise = Math.min((top - bottom) * (roofShape === "cone" ? .72 : .35), span * .45);
    const rise = shaped ? Math.max(.5, Math.min(top - bottom, context.roof_height_m ?? estimatedRise)) : 0;
    const eave = top - rise;
    const wallColor = new THREE.Color(top > 80 ? "#c2ccd0" : "#dddcd3");
    const roofColor = new THREE.Color(shaped ? "#b0bcbb" : "#c7cbc4");
    const detailStart = roofs.positions.length / 3;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (eave > bottom + .01) quad(walls, [[p[0], bottom, p[1]], [q[0], bottom, q[1]], [q[0], eave, q[1]], [p[0], eave, p[1]]], [[0, bottom / 3.2], [length / 3.5, bottom / 3.2], [length / 3.5, eave / 3.2], [0, eave / 3.2]], wallColor, owner);
      if (shaped) {
        const sections = /^(cone|pyramidal)$/.test(roofShape) ? 1 : 8;
        for (let layer = 0; layer < sections; layer++) {
          const lower = layer / sections, upper = (layer + 1) / sections;
          const radius = (t: number) => sections === 1 ? 1 - t : Math.cos(t * Math.PI / 2);
          const height = (t: number) => eave + rise * (sections === 1 ? t : Math.sin(t * Math.PI / 2));
          const vertex = (v: Point, t: number) => [cx + (v[0] - cx) * radius(t), height(t), cz + (v[1] - cz) * radius(t)];
          const ring = [vertex(p, lower), vertex(q, lower), vertex(q, upper), vertex(p, upper)];
          if (layer === sections - 1) triangle(roofs, ring[0], ring[1], ring[2], ring.slice(0, 3).map(([x, , z]) => [x / 20, z / 20]), roofColor, owner);
          else quad(roofs, ring, ring.map(([x, , z]) => [x / 20, z / 20]), roofColor, owner);
        }
      }
    }
    if (!shaped) {
      const shape = new THREE.Shape(poly.map(([x, z]) => new THREE.Vector2(x, -z)));
      const indexed = new THREE.ShapeGeometry(shape), roof = indexed.toNonIndexed(), positions = roof.getAttribute("position");
      for (let i = 0; i < positions.count; i += 3) {
        const points = [i, i + 1, i + 2].map(j => [positions.getX(j), top, -positions.getY(j)]);
        triangle(roofs, points[0], points[1], points[2], points.map(([x, , z]) => [x / 14, z / 14]), roofColor, owner);
      }
      roof.dispose(); indexed.dispose();
    }
    if (parent) (parent.detailRoofRanges ??= []).push([detailStart, roofs.positions.length / 3]);
  }

  const group = new THREE.Group();
  group.add(environment.group);
  const wallMesh = mesh(walls, new THREE.MeshStandardMaterial({ map: facadeTexture(), vertexColors: true, roughness: .76, side: THREE.DoubleSide }));
  const roofMaterial = new THREE.MeshStandardMaterial({ map: roofTexture(), vertexColors: true, roughness: .88, side: THREE.DoubleSide });
  const roofMesh = mesh(roofs, roofMaterial);
  group.add(wallMesh, roofMesh, mesh(trim, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .65, side: THREE.DoubleSide })), mesh(paths, new THREE.MeshStandardMaterial({ map: pavingTexture(), vertexColors: true, roughness: .86, side: THREE.DoubleSide })), mesh(curbs, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .9, side: THREE.DoubleSide })));
  const panels = new THREE.InstancedMesh(new THREE.BoxGeometry(2.5, .10, 3.8), new THREE.MeshStandardMaterial({ color: "#587d96", metalness: .4, roughness: .28, map: panelTexture() }), panelPositions.length);
  const helper = new THREE.Object3D();
  panelPositions.forEach((position, i) => { helper.position.copy(position); helper.rotation.x = Math.PI / 6; helper.updateMatrix(); panels.setMatrixAt(i, helper.matrix); });
  panels.castShadow = true; panels.receiveShadow = true;
  group.add(panels);
  const equipment = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: "#9babae", roughness: .65, metalness: .25 }), fixtures.length);
  fixtures.forEach((f, i) => { helper.position.set(f.x, f.y, f.z); helper.rotation.set(0, 0, 0); helper.scale.set(f.scale * 2, 1.6, f.scale); helper.updateMatrix(); equipment.setMatrixAt(i, helper.matrix); });
  equipment.castShadow = true; equipment.receiveShadow = true;
  group.add(equipment);
  // Landscaping is constrained by mapped green polygons and road/water clearance.
  const bounds = buildings.map((b) => ({ b, x0: Math.min(...b.polygon.map(p => p[0])) - 6, x1: Math.max(...b.polygon.map(p => p[0])) + 6, z0: Math.min(...b.polygon.map(p => p[1])) - 6, z1: Math.max(...b.polygon.map(p => p[1])) + 6 }));
  const contextPolygons = contextBuildings.map(b => b.polygon.map(project));
  const trees: { x: number; z: number; scale: number }[] = [];
  const clear = (x: number, z: number) => !bounds.some(q => x > q.x0 && x < q.x1 && z > q.z0 && z < q.z1 && (inside(x, z, q.b.polygon) || edgeDistance(x, z, q.b.polygon) < 6)) && !contextPolygons.some(poly => inside(x, z, poly) || edgeDistance(x, z, poly) < 6);
  for (const candidate of environment.treeCandidates) {
    if (trees.length >= 1400) break;
    if (clear(candidate.x, candidate.z) && !trees.some(t => Math.hypot(t.x - candidate.x, t.z - candidate.z) < 10)) trees.push(candidate);
  }
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(.22, .34, 4, 6), new THREE.MeshStandardMaterial({ color: "#6f6c5b", roughness: 1 }), trees.length);
  const crowns = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: .94 }), trees.length * 3);
  const beds = new THREE.InstancedMesh(new THREE.CircleGeometry(3.8, 16), new THREE.MeshStandardMaterial({ color: "#52694a", roughness: 1 }), trees.length);
  const shrubs = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 7, 5), new THREE.MeshStandardMaterial({ color: "#758954", roughness: .95 }), trees.length * 2);
  trees.forEach((t, i) => {
    helper.position.set(t.x, 2 * t.scale, t.z); helper.rotation.set(0, 0, 0); helper.scale.setScalar(t.scale); helper.updateMatrix(); trunks.setMatrixAt(i, helper.matrix);
    for (let j = 0; j < 3; j++) {
      const angle = j / 3 * Math.PI * 2 + i;
      helper.position.set(t.x + Math.cos(angle) * 1.15 * t.scale, (5.2 + j * .3) * t.scale, t.z + Math.sin(angle) * 1.15 * t.scale);
      helper.scale.set(2.7 * t.scale, (2.9 - j * .2) * t.scale, 2.4 * t.scale); helper.updateMatrix(); crowns.setMatrixAt(i * 3 + j, helper.matrix);
      crowns.setColorAt(i * 3 + j, new THREE.Color(["#607b4d", "#738950", "#536f45", "#829452"][i % 4]));
    }
    helper.position.set(t.x, .001, t.z); helper.rotation.set(-Math.PI / 2, 0, 0); helper.scale.setScalar(t.scale); helper.updateMatrix(); beds.setMatrixAt(i, helper.matrix);
    helper.rotation.set(0, 0, 0);
    for (let j = 0; j < 2; j++) {
      const angle = i + j * Math.PI;
      helper.position.set(t.x + Math.cos(angle) * 2.6 * t.scale, .65, t.z + Math.sin(angle) * 2.6 * t.scale);
      helper.scale.set(1.25 * t.scale, .85, 1.2 * t.scale); helper.updateMatrix(); shrubs.setMatrixAt(i * 2 + j, helper.matrix);
    }
  });
  trunks.name = "landscape-tree-trunks"; crowns.name = "landscape-tree-crowns";
  trunks.castShadow = true; crowns.castShadow = true; crowns.receiveShadow = true;
  beds.receiveShadow = true; shrubs.castShadow = true; shrubs.receiveShadow = true;
  group.add(trunks, crowns, beds, shrubs);

  const baseRoofColors = new Float32Array(roofMesh.geometry.getAttribute("color").array);
  const energy = data.buildings.map((b) => Math.log10(Math.max(1, b.kwh_year)));
  const lo = Math.min(...energy), range = Math.max(.001, Math.max(...energy) - lo);
  const quality = data.buildings.map((b) => b.kwh_per_kwp);
  const qualityMin = Math.min(...quality), qualityRange = Math.max(.001, Math.max(...quality) - qualityMin);
  const setMetric = (metric: "materials" | "energy" | "quality") => {
    const colors = roofMesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    if (metric === "materials") colors.array.set(baseRoofColors);
    else for (const b of buildings) {
      const amount = metric === "energy" ? (Math.log10(Math.max(1, b.data.kwh_year)) - lo) / range : (b.data.kwh_per_kwp - qualityMin) / qualityRange;
      const color = new THREE.Color("#e2e8eb").lerp(new THREE.Color(metric === "energy" ? "#d99222" : "#159581"), Math.max(0, Math.min(1, amount)));
      for (const [start, end] of [[b.roofStart, b.roofEnd], ...(b.detailRoofRanges ?? [])]) for (let i = start; i < end; i++) colors.setXYZ(i, color.r, color.g, color.b);
    }
    colors.needsUpdate = true;
    roofMaterial.map = metric === "materials" ? originalRoofMap : null;
    roofMaterial.needsUpdate = true;
    panels.visible = metric === "materials";
  };
  const originalRoofMap = roofMaterial.map;
  return { group, buildings, width, depth, panels, environment, pickables: [wallMesh, roofMesh], setMetric, roofTexture: originalRoofMap };
}
