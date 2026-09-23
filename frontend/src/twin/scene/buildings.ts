import * as THREE from "three";
import type { Rooftop, RooftopsResponse } from "../../api";

const DEG = Math.PI / 180;
type Point = [number, number];
export type CityBuilding = { data: Rooftop; polygon: Point[]; center: THREE.Vector3; radius: number; roofStart: number; roofEnd: number };

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
function groundTexture(width: number, depth: number, buildings: CityBuilding[]) {
  let seed = 714;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  return texture(2048, 2048, (ctx) => {
    ctx.fillStyle = "#959c88"; ctx.fillRect(0, 0, 2048, 2048);
    for (let i = 0; i < 2600; i++) {
      const x = rand() * 2048, y = rand() * 2048, radius = 6 + rand() * 72;
      const color = i % 3 === 0 ? "116,131,94" : i % 3 === 1 ? "176,166,137" : "138,145,123";
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, `rgba(${color},.4)`); gradient.addColorStop(1, `rgba(${color},0)`);
      ctx.fillStyle = gradient; ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }
    const toX = (x: number) => (x / width + .5) * 2048;
    const toY = (z: number) => (z / depth + .5) * 2048;
    // A softly paved perimeter follows each measured footprint; streets are not inferred.
    for (const b of buildings) {
      ctx.beginPath(); b.polygon.forEach(([x, z], i) => { if (!i) ctx.moveTo(toX(x), toY(z)); else ctx.lineTo(toX(x), toY(z)); }); ctx.closePath();
      ctx.strokeStyle = "#bcbeb5"; ctx.fillStyle = "#bcbeb5"; ctx.lineJoin = "round"; ctx.lineWidth = 12 * 2048 / width; ctx.stroke(); ctx.fill();
    }
    for (let i = 0; i < 160000; i++) {
      ctx.fillStyle = i % 2 ? "rgba(239,234,220,.1)" : "rgba(50,59,46,.08)";
      ctx.fillRect(rand() * 2048, rand() * 2048, 1 + rand() * 2, 1 + rand() * 2);
    }
  });
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
  const walls = surface(), roofs = surface(), trim = surface(), paths = surface();
  const buildings: CityBuilding[] = [];
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
    const roofStart = roofs.positions.length / 3;
    const wallColor = new THREE.Color(palette[index % palette.length]);
    const roofColor = new THREE.Color(b.pitched ? "#8f9290" : "#d1d1c9");
    const trimColor = new THREE.Color("#d8d9d5");
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], c = poly[(i + 1) % poly.length];
      const length = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (length < .01) continue;
      quad(walls, [[a[0], 0, a[1]], [c[0], 0, c[1]], [c[0], h, c[1]], [a[0], h, a[1]]], [[0, 0], [length / 3.5, 0], [length / 3.5, h / 3.2], [0, h / 3.2]], wallColor, b.id);
      // A roof parapet has inner and outer faces and a cap, rather than a line.
      const nx = (a[1] - c[1]) / length * .25, nz = (c[0] - a[0]) / length * .25;
      const rim = .7;
      quad(trim, [[a[0], h, a[1]], [c[0], h, c[1]], [c[0], h + rim, c[1]], [a[0], h + rim, a[1]]], uv, trimColor, b.id);
      quad(trim, [[a[0] + nx, h, a[1] + nz], [c[0] + nx, h, c[1] + nz], [c[0] + nx, h + rim, c[1] + nz], [a[0] + nx, h + rim, a[1] + nz]], uv, trimColor, b.id);
      quad(trim, [[a[0], h + rim, a[1]], [c[0], h + rim, c[1]], [c[0] + nx, h + rim, c[1] + nz], [a[0] + nx, h + rim, a[1] + nz]], uv, trimColor, b.id);
      // The apron is schematic; no invented streets are drawn through real footprints.
      const dx = (a[0] - cx) / (Math.hypot(a[0] - cx, a[1] - cz) || 1) * 4.5;
      const dz = (a[1] - cz) / (Math.hypot(a[0] - cx, a[1] - cz) || 1) * 4.5;
      const ex = (c[0] - cx) / (Math.hypot(c[0] - cx, c[1] - cz) || 1) * 4.5;
      const ez = (c[1] - cz) / (Math.hypot(c[0] - cx, c[1] - cz) || 1) * 4.5;
      quad(paths, [[a[0], .05, a[1]], [c[0], .05, c[1]], [c[0] + ex, .05, c[1] + ez], [a[0] + dx, .05, a[1] + dz]], uv, new THREE.Color("#c5c5bc"), "");
    }
    const shape = new THREE.Shape(poly.map(([x, z]) => new THREE.Vector2(x, -z)));
    const roofGeometry = new THREE.ShapeGeometry(shape).toNonIndexed();
    const p = roofGeometry.getAttribute("position");
    for (let i = 0; i < p.count; i += 3) {
      const points = [i, i + 1, i + 2].map((j) => [p.getX(j), h, -p.getY(j)]);
      triangle(roofs, points[0], points[1], points[2], points.map(([x, , z]) => [x / 14, z / 14]), roofColor, b.id);
    }
    roofGeometry.dispose();
    const minX = Math.min(...poly.map((p) => p[0])), maxX = Math.max(...poly.map((p) => p[0]));
    const minZ = Math.min(...poly.map((p) => p[1])), maxZ = Math.max(...poly.map((p) => p[1]));
    buildings.push({ data: b, polygon: poly, center: new THREE.Vector3((minX + maxX) / 2, h, (minZ + maxZ) / 2), radius: Math.max(maxX - minX, maxZ - minZ) / 2, roofStart, roofEnd: roofs.positions.length / 3 });
    let count = 0;
    const limit = Math.min(220, Math.floor(b.kwp / 1.1));
    for (let z = minZ + 4; z < maxZ - 4 && count < limit; z += 7) for (let x = minX + 4; x < maxX - 4 && count < limit; x += 4.2) {
      if (inside(x, z, poly) && edgeDistance(x, z, poly) > 3) {
        panelPositions.push(new THREE.Vector3(x, h + 1.1, z)); count++;
      }
    }
    if (b.roof_m2 > 150 && inside(cx, cz, poly) && edgeDistance(cx, cz, poly) > 4) fixtures.push({ x: cx, y: h + .9, z: cz, scale: Math.min(3, Math.sqrt(b.roof_m2) / 20) });
  });

  const group = new THREE.Group();
  const wallMesh = mesh(walls, new THREE.MeshStandardMaterial({ map: facadeTexture(), vertexColors: true, roughness: .76, side: THREE.DoubleSide }));
  const roofMaterial = new THREE.MeshStandardMaterial({ map: roofTexture(), vertexColors: true, roughness: .88, side: THREE.DoubleSide });
  const roofMesh = mesh(roofs, roofMaterial);
  group.add(wallMesh, roofMesh, mesh(trim, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .65, side: THREE.DoubleSide })), mesh(paths, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide })));
  const panels = new THREE.InstancedMesh(new THREE.BoxGeometry(2.5, .10, 3.8), new THREE.MeshStandardMaterial({ color: "#587d96", metalness: .4, roughness: .28, map: panelTexture() }), panelPositions.length);
  const helper = new THREE.Object3D();
  panelPositions.forEach((position, i) => { helper.position.copy(position); helper.rotation.x = Math.PI / 6; helper.updateMatrix(); panels.setMatrixAt(i, helper.matrix); });
  panels.castShadow = true; panels.receiveShadow = true;
  group.add(panels);
  const equipment = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: "#9babae", roughness: .65, metalness: .25 }), fixtures.length);
  fixtures.forEach((f, i) => { helper.position.set(f.x, f.y, f.z); helper.rotation.set(0, 0, 0); helper.scale.set(f.scale * 2, 1.6, f.scale); helper.updateMatrix(); equipment.setMatrixAt(i, helper.matrix); });
  equipment.castShadow = true; equipment.receiveShadow = true;
  group.add(equipment);
  const groundMap = groundTexture(width + 1000, depth + 1000, buildings);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(width + 1000, depth + 1000), new THREE.MeshStandardMaterial({ map: groundMap, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -.08; ground.receiveShadow = true; group.add(ground);
  // Landscaping is illustrative. Keep every trunk away from all OSM footprints.
  const bounds = buildings.map((b) => ({ b, x0: Math.min(...b.polygon.map(p => p[0])) - 4, x1: Math.max(...b.polygon.map(p => p[0])) + 4, z0: Math.min(...b.polygon.map(p => p[1])) - 4, z1: Math.max(...b.polygon.map(p => p[1])) + 4 }));
  const trees: { x: number; z: number; scale: number }[] = [];
  for (const b of buildings) {
    for (let j = 0; j < b.polygon.length; j += Math.max(1, Math.floor(b.polygon.length / 3))) {
      if (trees.length >= 650) break;
      const p = b.polygon[j], length = Math.hypot(p[0] - b.center.x, p[1] - b.center.z) || 1;
      const x = p[0] + (p[0] - b.center.x) / length * 13, z = p[1] + (p[1] - b.center.z) / length * 13;
      if (trees.some(t => Math.hypot(t.x - x, t.z - z) < 14)) continue;
      const obstructed = bounds.some(q => x > q.x0 && x < q.x1 && z > q.z0 && z < q.z1 && (inside(x, z, q.b.polygon) || edgeDistance(x, z, q.b.polygon) < 4));
      if (!obstructed) trees.push({ x, z, scale: .8 + (trees.length % 7) * .08 });
    }
  }
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(.22, .34, 4, 6), new THREE.MeshStandardMaterial({ color: "#6b6654", roughness: 1 }), trees.length);
  const crowns = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshStandardMaterial({ color: "#718051", roughness: .92 }), trees.length * 3);
  trees.forEach((t, i) => {
    helper.position.set(t.x, 2 * t.scale, t.z); helper.rotation.set(0, 0, 0); helper.scale.setScalar(t.scale); helper.updateMatrix(); trunks.setMatrixAt(i, helper.matrix);
    for (let j = 0; j < 3; j++) {
      const angle = j / 3 * Math.PI * 2 + i;
      helper.position.set(t.x + Math.cos(angle) * 1.15 * t.scale, (5.2 + j * .3) * t.scale, t.z + Math.sin(angle) * 1.15 * t.scale);
      helper.scale.set(2.7 * t.scale, (2.9 - j * .2) * t.scale, 2.4 * t.scale); helper.updateMatrix(); crowns.setMatrixAt(i * 3 + j, helper.matrix);
      crowns.setColorAt(i * 3 + j, new THREE.Color(["#c4c895", "#a6b988", "#d2cb9f", "#b1bf97"][i % 4]));
    }
  });
  trunks.castShadow = true; crowns.castShadow = true; crowns.receiveShadow = true; group.add(trunks, crowns);

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
      for (let i = b.roofStart; i < b.roofEnd; i++) colors.setXYZ(i, color.r, color.g, color.b);
    }
    colors.needsUpdate = true;
    roofMaterial.map = metric === "materials" ? originalRoofMap : null;
    roofMaterial.needsUpdate = true;
    panels.visible = metric === "materials";
  };
  const originalRoofMap = roofMaterial.map;
  return { group, buildings, width, depth, panels, pickables: [wallMesh, roofMesh], setMetric, roofTexture: originalRoofMap };
}
