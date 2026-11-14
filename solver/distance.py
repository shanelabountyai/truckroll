"""D-01 drive minutes. 1:1 port of src/lib/dispatch/distance.ts — keep the operation order identical."""

import math

from contract import Point

EARTH_RADIUS_MI = 3958.8
ROAD_FACTOR = 1.35
AVG_MPH = 45
_EPS = 1e-9  # see distance.ts: absorbs last-bit libm differences between V8 and CPython


def _rad(deg: float) -> float:
    return (deg * math.pi) / 180


def haversine_miles(a: Point, b: Point) -> float:
    d_lat = _rad(b.lat - a.lat)
    d_lng = _rad(b.lng - a.lng)
    s_lat = math.sin(d_lat / 2)
    s_lng = math.sin(d_lng / 2)
    h = s_lat * s_lat + math.cos(_rad(a.lat)) * math.cos(_rad(b.lat)) * s_lng * s_lng
    return 2 * EARTH_RADIUS_MI * math.asin(min(1, math.sqrt(h)))


def drive_minutes(a: Point, b: Point) -> int:
    if a.lat == b.lat and a.lng == b.lng:
        return 0
    minutes = ((haversine_miles(a, b) * ROAD_FACTOR) / AVG_MPH) * 60
    return max(0, math.ceil(minutes - _EPS))


def drive_matrix(points: list[Point]) -> list[list[int]]:
    return [[drive_minutes(a, b) for b in points] for a in points]
