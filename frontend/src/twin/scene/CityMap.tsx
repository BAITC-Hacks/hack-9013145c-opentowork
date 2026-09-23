/// <reference types="vite/client" />
import { useEffect, useMemo, useRef, useState } from "react";
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type {
  ExpressionSpecification,
  FilterSpecification,
  GeoJSONSource,
  Map as LibreMap,
  Marker,
  Popup,
  StyleSpecification,
} from "maplibre-gl";
import type { Rooftop, RooftopsResponse } from "../../api";
import { CITIES, type CityId } from "../cities";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import "./city-map.css";

interface CityMapProps {
  city: CityId;
  data: RooftopsResponse | null;
  selected: Rooftop | null;
  metric: "materials" | "energy" | "quality";
  onSelect: (building: Rooftop) => void;
  onUnavailable: () => void;
}

type Phase = "loading" | "ready" | "failed";
type RoofProperties = {
  id: string;
  height: number;
  energy: number;
  quality: number;
  material: string;
};
const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const BUILDINGS = "city-buildings-3d";
const ROOFS = "city-roofs";
const ROOF_LAYER = "city-roofs-3d";
const DISTRICT = "city-analysis-district";
const DISTRICT_LAYER = "city-analysis-district-line";
const SELECTED = "city-roof-selected";
const SELECTED_LAYER = "city-roof-selected-3d";
const DEM = "city-terrain";
const EMPTY: FeatureCollection<Polygon, RoofProperties> = {
  type: "FeatureCollection",
  features: [],
};
const BUILDING_FILTER: FilterSpecification = ["!=", ["get", "hide_3d"], true];

/** Real street geometry comes from the complete OpenFreeMap style. Only paint
 * and language preferences change; road classes, bridges and labels stay intact. */
function naturalStyle(style: StyleSpecification): StyleSpecification {
  style.layers = style.layers.filter(
    (layer) =>
      !(
        layer.type === "fill-extrusion" && layer["source-layer"] === "building"
      ),
  );
  const landmarks: StyleSpecification["layers"] = [];
  for (const layer of style.layers) {
    if (layer.type === "background")
      layer.paint = { ...layer.paint, "background-color": "#e6e3da" };
    if (layer.type === "fill") {
      const colors: Record<string, string> = {
        park: "#bdcea9",
        landuse_residential: "#dddcd5",
        landcover_wood: "#a4ba99",
        landcover_grass: "#c7d2b2",
        landcover_ice: "#edf0ec",
        landcover_wetland: "#baccc0",
        landuse_pitch: "#a7bd98",
        landuse_track: "#cabda6",
        landuse_cemetery: "#bdcbb0",
        landuse_hospital: "#dbd6cd",
        landuse_school: "#ddd9cb",
        water: "#9cbec7",
        landcover_sand: "#dcd0b5",
        aeroway_fill: "#c9cbc4",
        building: "#c2c0b7",
      };
      if (colors[layer.id])
        layer.paint = { ...layer.paint, "fill-color": colors[layer.id] };
      if (layer.id === "park")
        layer.paint = { ...layer.paint, "fill-outline-color": "#a8bd95" };
      if (layer["source-layer"] === "transportation") {
        layer.paint = { ...layer.paint, "fill-color": "#b2b4ac" };
        delete layer.paint["fill-pattern"];
      }
    }
    if (layer.type === "line") {
      const sourceLayer = layer["source-layer"];
      let color: string | undefined;
      if (sourceLayer === "transportation") {
        color = /rail/.test(layer.id)
          ? "#92978e"
          : /casing/.test(layer.id)
            ? "#d3d0c5"
            : /path|pedestrian/.test(layer.id)
              ? "#cac3b3"
              : "#959e9a";
      } else if (sourceLayer === "waterway") color = "#91b6c0";
      else if (sourceLayer === "boundary") color = "#b9b5a8";
      else if (sourceLayer === "park") color = "#a3ba90";
      else if (sourceLayer === "aeroway") color = "#aaafa8";
      if (color) layer.paint = { ...layer.paint, "line-color": color };
    }
    if (layer.type === "symbol" && layer.layout?.["text-field"]) {
      const field = layer.layout["text-field"];
      // Keep route numbers and special shield expressions from the provider.
      if (!/shield/.test(layer.id)) {
        layer.layout = {
          ...layer.layout,
          "text-field": [
            "coalesce",
            ["get", "name:ru"],
            ["get", "name"],
            ["get", "name:nonlatin"],
            field,
          ] as ExpressionSpecification,
        };
      }
      layer.paint = {
        ...layer.paint,
        "text-color": /water/.test(layer.id) ? "#526f78" : "#536059",
        "text-halo-color": "#f8f7f0",
        "text-halo-width": 1.3,
      };
      if (/^poi_r/.test(layer.id)) {
        // Services appear at close range. Recognisable landmarks stay available
        // in the initial city view without labels covering every building.
        if (layer.id === "poi_r1")
          landmarks.push({
            ...layer,
            id: "city-landmark-labels",
            minzoom: 15,
            maxzoom: 17,
            filter: [
              "all",
              layer.filter ?? ["literal", true],
              [
                "match",
                ["get", "class"],
                [
                  "attraction",
                  "museum",
                  "monument",
                  "castle",
                  "town_hall",
                  "college",
                  "stadium",
                  "place_of_worship",
                ],
                true,
                false,
              ],
            ] as FilterSpecification,
          });
        layer.minzoom = Math.max(layer.minzoom ?? 0, 17);
      }
    }
  }
  style.layers.push(...landmarks);
  return style;
}

