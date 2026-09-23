import type { WindSimulationInput } from "../api";

export interface DraftTurbine {
  id: string;
  name: string;
  input: WindSimulationInput;
}

const STORAGE_KEY = "renewable-twin.virtual-turbines.v1";
export const MAX_DRAFT_TURBINES = 12;

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function isDraft(value: unknown): value is DraftTurbine {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<DraftTurbine>;
  const input = draft.input;
  return typeof draft.id === "string" && typeof draft.name === "string" && !!input
    && typeof input.turbine_id === "string" && inRange(input.latitude, -90, 90)
    && inRange(input.longitude, -180, 180) && inRange(input.hub_height_m, 10, 180)
    && inRange(input.loss_percent, 0, 30) && [24, 48].includes(input.horizon_hours);
}

export function loadDraftTurbines(): DraftTurbine[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(data) ? data.filter(isDraft).slice(0, MAX_DRAFT_TURBINES) : [];
  } catch { return []; }
}

export function saveDraftTurbines(drafts: DraftTurbine[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts.slice(0, MAX_DRAFT_TURBINES)));
    return true;
  } catch { return false; }
}
