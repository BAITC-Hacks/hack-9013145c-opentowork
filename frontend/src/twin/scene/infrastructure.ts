import * as THREE from "three";
import { terrainHeight } from "./terrain";

type Site = { x: number; z: number };
type Size = [number, number, number];
type Part = { size: Size; at: Size; rotation?: Size };

/** Repeated facade, equipment and fence parts share one draw per material. */
class Parts {
  private boxes = new Map<THREE.Material, Part[]>();
  private cylinders = new Map<THREE.Material, Part[]>();

  box(material: THREE.Material, size: Size, at: Size, rotation?: Size) {
    const list = this.boxes.get(material) ?? [];
    list.push({ size, at, rotation });
    this.boxes.set(material, list);
  }

  cylinder(material: THREE.Material, radius: number, height: number, at: Size, rotation?: Size) {
    const list = this.cylinders.get(material) ?? [];
    list.push({ size: [radius, height, radius], at, rotation });
    this.cylinders.set(material, list);
  }

  finish(group: THREE.Group) {
    const matrix = new THREE.Object3D();
    for (const [collection, geometry, label] of [
      [this.boxes, new THREE.BoxGeometry(1, 1, 1), "Building and equipment"],
      [this.cylinders, new THREE.CylinderGeometry(1, 1, 1, 12), "Posts, bushings and mechanical details"],
    ] as const) {
      for (const [material, list] of collection) {
        const mesh = new THREE.InstancedMesh(geometry, material, list.length);
        mesh.name = `${label} · ${material.name}`;
        list.forEach((part, index) => {
          matrix.position.set(...part.at);
          matrix.scale.set(...part.size);
          matrix.rotation.set(...(part.rotation ?? [0, 0, 0]));
          matrix.updateMatrix();
          mesh.setMatrixAt(index, matrix.matrix);
        });
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.computeBoundingSphere();
        group.add(mesh);
      }
    }
  }
}

function surface(kind: "cladding" | "roof" | "asphalt"): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable");
  const pixels = context.createImageData(256, 256);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
      const grain = (n - Math.floor(n) - 0.5) * (kind === "asphalt" ? 22 : 7);
      const rib = x % 16 < 2 ? -20 : x % 16 < 4 ? 9 : 0;
      const seam = y % 128 < 2 ? -16 : 0;
      const base = kind === "asphalt" ? 106 : kind === "roof" ? 145 : 219;
      const tone = base + grain + (kind === "asphalt" ? 0 : rib + seam);
      const i = (y * 256 + x) * 4;
      pixels.data[i] = tone;
      pixels.data[i + 1] = tone + (kind === "cladding" ? 2 : 3);
      pixels.data[i + 2] = tone + (kind === "cladding" ? 0 : 4);
      pixels.data[i + 3] = 255;
    }
  }
  context.putImageData(pixels, 0, 0);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(kind === "asphalt" ? 10 : 5, kind === "asphalt" ? 8 : 2);
  map.anisotropy = 4;
  return map;
}

function material(name: string, color: string, roughness = 0.7, metalness = 0.05) {
  const value = new THREE.MeshStandardMaterial({ color, roughness, metalness });
  value.name = name;
  return value;
}

/** Keep the service yard clear of rotors, crane pads and full solar-array footprints. */
function hubLocation(sites: Site[], kind: "wind" | "solar"): Site {
  const center = {
    x: sites.reduce((sum, s) => sum + s.x, 0) / Math.max(sites.length, 1),
    z: sites.reduce((sum, s) => sum + s.z, 0) / Math.max(sites.length, 1),
  };
  let chosen = { x: center.x - 200, z: center.z + 230 };
  let best = Infinity;
  for (let radius = 220; radius <= 1000; radius += 100) {
    for (let step = 0; step < 16; step++) {
      const angle = step / 16 * Math.PI * 2;
      const point = { x: center.x + Math.cos(angle) * radius, z: center.z + Math.sin(angle) * radius };
      if (sites.some((s) => Math.hypot(s.x - point.x, s.z - point.z) < (kind === "solar" ? 225 : 170))) continue;
      const heights = [-1, 1].flatMap((x) => [-1, 1].map((z) => terrainHeight(point.x + x * 73, point.z + z * 53)));
      const slope = Math.max(...heights) - Math.min(...heights);
      const score = radius + slope * 42 + Math.abs(point.x - center.x + 110) * 0.12
        + Math.abs(point.z - center.z - 210) * 0.35;
      if (score < best) { best = score; chosen = point; }
    }
  }
  return chosen;
}