function validData(
  data: RooftopsResponse | null,
  city: CityId,
): RooftopsResponse | null {
  if (!data) return null;
  const center = CITIES.find((item) => item.id === city)!.center;
  const [south, west, north, east] = data.bbox;
  // During a city switch the previous request may still be visible in the parent.
  return Math.abs((west + east) / 2 - center[0]) < 1 &&
    Math.abs((south + north) / 2 - center[1]) < 1
    ? data
    : null;
}

function ring(building: Rooftop): [number, number][] {
  const coordinates = building.polygon
    .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map(([lat, lng]) => [lng, lat] as [number, number]);
  if (coordinates.length < 3) return [];
  const first = coordinates[0],
    last = coordinates[coordinates.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1])
    coordinates.push([...first]);
  return coordinates;
}

function roofGeoJSON(
  data: RooftopsResponse | null,
): FeatureCollection<Polygon, RoofProperties> {
  if (!data) return EMPTY;
  return {
    type: "FeatureCollection",
    features: data.buildings.flatMap((building) => {
      const coordinates = ring(building);
      if (!coordinates.length) return [];
      return [
        {
          type: "Feature" as const,
          id: building.id,
          geometry: { type: "Polygon" as const, coordinates: [coordinates] },
          properties: {
            id: building.id,
            height: Number.isFinite(building.height_m)
              ? Math.max(0, building.height_m)
              : 0,
            energy: Math.max(0, building.kwh_year || 0),
            quality: Math.max(0, building.kwh_per_kwp || 0),
            material: building.pitched ? "#bfa790" : "#c6c8be",
          },
        },
      ];
    }),
  };
}

/** Test original geographic footprints when the clicked OSM feature is a
 * building part. The city geometry remains untouched by solar assumptions. */
