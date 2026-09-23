import * as THREE from "three";

type Site = { x: number; z: number };

const LAND_SIZE = 7200;
const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const smooth = (v: number) => v * v * (3 - 2 * v);

function hash(x: number, y: number): number {
  let n = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function noise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const a = THREE.MathUtils.lerp(hash(ix, iy), hash(ix + 1, iy), fx);
  const b = THREE.MathUtils.lerp(hash(ix, iy + 1), hash(ix + 1, iy + 1), fx);
  return THREE.MathUtils.lerp(a, b, fy);
}

function fbm(x: number, z: number): number {
  return noise(x, z) * 0.54 + noise(x * 2.03 + 31, z * 2.03 + 7) * 0.28
    + noise(x * 4.13 + 12, z * 4.13 + 57) * 0.12 + noise(x * 8.19, z * 8.19) * 0.06;
}

/** A shared, deterministic elevation function; turbines and overlays use this datum. */
export function terrainHeight(x: number, z: number): number {
  return (fbm(x / 1900 + 9, z / 1900 + 23) - 0.5) * 51
    + (noise(x / 390 + 5, z / 390 + 17) - 0.5) * 5.5
    + Math.sin(x / 1600 + z / 2700) * 8;
}

function snowCover(x: number, z: number): number {
  const warp = noise(x / 310 + 14, z / 310 + 21);
  const broad = fbm(x / 190 + warp * 2.4 + 82, z / 170 + 46);
  const wind = noise(x / 220 + z / 330 + 55, z / 24 + 93);
  return smooth(clamp((broad * 0.8 + wind * 0.2 - 0.36) / 0.24));
}

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const element = document.createElement("canvas");
  element.width = element.height = size;
  const context = element.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas 2D is unavailable");
  return [element, context];
}

function texture(element: HTMLCanvasElement, color = false): THREE.CanvasTexture {
  const value = new THREE.CanvasTexture(element);
  value.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  value.anisotropy = 8;
  return value;
}

