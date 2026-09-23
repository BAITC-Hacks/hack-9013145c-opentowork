export type CityId = "astana" | "almaty" | "shymkent";

export interface City {
  id: CityId;
  name: string;
  subtitle: string;
  /** MapLibre uses longitude, latitude. */
  center: [number, number];
  zoom: number;
  bearing: number;
}

export const CITIES: City[] = [
  {
    id: "astana",
    name: "Астана",
    subtitle: "Есиль · левый берег",
    center: [71.425, 51.125],
    zoom: 15.5,
    bearing: -25,
  },
  {
    id: "almaty",
    name: "Алматы",
    subtitle: "Центральные кварталы · предгорья Заилийского Алатау",
    center: [76.945, 43.25],
    zoom: 15.5,
    bearing: -15,
  },
  {
    id: "shymkent",
    name: "Шымкент",
    subtitle: "Центральные кварталы города",
    center: [69.59, 42.32],
    zoom: 15.5,
    bearing: -20,
  },
];
