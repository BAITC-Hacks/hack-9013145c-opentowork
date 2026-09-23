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
function groundTexture() {
  let seed = 714;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  return texture(1024, 1024, (ctx) => {
    // A fine, coherent lawn surface rather than metre-scale dirt blotches.
    ctx.fillStyle = "#789169"; ctx.fillRect(0, 0, 1024, 1024);
    for (let i = 0; i < 125000; i++) {
      ctx.fillStyle = i % 3 === 0 ? "rgba(204,215,169,.13)" : i % 3 === 1 ? "rgba(44,81,42,.10)" : "rgba(128,151,97,.14)";
      const x = rand() * 1024, y = rand() * 1024;
      ctx.fillRect(x, y, .5 + rand(), 1 + rand() * 3);
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
  const walls = surface(), roofs = surface(), trim = surface(), paths = surface(), curbs = surface();
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
  const groundMap = groundTexture();
  // Extend past the fog horizon so the district never sits on a visible rectangular sheet.
  groundMap.repeat.set((width + 12000) / 80, (depth + 12000) / 80);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(width + 12000, depth + 12000), new THREE.MeshStandardMaterial({ map: groundMap, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -.08; ground.receiveShadow = true; group.add(ground);
  // Trees are grouped along the aprons, with clearance from every measured footprint.
  const bounds = buildings.map((b) => ({ b, x0: Math.min(...b.polygon.map(p => p[0])) - 6, x1: Math.max(...b.polygon.map(p => p[0])) + 6, z0: Math.min(...b.polygon.map(p => p[1])) - 6, z1: Math.max(...b.polygon.map(p => p[1])) + 6 }));
  const trees: { x: number; z: number; scale: number }[] = [];
  const clear = (x: number, z: number) => !bounds.some(q => x > q.x0 && x < q.x1 && z > q.z0 && z < q.z1 && (inside(x, z, q.b.polygon) || edgeDistance(x, z, q.b.polygon) < 6));
  for (const b of buildings) {
    let planted = 0;
    for (let j = 0; j < b.polygon.length && planted < 8; j++) {
      const a = b.polygon[j], p = b.polygon[(j + 1) % b.polygon.length];
      const length = Math.hypot(p[0] - a[0], p[1] - a[1]);
      if (length < 20) continue;
      const [nx, nz] = outsideNormal(b.polygon, j);
      for (let d = 9; d < length - 7 && planted < 8; d += 18) {
        if (trees.length >= 1000) break;
        const x = a[0] + (p[0] - a[0]) * d / length + nx * 10.5;
        const z = a[1] + (p[1] - a[1]) * d / length + nz * 10.5;
        if (!clear(x, z) || trees.some(t => Math.hypot(t.x - x, t.z - z) < 12)) continue;
        trees.push({ x, z, scale: .85 + (trees.length % 5) * .085 }); planted++;
      }
    }
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
    helper.position.set(t.x, -.035, t.z); helper.rotation.set(-Math.PI / 2, 0, 0); helper.scale.setScalar(t.scale); helper.updateMatrix(); beds.setMatrixAt(i, helper.matrix);
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