/** Unique kilometre-scale albedo, with fine snow grains supplied by a separate normal map. */
function groundMaps(): { map: THREE.CanvasTexture; normalMap: THREE.CanvasTexture; roughnessMap: THREE.CanvasTexture } {
  const size = 2048;
  const [albedo, ctx] = canvas(size);
  const image = ctx.createImageData(size, size);
  const pixels = image.data;
  for (let y = 0; y < size; y++) {
    const z = (y / (size - 1) - 0.5) * LAND_SIZE;
    for (let x = 0; x < size; x++) {
      const worldX = (x / (size - 1) - 0.5) * LAND_SIZE;
      const cover = snowCover(worldX, z);
      const grain = hash(x + 121, y + 97) - 0.5;
      const vegetation = noise(worldX / 25 + 33, z / 25 + 67);
      const soilVariation = vegetation * 24 + grain * 13;
      const snowVariation = noise(worldX / 60, z / 70) * 10 + grain * 7;
      const i = (y * size + x) * 4;
      pixels[i] = THREE.MathUtils.lerp(104 + soilVariation, 218 + snowVariation, cover);
      pixels[i + 1] = THREE.MathUtils.lerp(94 + soilVariation * 0.9, 220 + snowVariation, cover);
      pixels[i + 2] = THREE.MathUtils.lerp(75 + soilVariation * 0.8, 217 + snowVariation, cover);
      pixels[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const detailSize = 512;
  const [normal, normalCtx] = canvas(detailSize);
  const [rough, roughCtx] = canvas(detailSize);
  const normalImage = normalCtx.createImageData(detailSize, detailSize);
  const roughImage = roughCtx.createImageData(detailSize, detailSize);
  // All frequencies wrap exactly: close views show granular relief without seams.
  const heights = new Float32Array(detailSize * detailSize);
  for (let y = 0; y < detailSize; y++) {
    for (let x = 0; x < detailSize; x++) {
      const streak = Math.sin(x * Math.PI / 16 + Math.sin(y * Math.PI / 64) * 1.8);
      heights[y * detailSize + x] = hash(x, y) * 0.35 + streak * 0.035;
    }
  }
  for (let y = 0; y < detailSize; y++) {
    for (let x = 0; x < detailSize; x++) {
      const i = (y * detailSize + x) * 4;
      const dx = heights[y * detailSize + (x + 1) % detailSize]
        - heights[y * detailSize + (x + detailSize - 1) % detailSize];
      const dy = heights[((y + 1) % detailSize) * detailSize + x]
        - heights[((y + detailSize - 1) % detailSize) * detailSize + x];
      const n = new THREE.Vector3(-dx * 1.9, -dy * 1.9, 1).normalize();
      normalImage.data[i] = (n.x * 0.5 + 0.5) * 255;
      normalImage.data[i + 1] = (n.y * 0.5 + 0.5) * 255;
      normalImage.data[i + 2] = (n.z * 0.5 + 0.5) * 255;
      normalImage.data[i + 3] = 255;
      const value = 223 + hash(x + 81, y + 72) * 31;
      roughImage.data[i] = roughImage.data[i + 1] = roughImage.data[i + 2] = value;
      roughImage.data[i + 3] = 255;
    }
  }
  normalCtx.putImageData(normalImage, 0, 0);
  roughCtx.putImageData(roughImage, 0, 0);
  const normalMap = texture(normal);
  const roughnessMap = texture(rough);
  for (const map of [normalMap, roughnessMap]) {
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.repeat.set(LAND_SIZE / 32, LAND_SIZE / 32);
  }
  return { map: texture(albedo, true), normalMap, roughnessMap };
}

function gravelMap(): THREE.CanvasTexture {
  const size = 512;
  const [surface, ctx] = canvas(size);
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const speckle = hash(x + 35, y + 59);
      const grains = noise(x / 4, y / 4);
      const tone = 122 + speckle * 38 + grains * 16;
      image.data[i] = tone;
      image.data[i + 1] = tone - 8;
      image.data[i + 2] = tone - 18;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const map = texture(surface, true);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  return map;
}

/** A high-resolution, feathered surface around each asset, aligned to the base mesh. */
function localGround(site: Site, normal: THREE.CanvasTexture, roughness: THREE.CanvasTexture): THREE.Mesh {
  const patchSize = 420;
  const startX = Math.floor((site.x - patchSize / 2) / 30) * 30;
  const startZ = Math.floor((site.z - patchSize / 2) / 30) * 30;
  const size = 1024;
  const [surface, ctx] = canvas(size);
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    const z = startZ + y / (size - 1) * patchSize;
    for (let x = 0; x < size; x++) {
      const worldX = startX + x / (size - 1) * patchSize;
      const cover = snowCover(worldX, z);
      const distance = Math.hypot(worldX - site.x, z - site.z);
      const alpha = 1 - smooth(clamp((distance - 145) / 30));
      const fineGrain = hash(x + 27, y + 82) - 0.5;
      const mineral = noise(worldX / 0.8 + 18, z / 0.8 + 42) - 0.5;
      const soil = noise(worldX / 25 + 33, z / 25 + 67) * 24 + fineGrain * 16 + mineral * 22;
      const frost = noise(worldX / 60, z / 70) * 10 + fineGrain * 5 + mineral * 4;
      const i = (y * size + x) * 4;
      image.data[i] = THREE.MathUtils.lerp(104 + soil, 218 + frost, cover);
      image.data[i + 1] = THREE.MathUtils.lerp(94 + soil * 0.9, 220 + frost, cover);
      image.data[i + 2] = THREE.MathUtils.lerp(75 + soil * 0.8, 217 + frost, cover);
      image.data[i + 3] = alpha * 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  // Fine exposed straw lies on the earth; the alpha mask keeps the patch edge invisible.
  ctx.globalCompositeOperation = "source-atop";
  ctx.lineWidth = 0.6;
  for (let i = 0; i < 3600; i++) {
    const x = hash(i, 341) * size;
    const y = hash(i, 295) * size;
    if (snowCover(startX + x / size * patchSize, startZ + y / size * patchSize) > 0.65) continue;
    ctx.strokeStyle = i % 2 ? "rgba(132,115,85,.32)" : "rgba(76,67,51,.22)";
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + 1.8, y - 1.1, x + 3.5 + hash(i, 492) * 3, y - 1.4);
    ctx.stroke();
  }
  const normalMap = normal.clone();
  const roughnessMap = roughness.clone();
  for (const detail of [normalMap, roughnessMap]) {
    detail.repeat.set(patchSize / 32, patchSize / 32);
    detail.offset.set((startX + LAND_SIZE / 2) / 32, (LAND_SIZE / 2 - startZ - patchSize) / 32);
  }
  const geometry = new THREE.PlaneGeometry(patchSize, patchSize, 14, 14);
  geometry.rotateX(-Math.PI / 2);
  const positions = geometry.getAttribute("position");
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i) + startX + patchSize / 2;
    const z = positions.getZ(i) + startZ + patchSize / 2;
    positions.setXYZ(i, x, terrainHeight(x, z) + 0.025, z);
  }
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    map: texture(surface, true), normalMap, roughnessMap,
    normalScale: new THREE.Vector2(0.42, 0.42), roughness: 1,
    transparent: true, depthWrite: false,
  }));
  mesh.name = "Local 0.41 m/texel snow, soil and straw";
  mesh.receiveShadow = true;
  return mesh;
}

