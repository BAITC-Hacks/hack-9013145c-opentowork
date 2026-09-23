from datetime import UTC, datetime, timedelta

import numpy as np
from windpowerlib.power_output import power_curve

from app.wind.schemas import (
    SimulationHour,
    SimulationRequest,
    SimulationResponse,
    TurbineSpec,
    WeatherForecast,
    WeatherHour,
)
from app.wind.turbines import resolve_turbine

ASSUMPTIONS = [
    "Расчёт для отдельной исправной турбины. Модель WindCast двух турбин кейса не используется.",
    "Ветер интерполируется по логарифму высоты между уровнями 10, 80, 120 и 180 м.",
    "Плотность: температура у земли, градиент −0.0065 °C/м и барометрическая поправка давления.",
    "Кривые OEDB/windpowerlib; опорная плотность принята 1.225 кг/м³.",
    "Граница сильного ветра взята из нулевой точки таблицы, а не из настроек контроллера.",
    "Почасовая мощность принята постоянной в течение часа. Выработка = сумма кВт × 1 ч.",
    "Потери задаются пользователем. След соседних турбин, обледенение и простои не моделируются.",
    "Точность на этом месте не проверена; доверительные интервалы и годовая оценка не рассчитаны.",
    "Это текущий прогноз погоды. Время получения не является временем выпуска погодной модели.",
]


def hub_weather(hour: WeatherHour, height: float) -> tuple[float, float]:
    speed = float(np.interp(
        np.log(height), np.log([10, 80, 120, 180]),
        [hour.wind_10m_ms, hour.wind_80m_ms, hour.wind_120m_ms, hour.wind_180m_ms],
    ))
    ground_k = hour.temperature_2m_c + 273.15
    hub_k = ground_k - 0.0065 * (height - 2)
    pressure = hour.surface_pressure_hpa * 100 * np.exp(
        -9.80665 * height / (287.05 * (ground_k + hub_k) / 2)
    )
    return speed, float(pressure / (287.05 * hub_k))


def turbine_power(turbine: TurbineSpec, speeds: np.ndarray, densities: np.ndarray) -> np.ndarray:
    # Keep shutdown tied to actual wind. Density must not shift the controller's
    # high-wind boundary. Extend the last operating plateau only for interpolation.
    operating = [(v, p) for v, p in turbine.curve if v < turbine.high_wind_zero_ms]
    velocities, powers_kw = np.array(operating).T
    velocities = np.append(velocities, 100.0)
    powers_kw = np.append(powers_kw, powers_kw[-1])
    watts = power_curve(
        speeds, velocities, powers_kw * 1000,
        density=densities, density_correction=True,
    )
    result = np.clip(watts / 1000, 0, turbine.rated_power_kw)
    return np.where(speeds >= turbine.high_wind_zero_ms, 0, result)


def simulate(request: SimulationRequest, weather: WeatherForecast) -> SimulationResponse:
    turbine, height = resolve_turbine(request)
    if len(weather.hours) != request.horizon_hours:
        raise ValueError("Weather does not cover the requested horizon")
    for previous, current in zip(weather.hours, weather.hours[1:], strict=False):
        if current.time - previous.time != timedelta(hours=1):
            raise ValueError("Weather must contain consecutive hours")
    speeds, densities = np.array([hub_weather(h, height) for h in weather.hours]).T
    gross = turbine_power(turbine, speeds, densities)
    net = gross * (1 - request.loss_percent / 100)
    hours = [SimulationHour(
        time=hour.time,
        wind_hub_ms=round(float(speeds[i]), 3),
        density_kg_m3=round(float(densities[i]), 4),
        gross_power_kw=round(float(gross[i]), 3),
        net_power_kw=round(float(net[i]), 3),
        energy_kwh=round(float(net[i]), 3),
        high_wind_shutdown=bool(speeds[i] >= turbine.high_wind_zero_ms),
    ) for i, hour in enumerate(weather.hours)]
    return SimulationResponse(
        request=request, turbine=turbine, hub_height_m=height,
        weather_retrieved_at=weather.retrieved_at,
        weather_grid={"latitude": weather.grid_latitude, "longitude": weather.grid_longitude,
                      "elevation_m": weather.elevation_m},
        forecast_start=hours[0].time,
        forecast_end=hours[-1].time + timedelta(hours=1),
        generated_at=datetime.now(UTC),
        gross_energy_kwh=round(sum(h.gross_power_kw for h in hours), 3),
        net_energy_kwh=round(sum(h.energy_kwh for h in hours), 3),
        capacity_factor=round(float(net.mean()) / turbine.rated_power_kw, 5),
        mean_wind_hub_ms=round(float(speeds.mean()), 3),
        peak_net_power_kw=round(float(net.max()), 3),
        high_wind_shutdown_hours=sum(h.high_wind_shutdown for h in hours),
        hours=hours, assumptions=ASSUMPTIONS + turbine.notes,
    )
