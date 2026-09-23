"""Live weather smoke check; run from root: python -m scripts.smoke_wind.

Requires internet. Uses one Open-Meteo forecast for all catalogue models.
This is a service check, not an accuracy evaluation against turbine telemetry.
"""

import asyncio

from app.wind.model import simulate
from app.wind.schemas import SimulationRequest
from app.wind.turbines import turbine_catalog
from app.wind.weather import fetch_weather


async def main():
    weather = await fetch_weather(51.62, 73.1, 48)
    print(f"Weather retrieved {weather.retrieved_at.isoformat()}")
    for turbine in turbine_catalog():
        result = simulate(SimulationRequest(
            latitude=51.62, longitude=73.1, turbine_id=turbine.id,
            hub_height_m=turbine.hub_heights_m[0],
        ), weather)
        if len(result.hours) != 48 or not 0 <= result.capacity_factor <= 1:
            raise RuntimeError("Invalid simulation output")
        print(f"{turbine.id}: {result.net_energy_kwh / 1000:.2f} MWh / 48h; "
              f"CF={result.capacity_factor:.1%}; wind={result.mean_wind_hub_ms:.2f} m/s")


if __name__ == "__main__":
    asyncio.run(main())
