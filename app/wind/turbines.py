import json
from functools import lru_cache
from pathlib import Path

from app.errors import NotFound, ValidationFailed
from app.wind.schemas import SimulationRequest, TurbineSpec


@lru_cache(maxsize=1)
def turbine_catalog() -> tuple[TurbineSpec, ...]:
    data = json.loads(Path(__file__).with_name("turbines.json").read_text(encoding="utf-8"))
    return tuple(TurbineSpec.model_validate(item) for item in data["turbines"])


def resolve_turbine(request: SimulationRequest) -> tuple[TurbineSpec, float]:
    turbine = next((t for t in turbine_catalog() if t.id == request.turbine_id), None)
    if turbine is None:
        raise NotFound("Модель турбины отсутствует в каталоге")
    height = request.hub_height_m or turbine.hub_heights_m[0]
    if height not in turbine.hub_heights_m:
        raise ValidationFailed(
            "Выберите высоту башни из каталога этой модели",
            {"hub_heights_m": turbine.hub_heights_m},
        )
    return turbine, height