function ribbon(points: THREE.Vector3[], width: number, material: THREE.Material, offset: number): THREE.Mesh {
  const path = new THREE.CatmullRomCurve3(points);
  const length = path.getLength();
  const steps = Math.max(32, Math.ceil(length / 12));
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const center = path.getPoint(t);
    const tangent = path.getTangent(t).normalize();
    const perpendicular = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
    for (const side of [-1, 1]) {
      const x = center.x + perpendicular.x * width * 0.5 * side;
      const z = center.z + perpendicular.z * width * 0.5 * side;
      positions.push(x, terrainHeight(x, z) + offset, z);
      uvs.push(side === -1 ? 0 : width / 8, length * t / 8);
    }
    if (i < steps) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  return mesh;
}

function pad(site: Site, radius: number, material: THREE.Material): THREE.Mesh {
  const geometry = new THREE.CircleGeometry(radius, 64);
  geometry.rotateX(-Math.PI / 2);
  const positions = geometry.getAttribute("position");
  const uv = geometry.getAttribute("uv");
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i) + site.x;
    const z = positions.getZ(i) + site.z;
    positions.setXYZ(i, x, terrainHeight(x, z) + 0.3, z);
    uv.setXY(i, x / 8, z / 8);
  }
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  return mesh;
}

function accessRoadZ(x: number): number {
  return 510 + Math.sin(x / 1900) * 145;
}

function onClearedGround(x: number, z: number, sites: Site[]): boolean {
  return Math.abs(z - accessRoadZ(x)) < 12 || sites.some((site) => {
    const roadZ = accessRoadZ(site.x);
    return Math.hypot(x - site.x, z - site.z) < 36
      || (x > site.x - 55 && x < site.x + 24 && z > Math.min(site.z, roadZ) - 8 && z < Math.max(site.z, roadZ) + 8);
  });
}

function addInfrastructure(group: THREE.Group, sites: Site[]): void {
  const map = gravelMap();
  const gravel = new THREE.MeshStandardMaterial({ map, roughness: 1, color: 0xc3bbae });
  const shoulder = new THREE.MeshStandardMaterial({ map, roughness: 1, color: 0x938773 });
  const track = new THREE.MeshStandardMaterial({ color: 0x746d60, roughness: 1 });
  const main = [-3400, -2200, -1100, 0, 1100, 2400, 3400]
    .map((x) => new THREE.Vector3(x, 0, accessRoadZ(x)));
  group.add(ribbon(main, 10, shoulder, 0.2), ribbon(main, 7.4, gravel, 0.25));
  for (const site of sites) {
    const z = accessRoadZ(site.x);
    const approach = [
      new THREE.Vector3(site.x - 45, 0, z),
      new THREE.Vector3(site.x - 8, 0, z + (site.z - z) * 0.35),
      new THREE.Vector3(site.x + 10, 0, site.z + (z - site.z) * 0.22),
      new THREE.Vector3(site.x + 8, 0, site.z),
    ];
    group.add(ribbon(approach, 8, shoulder, 0.2), ribbon(approach, 5.5, gravel, 0.25));
    // The two compacted wheel tracks are restrained enough to read as ground detail.
    for (const offset of [-0.92, 0.92]) {
      const rut = approach.map((p) => new THREE.Vector3(p.x + offset, 0, p.z));
      group.add(ribbon(rut, 0.3, track, 0.3));
    }
    group.add(pad(site, 25, gravel));
    const cranePad = [new THREE.Vector3(site.x + 15, 0, site.z - 20), new THREE.Vector3(site.x + 15, 0, site.z + 22)];
    group.add(ribbon(cranePad, 18, gravel, 0.3));
  }
}

