import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { WindMapProps } from "../WindMap";
import { speedColor } from "../LegacyWindMap";
import { SITE } from "../demo";
import { createLandscape, terrainHeight } from "./terrain";
import { createSolarArray, createTurbine } from "./turbines";
import { createStationInfrastructure } from "./infrastructure";

type Props = WindMapProps & { onUnavailable: () => void };
type CameraAction = "in" | "out" | "reset" | "facility";
const DEG = Math.PI / 180;

function disposeScene(scene: THREE.Scene) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  scene.traverse((node) => {
    if (node instanceof THREE.InstancedMesh) node.dispose();
    if (node instanceof THREE.Mesh || node instanceof THREE.Line || node instanceof THREE.Points) {
      geometries.add(node.geometry);
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        materials.add(material);
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      }
    }
  });
  textures.forEach((t) => t.dispose());
  materials.forEach((m) => m.dispose());
  geometries.forEach((g) => g.dispose());
}

export default function Scene(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const labels = useRef<Record<string, HTMLButtonElement | null>>({});
  const current = useRef(props);
  current.current = props;
  const actions = useRef<(action: CameraAction) => void>(() => undefined);
  const invalidate = useRef<() => void>(() => undefined);
  const [ready, setReady] = useState(false);
  const [daylight, setDaylight] = useState(true);
  const daylightRef = useRef(daylight);
  daylightRef.current = daylight;
  // Rebuild assets only when site geometry changes, not on hourly forecast updates.
  const siteKey = props.units.map((u) => `${u.id}:${u.lat}:${u.lon}`).join("|");

  useEffect(() => {
    const container = host.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    } catch {
      current.current.onUnavailable();
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = "scene-canvas";
    renderer.domElement.setAttribute("aria-label", "Трёхмерная сцена станции. Перетащите для вращения, прокрутите для приближения.");
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#bdcbd2");
    scene.fog = new THREE.FogExp2("#c5d0d5", 0.00031);
    const camera = new THREE.PerspectiveCamera(40, 1, 1, 12000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.minDistance = 110;
    controls.maxDistance = 2700;
    controls.maxPolarAngle = Math.PI / 2 - 0.07;
    controls.minPolarAngle = 0.02;
    controls.enablePan = true;
    controls.screenSpacePanning = false;
    controls.panSpeed = 0.65;
    controls.zoomSpeed = 0.7;
    controls.rotateSpeed = 0.65;

    // Начало координат — центр своей станции: станции разнесены на тысячи км.
    const units = current.current.units;
    const ref = units.length
      ? { lat: units.reduce((a, u) => a + u.lat, 0) / units.length, lon: units.reduce((a, u) => a + u.lon, 0) / units.length }
      : SITE;
    const sites = units.map((u) => ({
      id: u.id,
      x: (u.lon - ref.lon) * Math.cos(ref.lat * DEG) * 111320,
      z: -(u.lat - ref.lat) * 110540,
    }));
    const center = new THREE.Vector3(
      sites.reduce((a, s) => a + s.x, 0) / Math.max(1, sites.length),
      38,
      sites.reduce((a, s) => a + s.z, 0) / Math.max(1, sites.length),
    );
    const span = Math.max(600, ...sites.map((s) => Math.hypot(s.x - center.x, s.z - center.z) * 2));
    const distance = Math.min(1900, span * 1.25);
    const home = center.clone().add(new THREE.Vector3(-distance * 0.5, distance * 0.32, distance * 0.78));
    camera.position.copy(current.current.tilt ? home : center.clone().add(new THREE.Vector3(0, distance * 1.05, 0.1)));
    controls.target.copy(center);
    controls.update();
    const goalPosition = home.clone();
    const goalTarget = center.clone();
    const facilityTarget = center.clone();
    let flying = false;
    let lastTilt = current.current.tilt;
    let lastSelected = current.current.selected;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const fly = (position: THREE.Vector3, target: THREE.Vector3) => {
      goalPosition.copy(position); goalTarget.copy(target);
      flying = true;
      if (reduced.matches) { camera.position.copy(position); controls.target.copy(target); flying = false; }
    };
    const cancelFlight = () => { flying = false; };
    controls.addEventListener("start", cancelFlight);
    actions.current = (action) => {
      if (action === "reset") {
        fly(current.current.tilt ? home : center.clone().add(new THREE.Vector3(0, distance * 1.05, 0.1)), center);
      } else if (action === "facility") {
        fly(facilityTarget.clone().add(new THREE.Vector3(-100, 65, 135)), facilityTarget);
      } else {
        const offset = camera.position.clone().sub(controls.target).multiplyScalar(action === "in" ? 0.75 : 1.33);
        offset.clampLength(controls.minDistance, controls.maxDistance);
        fly(controls.target.clone().add(offset), controls.target.clone());
      }
      invalidate.current();
    };

    const environment = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTarget = pmrem.fromScene(environment, 0.04);
    scene.environment = envTarget.texture;
    scene.environmentIntensity = 0.22;
    environment.dispose();
    pmrem.dispose();

    const hemisphere = new THREE.HemisphereLight("#dcebf4", "#747164", 1.35);
    scene.add(hemisphere);
    const sunlight = new THREE.DirectionalLight("#fff2db", 3.1);
    sunlight.position.set(-700, 750, 500);
    sunlight.castShadow = true;
    sunlight.shadow.mapSize.set(2048, 2048);
    const shadowRadius = Math.max(950, span * 0.8);
    Object.assign(sunlight.shadow.camera, { left: -shadowRadius, right: shadowRadius, top: shadowRadius, bottom: -shadowRadius, near: 10, far: 5000 });
    sunlight.shadow.normalBias = 0.35;
    sunlight.shadow.bias = -0.00012;
    sunlight.shadow.radius = 3;
    scene.add(sunlight, sunlight.target);

    const landscape = createLandscape(sites);
    scene.add(landscape);
    const infrastructure = createStationInfrastructure(sites, current.current.kind);
    facilityTarget.copy(infrastructure.children[0].position).add(new THREE.Vector3(0, 8, 0));
    scene.add(infrastructure);
    // Colour gradient sky, with atmospheric haze rather than a flat background.
    const skyMaterial = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: { zenith: { value: new THREE.Color("#7eabc8") }, horizon: { value: new THREE.Color("#dce1df") } },
      vertexShader: "varying vec3 vDirection; void main(){vDirection=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}",
      fragmentShader: `uniform vec3 zenith;uniform vec3 horizon;varying vec3 vDirection;
        void main(){float h=max(normalize(vDirection).y,0.0);
          gl_FragColor=vec4(mix(horizon,zenith,pow(h,0.55)),1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(5500, 32, 16), skyMaterial);
    scene.add(sky);

    const objects = sites.map((site, i) => {
      const asset = current.current.kind === "wind" ? createTurbine() : null;
      const group = asset?.group ?? createSolarArray(180, 110);
      group.position.set(site.x, terrainHeight(site.x, site.z), site.z);
      group.traverse((node) => { node.userData.unitId = site.id; });
      if (asset) {
        asset.rotor.rotation.z = i * 1.7 + 0.5;
        const direction = (current.current.point?.wind_dir ?? 290) * DEG;
        asset.yaw.rotation.y = Math.atan2(Math.sin(direction), -Math.cos(direction));
      }
      scene.add(group);
      return { ...site, group, asset };
    });
    const extraSolar = createSolarArray(150, 95);
    extraSolar.position.set(640, terrainHeight(640, -160), -160);
    scene.add(extraSolar);

    const ring = new THREE.Mesh(new THREE.RingGeometry(20, 21.2, 64), new THREE.MeshBasicMaterial({ color: "#dca459", transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    scene.add(ring);

    // Optional data overlays sit above the landscape and never replace its material.
    const fieldGeometry = new THREE.PlaneGeometry(3400, 3400, 55, 55);
    fieldGeometry.rotateX(-Math.PI / 2);
    const vertices = fieldGeometry.attributes.position;
    for (let i = 0; i < vertices.count; i++) vertices.setY(i, terrainHeight(vertices.getX(i), vertices.getZ(i)) + 0.7);
    fieldGeometry.computeVertexNormals();
    const colors = new Float32Array(vertices.count * 3);
    fieldGeometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const field = new THREE.Mesh(fieldGeometry, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.22, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }));
    field.renderOrder = 1;
    scene.add(field);

    const wakes = sites.map((site) => {
      const geometry = new THREE.PlaneGeometry(160, 700, 6, 40);
      // Tapered ribbon broadens downwind; rests on ground.
      const a = geometry.attributes.position;
      for (let i = 0; i < a.count; i++) {
        const along = a.getY(i) + 350;
        a.setXYZ(i, a.getX(i) * (0.7 + along / 360), 0, along);
      }
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: "#729dae", transparent: true, opacity: 0.13, side: THREE.DoubleSide, depthWrite: false }));
      mesh.position.set(site.x, terrainHeight(site.x, site.z) + 1.8, site.z);
      scene.add(mesh);
      return { mesh, local: new Float32Array(a.array), site };
    });
    const count = 160;
    const flowPositions = new Float32Array(count * 6);
    const flowSeeds = Array.from({ length: count }, (_, i) => ({
      x: Math.sin(i * 93.13) * 1500, z: Math.cos(i * 39.7) * 1500, y: 18 + (i % 8) * 7,
    }));
    const flowGeometry = new THREE.BufferGeometry();
    flowGeometry.setAttribute("position", new THREE.BufferAttribute(flowPositions, 3));
    const flow = new THREE.LineSegments(flowGeometry, new THREE.LineBasicMaterial({ color: "#e7f8ff", transparent: true, opacity: 0.4, depthWrite: false }));
    flow.frustumCulled = false;
    scene.add(flow);

    let width = 1, height = 1;
    const resize = () => {
      width = Math.max(1, container.clientWidth); height = Math.max(1, container.clientHeight);
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const down = new THREE.Vector2();
    const pointerDown = (event: PointerEvent) => { down.set(event.clientX, event.clientY); };
    const pointerUp = (event: PointerEvent) => {
      if (down.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) > 6) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(objects.map((o) => o.group), true)[0];
      if (hit?.object.userData.unitId) current.current.onSelect(hit.object.userData.unitId);
    };
    renderer.domElement.addEventListener("pointerdown", pointerDown);
    renderer.domElement.addEventListener("pointerup", pointerUp);
    const contextLost = (event: Event) => { event.preventDefault(); current.current.onUnavailable(); };
    renderer.domElement.addEventListener("webglcontextlost", contextLost);
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "+" || event.key === "=") { event.preventDefault(); actions.current("in"); }
      if (event.key === "-") { event.preventDefault(); actions.current("out"); }
      if (event.key === "Home") { event.preventDefault(); actions.current("reset"); }
    };
    renderer.domElement.tabIndex = 0;
    renderer.domElement.addEventListener("keydown", keyboard);

    let frame = 0, previous = 0, elapsed = 0;
    let lastPoint: Props["point"] = null;
    let lastLight = "";
    let inView = true, rendered = false;
    const visibility = new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; });
    visibility.observe(container);
    const vector = new THREE.Vector3();
    const render = (now: number, scheduled = true) => {
      if (scheduled) frame = requestAnimationFrame(render);
      const dt = Math.min(0.05, (now - (previous || now)) / 1000);
      previous = now;
      if (scheduled && rendered && (document.hidden || !inView)) return;
      const p = current.current;
      if (!reduced.matches) elapsed += dt;
      if (p.tilt !== lastTilt) {
        lastTilt = p.tilt;
        fly(p.tilt ? home : center.clone().add(new THREE.Vector3(0, distance * 1.05, 0.1)), center);
      }
      if (p.selected !== lastSelected) {
        lastSelected = p.selected;
        const object = objects.find((o) => o.id === p.selected);
        if (object && p.tilt) {
          const target = object.group.position.clone().add(new THREE.Vector3(0, p.kind === "wind" ? 65 : 8, 0));
          fly(target.clone().add(new THREE.Vector3(-220, 85, 320)), target);
        }
      }
      if (flying) {
        const k = !scheduled && document.hidden ? 1 : 1 - Math.exp(-dt * 4);
        camera.position.lerp(goalPosition, k);
        controls.target.lerp(goalTarget, k);
        if (camera.position.distanceTo(goalPosition) < 0.3) flying = false;
      }
      controls.update();
      // Keep camera above terrain when panning on low elevation views.
      camera.position.y = Math.max(camera.position.y, terrainHeight(camera.position.x, camera.position.z) + 8);
      const azimuth = (daylightRef.current ? 235 : p.sun.azimuth) * DEG;
      const elevation = daylightRef.current ? 32 : Math.max(6, p.sun.elevation);
      const lightKey = `${daylightRef.current}:${Math.round(p.sun.elevation)}:${Math.round(p.sun.azimuth)}`;
      if (lightKey !== lastLight) {
        lastLight = lightKey;
        const night = !daylightRef.current && p.sun.elevation < 0;
        sunlight.position.set(center.x + Math.sin(azimuth) * 1600, Math.sin(elevation * DEG) * 1600, center.z - Math.cos(azimuth) * 1600);
        sunlight.target.position.copy(center);
        sunlight.intensity = night ? 0.65 : 3.1;
        sunlight.color.set(night ? "#bdcfe9" : "#fff2db");
        hemisphere.intensity = night ? 0.7 : 1.35;
        renderer.toneMappingExposure = night ? 0.85 : 1.05;
        (scene.fog as THREE.FogExp2).color.set(night ? "#263a50" : "#c5d0d5");
        skyMaterial.uniforms.zenith.value.set(night ? "#101d34" : "#7eabc8");
        skyMaterial.uniforms.horizon.value.set(night ? "#405367" : "#dce1df");
      }
      field.visible = p.layers.speed && p.kind === "wind";
      flow.visible = p.layers.direction && p.kind === "wind";
      landscape.children.forEach((child) => { if (child.userData.terrainDetail) child.visible = p.layers.terrain; });
      extraSolar.visible = p.layers.solar && p.kind === "wind";
      const windDirection = (p.point?.wind_dir ?? 290) * DEG;
      wakes.forEach(({ mesh }) => { mesh.visible = p.layers.wake && p.kind === "wind"; });
      if (lastPoint !== p.point) {
        lastPoint = p.point;
        wakes.forEach(({ mesh, local, site }) => {
          const positions = mesh.geometry.attributes.position;
          for (let i = 0; i < positions.count; i++) {
            const x = local[i * 3], z = local[i * 3 + 2];
            const wx = x * Math.cos(windDirection) - z * Math.sin(windDirection);
            const wz = x * Math.sin(windDirection) + z * Math.cos(windDirection);
            positions.setXYZ(i, wx, terrainHeight(site.x + wx, site.z + wz) - mesh.position.y + 1.1, wz);
          }
          positions.needsUpdate = true;
          mesh.geometry.computeBoundingSphere();
        });
        for (let i = 0; i < vertices.count; i++) {
          const variation = 1 + 0.07 * Math.sin(vertices.getX(i) / 240) * Math.cos(vertices.getZ(i) / 310);
          const [r, g, b] = speedColor((p.point?.wind_speed ?? 0) * variation);
          const color = new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
          colors[i * 3] = color.r; colors[i * 3 + 1] = color.g; colors[i * 3 + 2] = color.b;
        }
        fieldGeometry.attributes.color.needsUpdate = true;
      }
      const dx = -Math.sin(windDirection), dz = Math.cos(windDirection);
      if (flow.visible) {
        for (let i = 0; i < count; i++) {
          const seed = flowSeeds[i];
          const shift = elapsed * (p.point?.wind_speed ?? 8) * 3;
          const x = ((seed.x + dx * shift + 30000) % 3000) - 1500;
          const z = ((seed.z + dz * shift + 30000) % 3000) - 1500;
          const y = terrainHeight(x, z) + seed.y;
          flowPositions.set([x, y, z, x + dx * 20, y, z + dz * 20], i * 6);
        }
        flowGeometry.attributes.position.needsUpdate = true;
      }
      ring.visible = !!p.selected;
      for (const object of objects) {
        if (object.asset) {
          const yaw = Math.atan2(Math.sin(windDirection), -Math.cos(windDirection));
          const delta = Math.atan2(Math.sin(yaw - object.asset.yaw.rotation.y), Math.cos(yaw - object.asset.yaw.rotation.y));
          object.asset.yaw.rotation.y += delta * Math.min(1, dt * 2);
          const power = p.point?.per_turbine?.[object.id] ?? p.point?.p50 ?? 0;
          const speed = p.point?.wind_speed ?? 0;
          if (!reduced.matches && power > 0.01 && speed < 25 && speed >= 3) object.asset.rotor.rotation.z -= dt * (5 + power * 11) / 60 * Math.PI * 2;
        }
        if (object.id === p.selected) ring.position.copy(object.group.position).add(new THREE.Vector3(0, 0.5, 0));
        const label = labels.current[object.id];
        if (label) {
          vector.copy(object.group.position).add(new THREE.Vector3(0, p.kind === "wind" ? 111 : 14, 0)).project(camera);
          const x = (vector.x * 0.5 + 0.5) * width, y = (-vector.y * 0.5 + 0.5) * height;
          const visible = vector.z > -1 && vector.z < 1 && x > 5 && x < width - 5 && y > 10 && y < height - 60;
          label.style.visibility = visible ? "visible" : "hidden";
          label.style.transform = `translate(${Math.min(width - 125, Math.max(8, x + 18))}px, ${Math.max(8, y - 24)}px)`;
        }
      }
      renderer.render(scene, camera);
      rendered = true;
    };
    invalidate.current = () => render(performance.now(), false);
    render(performance.now());
    setReady(true);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect(); visibility.disconnect();
      controls.removeEventListener("start", cancelFlight); controls.dispose();
      renderer.domElement.removeEventListener("pointerdown", pointerDown);
      renderer.domElement.removeEventListener("pointerup", pointerUp);
      renderer.domElement.removeEventListener("webglcontextlost", contextLost);
      renderer.domElement.removeEventListener("keydown", keyboard);
      disposeScene(scene); envTarget.dispose(); sunlight.shadow.dispose();
      renderer.dispose(); renderer.domElement.remove();
      actions.current = () => undefined;
      invalidate.current = () => undefined;
    };
  }, [siteKey, props.kind]);

  // Browsers can suspend animation in background tabs; discrete data/UI changes
  // still render one complete frame and respect reduced-motion preferences.
  useEffect(() => { invalidate.current(); }, [props.point, props.selected, props.tilt, props.layers, daylight]);

  return (
    <div className="map map-realistic">
      <div className="scene-host" ref={host} />
      {!ready && <div className="scene-loading"><span className="spin" /> Подготавливаем ландшафт…</div>}
      <div className="scene-toolbar" aria-label="Управление камерой">
        <button type="button" onClick={() => actions.current("in")} aria-label="Приблизить" title="Приблизить">＋</button>
        <button type="button" onClick={() => actions.current("out")} aria-label="Отдалить" title="Отдалить">−</button>
        <button type="button" onClick={() => actions.current("reset")} aria-label="Показать всю станцию" title="Вся станция">⌖</button>
        <button type="button" onClick={() => actions.current("facility")} aria-label="Осмотреть сервисный корпус" title="Осмотреть сервисный корпус">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="M3 21V7l10-4v18M13 10h8v11M1 21h22M6 9h4M6 13h4M6 17h4M16 13h2M16 17h2" />
          </svg>
        </button>
      </div>
      <button type="button" className="scene-light" onClick={() => setDaylight((d) => !d)} aria-pressed={daylight} title="Дневное освещение для осмотра или освещение по часу прогноза">
        <span aria-hidden="true">{daylight ? "☀" : "◐"}</span> {daylight ? "Дневной свет" : "По времени суток"}
      </button>
      <div className="scene-caption">Зимняя степь <span>·</span> 3D-реконструкция</div>
      {props.units.map((unit) => <button
        type="button" key={unit.id}
        ref={(element) => { labels.current[unit.id] = element; }}
        className={`turbine-label ${props.selected === unit.id ? "active" : ""}`}
        onClick={() => props.onSelect(unit.id)} aria-pressed={props.selected === unit.id}
        aria-label={`${unit.name}: ${props.labels[unit.id]?.main ?? ""}. Открыть показатели`}
      >
        <div className="tl-head"><b>{unit.id}</b><span>{props.labels[unit.id]?.sub}</span></div>
        <div className="tl-wind">{props.labels[unit.id]?.main ?? "—"}</div>
      </button>)}
    </div>
  );
}
