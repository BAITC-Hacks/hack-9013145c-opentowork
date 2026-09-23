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
import { pickWindUnit, type WindPickRegion } from "./picking";

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
    renderer.toneMappingExposure = 0.96;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = "scene-canvas";
    renderer.domElement.setAttribute("aria-label", "Трёхмерная сцена станции. Перетащите для вращения, прокрутите для приближения.");
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#c5d8e1");
    scene.fog = new THREE.FogExp2("#c5d8e1", 0.00019);
    const camera = new THREE.PerspectiveCamera(43, 1, 1, 12000);
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
      current.current.kind === "wind" ? 65 : 38,
      sites.reduce((a, s) => a + s.z, 0) / Math.max(1, sites.length),
    );
    const wind = current.current.kind === "wind";
    const span = Math.max(wind ? 420 : 600, ...sites.map((s) => Math.hypot(s.x - center.x, s.z - center.z) * 2));
    const maxFitDistance = Math.max(2700, span * 10);
    camera.far = Math.max(12000, maxFitDistance * 2);
    const viewportAspect = Math.max(0.6, container.clientWidth / Math.max(1, container.clientHeight));
    const distance = Math.min(2300, span * (wind ? 1.06 : 1.12) * Math.max(1, 1.25 / viewportAspect));
    const home = center.clone().add(new THREE.Vector3(-distance * 0.46, distance * 0.17, distance * 0.7));
    let overview = true;
    let focusedId: string | null = null;
    const fitPoints = sites.flatMap((site) => {
      const ground = terrainHeight(site.x, site.z);
      const points = [new THREE.Vector3(site.x, ground, site.z)];
      for (const x of [-63, 63]) for (const y of [44, 156]) for (const z of [-63, 63]) {
        points.push(new THREE.Vector3(site.x + x, ground + y, site.z + z));
      }
      return points;
    });
    const fitView = (target: THREE.Vector3, points: THREE.Vector3[], w: number, h: number) => {
      const preview = camera.clone();
      const direction = new THREE.Vector3(-.46, .17, .7).normalize();
      const projected = new THREE.Vector3();
      const left = Math.min(32, w * .08), right = Math.min(58, w * .14);
      const top = Math.min(62, h * .14), bottom = Math.min(142, h * .28);
      const fits = (range: number) => {
        preview.position.copy(target).addScaledVector(direction, range);
        preview.lookAt(target); preview.updateMatrixWorld(true);
        return points.every((point) => {
          projected.copy(point).project(preview);
          const x = (projected.x * .5 + .5) * w, y = (-projected.y * .5 + .5) * h;
          return projected.z > -1 && projected.z < 1 && x > left && x < w - right && y > top && y < h - bottom;
        });
      };
      let low = 110, high = Math.max(500, span * 2);
      while (!fits(high) && high < maxFitDistance) high = Math.min(maxFitDistance, high * 1.4);
      for (let i = 0; i < 20; i++) {
        const middle = (low + high) / 2;
        if (fits(middle)) high = middle; else low = middle;
      }
      controls.maxDistance = Math.max(controls.maxDistance, high * 1.6);
      return target.clone().addScaledVector(direction, high);
    };
    camera.position.copy(current.current.tilt ? home : center.clone().add(new THREE.Vector3(0, distance * 1.05, 0.1)));
    controls.target.copy(center);
    controls.update();
    const goalPosition = home.clone();
    const goalTarget = center.clone();
    const facilityTarget = center.clone();
    let flying = false;
    let lastTilt = current.current.tilt;
    let lastSelected: Props["selected"] | undefined;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const fly = (position: THREE.Vector3, target: THREE.Vector3) => {
      goalPosition.copy(position); goalTarget.copy(target);
      flying = true;
      if (reduced.matches) { camera.position.copy(position); controls.target.copy(target); flying = false; }
    };
    const cancelFlight = () => { flying = false; overview = false; focusedId = null; };
    controls.addEventListener("start", cancelFlight);
    actions.current = (action) => {
      focusedId = null;
      if (action === "reset") {
        overview = true;
        fly(current.current.tilt ? home : center.clone().add(new THREE.Vector3(0, distance * 1.05, 0.1)), center);
      } else if (action === "facility") {
        overview = false;
        fly(facilityTarget.clone().add(new THREE.Vector3(-100, 65, 135)), facilityTarget);
      } else {
        overview = false;
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

    const hemisphere = new THREE.HemisphereLight("#c3dff4", "#7d8875", 0.9);
    scene.add(hemisphere);
    const sunlight = new THREE.DirectionalLight("#fff0d9", 2.65);
    sunlight.position.set(-700, 750, 500);
    sunlight.castShadow = true;
    sunlight.shadow.mapSize.set(2048, 2048);
    const shadowRadius = Math.max(950, span * 0.8);
    Object.assign(sunlight.shadow.camera, { left: -shadowRadius, right: shadowRadius, top: shadowRadius, bottom: -shadowRadius, near: 10, far: 5000 });
    sunlight.shadow.normalBias = 0.22;
    sunlight.shadow.bias = -0.00012;
    sunlight.shadow.radius = 3.5;
    scene.add(sunlight, sunlight.target);

    const landscape = createLandscape(sites);
    scene.add(landscape);
    const infrastructure = createStationInfrastructure(sites, current.current.kind);
    facilityTarget.copy(infrastructure.children[0].position).add(new THREE.Vector3(0, 8, 0));
    scene.add(infrastructure);
    // Clear winter air, a warm low sun and sparse cirrus; no downloaded sky textures.
    const skyMaterial = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: {
        zenith: { value: new THREE.Color("#659fce") },
        horizon: { value: new THREE.Color("#d5e2e7") },
        cloudColor: { value: new THREE.Color("#f3f0e6") },
        cloudAmount: { value: 1 },
        sunDirection: { value: new THREE.Vector3(0.8, 0.45, 0.4).normalize() },
        sunGlow: { value: 1 },
      },
      vertexShader: "varying vec3 vDirection; void main(){vDirection=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}",
      fragmentShader: `
        uniform vec3 zenith, horizon, cloudColor, sunDirection;
        uniform float cloudAmount, sunGlow;
        varying vec3 vDirection;
        float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
        float noise(vec2 p){
          vec2 i=floor(p), f=fract(p);f=f*f*(3.0-2.0*f);
          return mix(mix(hash(i),hash(i+vec2(1.0,0.0)),f.x),
            mix(hash(i+vec2(0.0,1.0)),hash(i+vec2(1.0,1.0)),f.x),f.y);
        }
        float fbm(vec2 p){
          float value=0.0, amplitude=0.55;
          for(int i=0;i<4;i++){value+=noise(p)*amplitude;p=p*2.03+vec2(13.1,7.7);amplitude*=0.48;}
          return value;
        }
        void main(){
          vec3 direction=normalize(vDirection);
          float h=max(direction.y,0.0);
          vec3 color=mix(horizon,zenith,pow(h,0.42));
          vec2 uv=direction.xz/max(direction.y+0.25,0.25);
          float drift=fbm(uv*0.72+vec2(12.0,4.0));
          float wisps=fbm(uv*vec2(1.65,7.5)+vec2(drift*1.2,8.0));
          float cloud=smoothstep(0.52,0.77,wisps)*smoothstep(0.27,0.6,drift);
          cloud*=smoothstep(0.035,0.18,h)*(1.0-smoothstep(0.78,1.0,h));
          color=mix(color,cloudColor,cloud*0.42*cloudAmount);
          float facing=max(dot(direction,sunDirection),0.0);
          color+=vec3(1.0,0.79,0.48)*(pow(facing,18.0)*0.045+pow(facing,220.0)*0.07)*sunGlow;
          gl_FragColor=vec4(color,1.0);
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
    const regionsById = new Map(objects.filter((object) => object.asset).map((object) => [object.id, {
      id: object.id, base: { x: 0, y: 0 }, hub: { x: 0, y: 0 }, depth: 0,
      rotor: Array.from({ length: 16 }, () => ({ x: 0, y: 0 })),
    }]));
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
    const field = new THREE.Mesh(fieldGeometry, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.4, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }));
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
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: "#4f7f93", transparent: true, opacity: 0.26, side: THREE.DoubleSide, depthWrite: false }));
      mesh.position.set(site.x, terrainHeight(site.x, site.z) + 1.8, site.z);
      scene.add(mesh);
      return { mesh, local: new Float32Array(a.array), site };
    });
    // Каждая частица потока — стрелка из трёх отрезков: древко и два пера.
    // Линии в WebGL толщиной 1 px, поэтому видимость дают длина, наконечник и контраст.
    const count = 260;
    const flowPositions = new Float32Array(count * 18);
    const flowSeeds = Array.from({ length: count }, (_, i) => ({
      x: Math.sin(i * 93.13) * 1500, z: Math.cos(i * 39.7) * 1500, y: 18 + (i % 8) * 7,
    }));
    const flowGeometry = new THREE.BufferGeometry();
    flowGeometry.setAttribute("position", new THREE.BufferAttribute(flowPositions, 3));
    const flow = new THREE.LineSegments(flowGeometry, new THREE.LineBasicMaterial({ color: "#0d5566", transparent: true, opacity: 0.85, depthWrite: false }));
    flow.frustumCulled = false;
    scene.add(flow);

    let width = 1, height = 1;
    const resize = () => {
      if (!container.clientWidth || !container.clientHeight) return;
      width = Math.max(1, container.clientWidth); height = Math.max(1, container.clientHeight);
      renderer.setSize(width, height);
      camera.aspect = width / height;
      // Raise the visual centre slightly so the forecast timeline does not cover the foreground.
      camera.setViewOffset(width, height, 0, height * 0.035, width, height);
      camera.updateProjectionMatrix();
      if (wind && fitPoints.length) {
        home.copy(fitView(center, fitPoints, width, height));
        if (overview && current.current.tilt) {
          camera.position.copy(home); controls.target.copy(center);
          goalPosition.copy(home); goalTarget.copy(center); controls.update();
        } else if (focusedId && current.current.tilt) {
          const index = objects.findIndex((object) => object.id === focusedId);
          if (index >= 0) {
            const target = objects[index].group.position.clone().add(new THREE.Vector3(0, 65, 0));
            const position = fitView(target, fitPoints.slice(index * 9, index * 9 + 9), width, height);
            camera.position.copy(position); controls.target.copy(target);
            goalPosition.copy(position); goalTarget.copy(target); controls.update();
          }
        }
      }
      invalidate.current();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const down = new THREE.Vector2();
    let press: { id: number; moved: boolean } | null = null;
    let hovered: string | null = null;
    const pickRegions: WindPickRegion[] = [];
    const pick = (event: PointerEvent, exact = false) => {
      const rect = renderer.domElement.getBoundingClientRect();
      const x = event.clientX - rect.left, y = event.clientY - rect.top;
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
      const padding = event.pointerType === "touch" ? 26 : 18;
      const nearby = wind ? pickWindUnit({ x, y }, pickRegions, padding) : null;
      if (wind && (!exact || !nearby)) return nearby;
      pointer.set(x / rect.width * 2 - 1, -(y / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      // Real geometry wins when the generous rotor regions overlap.
      const candidates = wind
        ? objects.filter((object) => pickRegions.some((region) => region.id === object.id && pickWindUnit({ x, y }, [region], padding)))
        : objects;
      const hit = raycaster.intersectObjects(candidates.map((o) => o.group), true)[0];
      return (hit?.object.userData.unitId as string | undefined) ?? nearby;
    };
    const setHovered = (id: string | null) => {
      renderer.domElement.style.cursor = id ? "pointer" : "grab";
      if (id === hovered) return;
      if (hovered) labels.current[hovered]?.classList.remove("is-hovered");
      hovered = id;
      if (id) labels.current[id]?.classList.add("is-hovered");
    };
    renderer.domElement.style.cursor = "grab";
    const pointerDown = (event: PointerEvent) => {
      if (!event.isPrimary || event.button !== 0) { if (press) press.moved = true; return; }
      down.set(event.clientX, event.clientY); press = { id: event.pointerId, moved: false };
    };
    const pointerMove = (event: PointerEvent) => {
      if (press) {
        if (down.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) > 6) press.moved = true;
        if (press.moved) { setHovered(null); renderer.domElement.style.cursor = "grabbing"; }
        return;
      }
      if (event.pointerType !== "touch") setHovered(pick(event));
    };
    const pointerUp = (event: PointerEvent) => {
      if (!press || press.id !== event.pointerId) return;
      const moved = press.moved || down.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) > 6;
      press = null;
      renderer.domElement.style.cursor = "grab";
      if (moved) return;
      const id = pick(event, true);
      if (event.pointerType !== "touch") setHovered(id);
      if (id) current.current.onSelect(id);
    };
    const pointerCancel = () => { press = null; setHovered(null); renderer.domElement.style.cursor = "grab"; };
    const pointerLeave = () => { setHovered(null); };
    renderer.domElement.addEventListener("pointerdown", pointerDown);
    renderer.domElement.addEventListener("pointermove", pointerMove);
    renderer.domElement.addEventListener("pointerup", pointerUp);
    renderer.domElement.addEventListener("pointercancel", pointerCancel);
    renderer.domElement.addEventListener("pointerleave", pointerLeave);
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
        overview = true; focusedId = null;
        fly(p.tilt ? home : center.clone().add(new THREE.Vector3(0, distance * 1.05, 0.1)), center);
      }
      if (p.selected !== lastSelected) {
        lastSelected = p.selected;
        const object = objects.find((o) => o.id === p.selected);
        if (object && p.tilt) {
          overview = false;
          focusedId = object.id;
          const target = object.group.position.clone().add(new THREE.Vector3(0, p.kind === "wind" ? 65 : 8, 0));
          const close = p.kind === "wind" ? new THREE.Vector3(-165, 55, 240) : new THREE.Vector3(-220, 85, 320);
          const position = p.kind === "wind"
            ? fitView(target, fitPoints.slice(objects.indexOf(object) * 9, objects.indexOf(object) * 9 + 9), width, height)
            : target.clone().add(close);
          fly(position, target);
        } else if (!p.selected && focusedId && p.tilt) {
          focusedId = null; overview = true;
          fly(home, center);
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
      camera.updateMatrixWorld(true);
      const azimuth = (daylightRef.current ? 120 : p.sun.azimuth) * DEG;
      const elevation = daylightRef.current ? 28 : Math.max(6, p.sun.elevation);
      const lightKey = `${daylightRef.current}:${Math.round(p.sun.elevation)}:${Math.round(p.sun.azimuth)}`;
      if (lightKey !== lastLight) {
        lastLight = lightKey;
        const night = !daylightRef.current && p.sun.elevation < 0;
        const lowSun = daylightRef.current ? 0 : THREE.MathUtils.clamp((14 - p.sun.elevation) / 14, 0, 1);
        const direction = skyMaterial.uniforms.sunDirection.value as THREE.Vector3;
        direction.set(Math.sin(azimuth) * Math.cos(elevation * DEG), Math.sin(elevation * DEG), -Math.cos(azimuth) * Math.cos(elevation * DEG));
        sunlight.position.copy(center).addScaledVector(direction, 1800);
        sunlight.target.position.copy(center);
        sunlight.intensity = night ? 0.48 : THREE.MathUtils.lerp(2.65, 1.6, lowSun);
        sunlight.color.set(night ? "#a6c4ea" : "#fff0d9");
        if (!night) sunlight.color.lerp(new THREE.Color("#f4bd91"), lowSun);
        hemisphere.intensity = night ? 0.48 : 0.9;
        scene.environmentIntensity = night ? 0.14 : 0.22;
        renderer.toneMappingExposure = night ? 0.82 : 0.96;
        const fog = scene.fog as THREE.FogExp2;
        fog.color.set(night ? "#24374f" : "#c5d8e1");
        if (!night) fog.color.lerp(new THREE.Color("#d7c8b6"), lowSun * 0.65);
        fog.density = night ? 0.00025 : 0.00019;
        skyMaterial.uniforms.zenith.value.set(night ? "#11233c" : "#659fce");
        skyMaterial.uniforms.horizon.value.set(night ? "#3c526c" : "#d5e2e7");
        if (!night) skyMaterial.uniforms.horizon.value.lerp(new THREE.Color("#ebceb0"), lowSun * 0.7);
        skyMaterial.uniforms.cloudColor.value.set(night ? "#5c7189" : "#f3f0e6");
        skyMaterial.uniforms.cloudAmount.value = night ? 0.3 : 1;
        skyMaterial.uniforms.sunGlow.value = night ? 0 : 1;
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
      const cosBarb = Math.cos(0.45), sinBarb = Math.sin(0.45);
      if (flow.visible) {
        for (let i = 0; i < count; i++) {
          const seed = flowSeeds[i];
          const shift = elapsed * (p.point?.wind_speed ?? 8) * 3;
          const x = ((seed.x + dx * shift + 30000) % 3000) - 1500;
          const z = ((seed.z + dz * shift + 30000) % 3000) - 1500;
          const y = terrainHeight(x, z) + seed.y;
          const len = 28 + Math.min(25, p.point?.wind_speed ?? 8) * 5;
          const hx = x + dx * len, hz = z + dz * len, barb = len * 0.32;
          const bx1 = -dx * cosBarb + dz * sinBarb, bz1 = -dz * cosBarb - dx * sinBarb;
          const bx2 = -dx * cosBarb - dz * sinBarb, bz2 = -dz * cosBarb + dx * sinBarb;
          flowPositions.set([
            x, y, z, hx, y, hz,
            hx, y, hz, hx + bx1 * barb, y, hz + bz1 * barb,
            hx, y, hz, hx + bx2 * barb, y, hz + bz2 * barb,
          ], i * 18);
        }
        flowGeometry.attributes.position.needsUpdate = true;
      }
      ring.visible = !!p.selected || !!hovered;
      (ring.material as THREE.MeshBasicMaterial).color.set(p.selected ? "#dca459" : "#087f72");
      pickRegions.length = 0;
      for (const object of objects) {
        if (object.asset) {
          const yaw = Math.atan2(Math.sin(windDirection), -Math.cos(windDirection));
          const delta = Math.atan2(Math.sin(yaw - object.asset.yaw.rotation.y), Math.cos(yaw - object.asset.yaw.rotation.y));
          object.asset.yaw.rotation.y += delta * Math.min(1, dt * 2);
          const power = p.point?.per_turbine?.[object.id] ?? p.point?.p50 ?? 0;
          const speed = p.point?.wind_speed ?? 0;
          if (!reduced.matches && power > 0.01 && speed < 25 && speed >= 3) object.asset.rotor.rotation.z -= dt * (5 + power * 11) / 60 * Math.PI * 2;
        }
        if (object.id === (p.selected ?? hovered)) ring.position.copy(object.group.position).add(new THREE.Vector3(0, 0.5, 0));
        if (object.asset) {
          object.group.updateMatrixWorld(true);
          const region = regionsById.get(object.id)!;
          vector.copy(object.group.position).project(camera);
          const baseVisible = vector.z > -1 && vector.z < 1;
          region.base.x = (vector.x * .5 + .5) * width; region.base.y = (-vector.y * .5 + .5) * height;
          vector.setFromMatrixPosition(object.asset.rotor.matrixWorld).project(camera);
          if (baseVisible && vector.z > -1 && vector.z < 1) {
            region.hub.x = (vector.x * .5 + .5) * width; region.hub.y = (-vector.y * .5 + .5) * height;
            region.depth = vector.z;
            for (let index = 0; index < 16; index++) {
              const angle = index / 16 * Math.PI * 2;
              vector.set(Math.cos(angle) * 55, Math.sin(angle) * 55, 0).applyMatrix4(object.asset.rotor.matrixWorld).project(camera);
              region.rotor[index].x = (vector.x * .5 + .5) * width; region.rotor[index].y = (-vector.y * .5 + .5) * height;
            }
            pickRegions.push(region);
          }
        }
        const label = labels.current[object.id];
        if (label) {
          vector.copy(object.group.position).add(new THREE.Vector3(0, p.kind === "wind" ? 2 : 14, 0)).project(camera);
          const x = (vector.x * 0.5 + 0.5) * width, y = (-vector.y * 0.5 + 0.5) * height;
          const visible = vector.z > -1 && vector.z < 1 && x > 5 && x < width - 5 && y > 10 && y < height - (wind ? 120 : 60);
          label.style.visibility = visible ? "visible" : "hidden";
          label.style.transform = wind
            ? `translate(${Math.min(width - 62, Math.max(62, x))}px, ${Math.max(8, y + 9)}px) translateX(-50%)`
            : `translate(${Math.min(width - 125, Math.max(8, x + 18))}px, ${Math.max(8, y - 24)}px)`;
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
      renderer.domElement.removeEventListener("pointermove", pointerMove);
      renderer.domElement.removeEventListener("pointerup", pointerUp);
      renderer.domElement.removeEventListener("pointercancel", pointerCancel);
      renderer.domElement.removeEventListener("pointerleave", pointerLeave);
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
        className={`turbine-label scene-unit-label ${props.kind === "wind" ? "wind-unit-label" : "solar-unit-label"} ${props.selected === unit.id ? "active" : ""}`}
        onClick={() => props.onSelect(unit.id)} aria-pressed={props.selected === unit.id}
        aria-label={`${unit.name}: ${props.labels[unit.id]?.main ?? ""}. Открыть показатели`}
      >
        {props.kind === "wind" ? <>
          <span className="unit-label-id">{unit.id}</span>
          <span className="unit-label-power">{props.labels[unit.id]?.main ?? "—"}</span>
          <span className="unit-label-arrow" aria-hidden="true">↗</span>
        </> : <>
          <div className="tl-head"><b>{unit.id}</b><span>{props.labels[unit.id]?.sub}</span></div>
          <div className="tl-wind">{props.labels[unit.id]?.main ?? "—"}</div>
        </>}
      </button>)}
    </div>
  );
}
