from app.api.v1.stations import _solar_out
from app.solar.catalog import solar_farm, solar_farms


def test_catalog_is_real_osm_plants_inside_kazakhstan():
    farms = solar_farms()
    assert len(farms) >= 20
    for f in farms:
        assert f["osm"].startswith(("way/", "relation/"))
        assert 40 < f["lat"] < 56 and 46 < f["lon"] < 88
        assert f["units"], f["id"]


def test_block_capacity_adds_up_to_plant_capacity():
    for f in solar_farms():
        if f["capacity_mw"] is None:
            assert all(u["rated_kw"] is None for u in f["units"])
            continue
        total = sum(u["rated_kw"] for u in f["units"]) / 1000
        assert abs(total - f["capacity_mw"]) < 0.01 * f["capacity_mw"] + 0.01


def test_solar_station_contract():
    out = _solar_out(solar_farm("pv-way-731775244"))
    assert out.kind == "solar"
    assert out.name == "СЭС Сарань"
    assert out.capacity_mw == 100
    assert [u.id for u in out.units] == ["Б1", "Б2", "Б3", "Б4"]