function addVegetation(group: THREE.Group, sites: Site[]): void {
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  // One instanced draw for thousands of dormant tussocks; no camera-facing billboards.
  const blades = new THREE.BufferGeometry();
  const vertices: number[] = [];
  for (let i = 0; i < 5; i++) {
    const angle = i * 2.39996;
    const x = Math.cos(angle) * 0.3;
    const z = Math.sin(angle) * 0.3;
    const height = 0.7 + hash(i, 5) * 0.6;
    vertices.push(x - 0.07, 0, z, x + 0.07, 0, z, x + 0.24, height, z + 0.13);
  }
  blades.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  blades.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ color: 0x86735b, roughness: 1, side: THREE.DoubleSide });
  const count = 8500 + sites.length * 1500;
  const grass = new THREE.InstancedMesh(blades, material, count);
  let used = 0;
  for (let i = 0; i < count * 3 && used < count; i++) {
    const nearSite = i < sites.length * 2500 ? sites[i % sites.length] : undefined;
    const radius = 38 + Math.sqrt(hash(i, 732)) * 160;
    const angle = hash(i, 518) * Math.PI * 2;
    const x = nearSite ? nearSite.x + Math.cos(angle) * radius : (hash(i, 211) - 0.5) * 4000;
    const z = nearSite ? nearSite.z + Math.sin(angle) * radius : (hash(i, 137) - 0.5) * 3400;
    if (onClearedGround(x, z, sites)) continue;
    const cover = snowCover(x, z);
    if (hash(i, 37) < cover * 0.6 || noise(x / 130, z / 130) < 0.3) continue;
    dummy.position.set(x, terrainHeight(x, z) - 0.08, z);
    dummy.rotation.set(0, hash(i, 85) * Math.PI * 2, 0);
    const scale = 0.65 + hash(i, 119) * 1.5;
    dummy.scale.set(scale, scale * (0.7 + cover * 0.35), scale);
    dummy.updateMatrix();
    grass.setMatrixAt(used, dummy.matrix);
    color.setRGB(0.41 + hash(i, 31) * 0.13, 0.35 + hash(i, 31) * 0.1, 0.26 + hash(i, 31) * 0.08);
    grass.setColorAt(used++, color);
  }
  grass.count = used;
  grass.receiveShadow = true;
  grass.computeBoundingSphere();
  group.add(grass);

  const rockGeometry = new THREE.IcosahedronGeometry(1, 1);
  const rockPositions = rockGeometry.getAttribute("position");
  for (let i = 0; i < rockPositions.count; i++) {
    const x = rockPositions.getX(i);
    const y = rockPositions.getY(i);
    const z = rockPositions.getZ(i);
    // Equal spatial vertices receive equal deformation, preserving closed facets.
    const variation = 0.82 + noise(x * 7 + 21, z * 7 + y * 3 + 17) * 0.35;
    rockPositions.setXYZ(i, x * variation, y * variation, z * variation);
  }
  rockGeometry.computeVertexNormals();
  const rockLimit = 850 + sites.length * 150;
  const rocks = new THREE.InstancedMesh(rockGeometry, new THREE.MeshStandardMaterial({ color: 0x89877f, roughness: 0.98 }), rockLimit);
  let rockCount = 0;
  for (let i = 0; i < rockLimit * 2 && rockCount < rockLimit; i++) {
    const nearSite = i < sites.length * 180 ? sites[i % sites.length] : undefined;
    const radius = 35 + Math.sqrt(hash(i, 819)) * 150;
    const angle = hash(i, 820) * Math.PI * 2;
    const x = nearSite ? nearSite.x + Math.cos(angle) * radius : (hash(i, 515) - 0.5) * 3200;
    const z = nearSite ? nearSite.z + Math.sin(angle) * radius : (hash(i, 710) - 0.5) * 2800;
    if (onClearedGround(x, z, sites)) continue;
    const scale = 0.22 + Math.pow(hash(i, 142), 3) * (nearSite ? 0.65 : 1.5);
    dummy.position.set(x, terrainHeight(x, z) + scale * 0.1, z);
    dummy.rotation.set(hash(i, 59), hash(i, 46) * Math.PI * 2, hash(i, 81) * 0.4);
    dummy.scale.set(scale * 1.3, scale * 0.55, scale);
    dummy.updateMatrix();
    rocks.setMatrixAt(rockCount, dummy.matrix);
    color.setScalar(0.35 + hash(i, 91) * 0.25);
    rocks.setColorAt(rockCount++, color);
  }
  rocks.count = rockCount;
  rocks.receiveShadow = true;
  rocks.computeBoundingSphere();
  group.add(rocks);
}

/** Winter steppe, modelled in metres. All resources live on traversable meshes. */
export function createLandscape(sites: Site[]): THREE.Group {
  const group = new THREE.Group();
  group.name = "Winter steppe — procedural ground and service roads";
  const geometry = new THREE.PlaneGeometry(LAND_SIZE, LAND_SIZE, 240, 240);
  geometry.rotateX(-Math.PI / 2);
  const positions = geometry.getAttribute("position");
  for (let i = 0; i < positions.count; i++) {
    positions.setY(i, terrainHeight(positions.getX(i), positions.getZ(i)));
  }
  geometry.computeVertexNormals();
  const maps = groundMaps();
  const ground = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    ...maps,
    roughness: 1,
    normalScale: new THREE.Vector2(0.42, 0.42),
    metalness: 0,
  }));
  ground.name = "2048px unique snow / soil surface";
  ground.receiveShadow = true;
  group.add(ground);
  const details = new THREE.Group();
  details.name = "Ground detail — local surface, roads and vegetation";
  details.userData.terrainDetail = true;
  for (const site of sites) details.add(localGround(site, maps.normalMap, maps.roughnessMap));
  addInfrastructure(details, sites);
  addVegetation(details, sites);
  group.add(details);
  return group;
}
