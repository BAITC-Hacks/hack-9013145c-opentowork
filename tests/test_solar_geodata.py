"""OSM topology and road geometry checks without external services."""

import pytest

from scripts.fetch_solar_data import clip_road, outer_rings, parse_osm, road_width


def _geometry(points):
    return [{"lat": lat, "lon": lon} for lat, lon in points]


def test_open_building_is_not_artificially_closed():
    element = {"type": "way", "id": 1, "tags": {"building": "yes"},
               "geometry": _geometry([[0, 0], [0, 1], [1, 1], [1, 0]])}
    buildings, env = parse_osm([element], (0, 0, 2, 2))
    assert buildings == []
    assert env["skipped_polygon_features"] == 1


def test_relation_members_with_a_hole_are_not_drawn_as_solid_roof_or_park():
    ring = [[0, 0], [0, 2], [2, 2], [2, 0], [0, 0]]
    way = {"type": "way", "id": 10, "tags": {"building": "yes"},
           "geometry": _geometry(ring)}
    relation = {"type": "relation", "id": 20, "tags": {"building": "yes"},
                "members": [{"type": "way", "ref": 10, "role": "outer",
                             "geometry": _geometry(ring)},
                            {"type": "way", "ref": 11, "role": "inner"}]}
    buildings, env = parse_osm([way, relation], (0, 0, 2, 2))
    assert buildings == []
    assert env["areas"] == []
    assert env["skipped_polygon_features"] == 1


def test_multipolygon_outer_segments_join_in_reverse_direction():
    relation = {"type": "relation", "members": [
        {"type": "way", "role": "outer", "geometry": _geometry([[0, 0], [0, 1], [1, 1]])},
        {"type": "way", "role": "outer", "geometry": _geometry([[0, 0], [1, 0], [1, 1]])},
    ]}
    rings = outer_rings(relation)
    assert len(rings) == 1
    assert rings[0][0] == rings[0][-1]
    assert {tuple(p) for p in rings[0]} == {(0, 0), (0, 1), (1, 1), (1, 0)}


def test_road_clipping_preserves_boundary_and_does_not_bridge_outside_gap():
    lines = clip_road([[0.5, -1], [0.5, 2], [2, 2], [0.3, -1]], (0, 0, 1, 1))
    assert lines[0] == [[0.5, 0], [0.5, 1]]
    assert len(lines) == 2
    assert all(0 <= lat <= 1 and 0 <= lon <= 1 for line in lines for lat, lon in line)
    assert clip_road([[2, 0], [2, 1]], (0, 0, 1, 1)) == []


def test_width_units_and_assumptions_are_explicit():
    width, lanes, source = road_width({"highway": "primary", "width": "30 ft", "lanes": "2"})
    assert width == pytest.approx(9.14)
    assert lanes == 2
    assert source == "osm_width"
    assert road_width({"highway": "residential", "lanes": "2"}) == (
        7.0, 2, "assumed_from_lanes",
    )
    assert road_width({"highway": "footway", "width": "unknown"}) == (
        2, None, "assumed_by_kind",
    )
