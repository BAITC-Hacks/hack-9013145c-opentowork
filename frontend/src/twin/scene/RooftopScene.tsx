import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Rooftop, RooftopsResponse } from "../../api";
import { createCity } from "./buildings";

export type RoofSceneMetric = "materials" | "energy" | "quality";
type Props = { data: RooftopsResponse; selected: Rooftop | null; metric: RoofSceneMetric; onSelect: (b: Rooftop) => void; onUnavailable: () => void };
type Action = "in" | "out" | "home" | "top";

export default function RooftopScene(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const north = useRef<HTMLDivElement>(null);
  const current = useRef(props); current.current = props;
  const action = useRef<(value: Action) => void>(() => undefined);
  const sync = useRef<() => void>(() => undefined);
  const [topView, setTopView] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const container = host.current!;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" }); }
    catch { current.current.onUnavailable(); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute("aria-label", "Трёхмерный район. Перетаскивание вращает камеру, колесо меняет масштаб. Выбрать здание можно также в списке справа.");
    container.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#dce7ec");
    scene.fog = new THREE.Fog("#dce7ec", 1800, 6600);
    const city = createCity(current.current.data);
    scene.add(city.group);
    scene.add(new THREE.HemisphereLight("#dbeaf5", "#aba38f", 2.1));
    const sun = new THREE.DirectionalLight("#fff0d7", 3.1);
    sun.position.set(-550, 1000, 550);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const reach = Math.max(city.width, city.depth) * .65;
    sun.shadow.camera.left = sun.shadow.camera.bottom = -reach;
    sun.shadow.camera.right = sun.shadow.camera.top = reach;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 4200;
    sun.shadow.normalBias = .65;
    scene.add(sun, sun.target);
    const camera = new THREE.PerspectiveCamera(43, 1, 1, 10000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = .09;
    controls.minDistance = 35; controls.maxDistance = Math.max(city.width, city.depth) * 2;
    controls.maxPolarAngle = Math.PI / 2 - .08;
    controls.screenSpacePanning = false;
    controls.panSpeed = .7; controls.zoomSpeed = .8;
    const central = [...city.buildings].filter((b) => b.data.height_m > 35 && b.data.height_m < 120).sort((a, b) => Math.hypot(a.center.x, a.center.z) - Math.hypot(b.center.x, b.center.z))[0];
    const center = central ? new THREE.Vector3(central.center.x, 20, central.center.z) : new THREE.Vector3();
    camera.position.copy(center).add(new THREE.Vector3(-610, 410, 710));
    controls.target.copy(center); controls.update();
    const target = controls.target.clone(), position = camera.position.clone();
    let flying = false, isTop = false, lastSelected = "", lastMetric = "";
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const fly = (nextPosition: THREE.Vector3, nextTarget: THREE.Vector3) => {
      position.copy(nextPosition); target.copy(nextTarget); flying = true;
      if (reduced.matches || document.hidden) { camera.position.copy(position); controls.target.copy(target); flying = false; }
    };
    const outline = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: "#eb9b18", depthTest: false, transparent: true, opacity: .95 }));
    outline.renderOrder = 5; outline.visible = false; scene.add(outline);
    let frame = 0, last = performance.now(), rendering = false, disposed = false;
    const render = (now: number, schedule = true) => {
      if (disposed) return;
      if (schedule) frame = requestAnimationFrame(render);
      if (schedule && document.hidden) return;
      const dt = Math.min(.05, (now - last) / 1000); last = now;
      if (flying) {
        const k = 1 - Math.exp(-Math.max(.016, dt) * 5);
        camera.position.lerp(position, k); controls.target.lerp(target, k);
        if (camera.position.distanceTo(position) < .5) flying = false;
      }
      rendering = true;
      const changed = controls.update();
      if (north.current) north.current.style.transform = `rotate(${controls.getAzimuthalAngle()}rad)`;
      if (!schedule || changed || flying) renderer.render(scene, camera);
      rendering = false;
    };
    const invalidate = () => { if (!rendering) render(performance.now(), false); };
    const apply = () => {
      if (lastMetric !== current.current.metric) { city.setMetric(current.current.metric); lastMetric = current.current.metric; }
      const selectedId = current.current.selected?.id ?? "";
      if (lastSelected !== selectedId) {
        lastSelected = selectedId;
        const b = city.buildings.find((item) => item.data.id === selectedId);
        outline.visible = Boolean(b);
        if (b) {
          outline.geometry.dispose();
          outline.geometry = new THREE.BufferGeometry().setFromPoints(b.polygon.map(([x, z]) => new THREE.Vector3(x, b.data.height_m + 1.1, z)));
          const distance = Math.max(90, b.radius * 3.3, b.data.height_m * 1.8);
          const nextTarget = new THREE.Vector3(b.center.x, b.data.height_m * .55, b.center.z);
          fly(nextTarget.clone().add(isTop ? new THREE.Vector3(0, distance * 1.5, .1) : new THREE.Vector3(-distance * .85, distance * .68, distance)), nextTarget);
        }
      }
      invalidate();
    };
    sync.current = apply;
    action.current = (value) => {
      const distance = camera.position.distanceTo(controls.target);
      if (value === "home") {
        const extent = Math.max(city.width, city.depth);
        const homeTarget = new THREE.Vector3(0, 15, 0);
        fly(homeTarget.clone().add(isTop ? new THREE.Vector3(0, extent * 1.3, .1) : new THREE.Vector3(-extent * .65, extent * .6, extent * .78)), homeTarget);
      } else if (value === "top") {
        isTop = !isTop; setTopView(isTop);
        fly(controls.target.clone().add(isTop ? new THREE.Vector3(0, distance, .1) : new THREE.Vector3(-distance * .5, distance * .4, distance * .68)), controls.target);
      } else {
        const factor = value === "in" ? .72 : 1.4;
        const offset = camera.position.clone().sub(controls.target).setLength(Math.max(controls.minDistance, Math.min(controls.maxDistance, distance * factor)));
        fly(controls.target.clone().add(offset), controls.target);
      }
      invalidate();
    };
    const pointer = new THREE.Vector2(), ray = new THREE.Raycaster();
    let down = { x: 0, y: 0, time: 0 };
    const pointerDown = (event: PointerEvent) => { down = { x: event.clientX, y: event.clientY, time: performance.now() }; flying = false; };
    const pointerUp = (event: PointerEvent) => {
      if (event.button !== 0 || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5 || performance.now() - down.time > 600) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      ray.setFromCamera(pointer, camera);
      const hit = ray.intersectObjects(city.pickables, false)[0];
      if (hit?.faceIndex != null) {
        const id = hit.object.userData.owners[hit.faceIndex] as string;
        const building = city.buildings.find((b) => b.data.id === id);
        if (building) current.current.onSelect(building.data);
      }
    };
    const keyDown = (event: KeyboardEvent) => {
      const key = event.key;
      if (["+", "=", "-", "Home"].includes(key)) { event.preventDefault(); action.current(key === "Home" ? "home" : key === "-" ? "out" : "in"); }
    };
    const lost = (event: Event) => { event.preventDefault(); current.current.onUnavailable(); };
    renderer.domElement.addEventListener("pointerdown", pointerDown);
    renderer.domElement.addEventListener("pointerup", pointerUp);
    renderer.domElement.addEventListener("keydown", keyDown);
    renderer.domElement.addEventListener("webglcontextlost", lost);
    // Native browser previews can be backgrounded: draw interactions and the first frame synchronously.
    controls.addEventListener("change", invalidate);
    const resize = () => { const w = container.clientWidth, h = container.clientHeight; if (!w || !h) return; renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); invalidate(); };
    const observer = new ResizeObserver(resize); observer.observe(container); resize(); apply(); render(performance.now()); setReady(true);
    return () => {
      disposed = true; cancelAnimationFrame(frame); observer.disconnect();
      controls.removeEventListener("change", invalidate); controls.dispose();
      renderer.domElement.removeEventListener("pointerdown", pointerDown); renderer.domElement.removeEventListener("pointerup", pointerUp); renderer.domElement.removeEventListener("keydown", keyDown); renderer.domElement.removeEventListener("webglcontextlost", lost);
      const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
      if (city.roofTexture) textures.add(city.roofTexture);
      scene.traverse((obj) => { if (obj instanceof THREE.InstancedMesh) obj.dispose(); if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) { geometries.add(obj.geometry); (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach((m: THREE.Material) => { materials.add(m); Object.values(m).forEach((v) => { if (v instanceof THREE.Texture) textures.add(v); }); }); } });
      geometries.forEach((g) => g.dispose()); materials.forEach((m) => m.dispose()); textures.forEach((t) => t.dispose()); sun.shadow.dispose();
      renderer.dispose(); renderer.domElement.remove(); sync.current = () => undefined; action.current = () => undefined;
    };
  }, [props.data]);
  useEffect(() => sync.current(), [props.selected, props.metric]);
  return <div className="roof-scene">
    <div className="roof-scene-host" ref={host} />
    {!ready && <div className="roof-scene-loading"><span className="spin" /> Строим трёхмерный район…</div>}
    <div className="roof-scene-tools" aria-label="Управление сценой">
      <button onClick={() => action.current("in")} aria-label="Приблизить район">+</button>
      <button onClick={() => action.current("out")} aria-label="Отдалить район">−</button>
      <button onClick={() => action.current("home")} title="Показать весь район">⌂</button>
      <button className="roof-view-button" aria-pressed={topView} onClick={() => action.current("top")}>{topView ? "Перспектива" : "Вид сверху"}</button>
    </div>
    <div className="roof-scene-compass" ref={north} aria-hidden="true"><span>С</span>↑</div>
    <div className="roof-scene-caption"><b>3D-реконструкция · OpenStreetMap</b><span>Фасады, озеленение и панели — иллюстрация</span></div>
  </div>;
}