/** A terrain-following driveway meets the existing landscape's east–west service road. */
function driveway(hub: Site, elevation: number, roadMaterial: THREE.Material): THREE.Mesh {
  const startZ = hub.z + 52;
  const endZ = 510 + Math.sin(hub.x / 1900) * 145;
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  const length = Math.abs(endZ - startZ);
  for (let step = 0; step <= 32; step++) {
    const t = step / 32;
    const z = THREE.MathUtils.lerp(startZ, endZ, t);
    for (const side of [-1, 1]) {
      const x = hub.x + side * 4;
      const ground = terrainHeight(x, z) + 0.35;
      const height = THREE.MathUtils.lerp(elevation + 0.1, ground, Math.min(1, t * Math.max(length, 25) / 25));
      positions.push(x, height, z);
      uvs.push(side === -1 ? 0 : 1, t * length / 8);
    }
    if (step < 32) {
      const a = step * 2;
      if (endZ >= startZ) indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      else indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, roadMaterial);
  mesh.name = "Service compound driveway";
  mesh.receiveShadow = true;
  return mesh;
}

/** All resources are attached to scene meshes and handled by the scene's shared disposal. */
export function createStationInfrastructure(sites: Site[], kind: "wind" | "solar"): THREE.Group {
  const root = new THREE.Group();
  root.name = "Station operations building and electrical substation";
  const hub = hubLocation(sites, kind);
  const ground = [-1, 0, 1].flatMap((x) => [-1, 0, 1].map((z) => terrainHeight(hub.x + x * 73, hub.z + z * 53)));
  const elevation = Math.max(...ground) + 0.12;
  const compound = new THREE.Group();
  compound.position.set(hub.x, elevation, hub.z);
  root.add(compound);
  const parts = new Parts();

  const concrete = material("Concrete plinths", "#b4b5aa", 0.95);
  const facade = material("Ribbed light metal cladding", "#ffffff", 0.72, 0.22);
  facade.map = surface("cladding");
  facade.bumpMap = facade.map;
  facade.bumpScale = 0.055;
  const roof = material("Standing seam roofing", "#c4cdcd", 0.62, 0.3);
  roof.map = surface("roof");
  roof.bumpMap = roof.map;
  roof.bumpScale = 0.04;
  const asphalt = material("Compacted service apron", "#d0d1cc", 0.96);
  asphalt.map = surface("asphalt");
  const teal = material("Painted service doors and trim", "#4a777c", 0.55, 0.15);
  const metal = material("Galvanised steel", "#a4b0af", 0.48, 0.65);
  const dark = material("Equipment recesses", "#333f44", 0.8, 0.2);
  const glass = material("Reflective blue glazing", "#527b8b", 0.22, 0.55);
  const white = material("Road paint and service vehicles", "#e8e9dc", 0.7);
  const yellow = material("Safety bollards and clearance lines", "#dfb95d", 0.7);
  const insulator = material("Porcelain insulators", "#849798", 0.35, 0.1);
  const rubber = material("Vehicle tyres", "#282e30", 0.93);
  const depth = elevation - Math.min(...ground) + 0.45;
  parts.box(concrete, [146, depth, 106], [0, -depth / 2, 0]);
  parts.box(asphalt, [145.5, 0.16, 105.5], [0, 0.03, 0]);
  // A workshop with an attached lower control-room wing reads as an occupied facility.
  parts.box(concrete, [51, 0.65, 31], [-16, 0.38, -15]);
  parts.box(facade, [49, 10.5, 29], [-16, 5.9, -15]);
  parts.box(roof, [50.2, 0.3, 30.2], [-16, 11.3, -15]);
  parts.box(concrete, [19, 0.55, 25], [-49, 0.3, -10]);
  parts.box(facade, [18, 7.1, 24], [-49, 3.9, -10]);
  parts.box(roof, [19, 0.24, 25], [-49, 7.6, -10]);

  for (const [cx, cz, width, depthM, height] of [[-16, -15, 50.2, 30.2, 11.55], [-49, -10, 19, 25, 7.9]]) {
    for (const side of [-1, 1]) {
      parts.box(metal, [width, 0.42, 0.22], [cx, height, cz + side * depthM / 2]);
      parts.box(metal, [0.22, 0.42, depthM], [cx + side * width / 2, height, cz]);
      // Gutters and downpipes give the roof a visible construction edge.
      parts.box(teal, [width, 0.22, 0.28], [cx, height - 0.6, cz + side * depthM / 2]);
      parts.cylinder(metal, 0.09, height - 0.45, [cx + width / 2 - 0.5, height / 2, cz + side * depthM / 2]);
    }
  }
  for (const x of [-37, -27, -17, -7, 3]) {
    // Clerestory windows have an inset frame, mullion and a projecting sill.
    parts.box(dark, [6.3, 2.05, 0.22], [x, 8.6, -0.38]);
    parts.box(glass, [5.9, 1.7, 0.25], [x, 8.65, -0.24]);
    parts.box(metal, [0.09, 1.8, 0.3], [x, 8.65, -0.12]);
    parts.box(metal, [6.4, 0.1, 0.5], [x, 7.55, -0.2]);
  }
  for (const x of [-53.3, -48.7, -44.1]) {
    for (const y of [2.9, 5.5]) {
      parts.box(dark, [3.75, 1.9, 0.2], [x, y, 2.08]);
      parts.box(glass, [3.4, 1.6, 0.24], [x, y + 0.03, 2.21]);
      parts.box(metal, [0.07, 1.65, 0.26], [x, y + 0.03, 2.35]);
    }
  }
  for (const z of [-17, -11, -5]) {
    for (const y of [2.9, 5.5]) {
      parts.box(dark, [0.18, 1.9, 3.7], [-58.08, y, z]);
      parts.box(glass, [0.2, 1.6, 3.35], [-58.2, y + 0.03, z]);
      parts.box(metal, [0.23, 1.7, 0.08], [-58.33, y, z]);
    }
  }
  // Two roll-up workshop doors, with individual shutter slats and protected jambs.
  for (const x of [-26, -10]) {
    parts.box(dark, [8.5, 6.4, 0.3], [x, 3.8, -0.35]);
    parts.box(teal, [7.8, 5.9, 0.33], [x, 3.7, -0.15]);
    for (let slat = 0; slat < 18; slat++) parts.box(metal, [7.7, 0.045, 0.08], [x, 0.9 + slat * 0.32, 0.06]);
    for (const side of [-1, 1]) parts.cylinder(yellow, 0.15, 1.5, [x + side * 4.7, 0.82, 1.3]);
    parts.box(dark, [1.6, 0.15, 0.18], [x, 1.25, 0.12]);
  }
  parts.box(teal, [2, 3, 0.22], [-37, 2.15, -0.15]);
  parts.box(glass, [1.55, 1.3, 0.25], [-37, 2.6, 0]);
  parts.box(metal, [0.09, 0.52, 0.16], [-36.35, 1.8, 0.16]);
  parts.box(teal, [6.2, 0.2, 3.3], [-37, 3.9, 1.35]);
  for (const x of [-39.7, -34.3]) parts.cylinder(metal, 0.1, 3.6, [x, 2, 2.65]);
  // Roof plant: fan housings, exhaust cowls, raised skylights and access hatch.
  for (const x of [-31, -13, 1]) {
    parts.box(dark, [5, 0.4, 3.6], [x, 11.64, -18]);
    parts.box(metal, [4.6, 1.65, 3.2], [x, 12.55, -18]);
    for (const dz of [-0.78, 0.78]) {
      parts.cylinder(dark, 0.65, 0.09, [x, 13.44, -18 + dz]);
      parts.cylinder(metal, 0.2, 0.14, [x, 13.52, -18 + dz]);
      for (const angle of [0, Math.PI / 3, -Math.PI / 3]) parts.box(metal, [1.25, 0.045, 0.045], [x, 13.51, -18 + dz], [0, angle, 0]);
    }
    for (let louver = 0; louver < 7; louver++) parts.box(dark, [3.9, 0.06, 0.05], [x, 11.95 + louver * 0.18, -16.36]);
  }
  for (const x of [-30, -10]) {
    parts.box(metal, [9, 0.4, 2.4], [x, 11.7, -7]);
    parts.box(glass, [8.6, 0.18, 2.08], [x, 11.98, -7]);
    for (let i = -3; i <= 3; i += 2) parts.box(metal, [0.1, 0.12, 2.2], [x + i, 12.1, -7]);
  }
  for (const x of [-35, -21, -7]) {
    parts.cylinder(metal, 0.42, 1.8, [x, 12.25, -26]);
    parts.cylinder(dark, 0.65, 0.2, [x, 13.2, -26]);
    parts.cylinder(metal, 0.72, 0.12, [x, 13.36, -26]);
  }
  parts.box(teal, [2.2, 0.24, 2.4], [-49, 7.9, -17]);

  // Independent electrical compound: two oil-cooled transformers and switchgear.
  parts.box(concrete, [48, 0.18, 49], [37, 0.24, -15]);
  for (const x of [26, 47]) {
    parts.box(dark, [10.5, 0.5, 13], [x, 0.65, -17]);
    parts.box(concrete, [8, 0.8, 9], [x, 1.2, -17]);
    parts.box(teal, [6.8, 4.1, 7], [x, 3.65, -17]);
    parts.box(metal, [7.15, 0.3, 7.4], [x, 5.85, -17]);
    for (const side of [-1, 1]) {
      for (let fin = 0; fin < 12; fin++) parts.box(metal, [0.95, 3.1, 0.16], [x + side * 3.8, 3.55, -19.75 + fin * 0.5]);
    }
    parts.cylinder(teal, 0.9, 5.7, [x, 6.9, -19.2], [0, 0, Math.PI / 2]);
    for (const dx of [-2.1, 0, 2.1]) {
      for (const dz of [-0.3, 2.1]) {
        parts.cylinder(insulator, 0.2, 2, [x + dx, 6.8, -17 + dz]);
        for (let rib = 0; rib < 6; rib++) parts.cylinder(insulator, 0.4, 0.15, [x + dx, 6.1 + rib * 0.29, -17 + dz]);
        parts.cylinder(metal, 0.09, 0.6, [x + dx, 8.05, -17 + dz]);
      }
    }
  }
  for (let cabinet = 0; cabinet < 5; cabinet++) {
    const x = 22 + cabinet * 7.3;
    parts.box(concrete, [4.5, 0.4, 3.1], [x, 0.55, 1.5]);
    parts.box(facade, [4, 3.5, 2.65], [x, 2.5, 1.5]);
    parts.box(roof, [4.3, 0.18, 2.95], [x, 4.34, 1.5]);
    parts.box(dark, [0.045, 3.3, 0.05], [x, 2.5, 2.86]);
    parts.box(teal, [0.12, 0.45, 0.08], [x + 0.25, 2.4, 2.9]);
    for (let vent = 0; vent < 4; vent++) parts.box(dark, [2.9, 0.06, 0.05], [x, 1.3 + vent * 0.17, 2.87]);
  }

  const fenceWire: number[] = [];
  const fence = (a: Site, b: Site) => {
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const bays = Math.ceil(length / 3);
    for (let i = 0; i <= bays; i++) {
      const t = i / bays;
      parts.cylinder(metal, 0.065, 3, [THREE.MathUtils.lerp(a.x, b.x, t), 1.8, THREE.MathUtils.lerp(a.z, b.z, t)]);
    }
    for (const y of [0.7, 2.95]) fenceWire.push(a.x, y, a.z, b.x, y, b.z);
    // Diagonal wire is actual geometry, so it keeps its scale when orbiting.
    for (let offset = -2.4; offset < length; offset += 0.65) {
      for (const direction of [-1, 1]) {
        const start = Math.max(0, offset), end = Math.min(length, offset + 2.4);
        if (end <= start) continue;
        const y1 = direction > 0 ? 0.55 + start - offset : 2.95 - start + offset;
        const y2 = direction > 0 ? 0.55 + end - offset : 2.95 - end + offset;
        fenceWire.push(
          THREE.MathUtils.lerp(a.x, b.x, start / length), y1, THREE.MathUtils.lerp(a.z, b.z, start / length),
          THREE.MathUtils.lerp(a.x, b.x, end / length), y2, THREE.MathUtils.lerp(a.z, b.z, end / length),
        );
      }
    }
  };
  fence({ x: 13, z: -40 }, { x: 61, z: -40 });
  fence({ x: 13, z: -40 }, { x: 13, z: 10 });
  fence({ x: 61, z: -40 }, { x: 61, z: 10 });
  fence({ x: 13, z: 10 }, { x: 42, z: 10 });
  fence({ x: 50, z: 10 }, { x: 61, z: 10 });
  for (const x of [44, 48]) {
    parts.box(metal, [4, 0.09, 0.1], [x, 0.65, 10]);
    parts.box(metal, [4, 0.09, 0.1], [x, 2.8, 10]);
    for (let i = -1.8; i < 2; i += 0.4) parts.box(metal, [0.055, 2.2, 0.055], [x + i, 1.7, 10]);
  }
  const fenceGeometry = new THREE.BufferGeometry();
  fenceGeometry.setAttribute("position", new THREE.Float32BufferAttribute(fenceWire, 3));
  const meshFence = new THREE.LineSegments(fenceGeometry, new THREE.LineBasicMaterial({ color: "#778687", transparent: true, opacity: 0.65 }));
  meshFence.name = "Galvanised diamond-mesh substation fence";
  compound.add(meshFence);

  // Parking bays and a loading apron create useful visual scale at ground level.
  for (let bay = 0; bay <= 6; bay++) parts.box(white, [0.12, 0.025, 7.8], [-60 + bay * 3.6, 0.14, 34]);
  parts.box(white, [21.8, 0.025, 0.12], [-49.2, 0.14, 30.1]);
  for (const x of [-58.2, -51, -40.2]) {
    parts.box(white, [2.25, 1.3, 5.1], [x, 1.4, 34]);
    parts.box(white, [2.14, 1.1, 3.25], [x, 2.6, 33.6]);
    parts.box(glass, [1.88, 0.78, 0.08], [x, 2.52, 35.28]);
    parts.box(teal, [2.27, 0.22, 4.75], [x, 1.85, 34]);
    parts.box(dark, [2.3, 0.22, 0.2], [x, 0.95, 36.65]);
    for (const side of [-1, 1]) {
      parts.box(glass, [0.06, 0.72, 1.05], [x + side * 1.09, 2.53, 34.7]);
      for (const dz of [-1.55, 1.55]) {
        parts.cylinder(rubber, 0.46, 0.27, [x + side * 1.12, 0.73, 34 + dz], [0, 0, Math.PI / 2]);
        parts.cylinder(metal, 0.23, 0.28, [x + side * 1.14, 0.73, 34 + dz], [0, 0, Math.PI / 2]);
      }
    }
  }
  for (const x of [-26, -10]) {
    for (const dx of [-5, 5]) parts.box(yellow, [0.12, 0.025, 12], [x + dx, 0.14, 8]);
  }
  // A spares container, cable drums and stacked pallets complete the service yard.
  parts.box(teal, [12.2, 2.9, 2.45], [35, 1.65, 33]);
  parts.box(roof, [12.3, 0.1, 2.5], [35, 3.15, 33]);
  for (let rib = 0; rib < 36; rib++) parts.box(metal, [0.045, 2.65, 0.05], [29.1 + rib * 0.335, 1.64, 34.25]);
  for (const x of [45, 50]) {
    parts.cylinder(dark, 0.85, 1.5, [x, 1.25, 34], [Math.PI / 2, 0, 0]);
    for (const dz of [-0.82, 0.82]) parts.cylinder(concrete, 1.1, 0.16, [x, 1.25, 34 + dz], [Math.PI / 2, 0, 0]);
  }
  for (let level = 0; level < 4; level++) parts.box(concrete, [3.5, 0.25, 2.5], [57, 0.35 + level * 0.36, 33]);
  for (const [x, z] of [[-64, 16], [6, 30], [64, 24]]) {
    parts.cylinder(metal, 0.11, 8, [x, 4.15, z]);
    parts.box(metal, [2, 0.13, 0.15], [x + 0.85, 8.1, z]);
    parts.box(dark, [0.9, 0.15, 0.55], [x + 1.6, 8.04, z]);
    parts.box(white, [0.75, 0.04, 0.42], [x + 1.6, 7.94, z]);
  }
  parts.finish(compound);
  root.add(driveway(hub, elevation, asphalt));
  return root;
}