function containsPoint(building: Rooftop, lng: number, lat: number): boolean {
  const points = building.polygon;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [yi, xi] = points[i],
      [yj, xj] = points[j];
    if (
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

/** A vertex average may lie in a courtyard or outside a concave footprint.
 * Horizontal scanlines between vertex heights produce strictly interior spans;
 * even/odd pairs preserve holes. Prefer a broad span away from vertex heights. */
function interiorPoint(
  geometry: Polygon | MultiPolygon,
): [number, number] | null {
  const polygons =
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let best: [number, number] | null = null;
  let bestScore = 0;
  for (const rings of polygons) {
    const levels = [
      ...new Set(rings.flatMap((points) => points.map((p) => p[1]))),
    ]
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    for (let level = 1; level < levels.length; level += 1) {
      const verticalGap = levels[level] - levels[level - 1];
      if (verticalGap <= 0) continue;
      const y = (levels[level] + levels[level - 1]) / 2;
      const crossings: number[] = [];
      for (const points of rings) {
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
          const a = points[i],
            b = points[j];
          if (a[1] > y !== b[1] > y)
            crossings.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
        }
      }
      crossings.sort((a, b) => a - b);
      for (let i = 0; i + 1 < crossings.length; i += 2) {
        const width = crossings[i + 1] - crossings[i];
        const score = width * verticalGap;
        if (score > bestScore) {
          bestScore = score;
          best = [(crossings[i] + crossings[i + 1]) / 2, y];
        }
      }
    }
  }
  return best;
}

function metricColor(
  metric: CityMapProps["metric"],
  collection: FeatureCollection<Polygon, RoofProperties>,
): ExpressionSpecification {
  if (metric === "materials") return ["get", "material"];
  const key = metric === "energy" ? "energy" : "quality";
  const values = collection.features
    .map((feature) => feature.properties[key])
    .filter(Number.isFinite);
  const low = values.length ? Math.min(...values) : 0;
  const high = Math.max(values.length ? Math.max(...values) : 1, low + 1);
  if (metric === "energy") {
    return [
      "interpolate",
      ["linear"],
      ["ln", ["+", 1, ["get", key]]],
      Math.log1p(low),
      "#e8debd",
      Math.log1p(low) + (Math.log1p(high) - Math.log1p(low)) * 0.65,
      "#d6b36e",
      Math.log1p(high),
      "#ae741c",
    ];
  }
  return [
    "interpolate",
    ["linear"],
    ["get", key],
    low,
    "#dce4d7",
    low + (high - low) * 0.7,
    "#93b8a0",
    high,
    "#357c68",
  ];
}

export default function CityMap(props: CityMapProps) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LibreMap | null>(null);
  const popupRef = useRef<Popup | null>(null);
  const selectionMarkerRef = useRef<Marker | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [phase, setPhase] = useState<Phase>("loading");
  const [message, setMessage] = useState("");
  const [warning, setWarning] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [readyVersion, setReadyVersion] = useState(0);
  const [topView, setTopView] = useState(false);
  const [terrain, setTerrain] = useState(false);
  const [terrainBusy, setTerrainBusy] = useState(false);
  const [terrainFailed, setTerrainFailed] = useState(false);
  const terrainLoadedOnce = useRef(false);
  const config = CITIES.find((city) => city.id === props.city)!;
  const data = validData(props.data, props.city);
  const roofs = useMemo(() => roofGeoJSON(data), [data]);
  const reduced = useRef(false);
  const duration = () => (reduced.current ? 0 : 800);

  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    let map: LibreMap | null = null;
    let resize: ResizeObserver | null = null;
    let errors = 0;
    let styleReady = false;
    let lastMapError = "";
    const controller = new AbortController();
    const abortTimer = window.setTimeout(() => controller.abort(), 15000);
    const loadTimer = window.setTimeout(() => {
      if (!disposed) {
        setPhase("failed");
        setMessage(
          "Карта загружается слишком долго. Проверьте подключение или откройте сохранённый район." +
            (import.meta.env.DEV && lastMapError ? ` ${lastMapError}` : ""),
        );
      }
    }, 26000);
    reduced.current = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    setPhase("loading");
    setMessage("");
    setWarning("");
    setTopView(false);
    setTerrain(false);
    setTerrainFailed(false);
    setTerrainBusy(false);
    terrainLoadedOnce.current = false;

    const initialize = async () => {
      try {
        const [module, response] = await Promise.all([
          import("maplibre-gl"),
          fetch(STYLE_URL, { signal: controller.signal }),
        ]);
        if (!response.ok)
          throw new Error(`Картографический сервис ответил ${response.status}`);
        const style = naturalStyle(
          (await response.json()) as StyleSpecification,
        );
        if (disposed || !host.current) return;
        window.clearTimeout(abortTimer);
        // v6 requires a bundled worker URL. Plain ?url leaves an unresolved
        // sibling import in production; Vite's worker pipeline bundles it.
        module.setWorkerUrl(workerUrl);
        map = new module.Map({
          container: host.current,
          style,
          center: config.center,
          zoom: config.zoom,
          pitch: 55,
          bearing: config.bearing,
          maxPitch: 70,
          minZoom: 8,
          maxZoom: 19.5,
          canvasContextAttributes: { antialias: true },
          renderWorldCopies: false,
          attributionControl: false,
          locale: {
            "NavigationControl.ZoomIn": "Приблизить",
            "NavigationControl.ZoomOut": "Отдалить",
            "NavigationControl.ResetBearing": "Север сверху",
            "AttributionControl.ToggleAttribution": "Источники карты",
          },
        });
        mapRef.current = map;
        map.addControl(
          new module.NavigationControl({ visualizePitch: true }),
          "top-right",
        );
        map.addControl(
          new module.ScaleControl({ unit: "metric", maxWidth: 100 }),
          "bottom-left",
        );
        map.addControl(
          new module.AttributionControl({
            compact: true,
          }),
          "bottom-right",
        );
        // A DOM annotation stays readable when a roof's estimated solar height
        // differs from the vector building height. City geometry is unchanged.
        const markerElement = document.createElement("div");
        markerElement.className = "city-selected-marker";
        markerElement.style.display = "none";
        markerElement.setAttribute("role", "img");
        markerElement.appendChild(document.createElement("span"));
        selectionMarkerRef.current = new module.Marker({
          element: markerElement,
          anchor: "bottom",
          offset: [0, -9],
          opacityWhenCovered: 1,
        })
          .setLngLat(config.center)
          .addTo(map);
        const canvas = map.getCanvas();
        canvas.setAttribute(
          "aria-label",
          `Карта города ${config.name}. Стрелки — перемещение, плюс и минус — масштаб.`,
        );
        canvas.addEventListener("webglcontextlost", () => {
          if (!disposed) {
            setPhase("failed");
            setMessage(
              "Браузер приостановил 3D-карту. Попробуйте открыть её ещё раз или перейти к сохранённому району.",
            );
          }
        });
        map.on("style.load", () => {
          if (disposed || !map) return;
          try {
            const sourceId = Object.entries(map.getStyle().sources).find(
              ([, source]) => source.type === "vector",
            )?.[0];
            if (!sourceId) throw new Error("В стиле не найден источник зданий");
            const firstLabel = map
              .getStyle()
              .layers.find((layer) => layer.type === "symbol")?.id;
            map.addLayer(
              {
                id: BUILDINGS,
                type: "fill-extrusion",
                source: sourceId,
                "source-layer": "building",
                minzoom: 13.5,
                filter: BUILDING_FILTER,
                paint: {
                  "fill-extrusion-color": [
                    "interpolate",
                    ["linear"],
                    ["to-number", ["get", "render_height"], 0],
                    0,
                    "#c6c5b9",
                    50,
                    "#d3d0c3",
                    150,
                    "#ccd3cd",
                  ],
                  "fill-extrusion-height": [
                    "max",
                    0,
                    ["to-number", ["get", "render_height"], 0],
                  ],
                  "fill-extrusion-base": [
                    "max",
                    0,
                    ["to-number", ["get", "render_min_height"], 0],
                  ],
                  "fill-extrusion-opacity": 1,
                },
              },
              firstLabel,
            );
            map.addSource(ROOFS, { type: "geojson", data: EMPTY });
            map.addLayer(
              {
                id: ROOF_LAYER,
                type: "fill-extrusion",
                source: ROOFS,
                minzoom: 13,
                paint: {
                  "fill-extrusion-height": ["+", ["get", "height"], 0.35],
                  "fill-extrusion-base": ["+", ["get", "height"], 0.1],
                  "fill-extrusion-color": ["get", "material"],
                  "fill-extrusion-opacity": 1,
                },
              },
              firstLabel,
            );
            map.addSource(DISTRICT, {
              type: "geojson",
              data: { type: "FeatureCollection", features: [] },
            });
            map.addLayer(
              {
                id: DISTRICT_LAYER,
                type: "line",
                source: DISTRICT,
                paint: {
                  "line-color": "#ab832d",
                  "line-width": 1.5,
                  "line-opacity": 0.8,
                  "line-dasharray": [4, 3],
                },
              },
              firstLabel,
            );
            map.addSource(SELECTED, { type: "geojson", data: EMPTY });
            map.addLayer(
              {
                id: SELECTED_LAYER,
                type: "fill-extrusion",
                source: SELECTED,
                minzoom: 12,
                paint: {
                  "fill-extrusion-height": ["+", ["get", "height"], 0.55],
                  "fill-extrusion-base": ["+", ["get", "height"], 0.1],
                  "fill-extrusion-color": "#f1b54b",
                  "fill-extrusion-opacity": 1,
                },
              },
              firstLabel,
            );
            map.setLight({
              anchor: "viewport",
              color: "#fff8e8",
              intensity: 0.45,
              position: [1.2, 210, 35],
            });
            map.setSky({
              "sky-color": "#cddfe5",
              "horizon-color": "#e9ede5",
              "fog-color": "#d9e1d8",
              "fog-ground-blend": 0.5,
              "horizon-fog-blend": 0.6,
              "sky-horizon-blend": 0.8,
            });
            styleReady = true;
            setReadyVersion((version) => version + 1);
          } catch (error) {
            setPhase("failed");
            setMessage(
              error instanceof Error
                ? error.message
                : "Не удалось подготовить слои карты.",
            );
          }
        });
        map.on("load", () => {
          if (disposed || !styleReady) return;
          window.clearTimeout(loadTimer);
          setPhase("ready");
        });
        map.on("error", (event) => {
          if (disposed) return;
          lastMapError = event.error?.message ?? "Неизвестная ошибка карты";
          if (/worker failed/i.test(lastMapError)) {
            window.clearTimeout(loadTimer);
            setPhase("failed");
            setMessage(
              "Не удалось запустить обработку карты. Обновите страницу и попробуйте снова." +
                (import.meta.env.DEV ? ` ${lastMapError}` : ""),
            );
          }
          if ("sourceId" in event && event.sourceId === DEM) {
            map?.setTerrain(null);
            setTerrain(false);
            setTerrainBusy(false);
            setTerrainFailed(true);
            setWarning("Рельеф недоступен. Дороги и здания остаются на карте.");
            return;
          }
          errors += 1;
          if (errors >= 3)
            setWarning(
              "Часть тайлов не загрузилась. Карта может быть неполной; попробуйте обновить её.",
            );
        });
        map.on("sourcedata", (event) => {
          if (
            event.sourceId === DEM &&
            !disposed &&
            map?.getSource(DEM) &&
            map.isSourceLoaded(DEM)
          ) {
            terrainLoadedOnce.current = true;
            setTerrainBusy(false);
          }
        });
        map.on("idle", () => {
          if (
            !disposed &&
            map?.getTerrain()?.source === DEM &&
            map.isSourceLoaded(DEM)
          ) {
            terrainLoadedOnce.current = true;
            setTerrainBusy(false);
          }
        });
        map.on("pitchend", () => {
          if (!disposed && map) setTopView(map.getPitch() < 10);
        });
        map.on("click", (event) => {
          if (!map || !styleReady) return;
          const features = map.queryRenderedFeatures(event.point, {
            layers: [SELECTED_LAYER, ROOF_LAYER, BUILDINGS],
          });
          const feature = features[0];
          if (!feature) {
            popupRef.current?.remove();
            return;
          }
          const currentData = validData(
            latest.current.data,
            latest.current.city,
          );
          let building =
            feature.layer.id !== BUILDINGS
              ? currentData?.buildings.find(
                  (b) => b.id === feature.properties.id,
                )
              : undefined;
          if (!building && currentData && feature.layer.id === BUILDINGS) {
            const geometry = feature.geometry;
            const point =
              geometry.type === "Polygon" || geometry.type === "MultiPolygon"
                ? interiorPoint(geometry)
                : null;
            if (point) {
              const [lng, lat] = point;
              // A part's own result is preferred over a containing parent outline.
              building = currentData.buildings
                .filter((b) => containsPoint(b, lng, lat))
                .sort((a, b) => a.roof_m2 - b.roof_m2)[0];
            }
          }
          popupRef.current?.remove();
          if (building) {
            latest.current.onSelect(building);
            return;
          }
          const details = document.createElement("div");
          details.className = "city-building-popup";
          const title = document.createElement("b");
          title.textContent = String(
            feature.properties["name:ru"] ||
              feature.properties.name ||
              "Здание OpenStreetMap",
          );
          const text = document.createElement("p");
          text.textContent =
            "Солнечный потенциал этого здания пока не рассчитан.";
          const note = document.createElement("small");
          note.textContent =
            "Контур — OSM. Высота зависит от полноты исходных данных.";
          details.append(title, text, note);
          popupRef.current = new module.Popup({
            closeButton: true,
            maxWidth: "245px",
            offset: 10,
          })
            .setLngLat(event.lngLat)
            .setDOMContent(details)
            .addTo(map);
        });
        map.on("mousemove", (event) => {
          if (!map || !styleReady) return;
          const features = map.queryRenderedFeatures(event.point, {
            layers: [ROOF_LAYER, BUILDINGS],
          });
          map.getCanvas().style.cursor = features.length ? "pointer" : "";
        });
        resize = new ResizeObserver(() => map?.resize());
        resize.observe(host.current);
      } catch (error) {
        if (disposed) return;
        window.clearTimeout(loadTimer);
        setPhase("failed");
        setMessage(
          error instanceof Error && error.name !== "AbortError"
            ? `Не удалось открыть карту: ${error.message}`
            : "Картографический сервис не ответил. Проверьте подключение к интернету.",
        );
      }
    };
    void initialize();
    return () => {
      disposed = true;
      controller.abort();
      window.clearTimeout(abortTimer);
      window.clearTimeout(loadTimer);
      resize?.disconnect();
      popupRef.current?.remove();
      popupRef.current = null;
      selectionMarkerRef.current?.remove();
      selectionMarkerRef.current = null;
      map?.remove();
      if (mapRef.current === map) mapRef.current = null;
    };
  }, [props.city, attempt]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getSource(ROOFS)) return;
    (map.getSource(ROOFS) as GeoJSONSource).setData(roofs);
    // Solar data only paints a thin roof plate; it never replaces the detailed
    // OSM skyline or removes parts belonging to a larger building footprint.
    map.setLayoutProperty(
      ROOF_LAYER,
      "visibility",
      props.metric === "materials" ? "none" : "visible",
    );
    const district: FeatureCollection<Polygon> = {
      type: "FeatureCollection",
      features: [],
    };
    if (data) {
      const [south, west, north, east] = data.bbox;
      district.features.push({
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [west, south],
              [east, south],
              [east, north],
              [west, north],
              [west, south],
            ],
          ],
        },
      });
    }
    (map.getSource(DISTRICT) as GeoJSONSource).setData(district);
    map.setPaintProperty(
      ROOF_LAYER,
      "fill-extrusion-color",
      metricColor(props.metric, roofs),
    );
  }, [roofs, props.metric, readyVersion]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getSource(SELECTED)) return;
    const selected = roofs.features.filter(
      (feature) => feature.properties.id === props.selected?.id,
    );
    (map.getSource(SELECTED) as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: selected,
    });
    const marker = selectionMarkerRef.current;
    if (!selected.length) {
      if (marker) marker.getElement().style.display = "none";
      return;
    }
    const center = interiorPoint(selected[0].geometry);
    if (!center) return;
    if (marker) {
      const title = props.selected?.name || "Выбранная крыша";
      const element = marker.setLngLat(center).getElement();
      element.style.display = "";
      element.title = title;
      element.setAttribute("aria-label", `Выбрана крыша: ${title}`);
      element.firstElementChild!.textContent = title;
    }
    map.easeTo({
      center,
      zoom: Math.max(map.getZoom(), 17),
      duration: duration(),
    });
  }, [props.selected?.id, roofs, readyVersion]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer(BUILDINGS)) return;
    if (!terrain) {
      map.setTerrain(null);
      setTerrainBusy(false);
      terrainLoadedOnce.current = false;
      return;
    }
    try {
      if (!map.getSource(DEM))
        map.addSource(DEM, {
          type: "raster-dem",
          url: "https://tiles.mapterhorn.com/tilejson.json",
          tileSize: 512,
          encoding: "terrarium",
          attribution:
            '<a href="https://mapterhorn.com/attribution/" target="_blank" rel="noopener">Mapterhorn</a>',
        });
      terrainLoadedOnce.current = map.isSourceLoaded(DEM);
      setTerrainBusy(!terrainLoadedOnce.current);
      map.setTerrain({ source: DEM, exaggeration: 1 });
    } catch {
      setTerrain(false);
      setTerrainBusy(false);
      setTerrainFailed(true);
      setWarning("Рельеф недоступен. Карта продолжает работать без него.");
    }
    const timeout = window.setTimeout(() => {
      if (mapRef.current !== map) return;
      // A successful first load ends the busy state even when no source event
      // reported the final tile. Later panning must not turn that success into
      // a timeout merely because additional terrain tiles are in flight.
      if (terrainLoadedOnce.current || map.isSourceLoaded(DEM)) {
        terrainLoadedOnce.current = true;
        setTerrainBusy(false);
      } else {
        mapRef.current?.setTerrain(null);
        setTerrain(false);
        setTerrainBusy(false);
        setTerrainFailed(true);
        setWarning("Источник рельефа не ответил. Продолжаем без рельефа.");
      }
    }, 15000);
    return () => window.clearTimeout(timeout);
  }, [terrain, readyVersion]);

  const fitDistrict = () => {
    if (!data) return;
    const [south, west, north, east] = data.bbox;
    mapRef.current?.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      {
        padding: { top: 90, right: 45, bottom: 75, left: 45 },
        pitch: 55,
        bearing: config.bearing,
        maxZoom: 16.3,
        duration: duration(),
      },
    );
  };

  return (
    <div
      className="roof-scene city-map"
      aria-label={`Городская карта: ${config.name}`}
    >
      <div className="city-map-host" ref={host} />
      <div
        className="city-map-actions"
        role="group"
        aria-label="Управление картой"
      >
        <button
          disabled={phase !== "ready"}
          onClick={() =>
            mapRef.current?.easeTo({
              center: config.center,
              zoom: config.zoom,
              pitch: 55,
              bearing: config.bearing,
              duration: duration(),
            })
          }
        >
          Центр города
        </button>
        <button
          disabled={phase !== "ready"}
          onClick={() =>
            mapRef.current?.easeTo({
              center: config.center,
              zoom: props.city === "astana" ? 10.8 : 11.2,
              pitch: 25,
              bearing: 0,
              duration: duration(),
            })
          }
        >
          Весь город
        </button>
        <button
          disabled={phase !== "ready" || !data?.buildings.length}
          onClick={fitDistrict}
        >
          Крыши с расчётом
        </button>
        <button
          disabled={phase !== "ready"}
          aria-pressed={topView}
          onClick={() =>
            mapRef.current?.easeTo({
              pitch: topView ? 55 : 0,
              duration: duration(),
            })
          }
        >
          {topView ? "Перспектива" : "Вид сверху"}
        </button>
        <label className={terrainFailed ? "unavailable" : ""}>
          <input
            type="checkbox"
            aria-label="Рельеф"
            checked={terrain}
            disabled={phase !== "ready" || terrainFailed}
            onChange={(event) => setTerrain(event.target.checked)}
          />
          {terrainBusy ? "Загрузка рельефа…" : "Рельеф"}
        </label>
      </div>
      {phase !== "ready" && (
        <div className="city-map-state" role="status" aria-live="polite">
          <div>
            {phase === "loading" ? (
              <>
                <span className="city-map-spinner" />
                <b>Открываем {config.name}</b>
                <p>Загружаем настоящие улицы, кварталы и здания.</p>
              </>
            ) : (
              <>
                <span className="city-map-state-icon" aria-hidden="true">
                  ⌁
                </span>
                <b>Карта пока недоступна</b>
                <p>{message}</p>
                <button
                  className="city-map-retry"
                  onClick={() => setAttempt((value) => value + 1)}
                >
                  Попробовать снова
                </button>
              </>
            )}
            <button className="city-map-fallback" onClick={props.onUnavailable}>
              {data ? "Открыть сохранённый район" : "Повторить загрузку"}
            </button>
          </div>
        </div>
      )}
      {phase === "ready" && warning && (
        <div className="city-map-warning" role="status">
          <span>{warning}</span>
          <button onClick={() => setAttempt((value) => value + 1)}>
            Повторить
          </button>
          <button onClick={props.onUnavailable}>Без интернета</button>
        </div>
      )}
      {phase === "ready" && (
        <div className="city-map-caption">
          <b>Улицы и здания — OpenStreetMap</b>
          <span>
            Высоты могут быть оценочными.{" "}
            {data
              ? "Пунктир — граница района солнечного расчёта."
              : "Солнечный расчёт появится после загрузки района."}
          </span>
        </div>
      )}
    </div>
  );
}
