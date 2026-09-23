from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class SimulationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    turbine_id: str = Field(min_length=1, max_length=64)
    hub_height_m: float | None = Field(default=None, ge=10, le=180)
    horizon_hours: Literal[24, 48] = 48
    loss_percent: float = Field(default=0, ge=0, le=30)


class TurbineSpec(BaseModel):
    id: str
    name: str
    manufacturer: str
    rated_power_kw: float
    rotor_diameter_m: float
    hub_heights_m: list[float]
    reference_density_kg_m3: float
    high_wind_zero_ms: float
    curve: list[tuple[float, float]]  # m/s, kW
    source_url: str
    metadata_source_url: str
    notes: list[str]


class ReferenceSite(BaseModel):
    name: str
    units: int | None
    capacity_mw: float | None
    owner: str | None


class ReferenceSource(BaseModel):
    title: str
    url: str


class ReferenceTurbine(BaseModel):
    """Оборудование казахстанских ВЭС без опубликованной кривой мощности — только паспорт."""

    id: str
    name: str
    manufacturer: str
    rated_power_kw: float
    rotor_diameter_m: float
    hub_height_m: float | None
    sites: list[ReferenceSite]
    specs: list[str]
    sources: list[ReferenceSource]


class WeatherHour(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)

    time: datetime
    wind_10m_ms: float = Field(ge=0, le=150)
    wind_80m_ms: float = Field(ge=0, le=150)
    wind_120m_ms: float = Field(ge=0, le=150)
    wind_180m_ms: float = Field(ge=0, le=150)
    temperature_2m_c: float = Field(ge=-100, le=70)
    surface_pressure_hpa: float = Field(ge=300, le=1100)


class WeatherForecast(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)

    retrieved_at: datetime
    grid_latitude: float = Field(ge=-90, le=90)
    grid_longitude: float = Field(ge=-180, le=180)
    elevation_m: float = Field(ge=-500, le=9000)
    hours: list[WeatherHour]


class SimulationHour(BaseModel):
    time: datetime
    wind_hub_ms: float
    density_kg_m3: float
    gross_power_kw: float
    net_power_kw: float
    energy_kwh: float
    high_wind_shutdown: bool


class SimulationResponse(BaseModel):
    method: Literal["engineering_power_curve_v1"] = "engineering_power_curve_v1"
    calibrated: Literal[False] = False
    request: SimulationRequest
    turbine: TurbineSpec
    hub_height_m: float
    weather_provider: str = "Open-Meteo Forecast (best_match)"
    weather_source_url: str = "https://open-meteo.com/en/docs"
    weather_retrieved_at: datetime
    weather_run_issued_at: datetime | None = None
    weather_grid: dict[str, float]
    forecast_start: datetime
    forecast_end: datetime
    generated_at: datetime
    gross_energy_kwh: float
    net_energy_kwh: float
    capacity_factor: float
    mean_wind_hub_ms: float
    peak_net_power_kw: float
    high_wind_shutdown_hours: int
    hours: list[SimulationHour]
    assumptions: list[str]
