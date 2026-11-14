from contract import Point
from distance import drive_matrix, drive_minutes, haversine_miles

MUSKOGEE = Point(lat=35.7479, lng=-95.3697)
TAHLEQUAH = Point(lat=35.9154, lng=-94.97)


def test_zero_for_same_point():
    assert drive_minutes(MUSKOGEE, MUSKOGEE) == 0


def test_shop_to_shop_matches_the_ts_test():
    assert 25.0 < haversine_miles(MUSKOGEE, TAHLEQUAH) < 25.4
    assert drive_minutes(MUSKOGEE, TAHLEQUAH) == 46  # same value tests/truckroll/distance.test.ts pins


def test_rounds_up():
    assert drive_minutes(MUSKOGEE, Point(lat=MUSKOGEE.lat + 0.001, lng=MUSKOGEE.lng)) == 1


def test_symmetric():
    pts = [MUSKOGEE, TAHLEQUAH, Point(lat=35.6, lng=-95.5), Point(lat=36.0, lng=-94.9)]
    m = drive_matrix(pts)
    assert all(m[i][j] == m[j][i] for i in range(4) for j in range(4))
